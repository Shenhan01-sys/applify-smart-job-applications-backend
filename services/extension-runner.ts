import crypto from 'crypto'
import { classifyJobChannel, isLinkedInUrl, sanitizeHttpUrl } from './apply-channel.js'
import { cleanLine, isSecretLabel, sanitizePendingQuestions, sanitizeSecretSkips } from './extension-planner.js'
import { EXT_FILE_KINDS, type ExtFileKind } from './extension-file-targets.js'
import { pageMatchesJob } from './page-host.js'
import type { GuardDb } from './queue-guard.js'
import { DAILY_APPLY_LIMIT, COUNTED_ACTIONS, startOfUtcDay } from './rate-limit.service.js'
import { APPLICATION_STATUSES, notifyApplicationStatus, type ApplicationStatus } from './application-status.service.js'
import { notificationDispatcher } from './notification-dispatcher.service.js'
import { notificationsService } from './notifications.service.js'
import { runDetached, type AfterReply } from './after-reply.js'

/**
 * Penjaga & pelapor eksekusi Ekstensi Browser Applify (`pending-approvals`, `authorize-submit`, `report-run`).
 *
 * Aturan keras (sama ketatnya dengan `worker/src/lib/approval.ts` & `worker/src/lib/quota.ts`):
 *   1. Lowongan / URL LinkedIn ditolak (403 `linkedin_manual_only`).
 *   2. Satu baris `approval_requests` hanya sah untuk SATU kali pengiriman. Jaminannya atomik: `authorize-submit`
 *      menyisipkan satu baris ke `approval_submit_claims` (kunci utama = id persetujuan). Sisipan kedua gagal
 *      (409 `already_claimed`), baik dari tab lain, klik ganda, maupun worker. Tabel tidak ada atau galat lain
 *      pada sisipan: 503 `claim_unavailable` (fail closed). Pemeriksaan log `success` / `submit_unverified`
 *      tetap ada sebagai lapis kedua (`approval_already_used`).
 *   3. Sebelum klik Submit server memverifikasi status `'approved'`, masa berlaku, kesesuaian `job_id`, kuota
 *      harian UTC, dan kecocokan host halaman dengan lowongan (409 `page_mismatch`).
 *   4. Setelah submit sudah terjadi (`submitted` / `submit_unverified`) laporan SELALU dicatat. Kuota, masa
 *      berlaku, dan status persetujuan yang sekarang tidak lolos hanya ditandai di `details` (`late_*`).
 *      Kegagalan mencatat berarti pengguna bisa menekan Kirim lagi.
 *   5. Hasil yang berarti "tidak terkirim" (`incomplete`, `not_submitted`, `validation_error`, `cancelled`)
 *      melepas klaim milik run itu (approval + `runId` dari `authorize-submit` + channel `extension`) supaya
 *      persetujuan bisa dipakai lagi. `incomplete` tanpa `runId` (laporan tahap isi, sebelum otorisasi) tidak
 *      melepas apa pun. `submitted` dan `submit_unverified` mempertahankan klaim.
 *   6. Tangkapan layar bukti hanya diterima sebagai PNG sah (magic bytes `89 50 4E 47`) dan hanya ditulis ke
 *      bucket `agent-screenshots` di path `${userId}/ext-<runId>/{filled,after}.png`.
 *   7. Baris `application_logs` memakai kunci `details` yang sama dengan worker supaya layar bukti di frontend
 *      membaca hasil ekstensi seperti hasil worker.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const RUN_ID_RE = /^[A-Za-z0-9_-]{8,100}$/
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
export const MAX_SCREENSHOT_BYTES = 2_500_000
export const SCREENSHOT_BUCKET = 'agent-screenshots'
export const SIGNED_URL_TTL_SECONDS = 7 * 24 * 60 * 60
export const APPROVAL_CLAIM_TABLE = 'approval_submit_claims'
/**
 * Batas badan permintaan `report-run`: dua PNG 2,5 MB menjadi sekitar 6,7 MB base64. Bawaan Fastify (1 MiB)
 * membuat laporan kirim ditolak 413 sesudah klik Submit terjadi (temuan keamanan 3). Hanya rute ini yang diperbesar.
 */
export const REPORT_RUN_BODY_LIMIT = 8 * 1024 * 1024
export const MAX_FILLED_FIELDS = 40
const MAX_REMAINING_REQUIRED = 20

export type ExtensionRunOutcome =
  | 'ready'
  | 'incomplete'
  | 'awaiting_login'
  | 'submitted'
  | 'submit_unverified'
  | 'not_submitted'
  | 'validation_error'
  | 'cancelled'

/** Hasil yang berarti formulir benar-benar terkirim (atau mungkin terkirim). Log wajib tertulis. */
export const SENT_OUTCOMES: ReadonlySet<ExtensionRunOutcome> = new Set<ExtensionRunOutcome>(['submitted', 'submit_unverified'])
/**
 * Hasil yang berarti Submit tidak mengirim apa pun: klaim run ini dilepas. `incomplete` termasuk karena ekstensi
 * memakainya saat tombol Submit tidak ditemukan sesudah otorisasi (tidak ada yang diklik).
 */
export const RELEASE_OUTCOMES: ReadonlySet<ExtensionRunOutcome> = new Set<ExtensionRunOutcome>([
  'incomplete',
  'not_submitted',
  'validation_error',
  'cancelled',
])
const VALID_OUTCOMES: ReadonlySet<string> = new Set<ExtensionRunOutcome>([
  'ready',
  'incomplete',
  'awaiting_login',
  'submitted',
  'submit_unverified',
  'not_submitted',
  'validation_error',
  'cancelled',
])

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
  queueJobId?: string | null
  queueStatus?: string | null
}

export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v)
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** `runId` kiriman klien: kosong = server membuatkan; bentuk tidak sah = 400 (dipakai di path penyimpanan). */
function parseRunId(raw: unknown): string | null {
  if (raw == null || raw === '') return null
  if (typeof raw !== 'string' || !RUN_ID_RE.test(raw)) {
    throw new ExtensionRunnerError(400, 'invalid_run_id', 'runId harus 8-100 karakter huruf, angka, garis bawah, atau tanda hubung')
  }
  return raw
}

type ApprovalLookup =
  | { ok: true; row: Record<string, any> }
  | { ok: false; statusCode: number; code: string; error: string }

async function loadApprovalRow(db: GuardDb, userId: string, approvalId: string): Promise<ApprovalLookup> {
  if (!isUuid(approvalId)) {
    return { ok: false, statusCode: 400, code: 'invalid_approval_id', error: 'approvalId tidak valid' }
  }
  const { data: row, error } = await db
    .from('approval_requests')
    .select('id, user_id, job_id, application_id, status, expires_at, cover_letter, resume_url, job_title, company')
    .eq('id', approvalId)
    .eq('user_id', userId)
    .maybeSingle()

  if (error) {
    return { ok: false, statusCode: 500, code: 'approval_lookup_failed', error: 'Gagal memeriksa persetujuan' }
  }
  if (!row) {
    return { ok: false, statusCode: 404, code: 'approval_not_found', error: 'Persetujuan tidak ditemukan' }
  }
  return { ok: true, row }
}

export interface LateFlags {
  expired: boolean
  notApproved: boolean
}

/**
 * Verifikasi persetujuan + jaminan 1 approval = 1 submission (memeriksa `application_logs`).
 * `afterSend: true` dipakai saat melaporkan pengiriman yang SUDAH terjadi: status dan masa berlaku tidak lagi
 * menolak laporan, hanya dikembalikan sebagai `late`.
 */
export async function verifyExtensionApproval(
  db: GuardDb,
  args: { userId: string; approvalId: string; jobId?: string | null; now?: Date; afterSend?: boolean }
): Promise<
  | { ok: true; row: Record<string, any>; late: LateFlags }
  | { ok: false; statusCode: number; code: string; error: string }
> {
  const { userId, approvalId, jobId } = args
  const now = args.now ?? new Date()

  const found = await loadApprovalRow(db, userId, approvalId)
  if ('code' in found) return found
  const row = found.row

  const late: LateFlags = { expired: false, notApproved: false }
  if (row.status !== 'approved') {
    if (!args.afterSend) {
      return { ok: false, statusCode: 409, code: 'approval_not_approved', error: 'Persetujuan belum disetujui' }
    }
    late.notApproved = true
  }

  const expiresMs = row.expires_at ? new Date(row.expires_at).getTime() : NaN
  if (!Number.isFinite(expiresMs) || expiresMs <= now.getTime()) {
    if (!args.afterSend) {
      return { ok: false, statusCode: 410, code: 'approval_expired', error: 'Persetujuan sudah kedaluwarsa' }
    }
    late.expired = true
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

  return { ok: true, row, late }
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

/**
 * Persetujuan yang boleh dipakai ekstensi: `approved`, belum kedaluwarsa, bukan LinkedIn, belum dipakai kirim,
 * belum diklaim jalur lain (`approval_submit_claims`), dan tidak sedang dikerjakan worker (antrian `apply`
 * berstatus pending atau processing). Setiap pencarian pendukung gagal tertutup: galat = daftar tidak dikirim.
 */
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

  const approvalIds = approvals.map((a: any) => a.id).filter(Boolean)
  const jobIds = [...new Set(approvals.map((a: any) => a.job_id).filter(Boolean))]

  const [jobsRes, sentRes, claimRes, queueRes] = await Promise.all([
    jobIds.length
      ? db.from('jobs').select('id, title, company, platform_source, external_url, description').in('id', jobIds)
      : Promise.resolve({ data: [], error: null }),
    db
      .from('application_logs')
      .select('details')
      .eq('user_id', userId)
      .in('status', ['success', 'submit_unverified'])
      .in('details->>approval_request_id', approvalIds)
      .order('created_at', { ascending: false })
      .limit(200),
    db.from(APPROVAL_CLAIM_TABLE).select('approval_request_id').in('approval_request_id', approvalIds),
    db
      .from('automation_queue')
      .select('id, job_type, status, payload')
      .eq('user_id', userId)
      .in('job_type', ['apply', 'extension_apply'])
      .in('status', ['pending', 'processing'])
      .in('payload->>approval_request_id', approvalIds)
      .limit(100),
  ])

  if (jobsRes.error) throw new ExtensionRunnerError(500, 'jobs_lookup_failed', 'Gagal membaca data lowongan')
  if (sentRes.error) throw new ExtensionRunnerError(500, 'approval_usage_lookup_failed', 'Gagal memeriksa riwayat pengiriman persetujuan')
  if (claimRes.error) throw new ExtensionRunnerError(503, 'claim_unavailable', 'Penyimpanan klaim kirim belum siap')
  if (queueRes.error) throw new ExtensionRunnerError(500, 'queue_lookup_failed', 'Gagal memeriksa antrian worker')

  const blockedApprovalIds = new Set<string>()
  const extQueueByApproval = new Map<string, { id: string; status: string }>()
  for (const l of Array.isArray(sentRes.data) ? sentRes.data : []) {
    const id = l?.details?.approval_request_id
    if (typeof id === 'string') blockedApprovalIds.add(id)
  }
  for (const c of Array.isArray(claimRes.data) ? claimRes.data : []) {
    if (typeof c?.approval_request_id === 'string') blockedApprovalIds.add(c.approval_request_id)
  }
  for (const q of Array.isArray(queueRes.data) ? queueRes.data : []) {
    const id = q?.payload?.approval_request_id
    if (typeof id !== 'string') continue
    if (q?.job_type === 'apply') {
      blockedApprovalIds.add(id)
    } else if (q?.job_type === 'extension_apply' && !extQueueByApproval.has(id)) {
      extQueueByApproval.set(id, { id: String(q.id), status: String(q.status ?? 'pending') })
    }
  }

  const jobById = new Map<string, any>((Array.isArray(jobsRes.data) ? jobsRes.data : []).map((j: any) => [j.id, j]))
  const results: ExtensionApprovalSummary[] = []

  for (const a of approvals) {
    if (blockedApprovalIds.has(a.id)) continue
    const job = jobById.get(a.job_id) ?? {}
    const classified = classifyJobChannel(job)
    if (classified.manualOnly) continue
    const qInfo = extQueueByApproval.get(a.id)
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
      ...(qInfo ? { queueJobId: qInfo.id, queueStatus: qInfo.status } : {}),
    })
  }

  return results
}

/**
 * Klaim atomik satu kali pakai. Hanya satu pemanggil per persetujuan yang lolos; yang lain mendapat 409
 * `already_claimed`. Semua galat lain (termasuk tabel belum dimigrasi: 42P01 / PGRST205) menolak kirim, 503.
 */
export async function claimApprovalForSubmit(
  db: GuardDb,
  args: { approvalId: string; userId: string; runId: string }
): Promise<void> {
  let error: { code?: string; message?: string } | null = null
  try {
    const res = await db.from(APPROVAL_CLAIM_TABLE).insert({
      approval_request_id: args.approvalId,
      user_id: args.userId,
      channel: 'extension',
      run_id: args.runId,
    })
    error = res?.error ?? null
  } catch (err: any) {
    error = { code: 'exception', message: String(err?.message ?? err) }
  }
  if (!error) return
  if (error.code === '23505') {
    throw new ExtensionRunnerError(
      409,
      'already_claimed',
      'Persetujuan ini sedang dipakai atau sudah dipakai untuk mengirim lamaran (tab lain atau worker).'
    )
  }
  throw new ExtensionRunnerError(503, 'claim_unavailable', 'Klaim kirim tidak dapat dibuat. Pengiriman ditolak demi keamanan.')
}

/** Lepas klaim milik run ini setelah hasil "tidak terkirim". Tidak pernah melepas bila ada log kirim, atau klaim jalur lain. */
async function releaseApprovalClaim(db: GuardDb, userId: string, approvalId: string, runId: string): Promise<boolean> {
  try {
    const { data: used, error: usedErr } = await db
      .from('application_logs')
      .select('id')
      .eq('user_id', userId)
      .in('status', ['success', 'submit_unverified'])
      .contains('details', { approval_request_id: approvalId })
      .limit(1)
    if (usedErr || (Array.isArray(used) && used.length > 0)) return false

    const { data, error } = await db
      .from(APPROVAL_CLAIM_TABLE)
      .delete()
      .eq('approval_request_id', approvalId)
      .eq('user_id', userId)
      .eq('channel', 'extension')
      .eq('run_id', runId)
      .select('approval_request_id')
    return !error && Array.isArray(data) && data.length > 0
  } catch {
    return false
  }
}

export async function authorizeExtensionSubmit(
  db: GuardDb,
  userId: string,
  input: { approvalId: string; jobId: string; pageUrl: string; missingRequiredCount?: number; runId?: string | null },
  now: Date = new Date()
): Promise<{
  authorized: true
  approvalId: string
  jobId: string
  runId: string
  quota: { used: number; limit: number }
}> {
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
  const runId = parseRunId(input.runId) ?? crypto.randomUUID()

  const check = await verifyExtensionApproval(db, { userId, approvalId: input.approvalId, jobId: input.jobId, now })
  if ('code' in check) {
    throw new ExtensionRunnerError(check.statusCode, check.code, check.error)
  }

  // Halaman harus milik lowongan persetujuan ini (host sama, atau host ATS yang dikenal). Gagal baca = tolak.
  const { data: job, error: jobErr } = check.row.job_id
    ? await db
        .from('jobs')
        .select('id, platform_source, title, company, external_url, description')
        .eq('id', check.row.job_id)
        .maybeSingle()
    : { data: null, error: null }
  if (jobErr) throw new ExtensionRunnerError(500, 'jobs_lookup_failed', 'Gagal membaca data lowongan')
  if (job && classifyJobChannel(job).manualOnly) {
    throw new ExtensionRunnerError(403, 'linkedin_manual_only', 'Lowongan LinkedIn wajib dikirim manual (bukan via ekstensi).')
  }
  if (!pageMatchesJob(pageUrl, job).ok) {
    throw new ExtensionRunnerError(
      409,
      'page_mismatch',
      'Halaman aktif bukan halaman lamaran lowongan ini. Buka halaman lamaran lowongan yang disetujui, lalu coba lagi.'
    )
  }

  const quota = await checkExtensionDailyQuota(db, userId, now)
  if (!quota.allowed) {
    throw new ExtensionRunnerError(
      429,
      'daily_quota_exceeded',
      `Batas kiriman harian (${quota.used}/${quota.limit}) sudah penuh untuk paket ${quota.tier}.`
    )
  }

  // Pastikan tidak ada tugas worker `apply` yang sedang berjalan untuk persetujuan ini sebelum klaim.
  const { data: activeWorker, error: workerQueueErr } = await db
    .from('automation_queue')
    .select('id')
    .eq('user_id', userId)
    .eq('job_type', 'apply')
    .in('status', ['pending', 'processing'])
    .eq('payload->>approval_request_id', input.approvalId)
    .limit(1)
  if (workerQueueErr) throw new ExtensionRunnerError(500, 'queue_lookup_failed', 'Gagal memeriksa antrian worker')
  if (Array.isArray(activeWorker) && activeWorker.length > 0) {
    throw new ExtensionRunnerError(409, 'agent_working', 'Agen worker sedang mengerjakan persetujuan ini.')
  }

  // Terakhir, setelah semua pemeriksaan lain: klaim atomik. Hanya satu pemanggil yang boleh menekan Submit.
  await claimApprovalForSubmit(db, { approvalId: input.approvalId, userId, runId })

  return {
    authorized: true,
    approvalId: input.approvalId,
    jobId: input.jobId,
    runId,
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

/** Bentuk yang sama dengan `EvidenceRef` worker (`details.screenshots.filled|after`): jalur objek + tautan bertanda tangan. */
export interface EvidenceRef {
  path: string
  url: string | null
}

async function uploadEvidencePng(
  db: GuardDb & { storage?: any },
  userId: string,
  runId: string,
  name: 'filled' | 'after',
  buf: Buffer | null
): Promise<EvidenceRef | null> {
  if (!buf || !db.storage || typeof db.storage.from !== 'function') return null
  const objectPath = `${userId}/ext-${runId}/${name}.png`
  try {
    const bucket = db.storage.from(SCREENSHOT_BUCKET)
    const { error } = await bucket.upload(objectPath, buf, { contentType: 'image/png', upsert: true })
    if (error) return null
    let url: string | null = null
    try {
      const signed = typeof bucket.createSignedUrl === 'function' ? await bucket.createSignedUrl(objectPath, SIGNED_URL_TTL_SECONDS) : null
      url = !signed?.error && typeof signed?.data?.signedUrl === 'string' ? signed.data.signedUrl : null
    } catch {
      url = null
    }
    return { path: objectPath, url }
  } catch {
    return null
  }
}

const STATUS_RANK: Record<string, number> = Object.fromEntries(APPLICATION_STATUSES.map((s, i) => [s, i]))

// ---------------------------------------------------------------------------------------------------------
// Bentuk `details` yang sama dengan worker (`worker/src/handlers/apply.ts`, `lib/formFill.ts` FilledField).
// ---------------------------------------------------------------------------------------------------------

export type FilledFieldKind = 'text' | 'select' | 'check' | 'upload'
export interface FilledField {
  label: string
  kind: FilledFieldKind
  value?: string
}

const FILLED_KINDS = new Set<string>(['text', 'select', 'check', 'upload'])
const MAX_FILLED_VALUE = 80
const MAX_FILLED_LABEL = 120
/** Label kontrol yang menyimpan rahasia: nilainya tidak pernah dicatat (sama dengan `SECRET_LABEL` worker). */
const WORKER_SECRET_LABEL = /\b(?:password|passcode|passphrase|pass|kata\s*sandi|sandi|pin|otp|secret)\b/i
const fileNameOnly = (p: string): string => String(p ?? '').split(/[\\/]/).filter(Boolean).pop() ?? ''

/** `filledFields` kiriman ekstensi -> `details.filled_fields`: label dan nilai dipotong, tanpa nilai untuk rahasia dan centang. */
export function sanitizeFilledFields(raw: unknown): FilledField[] {
  if (!Array.isArray(raw)) return []
  const out: FilledField[] = []
  for (const item of raw) {
    if (out.length >= MAX_FILLED_FIELDS) break
    if (!isRecord(item)) continue
    const label = cleanLine(item.label, MAX_FILLED_LABEL) || '(tanpa label)'
    const kind = (typeof item.kind === 'string' && FILLED_KINDS.has(item.kind) ? item.kind : 'text') as FilledFieldKind
    const entry: FilledField = { label, kind }
    const rawValue = typeof item.value === 'number' && Number.isFinite(item.value) ? String(item.value) : item.value
    if (kind !== 'check' && typeof rawValue === 'string' && !WORKER_SECRET_LABEL.test(label) && !isSecretLabel(label)) {
      const v = cleanLine(kind === 'upload' ? fileNameOnly(rawValue) : rawValue, 4000)
      if (v) entry.value = v.length > MAX_FILLED_VALUE ? `${v.slice(0, MAX_FILLED_VALUE - 1).trimEnd()}…` : v
    }
    out.push(entry)
  }
  return out
}

function fieldsByKind(fields: FilledField[]): Record<FilledFieldKind, number> {
  const counts: Record<FilledFieldKind, number> = { text: 0, select: 0, check: 0, upload: 0 }
  for (const f of fields) counts[f.kind] += 1
  return counts
}

/** `filesAttached` kiriman ekstensi -> `details.documents_attached`: hanya empat jenis dikenal, nilainya boolean (nama berkas tidak disimpan). */
export function sanitizeFilesAttached(raw: unknown): Record<ExtFileKind, boolean> | null {
  const out: Record<ExtFileKind, boolean> = { resume: false, cover_letter: false, transcript: false, portfolio: false }
  if (Array.isArray(raw)) {
    for (const k of raw) if (typeof k === 'string' && (EXT_FILE_KINDS as readonly string[]).includes(k)) out[k as ExtFileKind] = true
    return out
  }
  if (!isRecord(raw)) return null
  for (const kind of EXT_FILE_KINDS) {
    const v = raw[kind]
    out[kind] = v === true || (typeof v === 'string' && v.trim() !== '')
  }
  return out
}

/** `remainingRequired`: daftar label (bentuk worker). Angka (kiriman lama) diganti label pertanyaan WAJIB yang diketahui. */
function sanitizeRemainingRequired(raw: unknown, questionLabels: string[]): string[] {
  const labels: string[] = []
  const push = (v: unknown) => {
    const label = cleanLine(v, 200)
    if (label && !labels.includes(label) && labels.length < MAX_REMAINING_REQUIRED) labels.push(label)
  }
  if (Array.isArray(raw)) {
    for (const item of raw) push(item)
  } else if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) {
    for (const label of questionLabels.slice(0, Math.floor(raw))) push(label)
  }
  return labels
}

const SUBMIT_VERDICT: Partial<Record<ExtensionRunOutcome, 'confirmed' | 'validation_error' | 'uncertain'>> = {
  submitted: 'confirmed',
  submit_unverified: 'uncertain',
  validation_error: 'validation_error',
}

const pathOnly = (u: unknown): string | null => {
  const safe = sanitizeHttpUrl(u)
  return safe ? new URL(safe).pathname : null
}

/**
 * `details.submit_check`. Putusan ditentukan oleh `outcome` (laporan yang saling bertentangan tidak dipercaya);
 * ekstensi hanya menambah bukti: frasa konfirmasi, jumlah pesan validasi, apakah tombol masih ada, URL berubah.
 */
function buildSubmitCheck(raw: unknown, outcome: ExtensionRunOutcome, pageUrl: string): Record<string, unknown> | null {
  const verdict = SUBMIT_VERDICT[outcome]
  if (!verdict) return null
  const rec = isRecord(raw) ? raw : {}
  const phrase = cleanLine(rec.confirmationPhrase, 160)
  const messages = typeof rec.validationMessages === 'number' && Number.isFinite(rec.validationMessages) ? Math.max(0, Math.min(999, Math.floor(rec.validationMessages))) : 0
  return {
    verdict,
    confirmation_phrase: phrase || null,
    validation_messages: messages,
    control_present: typeof rec.controlPresent === 'boolean' ? rec.controlPresent : null,
    url_changed: typeof rec.urlChanged === 'boolean' ? rec.urlChanged : false,
    before_path: pathOnly(rec.beforeUrl),
    after_path: pathOnly(rec.afterUrl) ?? pathOnly(pageUrl),
  }
}

function reasonFor(outcome: ExtensionRunOutcome, clientReason: unknown, filledCount: number): string | null {
  const given = typeof clientReason === 'string' && /^[a-z0-9_]{1,40}$/.test(clientReason) ? clientReason : null
  switch (outcome) {
    case 'awaiting_login':
      return 'awaiting_login'
    case 'validation_error':
      return 'validation_failed'
    case 'cancelled':
      return 'cancelled'
    case 'not_submitted':
      return given ?? 'not_submitted'
    case 'incomplete':
      return given ?? (filledCount === 0 ? 'no_fields_filled' : 'partly_filled')
    default:
      return null
  }
}

export const EXTENSION_AWAITING_LOGIN_MAX_MS = 15 * 60 * 1000

export interface ReportRunInput {
  approvalId: string
  jobId: string
  pageUrl: string
  outcome: ExtensionRunOutcome
  runId?: string | null
  queueJobId?: string | null
  awaitingUntil?: string | null
  loginUrl?: string | null
  reason?: string | null
  filledCount?: number
  filledFields?: unknown
  /** Berkas yang terpasang: `{ resume, cover_letter, transcript, portfolio }` (boolean), disimpan ke `details.documents_attached`. */
  filesAttached?: unknown
  /** Daftar label kolom wajib yang belum terisi (bentuk worker). Angka diterima sebagai kiriman lama. */
  remainingRequired?: number | unknown[]
  questions?: unknown[]
  submitCheck?: unknown
  filledScreenshot?: unknown
  afterScreenshot?: unknown
}

export interface ReportRunResult {
  ok: true
  runId: string
  logStatus: 'success' | 'submit_unverified' | 'ready' | 'incomplete' | 'awaiting_login'
  applicationStatus: ApplicationStatus | null
  screenshots: { filledPath: string | null; afterPath: string | null }
  /** true bila klaim `approval_submit_claims` milik run ini dihapus (hanya pada hasil "tidak terkirim" dengan `runId` yang cocok). */
  claimReleased: boolean
  /** Hanya bermakna pada `submitted` / `submit_unverified`: kuota atau masa berlaku sudah lewat saat laporan masuk. */
  lateQuotaExceeded: boolean
  lateExpired: boolean
}

/**
 * `afterReply` menjadwalkan notifikasi SESUDAH balasan HTTP terkirim (rute memberikannya). Tanpa itu, notifikasi
 * jalan terlepas dari alur ini (`runDetached`). Notifikasi tidak pernah ditunggu sebelum membalas.
 */
export async function reportExtensionRun(
  db: GuardDb & { storage?: any },
  userId: string,
  input: ReportRunInput,
  now: Date = new Date(),
  afterReply: AfterReply = runDetached
): Promise<ReportRunResult> {
  if (!VALID_OUTCOMES.has(input.outcome)) {
    throw new ExtensionRunnerError(400, 'invalid_outcome', 'Status hasil eksekusi ekstensi tidak valid')
  }
  const outcome = input.outcome
  const pageUrl = sanitizeHttpUrl(input.pageUrl)
  if (!pageUrl) throw new ExtensionRunnerError(400, 'invalid_url', 'URL tab aktif tidak valid')
  if (isLinkedInUrl(pageUrl)) {
    throw new ExtensionRunnerError(403, 'linkedin_manual_only', 'Ekstensi tidak diperbolehkan melapor aksi pada domain LinkedIn.')
  }
  const runId = parseRunId(input.runId) ?? crypto.randomUUID()
  const sent = SENT_OUTCOMES.has(outcome)

  // 1. Persetujuan. Setelah pengiriman terjadi, hanya yang mustahil dicatat yang menolak (tidak ada baris, lowongan lain,
  //    sudah ada log kirim). Kuota, masa berlaku, dan status hanya ditandai.
  let approvalRow: Record<string, any>
  let late: LateFlags = { expired: false, notApproved: false }
  if (sent) {
    const check = await verifyExtensionApproval(db, { userId, approvalId: input.approvalId, jobId: input.jobId, now, afterSend: true })
    if ('code' in check) throw new ExtensionRunnerError(check.statusCode, check.code, check.error)
    approvalRow = check.row
    late = check.late
  } else {
    const found = await loadApprovalRow(db, userId, input.approvalId)
    if ('code' in found) throw new ExtensionRunnerError(found.statusCode, found.code, found.error)
    if (input.jobId && found.row.job_id !== input.jobId) {
      throw new ExtensionRunnerError(409, 'approval_job_mismatch', 'Persetujuan ini untuk lowongan lain')
    }
    approvalRow = found.row
  }

  let lateQuotaExceeded = false
  if (sent) {
    try {
      lateQuotaExceeded = !(await checkExtensionDailyQuota(db, userId, now)).allowed
    } catch {
      // Kegagalan membaca kuota tidak boleh menghalangi pencatatan pengiriman yang sudah terjadi.
    }
  }

  // 2. Bukti. Pada hasil kirim, bukti yang tidak sah dibuang (ditandai), tidak pernah menggagalkan pencatatan.
  const decoded: Record<'filled' | 'after', Buffer | null> = { filled: null, after: null }
  let screenshotRejected: string | null = null
  for (const [name, raw] of [['filled', input.filledScreenshot], ['after', input.afterScreenshot]] as const) {
    try {
      decoded[name] = decodePngBase64(raw)
    } catch (err) {
      if (!sent || !(err instanceof ExtensionRunnerError)) throw err
      screenshotRejected = err.code
    }
  }
  const [filledRef, afterRef] = await Promise.all([
    uploadEvidencePng(db, userId, runId, 'filled', decoded.filled),
    uploadEvidencePng(db, userId, runId, 'after', decoded.after),
  ])

  let job: Record<string, any> | null = null
  try {
    const res = await db.from('jobs').select('id, title, company, platform_source').eq('id', approvalRow.job_id).maybeSingle()
    job = res?.data ?? null
  } catch {
    job = null
  }

  // 3. Baris log dengan kunci `details` worker.
  const logStatus: ReportRunResult['logStatus'] =
    outcome === 'submitted'
      ? 'success'
      : outcome === 'submit_unverified'
        ? 'submit_unverified'
        : outcome === 'ready'
          ? 'ready'
          : outcome === 'awaiting_login'
            ? 'awaiting_login'
            : 'incomplete'

  const awaitingLogin = outcome === 'awaiting_login'
  const queueJobId = isUuid(input.queueJobId) ? input.queueJobId : null
  const awaitingUntilIso = (() => {
    if (!awaitingLogin) return null
    const maxAt = now.getTime() + EXTENSION_AWAITING_LOGIN_MAX_MS
    const raw = typeof input.awaitingUntil === 'string' ? Date.parse(input.awaitingUntil) : NaN
    const clamped = Number.isFinite(raw) && raw > now.getTime() ? Math.min(raw, maxAt) : maxAt
    return new Date(clamped).toISOString()
  })()
  const cleanLoginUrl = (() => {
    if (!awaitingLogin) return null
    const safe = sanitizeHttpUrl(input.loginUrl ?? pageUrl)
    if (!safe || isLinkedInUrl(safe)) return null
    const u = new URL(safe)
    return `${u.origin}${u.pathname}`
  })()

  const filledFields = awaitingLogin ? [] : sanitizeFilledFields(input.filledFields)
  const questions = sent || awaitingLogin ? [] : sanitizePendingQuestions(input.questions)
  // Kontrol rahasia dicatat terpisah (label saja): `details.questions` hanya berisi yang bisa dijawab di Applify.
  const secretSkipped = sent || awaitingLogin ? [] : sanitizeSecretSkips(input.questions)
  const documentsAttached = awaitingLogin ? null : sanitizeFilesAttached(input.filesAttached)
  const rawCount = awaitingLogin ? 0 : Math.max(0, Math.floor(Number(input.filledCount ?? 0) || 0))
  const filledCount = Math.max(rawCount, filledFields.length)
  const remaining = awaitingLogin
    ? []
    : sanitizeRemainingRequired(
        input.remainingRequired,
        [...questions, ...secretSkipped].filter((q) => q.required).map((q) => q.label)
      )
  const targetAppStatus: ApplicationStatus | null = awaitingLogin
    ? null
    : logStatus === 'success'
      ? 'submitted'
      : logStatus === 'ready' || logStatus === 'submit_unverified' || filledCount > 0
        ? 'ready'
        : null
  const finalUrlClean = (() => {
    const u = new URL(pageUrl)
    return `${u.origin}${u.pathname}`
  })()

  const details: Record<string, any> = {
    channel: 'extension',
    run_id: runId,
    ...(queueJobId ? { queue_job_id: queueJobId } : {}),
    reason: reasonFor(outcome, input.reason, filledCount),
    application_status: targetAppStatus ?? 'unchanged',
    approval_request_id: input.approvalId,
    fields_filled: filledCount,
    fields_by_kind: fieldsByKind(filledFields),
    filled_fields: filledFields,
    remaining_required: remaining,
    ...(awaitingUntilIso ? { awaiting_until: awaitingUntilIso } : {}),
    ...(cleanLoginUrl ? { login_url: cleanLoginUrl } : {}),
    ...(questions.length > 0 ? { questions, questions_pending: questions.length } : {}),
    ...(secretSkipped.length > 0 ? { secret_skipped: secretSkipped.map((q) => ({ key: q.key, label: q.label, required: q.required })) } : {}),
    ...(documentsAttached ? { documents_attached: documentsAttached } : {}),
    submit_clicked: sent || outcome === 'validation_error',
    submit_check: buildSubmitCheck(input.submitCheck, outcome, pageUrl),
    screenshots: { filled: filledRef, after: afterRef },
    final_url: finalUrlClean,
    ...(sent
      ? { late_quota_exceeded: lateQuotaExceeded, late_expired: late.expired, ...(late.notApproved ? { late_not_approved: true } : {}) }
      : {}),
    ...(screenshotRejected ? { screenshot_rejected: screenshotRejected } : {}),
  }

  const { error: logErr } = await db.from('application_logs').insert({
    user_id: userId,
    job_id: String(approvalRow.job_id),
    job_title: job?.title ?? approvalRow.job_title ?? null,
    company: job?.company ?? approvalRow.company ?? null,
    action: 'apply',
    platform: String(job?.platform_source ?? 'web'),
    status: logStatus,
    details,
  })
  if (logErr) throw new ExtensionRunnerError(500, 'log_insert_failed', `Gagal mencatat log ekstensi: ${logErr.message}`)

  // 4. Sesudah log tertulis tidak ada lagi yang boleh melempar: pada hasil kirim, status kartu hanya pelengkap.
  let updatedAppStatus: ApplicationStatus | null = null
  try {
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
            const applicationId = String(appRow.id)
            afterReply(() =>
              notifyApplicationStatus(db as any, notificationsService, { userId, applicationId }, { dispatcher: notificationDispatcher })
            )
          }
        } else {
          updatedAppStatus = appRow.status as ApplicationStatus
        }
      }
    }
  } catch {
    updatedAppStatus = null
  }

  const claimReleased = RELEASE_OUTCOMES.has(outcome) ? await releaseApprovalClaim(db, userId, input.approvalId, runId) : false

  // Perbarui antrean `extension_apply` terkait secara best-effort (tidak pernah menggagalkan log).
  try {
    const iso = now.toISOString()
    const baseQueuePatch = awaitingLogin
      ? { status: 'processing', processed_at: iso, updated_at: iso }
      : { status: 'completed', completed_at: iso, error_message: null, updated_at: iso }
    const fullQueuePatch = awaitingLogin
      ? { ...baseQueuePatch, heartbeat_at: iso }
      : { ...baseQueuePatch, heartbeat_at: null }

    const runQueueUpdate = (patch: Record<string, any>) => {
      let q = db.from('automation_queue').update(patch).eq('user_id', userId).eq('job_type', 'extension_apply')
      q = queueJobId ? q.eq('id', queueJobId) : q.eq('payload->>approval_request_id', input.approvalId).in('status', ['pending', 'processing'])
      return q
    }

    let qRes = await runQueueUpdate(fullQueuePatch)
    if (
      qRes?.error &&
      (qRes.error.code === '42703' || qRes.error.code === 'PGRST204' || /heartbeat_at/i.test(String(qRes.error.message ?? '')))
    ) {
      await runQueueUpdate(baseQueuePatch)
    }
  } catch {
    // Abaikan kegagalan sinkronisasi baris antrean sesudah log hasil tersimpan aman.
  }

  return {
    ok: true,
    runId,
    logStatus,
    applicationStatus: updatedAppStatus,
    screenshots: { filledPath: filledRef?.path ?? null, afterPath: afterRef?.path ?? null },
    claimReleased,
    lateQuotaExceeded,
    lateExpired: late.expired,
  }
}

export const EXTENSION_REVOCATION_TABLE = 'user_extension_revocations'

const isMissingTable = (err: { code?: string } | null | undefined): boolean =>
  err?.code === '42P01' || err?.code === 'PGRST205'

let warnedMissingRevocationTable = false

/** Baca versi token minimum pengguna (bawaan 1 bila tabel belum dimigrasi agar rollout tetap mulus). */
export async function getUserMinTokenVersion(db: GuardDb, userId: string): Promise<number> {
  try {
    const { data, error } = await db
      .from(EXTENSION_REVOCATION_TABLE)
      .select('min_token_version')
      .eq('user_id', userId)
      .maybeSingle()
    if (error) {
      if (isMissingTable(error)) {
        if (!warnedMissingRevocationTable) {
          warnedMissingRevocationTable = true
          console.warn('[extension-token] tabel user_extension_revocations belum dimigrasi; memakai versi minimum 1')
        }
        return 1
      }
      throw new ExtensionRunnerError(503, 'revocation_check_failed', 'Gagal memeriksa status pencabutan token ekstensi')
    }
    const ver = Number(data?.min_token_version ?? 1)
    return Number.isInteger(ver) && ver >= 1 ? ver : 1
  } catch (err) {
    if (err instanceof ExtensionRunnerError) throw err
    throw new ExtensionRunnerError(503, 'revocation_check_failed', 'Gagal memeriksa status pencabutan token ekstensi')
  }
}

/** Cabut seluruh token ekstensi lama milik pengguna dengan menaikkan `min_token_version` (+1). */
export async function revokeAllExtensionTokens(
  db: GuardDb,
  userId: string,
  now: Date = new Date()
): Promise<{ revoked: true; minTokenVersion: number }> {
  const current = await (async () => {
    const { data, error } = await db
      .from(EXTENSION_REVOCATION_TABLE)
      .select('min_token_version')
      .eq('user_id', userId)
      .maybeSingle()
    if (error) {
      if (isMissingTable(error)) {
        throw new ExtensionRunnerError(503, 'revocation_unavailable', 'Tabel pencabutan token belum dimigrasi di database')
      }
      throw new ExtensionRunnerError(500, 'revocation_lookup_failed', 'Gagal membaca versi token pengguna')
    }
    const v = Number(data?.min_token_version ?? 1)
    return Number.isInteger(v) && v >= 1 ? v : 1
  })()

  const nextVersion = current + 1
  const tableApi = db.from(EXTENSION_REVOCATION_TABLE)
  const writeRes =
    typeof tableApi.upsert === 'function'
      ? await tableApi.upsert({ user_id: userId, min_token_version: nextVersion, updated_at: now.toISOString() }, { onConflict: 'user_id' })
      : await (async () => {
          const { data: existing } = await db.from(EXTENSION_REVOCATION_TABLE).select('user_id').eq('user_id', userId).maybeSingle()
          return existing
            ? db.from(EXTENSION_REVOCATION_TABLE).update({ min_token_version: nextVersion, updated_at: now.toISOString() }).eq('user_id', userId)
            : db.from(EXTENSION_REVOCATION_TABLE).insert({ user_id: userId, min_token_version: nextVersion, updated_at: now.toISOString() })
        })()

  if (writeRes?.error) {
    if (isMissingTable(writeRes.error)) {
      throw new ExtensionRunnerError(503, 'revocation_unavailable', 'Tabel pencabutan token belum dimigrasi di database')
    }
    throw new ExtensionRunnerError(500, 'revocation_update_failed', 'Gagal memperbarui versi pencabutan token')
  }

  return { revoked: true, minTokenVersion: nextVersion }
}
