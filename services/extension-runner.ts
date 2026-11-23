import crypto from 'crypto'
import { classifyJobChannel, isLinkedInUrl, sanitizeHttpUrl } from './apply-channel.js'
import type { GuardDb } from './queue-guard.js'
import { DAILY_APPLY_LIMIT, COUNTED_ACTIONS, startOfUtcDay } from './rate-limit.service.js'
import { APPLICATION_STATUSES, notifyApplicationStatus, type ApplicationStatus } from './application-status.service.js'
import { notificationsService } from './notifications.service.js'

/**
 * Penjaga & pelapor eksekusi Ekstensi Browser Applify (`pending-approvals`, `authorize-submit`, `report-run`).
 *
 * Aturan keras (sama ketatnya dengan `worker/src/lib/approval.ts` & `worker/src/lib/quota.ts`):
 *   1. Lowongan / URL LinkedIn ditolak (403 `linkedin_manual_only`).
 *   2. Satu baris `approval_requests` hanya sah untuk SATU kali pengiriman (`success` / `submit_unverified`).
 *   3. Sebelum klik Submit maupun saat melapor `submitted` / `submit_unverified`, server memverifikasi
 *      status `'approved'`, masa berlaku, kesesuaian `job_id`, dan kuota harian UTC.
 *   4. Tangkapan layar bukti hanya diterima sebagai PNG sah (magic bytes `89 50 4E 47`) dan hanya ditulis ke
 *      bucket `agent-screenshots` di path `${userId}/ext-<runId>/{filled,after}.png`.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
export const MAX_SCREENSHOT_BYTES = 2_500_000
export const SCREENSHOT_BUCKET = 'agent-screenshots'

export type ExtensionRunOutcome = 'ready' | 'incomplete' | 'submitted' | 'submit_unverified'

export class ExtensionRunnerError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string
  ) {
    super(message)
  }
}

export interface ExtensionApprovalSummary {
  approvalId: string
  jobId: string
  applicationId: string | null
  title: string
  company: string
  platform: string
  applyUrl: string | null
  channel: string
  manualOnly: boolean
  extensionSupported: boolean
  reason: string
  coverLetter: string | null
  expiresAt: string
}

const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v)

/**
 * Verifikasi persetujuan + jaminan 1 approval = 1 submission (memeriksa `application_logs`).
 */
export async function verifyExtensionApproval(
  db: GuardDb,
  args: { userId: string; approvalId: string; jobId?: string | null; now?: Date }
): Promise<{ ok: true; row: Record<string, any> } | { ok: false; statusCode: number; code: string; error: string }> {
  const { userId, approvalId, jobId } = args
  const now = args.now ?? new Date()
  if (!isUuid(approvalId)) {
    return { ok: false, statusCode: 400, code: 'invalid_approval_id', error: 'approvalId tidak valid' }
  }

  const { data: row, error } = await db
    .from('approval_requests')
    .select('id, user_id, job_id, application_id, status, expires_at, cover_letter, resume_url')
    .eq('id', approvalId)
    .eq('user_id', userId)
    .maybeSingle()

  if (error) {
    return { ok: false, statusCode: 500, code: 'approval_lookup_failed', error: 'Gagal memeriksa persetujuan' }
  }
  if (!row) {
    return { ok: false, statusCode: 404, code: 'approval_not_found', error: 'Persetujuan tidak ditemukan' }
  }
  if (row.status !== 'approved') {
    return { ok: false, statusCode: 409, code: 'approval_not_approved', error: 'Persetujuan belum disetujui' }
  }

  const expiresMs = row.expires_at ? new Date(row.expires_at).getTime() : NaN
  if (!Number.isFinite(expiresMs) || expiresMs <= now.getTime()) {
    return { ok: false, statusCode: 410, code: 'approval_expired', error: 'Persetujuan sudah kedaluwarsa' }
  }

  if (jobId && row.job_id !== jobId) {
    return { ok: false, statusCode: 409, code: 'approval_job_mismatch', error: 'Persetujuan ini untuk lowongan lain' }
  }

  const { data: used, error: usedErr } = await db
    .from('application_logs')
    .select('id')
    .eq('user_id', userId)
    .in('status', ['success', 'submit_unverified'])
    .contains('details', { approval_request_id: approvalId })
    .limit(1)

  if (usedErr) {
    return { ok: false, statusCode: 500, code: 'approval_usage_lookup_failed', error: 'Gagal memeriksa riwayat pengiriman persetujuan' }
  }
  if (Array.isArray(used) && used.length > 0) {
    return { ok: false, statusCode: 409, code: 'approval_already_used', error: 'Persetujuan ini sudah pernah dipakai untuk mengirim lamaran.' }
  }

  return { ok: true, row }
}

/** Fail-closed daily UTC quota check (matching `worker/src/lib/quota.ts`). */
export async function checkExtensionDailyQuota(
  db: GuardDb,
  userId: string,
  now: Date = new Date()
): Promise<{ allowed: boolean; used: number; limit: number; tier: 'free' | 'pro' }> {
  const { data: sub } = await db.from('subscriptions').select('ai_model_tier').eq('user_id', userId).maybeSingle()
  const tier: 'free' | 'pro' = sub?.ai_model_tier === 'pro' ? 'pro' : 'free'
  const limit = DAILY_APPLY_LIMIT[tier]
  const dayStart = startOfUtcDay(now)

  const { count, error } = await db
    .from('application_logs')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', userId)
    .in('action', [...COUNTED_ACTIONS])
    .eq('status', 'success')
    .gte('created_at', dayStart.toISOString())

  if (error) {
    throw new ExtensionRunnerError(503, 'quota_check_failed', 'Gagal memeriksa kuota harian')
  }

  const used = count ?? 0
  return { allowed: used < limit, used, limit, tier }
}

export async function listPendingExtensionApprovals(
  db: GuardDb,
  userId: string,
  now: Date = new Date()
): Promise<ExtensionApprovalSummary[]> {
  const { data: approvals, error } = await db
    .from('approval_requests')
    .select('id, job_id, application_id, status, expires_at, cover_letter')
    .eq('user_id', userId)
    .eq('status', 'approved')
    .gt('expires_at', now.toISOString())
    .order('reviewed_at', { ascending: false })
    .limit(30)

  if (error) throw new ExtensionRunnerError(500, 'approvals_lookup_failed', error.message)
  if (!Array.isArray(approvals) || approvals.length === 0) return []

  const jobIds = [...new Set(approvals.map((a: any) => a.job_id).filter(Boolean))]
  const [{ data: jobs }, { data: sentLogs }] = await Promise.all([
    jobIds.length
      ? db.from('jobs').select('id, title, company, platform, external_url, description').in('id', jobIds)
      : Promise.resolve({ data: [] }),
    db
      .from('application_logs')
      .select('details')
      .eq('user_id', userId)
      .in('status', ['success', 'submit_unverified'])
      .limit(200),
  ])

  const usedApprovalIds = new Set<string>()
  for (const l of Array.isArray(sentLogs) ? sentLogs : []) {
    const id = l?.details?.approval_request_id
    if (typeof id === 'string') usedApprovalIds.add(id)
  }

  const jobById = new Map<string, any>((Array.isArray(jobs) ? jobs : []).map((j: any) => [j.id, j]))
  const results: ExtensionApprovalSummary[] = []

  for (const a of approvals) {
    if (usedApprovalIds.has(a.id)) continue
    const job = jobById.get(a.job_id) ?? {}
    const classified = classifyJobChannel(job)
    if (classified.manualOnly) continue
    results.push({
      approvalId: a.id,
      jobId: a.job_id,
      applicationId: a.application_id ?? null,
      title: String(job.title ?? 'Lowongan'),
      company: String(job.company ?? 'Perusahaan'),
      platform: classified.platform,
      applyUrl: classified.applyUrl,
      channel: classified.channel,
      manualOnly: classified.manualOnly,
      extensionSupported: classified.extensionSupported,
      reason: classified.reason,
      coverLetter: typeof a.cover_letter === 'string' ? a.cover_letter : null,
      expiresAt: a.expires_at,
    })
  }

  return results
}

export async function authorizeExtensionSubmit(
  db: GuardDb,
  userId: string,
  input: { approvalId: string; jobId: string; pageUrl: string; missingRequiredCount?: number },
  now: Date = new Date()
): Promise<{ authorized: true; approvalId: string; jobId: string; quota: { used: number; limit: number } }> {
  const pageUrl = sanitizeHttpUrl(input.pageUrl)
  if (!pageUrl) {
    throw new ExtensionRunnerError(400, 'invalid_url', 'URL tab aktif tidak valid')
  }
  if (isLinkedInUrl(pageUrl)) {
    throw new ExtensionRunnerError(403, 'linkedin_manual_only', 'Lowongan LinkedIn wajib dikirim manual (bukan via ekstensi).')
  }
  if ((input.missingRequiredCount ?? 0) > 0) {
    throw new ExtensionRunnerError(409, 'missing_required_fields', 'Masih ada kolom wajib yang belum terisi sebelum mengirim.')
  }

  const check = await verifyExtensionApproval(db, { userId, approvalId: input.approvalId, jobId: input.jobId, now })
  if ('code' in check) {
    throw new ExtensionRunnerError(check.statusCode, check.code, check.error)
  }

  const quota = await checkExtensionDailyQuota(db, userId, now)
  if (!quota.allowed) {
    throw new ExtensionRunnerError(
      429,
      'daily_quota_exceeded',
      `Batas kiriman harian (${quota.used}/${quota.limit}) sudah penuh untuk paket ${quota.tier}.`
    )
  }

  return {
    authorized: true,
    approvalId: input.approvalId,
    jobId: input.jobId,
    quota: { used: quota.used, limit: quota.limit },
  }
}

export function decodePngBase64(raw: unknown): Buffer | null {
  if (raw == null || raw === '') return null
  if (typeof raw !== 'string') throw new ExtensionRunnerError(400, 'invalid_screenshot', 'Format tangkapan layar tidak valid')
  const stripped = raw.startsWith('data:image/png;base64,') ? raw.slice('data:image/png;base64,'.length) : raw
  if (stripped.length > MAX_SCREENSHOT_BYTES * 1.4) {
    throw new ExtensionRunnerError(400, 'screenshot_too_large', 'Ukuran tangkapan layar terlalu besar')
  }
  const buf = Buffer.from(stripped, 'base64')
  if (buf.length < PNG_MAGIC.length || !buf.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC)) {
    throw new ExtensionRunnerError(400, 'invalid_screenshot_png', 'Bukti gambar harus berupa PNG asli')
  }
  if (buf.length > MAX_SCREENSHOT_BYTES) {
    throw new ExtensionRunnerError(400, 'screenshot_too_large', 'Ukuran gambar melebihi batas 2.5 MB')
  }
  return buf
}

async function uploadEvidencePng(
  db: GuardDb & { storage?: any },
  userId: string,
  runId: string,
  name: 'filled' | 'after',
  buf: Buffer | null
): Promise<string | null> {
  if (!buf || !db.storage || typeof db.storage.from !== 'function') return null
  const objectPath = `${userId}/ext-${runId}/${name}.png`
  const { error } = await db.storage.from(SCREENSHOT_BUCKET).upload(objectPath, buf, {
    contentType: 'image/png',
    upsert: true,
  })
  return error ? null : objectPath
}

const VALID_OUTCOMES = new Set<ExtensionRunOutcome>(['ready', 'incomplete', 'submitted', 'submit_unverified'])
const STATUS_RANK: Record<string, number> = Object.fromEntries(APPLICATION_STATUSES.map((s, i) => [s, i]))

export async function reportExtensionRun(
  db: GuardDb & { storage?: any },
  userId: string,
  input: {
    approvalId: string
    jobId: string
    pageUrl: string
    outcome: ExtensionRunOutcome
    reason?: string | null
    filledCount?: number
    remainingRequired?: number
    questions?: unknown[]
    filledScreenshot?: unknown
    afterScreenshot?: unknown
  },
  now: Date = new Date()
): Promise<{
  ok: true
  logStatus: 'success' | 'submit_unverified' | 'ready' | 'incomplete'
  applicationStatus: ApplicationStatus | null
  screenshots: { filledPath: string | null; afterPath: string | null }
}> {
  if (!VALID_OUTCOMES.has(input.outcome)) {
    throw new ExtensionRunnerError(400, 'invalid_outcome', 'Status hasil eksekusi ekstensi tidak valid')
  }
  const pageUrl = sanitizeHttpUrl(input.pageUrl)
  if (!pageUrl) throw new ExtensionRunnerError(400, 'invalid_url', 'URL tab aktif tidak valid')
  if (isLinkedInUrl(pageUrl)) {
    throw new ExtensionRunnerError(403, 'linkedin_manual_only', 'Ekstensi tidak diperbolehkan melapor aksi pada domain LinkedIn.')
  }

  let approvalRow: Record<string, any> | null = null
  if (input.outcome === 'submitted' || input.outcome === 'submit_unverified') {
    const check = await verifyExtensionApproval(db, {
      userId,
      approvalId: input.approvalId,
      jobId: input.jobId,
      now,
    })
    if ('code' in check) throw new ExtensionRunnerError(check.statusCode, check.code, check.error)
    approvalRow = check.row
    if (input.outcome === 'submitted') {
      const quota = await checkExtensionDailyQuota(db, userId, now)
      if (!quota.allowed) {
        throw new ExtensionRunnerError(429, 'daily_quota_exceeded', `Batas kiriman harian (${quota.used}/${quota.limit}) sudah penuh.`)
      }
    }
  } else {
    const { data: row } = await db
      .from('approval_requests')
      .select('id, job_id, application_id')
      .eq('id', input.approvalId)
      .eq('user_id', userId)
      .maybeSingle()
    if (!row) throw new ExtensionRunnerError(404, 'approval_not_found', 'Persetujuan tidak ditemukan')
    if (input.jobId && row.job_id !== input.jobId) {
      throw new ExtensionRunnerError(409, 'approval_job_mismatch', 'Persetujuan ini untuk lowongan lain')
    }
    approvalRow = row
  }

  const filledBuf = decodePngBase64(input.filledScreenshot)
  const afterBuf = decodePngBase64(input.afterScreenshot)
  const runId = crypto.randomUUID()
  const [filledPath, afterPath] = await Promise.all([
    uploadEvidencePng(db, userId, runId, 'filled', filledBuf),
    uploadEvidencePng(db, userId, runId, 'after', afterBuf),
  ])

  const { data: job } = await db
    .from('jobs')
    .select('id, title, company, platform')
    .eq('id', approvalRow.job_id)
    .maybeSingle()

  const logStatus: 'success' | 'submit_unverified' | 'ready' | 'incomplete' =
    input.outcome === 'submitted'
      ? 'success'
      : input.outcome === 'submit_unverified'
        ? 'submit_unverified'
        : input.outcome === 'ready'
          ? 'ready'
          : 'incomplete'

  const questions = Array.isArray(input.questions) ? input.questions.slice(0, 20) : []
  const filledCount = Math.max(0, Math.floor(Number(input.filledCount ?? 0) || 0))
  const remainingRequired = Math.max(0, Math.floor(Number(input.remainingRequired ?? questions.length) || 0))
  const finalUrlClean = (() => {
    const u = new URL(pageUrl)
    return `${u.origin}${u.pathname}`
  })()

  const details: Record<string, any> = {
    channel: 'browser_extension',
    run_id: runId,
    approval_request_id: input.approvalId,
    filled: filledCount,
    remaining_required: remainingRequired,
    final_url: finalUrlClean,
    ...(input.reason ? { reason: String(input.reason).slice(0, 64) } : {}),
    ...(questions.length > 0 ? { questions } : {}),
    ...(filledPath || afterPath
      ? {
          screenshots: {
            ...(filledPath ? { filled: filledPath } : {}),
            ...(afterPath ? { after: afterPath } : {}),
          },
        }
      : {}),
  }

  const { error: logErr } = await db.from('application_logs').insert({
    user_id: userId,
    job_id: approvalRow.job_id,
    action: 'apply',
    platform: String(job?.platform ?? 'web'),
    status: logStatus,
    details,
  })
  if (logErr) throw new ExtensionRunnerError(500, 'log_insert_failed', `Gagal mencatat log ekstensi: ${logErr.message}`)

  let targetAppStatus: ApplicationStatus | null = null
  if (logStatus === 'success') {
    targetAppStatus = 'submitted'
  } else if (logStatus === 'ready' || (logStatus === 'incomplete' && filledCount > 0) || logStatus === 'submit_unverified') {
    targetAppStatus = 'ready'
  }

  let updatedAppStatus: ApplicationStatus | null = null
  if (targetAppStatus && approvalRow.application_id) {
    const { data: appRow } = await db
      .from('ai_applications')
      .select('id, status, submitted_at, follow_up_scheduled')
      .eq('id', approvalRow.application_id)
      .eq('user_id', userId)
      .maybeSingle()

    if (appRow) {
      const currRank = STATUS_RANK[String(appRow.status)] ?? 0
      const nextRank = STATUS_RANK[targetAppStatus] ?? 0
      if (nextRank > currRank) {
        const patch: Record<string, any> = { status: targetAppStatus }
        if (targetAppStatus === 'submitted') {
          patch.submitted_at = appRow.submitted_at ?? now.toISOString()
          patch.follow_up_scheduled = appRow.follow_up_scheduled ?? new Date(now.getTime() + 4 * 86400 * 1000).toISOString()
        }
        await db.from('ai_applications').update(patch).eq('id', appRow.id).eq('user_id', userId)
        updatedAppStatus = targetAppStatus

        if (targetAppStatus === 'submitted') {
          await notifyApplicationStatus(
            db as any,
            notificationsService,
            { userId, applicationId: appRow.id }
          ).catch(() => undefined)
        }
      } else {
        updatedAppStatus = appRow.status as ApplicationStatus
      }
    }
  }

  return {
    ok: true,
    logStatus,
    applicationStatus: updatedAppStatus,
    screenshots: { filledPath, afterPath },
  }
}
