/**
 * Izin memakai Ekstensi Browser untuk persetujuan yang jalurnya ekstensi.
 *
 * Lowongan di portal login atau ATS yang hanya bisa dibuka ekstensi tidak otomatis masuk antrean
 * `extension_apply`. Pengguna memberi izin per lamaran (POST /api/approvals/:id/extension-consent), atau sekali
 * untuk seterusnya (`extension_auto_use = true` di `user_automation_settings`). Jalur yang sama dipakai bila
 * worker sudah mencoba (`apply`) dan berhenti karena butuh login (`auth_required` / `external_redirect`):
 * lamaran belum terkirim, jadi pengguna boleh memindahkannya ke ekstensi.
 *
 * Kolom `extension_auto_use` baru ada setelah migrasi DRAFT_2026-11-24b. Sebelum itu nilainya dianggap false
 * dan penyimpanannya dilewati tanpa galat.
 */
import { resolveApplyChannel } from './apply-channel.js'
import { ApprovalChannelConflictError, clientErrorReply, type GuardDb } from './queue-guard.js'
import { fetchRerunFacts, MAX_RUNS_PER_APPROVAL, type RerunFacts } from './rerun-guard.js'
import { isMissingColumnError } from './automation-settings.js'

const SETTINGS_TABLE = 'user_automation_settings'
const AUTO_USE_COLUMN = 'extension_auto_use'

/** Pengguna sudah memilih "selalu pakai ekstensi". Galat apa pun, termasuk kolom belum ada, berarti false. */
export async function readExtensionAutoUse(db: GuardDb, userId: string): Promise<boolean> {
  try {
    const { data, error } = await db.from(SETTINGS_TABLE).select(AUTO_USE_COLUMN).eq('user_id', userId).maybeSingle()
    if (error) return false
    return data?.[AUTO_USE_COLUMN] === true
  } catch {
    return false
  }
}

/**
 * Simpan pilihan "selalu pakai ekstensi". Mengembalikan true bila tersimpan. Kolom belum ada (migrasi belum
 * dijalankan) atau galat lain: false, tidak pernah melempar, supaya izin per lamaran tetap berjalan.
 */
export async function saveExtensionAutoUse(db: GuardDb, userId: string, value: boolean): Promise<boolean> {
  try {
    const { data: existing, error: lookupErr } = await db.from(SETTINGS_TABLE).select('id').eq('user_id', userId).maybeSingle()
    if (lookupErr && lookupErr.code !== 'PGRST116') return false
    const res = existing
      ? await db.from(SETTINGS_TABLE).update({ [AUTO_USE_COLUMN]: value, updated_at: new Date().toISOString() }).eq('user_id', userId).select('id')
      : await db.from(SETTINGS_TABLE).insert({ user_id: userId, [AUTO_USE_COLUMN]: value }).select('id')
    if (res.error) return false
    return true
  } catch {
    return false
  }
}

export interface ExtensionConsentQueue {
  addApprovedExtensionApplyJob(userId: string, approvalId: string): Promise<{ id: string }>
}

export interface ExtensionConsentReply {
  status: number
  body: Record<string, unknown>
}

type Verdict = { ok: true } | { ok: false; status: 404 | 409 | 410 | 422 | 429; error: string; code: string }

/** Aturan pertama yang gagal menang. Persis syarat rerun, ditambah kode galat yang bisa dibaca klien. */
export function decideExtensionConsent(facts: RerunFacts): Verdict {
  const { approval, now, usedCount, activeCount, totalCount } = facts
  if (!approval) return { ok: false, status: 404, error: 'Persetujuan tidak ditemukan', code: 'approval_not_found' }
  if (approval.status !== 'approved') {
    return { ok: false, status: 409, error: 'Persetujuan belum disetujui atau sudah diproses', code: 'not_approved' }
  }
  const expires = approval.expires_at ? new Date(approval.expires_at).getTime() : NaN
  if (!Number.isFinite(expires) || expires <= now.getTime()) {
    return { ok: false, status: 410, error: 'Persetujuan sudah kedaluwarsa', code: 'approval_expired' }
  }
  if (!approval.job_id) {
    return { ok: false, status: 422, error: 'Persetujuan tidak memiliki lowongan', code: 'no_job' }
  }
  if (usedCount > 0) {
    return { ok: false, status: 409, error: 'Lamaran untuk persetujuan ini sudah terkirim', code: 'already_submitted' }
  }
  if (activeCount > 0) {
    return { ok: false, status: 409, error: 'Persetujuan ini sedang dikerjakan', code: 'already_active' }
  }
  if (totalCount >= MAX_RUNS_PER_APPROVAL) {
    return { ok: false, status: 429, error: 'Terlalu banyak percobaan untuk persetujuan ini', code: 'too_many_runs' }
  }
  return { ok: true }
}

/** Pindahkan penanda kanal persetujuan; kolom belum ada = tidak ada yang dipindah (sebelum migrasi). */
async function setApprovalChannel(db: GuardDb, userId: string, approvalId: string, channel: 'worker' | 'extension'): Promise<void> {
  const res = await db
    .from('approval_requests')
    .update({ apply_channel: channel })
    .eq('id', approvalId)
    .eq('user_id', userId)
    .eq('status', 'approved')
    .select('id')
  if (res?.error && !isMissingColumnError(res.error, 'apply_channel')) {
    throw new Error(`apply_channel update failed: ${res.error.message}`)
  }
}

/**
 * Penjaga dalam proses: dua permintaan bersamaan untuk persetujuan yang sama tidak boleh sama-sama lolos
 * pemeriksaan sebelum salah satunya sempat masuk antrean. (Antar proses, indeks unik dari migrasi DRAFT yang
 * menjaga; sebelum migrasi, pemeriksaan di enqueue menutup sisanya.)
 */
const inFlight = new Set<string>()

/**
 * Alur POST /api/approvals/:id/extension-consent: fakta, keputusan, enqueue `extension_apply`, lalu (bila
 * `always`) simpan `extension_auto_use`. Mengembalikan status dan badan jawaban HTTP.
 */
export async function grantExtensionConsent(
  db: GuardDb,
  queue: ExtensionConsentQueue,
  userId: string,
  approvalId: string,
  opts: { always?: boolean; now?: Date } = {}
): Promise<ExtensionConsentReply> {
  const now = opts.now ?? new Date()
  const lockKey = `${userId}:${approvalId}`
  if (inFlight.has(lockKey)) {
    return { status: 409, body: { error: 'Persetujuan ini sedang dikerjakan', code: 'already_active' } }
  }
  inFlight.add(lockKey)
  try {
    return await runConsent(db, queue, userId, approvalId, opts.always === true, now)
  } finally {
    inFlight.delete(lockKey)
  }
}

async function runConsent(
  db: GuardDb,
  queue: ExtensionConsentQueue,
  userId: string,
  approvalId: string,
  always: boolean,
  now: Date
): Promise<ExtensionConsentReply> {
  let previousChannel: string | null = null
  let channelMoved = false
  try {
    const facts = await fetchRerunFacts(db, userId, approvalId, now)
    const verdict = decideExtensionConsent(facts)
    if (!verdict.ok) return { status: verdict.status, body: { error: verdict.error, code: verdict.code } }

    // LinkedIn tidak pernah dikerjakan ekstensi (manual saja). Lowongan yang hilang tidak bisa diisi.
    const classified = await resolveApplyChannel(db, String(facts.approval?.job_id))
    if (!classified) return { status: 422, body: { error: 'Lowongan tidak ditemukan', code: 'job_not_found' } }
    if (classified.manualOnly) {
      return { status: 409, body: { error: 'Lowongan ini hanya bisa dilamar manual', code: 'manual_only' } }
    }

    // Persetujuan yang dulu berjalan di worker (mis. berhenti karena butuh login) pindah kanal sebelum antre,
    // karena enqueue menolak persetujuan yang kanalnya bukan 'extension'.
    previousChannel = facts.approval?.apply_channel ?? null
    if (previousChannel !== 'extension') {
      await setApprovalChannel(db, userId, approvalId, 'extension')
      channelMoved = true
    }

    const queued = await queue.addApprovedExtensionApplyJob(userId, approvalId)
    const body: Record<string, unknown> = { queued: true, queue_job_id: queued.id }
    if (always) body.extension_auto_use = await saveExtensionAutoUse(db, userId, true)
    return { status: 200, body }
  } catch (err: any) {
    // Gagal masuk antrean: kembalikan penanda kanal supaya persetujuan tidak terkunci di kanal yang tak berjalan.
    if (channelMoved && previousChannel) {
      try {
        await setApprovalChannel(db, userId, approvalId, previousChannel as 'worker' | 'extension')
      } catch {
        // Pemulihan terbaik-upaya; galat aslinya yang dijawab.
      }
    }
    if (err instanceof ApprovalChannelConflictError) {
      return { status: 409, body: { error: 'Persetujuan ini sudah aktif di antrean atau sudah dipakai', code: err.code } }
    }
    const client = clientErrorReply(err)
    if (client) return { status: client.statusCode, body: client.body }
    console.error('[extension-consent] gagal memasukkan antrean:', String(err?.message ?? err))
    return { status: 500, body: { error: 'Gagal memasukkan lamaran ke antrean ekstensi', code: 'consent_failed' } }
  }
}
