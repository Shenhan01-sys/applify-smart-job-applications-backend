import { classifyJobChannel } from './apply-channel.js'
import { ExtensionRunnerError, isUuid, verifyExtensionApproval } from './extension-runner.js'
import type { GuardDb } from './queue-guard.js'
import { sweepExtensionJobs } from './extension-sweep.js'
import { leaseHolds, newLeaseId, parseLeaseId, readQueueRow, warnMissingLease } from './extension-lease.js'

/**
 * Layanan antrean khusus Ekstensi Browser (`job_type = 'extension_apply'`).
 *
 * Menggantikan polling pasif: persetujuan untuk portal login (JobStreet, Glints, Kalibrr, Dealls)
 * atau situs non-worker masuk ke `automation_queue` bertipe `extension_apply` yang diabaikan worker.
 * Ekstensi mengklaim tugas miliknya lewat token scoped (`requireExtensionUser`), mengirim heartbeat tiap
 * ~30 detik, dan melepas bila batal; tugas `processing` dengan heartbeat > 5 menit dapat diklaim ulang.
 */

export const EXTENSION_QUEUE_JOB_TYPE = 'extension_apply'
export const EXTENSION_HEARTBEAT_INTERVAL_SEC = 30
export const EXTENSION_LEASE_STALE_MS = 5 * 60 * 1000
export const DEFAULT_RELEASE_DELAY_SEC = 15

export interface ClaimedExtensionJob {
  queueJobId: string
  /**
   * Kepemilikan tugas: UUID acak yang disimpan di `automation_queue.claimed_by`. Ekstensi mengirimnya kembali
   * pada heartbeat, release, dan report-run (`lease_id`). Sebelum migrasi kolom itu belum ada, nilainya tetap
   * dikirim tetapi tidak diperiksa.
   */
  lease_id: string
  approvalId: string
  jobId: string
  applicationId: string | null
  title: string
  company: string
  platform: string
  applyUrl: string | null
  channel: string
  coverLetter: string | null
  expiresAt: string
  attempt: number
  leaseSeconds: number
  heartbeatIntervalSeconds: number
}

export function isMissingQueueSchemaError(err: { code?: string; message?: string } | null | undefined): boolean {
  const code = err?.code
  if (code === '42703' || code === 'PGRST204' || code === '42883' || code === 'PGRST202' || code === '42P01' || code === 'PGRST205') {
    return true
  }
  const msg = String(err?.message ?? '')
  return /heartbeat_at|claimed_by|apply_channel|claim_extension_apply_job/i.test(msg)
}

function validQueueId(id: unknown): id is string {
  return isUuid(id)
}

function cleanReleaseError(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const text = raw.replace(/[\r\n\t]+/g, ' ').trim().slice(0, 240)
  return text || null
}

function lastHeartbeatMs(row: Record<string, any>): number {
  for (const col of ['heartbeat_at', 'processed_at', 'updated_at', 'created_at']) {
    const raw = row?.[col]
    if (typeof raw === 'string' && raw) {
      const t = Date.parse(raw)
      if (Number.isFinite(t)) return t
    }
  }
  return 0
}

/** Cek apakah persetujuan sudah terklaim di `approval_submit_claims` atau sedang dikerjakan worker (`job_type = 'apply'`). */
async function hasWorkerOrSubmitConflict(db: GuardDb, userId: string, approvalId: string): Promise<boolean> {
  const [claimRes, workerRes] = await Promise.all([
    db.from('approval_submit_claims').select('approval_request_id').eq('approval_request_id', approvalId).limit(1),
    db
      .from('automation_queue')
      .select('id')
      .eq('user_id', userId)
      .eq('job_type', 'apply')
      .in('status', ['pending', 'processing'])
      .eq('payload->>approval_request_id', approvalId)
      .limit(1),
  ])
  if (claimRes.error && !isMissingQueueSchemaError(claimRes.error)) {
    throw new ExtensionRunnerError(503, 'claim_unavailable', 'Status klaim persetujuan gagal diperiksa')
  }
  if (workerRes.error) {
    throw new ExtensionRunnerError(500, 'queue_lookup_failed', 'Gagal memeriksa antrean worker')
  }
  if (Array.isArray(claimRes.data) && claimRes.data.length > 0) return true
  if (Array.isArray(workerRes.data) && workerRes.data.length > 0) return true
  return false
}

async function markQueueFailedSafe(db: GuardDb, userId: string, queueJobId: string, reason: string, now: Date) {
  try {
    await db
      .from('automation_queue')
      .update({
        status: 'failed',
        completed_at: now.toISOString(),
        error_message: reason.slice(0, 240),
      })
      .eq('id', queueJobId)
      .eq('user_id', userId)
  } catch {
    // Abaikan kegagalan cleanup baris yang rusak saat klaim melewati kandidat ini.
  }
}

async function updateClaimLeaseColumnsSafe(
  db: GuardDb,
  userId: string,
  queueJobId: string,
  prevStatus: string,
  prevProcessedAt: unknown,
  nextRetry: number,
  claimer: string,
  now: Date
): Promise<{ claimed: boolean }> {
  const iso = now.toISOString()
  const basePatch = {
    status: 'processing',
    processed_at: iso,
    retry_count: nextRetry,
  }
  const fullPatch = { ...basePatch, heartbeat_at: iso, claimed_by: claimer }

  const buildUpdate = (patch: Record<string, any>) => {
    let q = db
      .from('automation_queue')
      .update(patch)
      .eq('id', queueJobId)
      .eq('user_id', userId)
      .eq('job_type', EXTENSION_QUEUE_JOB_TYPE)
      .eq('status', prevStatus)
    if (prevStatus === 'processing' && typeof prevProcessedAt === 'string' && prevProcessedAt) {
      q = q.eq('processed_at', prevProcessedAt)
    }
    return q.select('*')
  }

  let res = await buildUpdate(fullPatch)
  if (res.error && isMissingQueueSchemaError(res.error)) {
    res = await buildUpdate(basePatch)
  }
  if (res.error) throw new ExtensionRunnerError(500, 'extension_claim_failed', res.error.message)
  return { claimed: Array.isArray(res.data) && res.data.length > 0 }
}

/**
 * Klaim satu pekerjaan `extension_apply` milik `userId`.
 * Prioritas: `pending` yang sudah jatuh tempo terlebih dahulu, lalu `processing` yang heartbeat-nya > 5 menit.
 * Menggunakan RPC SQL `claim_extension_apply_job` (`SKIP LOCKED`) bila sudah dimigrasi, atau fallback atomik di Node.
 */
export async function claimNextExtensionJob(
  db: GuardDb,
  userId: string,
  opts: { now?: Date; staleAfterMs?: number } = {}
): Promise<ClaimedExtensionJob | null> {
  const now = opts.now ?? new Date()
  const staleMs = Math.max(60_000, opts.staleAfterMs ?? EXTENSION_LEASE_STALE_MS)
  // Tiap klaim memakai lease baru; label `claimer` dari klien tidak lagi disimpan.
  const leaseId = newLeaseId()
  const claimer = leaseId

  // Sapu dulu tugas pengguna ini yang tak akan pernah selesai (jatah percobaan habis, persetujuan kedaluwarsa)
  // supaya tidak menggantung. Terbaik-upaya: gagal menyapu tidak boleh menggagalkan klaim.
  try {
    await sweepExtensionJobs(db, { userId, now, staleAfterMs: staleMs })
  } catch (err: any) {
    console.warn('[extension-queue] sapuan tugas ekstensi gagal:', String(err?.message ?? err))
  }

  for (let pass = 0; pass < 10; pass++) {
    let claimedRow: Record<string, any> | null = null

    if (typeof (db as any).rpc === 'function') {
      const rpcRes = await (db as any).rpc('claim_extension_apply_job', {
        p_user_id: userId,
        p_claimer: claimer.slice(0, 80),
        p_stale_after_seconds: Math.round(staleMs / 1000),
      })
      if (!rpcRes?.error) {
        const rows = Array.isArray(rpcRes?.data) ? rpcRes.data : rpcRes?.data ? [rpcRes.data] : []
        claimedRow = rows[0] ?? null
        if (!claimedRow) return null
      } else if (!isMissingQueueSchemaError(rpcRes.error)) {
        throw new ExtensionRunnerError(500, 'extension_claim_failed', rpcRes.error.message)
      }
    }

    if (!claimedRow) {
      const { data: candidates, error: listErr } = await db
        .from('automation_queue')
        .select('*')
        .eq('user_id', userId)
        .eq('job_type', EXTENSION_QUEUE_JOB_TYPE)
        .in('status', ['pending', 'processing'])
        .order('scheduled_at', { ascending: true })
        .limit(20)

      if (listErr) throw new ExtensionRunnerError(500, 'queue_lookup_failed', listErr.message)
      const list = Array.isArray(candidates) ? candidates : []
      if (list.length === 0) return null

      const nowMs = now.getTime()
      const cutoffMs = nowMs - staleMs

      // Pilih pending yang jatuh tempo; bila tidak ada, cari processing dengan heartbeat > 5 menit.
      let target: Record<string, any> | null = null
      const pendingReady = list
        .filter((r) => r.status === 'pending' && (!r.scheduled_at || Date.parse(r.scheduled_at) <= nowMs))
        .sort((a, b) => (Number(b.priority ?? 0) - Number(a.priority ?? 0)) || (Date.parse(a.scheduled_at ?? '') - Date.parse(b.scheduled_at ?? '')))

      if (pendingReady.length > 0) {
        target = pendingReady[0]
      } else {
        for (const row of list) {
          if (row.status !== 'processing') continue
          if (lastHeartbeatMs(row) >= cutoffMs) continue
          const retries = Number(row.retry_count ?? 0)
          const maxRetries = Number(row.max_retries ?? 3)
          if (retries >= maxRetries) {
            await markQueueFailedSafe(db, userId, String(row.id), 'extension heartbeat timeout after max retries', now)
            continue
          }
          target = row
          break
        }
      }

      if (!target) return null
      const nextRetry = target.status === 'processing' ? Number(target.retry_count ?? 0) + 1 : Number(target.retry_count ?? 0)
      const { claimed } = await updateClaimLeaseColumnsSafe(
        db,
        userId,
        String(target.id),
        String(target.status),
        target.processed_at,
        nextRetry,
        claimer,
        now
      )
      if (!claimed) continue
      claimedRow = { ...target, status: 'processing', retry_count: nextRetry }
    }

    const approvalId = typeof claimedRow?.payload?.approval_request_id === 'string' ? claimedRow.payload.approval_request_id : ''
    const payloadJobId = typeof claimedRow?.payload?.job_id === 'string' ? claimedRow.payload.job_id : ''
    if (!approvalId) {
      await markQueueFailedSafe(db, userId, String(claimedRow.id), 'missing approval_request_id', now)
      continue
    }

    const approvalCheck = await verifyExtensionApproval(db, { userId, approvalId, jobId: payloadJobId || undefined, now })
    if ('code' in approvalCheck) {
      await markQueueFailedSafe(db, userId, String(claimedRow.id), approvalCheck.code, now)
      continue
    }
    if (await hasWorkerOrSubmitConflict(db, userId, approvalId)) {
      await markQueueFailedSafe(db, userId, String(claimedRow.id), 'approval_conflict_with_worker_or_claim', now)
      continue
    }

    const jobId = String(approvalCheck.row.job_id ?? payloadJobId)
    const { data: jobRow, error: jobErr } = await db
      .from('jobs')
      .select('id, title, company, platform_source, external_url, description')
      .eq('id', jobId)
      .maybeSingle()
    if (jobErr) throw new ExtensionRunnerError(500, 'jobs_lookup_failed', 'Gagal membaca data lowongan')

    const classified = classifyJobChannel(jobRow ?? {})
    if (classified.manualOnly) {
      await markQueueFailedSafe(db, userId, String(claimedRow.id), 'linkedin_manual_only', now)
      continue
    }

    return {
      queueJobId: String(claimedRow.id),
      lease_id: leaseId,
      approvalId,
      jobId,
      applicationId: approvalCheck.row.application_id ?? null,
      title: String(jobRow?.title ?? approvalCheck.row.job_title ?? 'Lowongan'),
      company: String(jobRow?.company ?? approvalCheck.row.company ?? 'Perusahaan'),
      platform: classified.platform,
      applyUrl: classified.applyUrl,
      channel: classified.channel,
      coverLetter: typeof approvalCheck.row.cover_letter === 'string' ? approvalCheck.row.cover_letter : null,
      expiresAt: String(approvalCheck.row.expires_at),
      attempt: Number(claimedRow.retry_count ?? 0) + 1,
      leaseSeconds: Math.round(staleMs / 1000),
      heartbeatIntervalSeconds: EXTENSION_HEARTBEAT_INTERVAL_SEC,
    }
  }

  return null
}

/**
 * Perbarui heartbeat tugas `extension_apply` yang sedang `processing` milik pengguna.
 * `leaseId` (dari klaim) harus sama dengan `claimed_by` bila kolomnya ada; beda = 409 `lease_lost` (tugas sudah
 * direklaim ekstensi lain). Tanpa `leaseId` (ekstensi lama) diterima dan dicatat di log.
 */
export async function heartbeatExtensionJob(
  db: GuardDb,
  userId: string,
  queueJobId: string,
  now: Date = new Date(),
  leaseId?: unknown
): Promise<{ ok: true; queueJobId: string; heartbeatAt: string }> {
  if (!validQueueId(queueJobId)) {
    throw new ExtensionRunnerError(400, 'invalid_job_id', 'ID tugas antrean tidak valid')
  }
  const lease = parseLeaseId(leaseId)
  if (lease.kind === 'invalid') throw new ExtensionRunnerError(400, 'invalid_lease_id', 'lease_id tidak valid')
  if (lease.kind === 'absent') warnMissingLease('heartbeat')

  const iso = now.toISOString()
  const basePatch = { processed_at: iso }
  const fullPatch = { ...basePatch, heartbeat_at: iso }

  const runUpdate = (patch: Record<string, any>, withLeaseFilter: boolean) => {
    let q = db
      .from('automation_queue')
      .update(patch)
      .eq('id', queueJobId)
      .eq('user_id', userId)
      .eq('job_type', EXTENSION_QUEUE_JOB_TYPE)
      .eq('status', 'processing')
    // Syarat kepemilikan ikut di UPDATE: reklamasi di antara pembacaan dan penulisan tidak boleh tertimpa.
    if (withLeaseFilter && lease.kind === 'present') q = q.eq('claimed_by', lease.leaseId)
    return q.select('id, status')
  }

  let res = await runUpdate(fullPatch, true)
  if (res.error && isMissingQueueSchemaError(res.error)) {
    res = await runUpdate(basePatch, false)
  }
  if (res.error) throw new ExtensionRunnerError(500, 'heartbeat_failed', res.error.message)
  if (Array.isArray(res.data) && res.data.length > 0) {
    return { ok: true, queueJobId, heartbeatAt: iso }
  }

  let lookup: Awaited<ReturnType<typeof readQueueRow>>
  try {
    lookup = await readQueueRow(db, userId, queueJobId, 'id, job_type, status')
  } catch (err: any) {
    throw new ExtensionRunnerError(500, 'queue_lookup_failed', String(err?.message ?? 'queue lookup failed'))
  }
  const existing = lookup.row
  if (!existing || existing.job_type !== EXTENSION_QUEUE_JOB_TYPE) {
    throw new ExtensionRunnerError(404, 'job_not_found', 'Tugas antrean ekstensi tidak ditemukan')
  }
  if (existing.status === 'processing' && !leaseHolds(lease, existing, lookup.hasLeaseColumn)) {
    throw new ExtensionRunnerError(409, 'lease_lost', 'Tugas ini sudah direklaim ekstensi lain')
  }
  throw new ExtensionRunnerError(409, 'job_not_processing', `Tugas berstatus ${existing.status}, tidak menerima heartbeat`)
}

/**
 * Lepas kembali tugas `extension_apply` ke `pending` (atau `failed` bila terminal / batas coba habis).
 * `opts.leaseId` harus sama dengan `claimed_by` bila kolomnya ada, kalau tidak 409 `lease_lost`; claimed_by
 * dikosongkan saat dilepas. Tanpa `leaseId` (ekstensi lama) diterima dan dicatat di log.
 */
export async function releaseExtensionJob(
  db: GuardDb,
  userId: string,
  queueJobId: string,
  opts: { terminal?: boolean; error?: string; countRetry?: boolean; delaySeconds?: number; leaseId?: unknown } = {},
  now: Date = new Date()
): Promise<{ ok: true; queueJobId: string; status: 'pending' | 'failed'; retryCount: number }> {
  if (!validQueueId(queueJobId)) {
    throw new ExtensionRunnerError(400, 'invalid_job_id', 'ID tugas antrean tidak valid')
  }
  const lease = parseLeaseId(opts.leaseId)
  if (lease.kind === 'invalid') throw new ExtensionRunnerError(400, 'invalid_lease_id', 'lease_id tidak valid')
  if (lease.kind === 'absent') warnMissingLease('release')

  let lookup: Awaited<ReturnType<typeof readQueueRow>>
  try {
    lookup = await readQueueRow(db, userId, queueJobId)
  } catch (err: any) {
    throw new ExtensionRunnerError(500, 'queue_lookup_failed', String(err?.message ?? 'queue lookup failed'))
  }
  const existing = lookup.row

  if (!existing || existing.job_type !== EXTENSION_QUEUE_JOB_TYPE) {
    throw new ExtensionRunnerError(404, 'job_not_found', 'Tugas antrean ekstensi tidak ditemukan')
  }
  if (existing.status === 'completed' || existing.status === 'failed') {
    throw new ExtensionRunnerError(409, 'job_already_finished', `Tugas sudah berstatus ${existing.status}`)
  }
  if (!leaseHolds(lease, existing, lookup.hasLeaseColumn)) {
    throw new ExtensionRunnerError(409, 'lease_lost', 'Tugas ini sudah direklaim ekstensi lain')
  }

  const countRetry = opts.countRetry !== false
  const nextRetry = countRetry ? Number(existing.retry_count ?? 0) + 1 : Number(existing.retry_count ?? 0)
  const maxRetries = Number(existing.max_retries ?? 3)
  const nextStatus: 'pending' | 'failed' = opts.terminal || nextRetry >= maxRetries ? 'failed' : 'pending'
  const delaySec = Math.max(0, Math.min(Number(opts.delaySeconds ?? DEFAULT_RELEASE_DELAY_SEC) || 0, 900))
  const iso = now.toISOString()

  const basePatch: Record<string, any> = {
    status: nextStatus,
    retry_count: nextRetry,
    error_message: cleanReleaseError(opts.error),
    scheduled_at: nextStatus === 'pending' ? new Date(now.getTime() + delaySec * 1000).toISOString() : iso,
    ...(nextStatus === 'failed' ? { completed_at: iso } : { processed_at: null }),
  }
  const fullPatch = { ...basePatch, heartbeat_at: null, claimed_by: null }

  const runUpdate = (patch: Record<string, any>, withLeaseFilter: boolean) => {
    let q = db
      .from('automation_queue')
      .update(patch)
      .eq('id', queueJobId)
      .eq('user_id', userId)
      .eq('job_type', EXTENSION_QUEUE_JOB_TYPE)
      .eq('status', existing.status as string)
    if (withLeaseFilter && lease.kind === 'present') q = q.eq('claimed_by', lease.leaseId)
    return q.select('id, status')
  }

  let res = await runUpdate(fullPatch, lookup.hasLeaseColumn)
  if (res.error && isMissingQueueSchemaError(res.error)) {
    res = await runUpdate(basePatch, false)
  }
  if (res.error) throw new ExtensionRunnerError(500, 'release_failed', res.error.message)
  if (!Array.isArray(res.data) || res.data.length === 0) {
    throw new ExtensionRunnerError(409, 'release_conflict', 'Status tugas berubah sebelum dilepas')
  }
  return { ok: true, queueJobId, status: nextStatus, retryCount: nextRetry }
}
