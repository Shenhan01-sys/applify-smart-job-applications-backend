import crypto from 'crypto'
import type { GuardDb } from './queue-guard.js'
import { APPROVAL_CLAIM_TABLE } from './extension-runner.js'
import { APPROVAL_TTL_MS } from '../api/routes/approval.js'

/**
 * Penanganan klaim persetujuan yang macet (`approval_submit_claims`) — Catatan 16 section 4.4.
 *
 * Masalah: bila worker atau ekstensi crash/putus sesudah mengklaim `approval_submit_claims` sebelum sempat
 * menulis `application_logs`, baris persetujuan terkunci selamanya tanpa tanda yang jelas di UI.
 *
 * Prinsip keamanan mutlak:
 *   - JANGAN pernah menghapus klaim dari `approval_submit_claims` saat status pengiriman tidak pasti (tombol
 *     Submit mungkin sudah terklik di situs lowongan).
 *   - Sajikan status `locked_stuck` secara jujur beserta dua jalan pulih sadar sesudah pengguna memeriksa
 *     kotak masuk / portal lowongan:
 *       1) `mark_sent`: catat log `success` (`manual_recovery`) & majukan lamaran ke `submitted` (klaim tetap).
 *       2) `create_fresh_approval`: biarkan klaim lama tetap terkunci selamanya, catat log `incomplete`
 *          (`reason: abandoned_locked_claim`), dan buat `approval_requests` baru berstatus `pending`.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const EXTENSION_CLAIM_STALE_MS = 2 * 60 * 1000
export const MAX_CLAIM_STATUS_IDS = 50

export type ClaimStatusKind = 'none' | 'in_progress' | 'submitted' | 'locked_stuck'

export interface ClaimStatusInfo {
  approvalId: string
  state: ClaimStatusKind
  channel: 'worker' | 'extension' | null
  claimedAt: string | null
  queueJobId: string | null
  runId: string | null
}

export type ClaimResolution = 'mark_sent' | 'create_fresh_approval'

export class ClaimRecoveryError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string
  ) {
    super(message)
  }
}

export async function getClaimStatuses(
  db: GuardDb,
  userId: string,
  rawIds: unknown,
  now: Date = new Date()
): Promise<Record<string, ClaimStatusInfo>> {
  const ids = (Array.isArray(rawIds) ? rawIds : [])
    .filter((id): id is string => typeof id === 'string' && UUID_RE.test(id))
    .slice(0, MAX_CLAIM_STATUS_IDS)

  const out: Record<string, ClaimStatusInfo> = {}
  if (ids.length === 0) return out

  const [claimsRes, logsRes, queueRes] = await Promise.all([
    db.from(APPROVAL_CLAIM_TABLE).select('approval_request_id, channel, queue_job_id, run_id, created_at').eq('user_id', userId).in('approval_request_id', ids),
    db.from('application_logs').select('status, details').eq('user_id', userId).in('status', ['success', 'submit_unverified']).in('details->>approval_request_id', ids),
    db.from('automation_queue').select('id, status, payload').eq('user_id', userId).eq('job_type', 'apply').in('status', ['pending', 'processing']).in('payload->>approval_request_id', ids),
  ])

  if (claimsRes.error) {
    // Jika tabel klaim belum dimigrasi di DB tertentu, laporkan kosong tanpa melempar error ke UI riwayat.
    if (claimsRes.error.code === '42P01' || claimsRes.error.code === 'PGRST205') return out
    throw new ClaimRecoveryError(500, 'claims_lookup_failed', 'Gagal memeriksa status klaim pengiriman')
  }

  const submittedIds = new Set<string>()
  for (const row of Array.isArray(logsRes.data) ? logsRes.data : []) {
    const aid = row?.details?.approval_request_id
    if (typeof aid === 'string') submittedIds.add(aid)
  }

  const activeQueueIds = new Set<string>()
  for (const row of Array.isArray(queueRes.data) ? queueRes.data : []) {
    const aid = row?.payload?.approval_request_id
    if (typeof aid === 'string') activeQueueIds.add(aid)
  }

  const claimByApproval = new Map<string, any>()
  for (const c of Array.isArray(claimsRes.data) ? claimsRes.data : []) {
    if (typeof c?.approval_request_id === 'string') claimByApproval.set(c.approval_request_id, c)
  }

  for (const id of ids) {
    const claim = claimByApproval.get(id)
    if (!claim) {
      out[id] = { approvalId: id, state: 'none', channel: null, claimedAt: null, queueJobId: null, runId: null }
      continue
    }
    const channel = claim.channel === 'extension' ? 'extension' : 'worker'
    if (submittedIds.has(id)) {
      out[id] = {
        approvalId: id,
        state: 'submitted',
        channel,
        claimedAt: claim.created_at ?? null,
        queueJobId: claim.queue_job_id ?? null,
        runId: claim.run_id ?? null,
      }
      continue
    }

    const claimedMs = claim.created_at ? new Date(claim.created_at).getTime() : 0
    const staleExt = channel === 'extension' && (!Number.isFinite(claimedMs) || now.getTime() - claimedMs >= EXTENSION_CLAIM_STALE_MS)
    const workerStillRunning = channel === 'worker' && activeQueueIds.has(id)
    const isStuck = channel === 'worker' ? !workerStillRunning : staleExt

    out[id] = {
      approvalId: id,
      state: isStuck ? 'locked_stuck' : 'in_progress',
      channel,
      claimedAt: claim.created_at ?? null,
      queueJobId: claim.queue_job_id ?? null,
      runId: claim.run_id ?? null,
    }
  }

  return out
}

export async function resolveLockedClaim(
  db: GuardDb,
  userId: string,
  approvalId: string,
  resolution: ClaimResolution,
  now: Date = new Date()
): Promise<{ ok: true; resolution: ClaimResolution; newApprovalId: string | null }> {
  if (!UUID_RE.test(approvalId)) {
    throw new ClaimRecoveryError(400, 'invalid_approval_id', 'ID persetujuan tidak valid')
  }
  if (resolution !== 'mark_sent' && resolution !== 'create_fresh_approval') {
    throw new ClaimRecoveryError(400, 'invalid_resolution', 'Pilihan penyelesaian klaim tidak valid')
  }

  const { data: approval, error: appErr } = await db
    .from('approval_requests')
    .select('id, user_id, job_id, application_id, job_title, company, platform, cover_letter, answers, resume_url, status')
    .eq('id', approvalId)
    .eq('user_id', userId)
    .maybeSingle()

  if (appErr) throw new ClaimRecoveryError(500, 'approval_lookup_failed', 'Gagal membaca persetujuan')
  if (!approval) throw new ClaimRecoveryError(404, 'approval_not_found', 'Persetujuan tidak ditemukan')

  const { data: claim, error: claimErr } = await db
    .from(APPROVAL_CLAIM_TABLE)
    .select('approval_request_id, channel, queue_job_id, run_id')
    .eq('approval_request_id', approvalId)
    .eq('user_id', userId)
    .maybeSingle()

  if (claimErr) throw new ClaimRecoveryError(503, 'claim_unavailable', 'Tabel klaim persetujuan belum tersedia')
  if (!claim) throw new ClaimRecoveryError(409, 'claim_not_found', 'Persetujuan ini tidak sedang terkunci oleh klaim aktif')

  const { data: sent } = await db
    .from('application_logs')
    .select('id')
    .eq('user_id', userId)
    .in('status', ['success', 'submit_unverified'])
    .contains('details', { approval_request_id: approvalId })
    .limit(1)

  if (Array.isArray(sent) && sent.length > 0) {
    throw new ClaimRecoveryError(409, 'already_logged', 'Persetujuan ini sudah memiliki catatan pengiriman.')
  }

  if (resolution === 'mark_sent') {
    const { error: logErr } = await db.from('application_logs').insert({
      user_id: userId,
      job_id: approval.job_id,
      job_title: approval.job_title ?? null,
      company: approval.company ?? null,
      action: 'apply',
      platform: String(approval.platform ?? 'web'),
      status: 'success',
      details: {
        approval_request_id: approvalId,
        channel: 'manual_recovery',
        recovered_from_claim: true,
        previous_channel: claim.channel,
      },
    })
    if (logErr) throw new ClaimRecoveryError(500, 'log_insert_failed', 'Gagal menyimpan catatan terkirim manual')

    if (approval.application_id) {
      await db
        .from('ai_applications')
        .update({
          status: 'submitted',
          submitted_at: now.toISOString(),
          follow_up_scheduled: new Date(now.getTime() + 4 * 86400 * 1000).toISOString(),
        })
        .eq('id', approval.application_id)
        .eq('user_id', userId)
    }
    return { ok: true, resolution, newApprovalId: null }
  }

  // `create_fresh_approval`: KLAIM LAMA TIDAK PERNAH DIHAPUS. Log mencatat abandonment eksplisit dan
  // dibuatkan permintaan persetujuan baru berstatus `pending` agar pengguna memeriksa & menyetujui ulang secara sadar.
  await db.from('application_logs').insert({
    user_id: userId,
    job_id: approval.job_id,
    job_title: approval.job_title ?? null,
    company: approval.company ?? null,
    action: 'apply',
    platform: String(approval.platform ?? 'web'),
    status: 'incomplete',
    details: {
      approval_request_id: approvalId,
      reason: 'abandoned_locked_claim',
      previous_channel: claim.channel,
      queue_job_id: claim.queue_job_id ?? null,
      run_id: claim.run_id ?? null,
    },
  })

  const newId = crypto.randomUUID()
  const { data: insertedRows, error: insErr } = await db
    .from('approval_requests')
    .insert({
      id: newId,
      user_id: userId,
      job_id: approval.job_id,
      application_id: approval.application_id ?? null,
      job_title: approval.job_title,
      company: approval.company,
      platform: approval.platform,
      cover_letter: approval.cover_letter ?? null,
      answers: Array.isArray(approval.answers) ? approval.answers : [],
      resume_url: approval.resume_url ?? null,
      status: 'pending',
      expires_at: new Date(now.getTime() + APPROVAL_TTL_MS).toISOString(),
    })
    .select('id')

  const created = Array.isArray(insertedRows) ? insertedRows[0] : insertedRows
  if (insErr) {
    throw new ClaimRecoveryError(500, 'fresh_approval_failed', 'Gagal membuat permintaan persetujuan baru')
  }

  return { ok: true, resolution, newApprovalId: String(created?.id ?? newId) }
}
