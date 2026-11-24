/**
 * Kepemilikan lease antrean `extension_apply`.
 *
 * Saat ekstensi mengklaim tugas, server membuat `lease_id` (UUID acak) dan menyimpannya di
 * `automation_queue.claimed_by`. Heartbeat, release, dan report-run mengirim `lease_id` itu kembali. Bila
 * tugas sudah direklaim ekstensi lain (heartbeat lama > 5 menit) nilai `claimed_by` berbeda, dan pemilik lama
 * tidak boleh lagi menyentuh barisnya (409 `lease_lost`).
 *
 * Kolom `claimed_by` baru ada setelah migrasi DRAFT_2026-11-24. Sebelum itu lease tetap dikirim ke ekstensi
 * tetapi tidak disimpan, dan pemeriksaan dilewati. Permintaan tanpa `lease_id` (ekstensi versi lama) tetap
 * diterima dan dicatat di log.
 *
 * Berkas ini sengaja tidak mengimpor extension-runner.ts / extension-queue.ts (mereka saling memanggil).
 */
import crypto from 'crypto'
import type { GuardDb } from './queue-guard.js'
import { isUuid } from './uuid.js'

export const EXTENSION_JOB_TYPE = 'extension_apply'

export function newLeaseId(): string {
  return crypto.randomUUID()
}

export type LeaseInput =
  | { kind: 'absent' }
  | { kind: 'invalid' }
  | { kind: 'present'; leaseId: string }

/** `lease_id` dari badan permintaan: tidak ada (ekstensi lama), rusak (bukan UUID), atau sah. */
export function parseLeaseId(raw: unknown): LeaseInput {
  if (raw === undefined || raw === null || raw === '') return { kind: 'absent' }
  if (!isUuid(raw)) return { kind: 'invalid' }
  return { kind: 'present', leaseId: raw.toLowerCase() }
}

/** Galat PostgREST/Postgres karena kolom antrean belum ada (migrasi belum dijalankan). */
export function isMissingLeaseColumn(err: { code?: string; message?: string } | null | undefined): boolean {
  if (!err) return false
  if (err.code === '42703' || err.code === 'PGRST204') return true
  return /claimed_by|heartbeat_at/i.test(String(err.message ?? ''))
}

const warnedAt = new Map<string, number>()

/** Catat (paling sering sekali per menit per rute) permintaan ekstensi lama yang belum mengirim lease_id. */
export function warnMissingLease(route: string, now: number = Date.now()): void {
  const last = warnedAt.get(route) ?? 0
  if (now - last < 60_000) return
  warnedAt.set(route, now)
  console.warn(`[extension-lease] ${route}: permintaan tanpa lease_id (ekstensi versi lama), diterima tanpa pemeriksaan kepemilikan`)
}

export interface LeaseRow {
  id: string
  job_type?: string | null
  status?: string | null
  retry_count?: number | null
  max_retries?: number | null
  payload?: Record<string, any> | null
  claimed_by?: string | null
}

/**
 * Baca baris antrean milik pengguna beserta `claimed_by`. `hasLeaseColumn` false bila kolom belum ada
 * (barisnya tetap dikembalikan tanpa `claimed_by`).
 */
export async function readQueueRow(
  db: GuardDb,
  userId: string,
  queueJobId: string,
  columns = 'id, job_type, status, retry_count, max_retries, payload'
): Promise<{ row: LeaseRow | null; hasLeaseColumn: boolean }> {
  const run = (cols: string) => db.from('automation_queue').select(cols).eq('id', queueJobId).eq('user_id', userId).maybeSingle()
  let res = await run(`${columns}, claimed_by`)
  let hasLeaseColumn = true
  if (res.error && isMissingLeaseColumn(res.error)) {
    hasLeaseColumn = false
    res = await run(columns)
  }
  if (res.error) throw Object.assign(new Error(String(res.error.message ?? 'queue lookup failed')), { dbCode: res.error.code })
  return { row: (res.data as LeaseRow | null) ?? null, hasLeaseColumn }
}

/** Pemilik lease sah? Tanpa kolom atau tanpa lease_id dari klien: lolos (kompatibilitas). */
export function leaseHolds(input: LeaseInput, row: LeaseRow | null, hasLeaseColumn: boolean): boolean {
  if (!hasLeaseColumn) return true
  if (input.kind === 'absent') return true
  if (input.kind === 'invalid') return false
  return Boolean(row) && String(row?.claimed_by ?? '').toLowerCase() === input.leaseId
}

export interface SettleParams {
  approvalId: string
  queueJobId: string | null
  lease: LeaseInput
  /** Patch dengan kolom lease (heartbeat_at); dicoba dulu. */
  fullPatch: Record<string, any>
  /** Patch tanpa kolom baru; dipakai bila kolom belum ada. */
  basePatch: Record<string, any>
}

export type SettleResult =
  | { touched: true; queueJobId: string }
  | { touched: false; reason: 'not_found' | 'lease_lost' | 'approval_mismatch' | 'not_active' }

/**
 * Perbarui baris `extension_apply` sesudah laporan hasil (report-run). Hanya baris `pending`/`processing`
 * yang `payload.approval_request_id`-nya sama dengan persetujuan yang dilaporkan, dan (bila lease dikirim dan
 * kolomnya ada) yang `claimed_by`-nya sama dengan lease itu. Selain itu baris tidak disentuh.
 */
export async function settleExtensionQueueRow(db: GuardDb, userId: string, p: SettleParams): Promise<SettleResult> {
  let target: LeaseRow | null = null
  let hasLeaseColumn = true

  if (p.queueJobId) {
    const read = await readQueueRow(db, userId, p.queueJobId)
    hasLeaseColumn = read.hasLeaseColumn
    target = read.row
    if (!target || target.job_type !== EXTENSION_JOB_TYPE) return { touched: false, reason: 'not_found' }
    if (target.status !== 'pending' && target.status !== 'processing') return { touched: false, reason: 'not_active' }
    if (target.payload?.approval_request_id !== p.approvalId) return { touched: false, reason: 'approval_mismatch' }
  } else {
    // Ekstensi lama tanpa queueJobId: cari baris aktif persetujuan ini.
    const find = (cols: string) =>
      db
        .from('automation_queue')
        .select(cols)
        .eq('user_id', userId)
        .eq('job_type', EXTENSION_JOB_TYPE)
        .eq('payload->>approval_request_id', p.approvalId)
        .in('status', ['pending', 'processing'])
        .limit(1)
    let res = await find('id, status, payload, claimed_by')
    if (res.error && isMissingLeaseColumn(res.error)) {
      hasLeaseColumn = false
      res = await find('id, status, payload')
    }
    if (res.error) throw Object.assign(new Error(String(res.error.message ?? 'queue lookup failed')), { dbCode: res.error.code })
    target = Array.isArray(res.data) ? (res.data[0] ?? null) : null
    if (!target) return { touched: false, reason: 'not_found' }
  }

  if (!leaseHolds(p.lease, target, hasLeaseColumn)) return { touched: false, reason: 'lease_lost' }

  const update = (patch: Record<string, any>, withLeaseFilter: boolean) => {
    let q = db
      .from('automation_queue')
      .update(patch)
      .eq('id', target!.id)
      .eq('user_id', userId)
      .eq('job_type', EXTENSION_JOB_TYPE)
      .in('status', ['pending', 'processing'])
      .eq('payload->>approval_request_id', p.approvalId)
    // Syarat kepemilikan ikut di UPDATE supaya reklamasi di antara pembacaan dan penulisan tidak menimpa pemilik baru.
    if (withLeaseFilter && p.lease.kind === 'present') q = q.eq('claimed_by', p.lease.leaseId)
    return q.select('id')
  }

  let res = await update(p.fullPatch, hasLeaseColumn)
  if (res.error && isMissingLeaseColumn(res.error)) res = await update(p.basePatch, false)
  if (res.error) throw Object.assign(new Error(String(res.error.message ?? 'queue update failed')), { dbCode: res.error.code })
  if (!Array.isArray(res.data) || res.data.length === 0) return { touched: false, reason: 'lease_lost' }
  return { touched: true, queueJobId: String(target.id) }
}
