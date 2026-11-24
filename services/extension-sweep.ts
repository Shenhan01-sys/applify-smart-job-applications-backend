/**
 * Sapu tugas `extension_apply` yang tidak akan pernah selesai.
 *
 * Dua kasus dijadikan `failed` dengan pesan jelas supaya tidak menggantung di antrean selamanya:
 *   1. `processing` yang heartbeat-nya lebih tua dari 5 menit dan jatah percobaannya habis
 *      (`retry_count >= max_retries`). RPC klaim tidak memilih baris seperti ini, jadi tanpa sapuan ia macet.
 *   2. Persetujuannya sudah tidak berlaku: kedaluwarsa, tidak lagi `approved`, atau barisnya hilang.
 *
 * Logika yang sama ada di SQL (`public.sweep_extension_apply_jobs`, DRAFT_2026-11-24b_extension_consent_and_sweep.sql)
 * dan di fallback Node di bawah. Jaga keduanya tetap sama. Pemanggil:
 *   - backend: awal setiap klaim ekstensi, untuk pengguna itu saja (jalan juga sebelum migrasi, lewat fallback Node);
 *   - worker: siklus reclaimStale memanggil RPC untuk semua pengguna (hanya bila RPC sudah dimigrasi).
 */
import type { GuardDb } from './queue-guard.js'

export const EXTENSION_SWEEP_RPC = 'sweep_extension_apply_jobs'
export const EXTENSION_STALE_MS = 5 * 60 * 1000
const SWEEP_BATCH = 200

export const EXHAUSTED_MESSAGE =
  'Ekstensi berhenti merespons dan jatah percobaan sudah habis. Jalankan ulang lamaran dari halaman Persetujuan.'
export const EXPIRED_MESSAGE =
  'Persetujuan sudah tidak berlaku (kedaluwarsa) sebelum ekstensi selesai mengerjakannya. Setujui lowongan ini lagi.'

export interface SweepResult {
  failed: number
  via: 'rpc' | 'node'
}

const isMissingFunction = (err: { code?: string; message?: string } | null | undefined): boolean =>
  err?.code === '42883' || err?.code === 'PGRST202' || /sweep_extension_apply_jobs/i.test(String(err?.message ?? ''))

function lastBeatMs(row: Record<string, any>): number {
  for (const col of ['heartbeat_at', 'processed_at', 'updated_at', 'created_at']) {
    const raw = row?.[col]
    if (typeof raw === 'string' && raw) {
      const t = Date.parse(raw)
      if (Number.isFinite(t)) return t
    }
  }
  return 0
}

async function failRow(db: GuardDb, row: Record<string, any>, message: string, iso: string): Promise<boolean> {
  const res = await db
    .from('automation_queue')
    .update({ status: 'failed', completed_at: iso, error_message: message.slice(0, 240), updated_at: iso })
    .eq('id', row.id)
    .eq('job_type', 'extension_apply')
    .eq('status', row.status)
    .select('id')
  return !res.error && Array.isArray(res.data) && res.data.length > 0
}

/** Fallback Node: aturan sama dengan fungsi SQL. */
export async function sweepExtensionJobsNode(
  db: GuardDb,
  opts: { userId?: string | null; now?: Date; staleAfterMs?: number } = {}
): Promise<number> {
  const now = opts.now ?? new Date()
  const iso = now.toISOString()
  const staleMs = Math.max(60_000, opts.staleAfterMs ?? EXTENSION_STALE_MS)

  let q = db
    .from('automation_queue')
    .select('*')
    .eq('job_type', 'extension_apply')
    .in('status', ['pending', 'processing'])
    .limit(SWEEP_BATCH)
  if (opts.userId) q = q.eq('user_id', opts.userId)
  const { data, error } = await q
  if (error) throw new Error(`extension sweep lookup failed: ${error.message}`)
  const rows: Array<Record<string, any>> = Array.isArray(data) ? data : []
  if (rows.length === 0) return 0

  const failedIds = new Set<string>()
  let failed = 0

  // 1. Jatah percobaan habis dan heartbeat basi.
  for (const row of rows) {
    if (row.status !== 'processing') continue
    if (lastBeatMs(row) >= now.getTime() - staleMs) continue
    if (Number(row.retry_count ?? 0) < Number(row.max_retries ?? 3)) continue
    if (await failRow(db, row, EXHAUSTED_MESSAGE, iso)) {
      failedIds.add(String(row.id))
      failed++
    }
  }

  // 2. Persetujuan tidak berlaku. Hanya dinilai bila pencarian persetujuan berhasil.
  const remaining = rows.filter((r) => !failedIds.has(String(r.id)))
  const approvalIds = [...new Set(remaining.map((r) => r?.payload?.approval_request_id).filter((v): v is string => typeof v === 'string' && v !== ''))]
  if (approvalIds.length > 0) {
    let aq = db.from('approval_requests').select('id, status, expires_at').in('id', approvalIds)
    if (opts.userId) aq = aq.eq('user_id', opts.userId)
    const { data: approvals, error: aErr } = await aq
    if (!aErr) {
      const valid = new Set<string>()
      for (const a of Array.isArray(approvals) ? approvals : []) {
        const exp = a?.expires_at ? Date.parse(a.expires_at) : NaN
        if (a?.status === 'approved' && Number.isFinite(exp) && exp > now.getTime()) valid.add(String(a.id))
      }
      for (const row of remaining) {
        const approvalId = row?.payload?.approval_request_id
        if (typeof approvalId !== 'string' || approvalId === '') continue
        if (valid.has(approvalId)) continue
        if (await failRow(db, row, EXPIRED_MESSAGE, iso)) failed++
      }
    }
  }
  return failed
}

/**
 * Sapu tugas ekstensi. Mencoba RPC SQL dulu (satu pernyataan atomik); bila fungsi belum dimigrasi memakai
 * fallback Node. `userId` kosong = semua pengguna (hanya masuk akal dengan kunci service-role).
 */
export async function sweepExtensionJobs(
  db: GuardDb,
  opts: { userId?: string | null; now?: Date; staleAfterMs?: number } = {}
): Promise<SweepResult> {
  const staleMs = Math.max(60_000, opts.staleAfterMs ?? EXTENSION_STALE_MS)
  if (typeof (db as any).rpc === 'function') {
    const res = await (db as any).rpc(EXTENSION_SWEEP_RPC, {
      p_user_id: opts.userId ?? null,
      p_stale_after_seconds: Math.round(staleMs / 1000),
    })
    if (!res?.error) return { failed: Number(res?.data ?? 0) || 0, via: 'rpc' }
    if (!isMissingFunction(res.error)) throw new Error(`extension sweep rpc failed: ${res.error.message}`)
  }
  return { failed: await sweepExtensionJobsNode(db, opts), via: 'node' }
}
