import type { SupabaseClient } from '@supabase/supabase-js'
import { enrichJob, type EnrichResult } from './job-detail.service.js'

/**
 * Backfill detail lowongan lama (deskripsi, syarat, gaji) dari halaman JobStreet dan Dealls.
 *
 * Latar: sebelum 20 November 2026 pemindai hanya menyimpan ringkasan dan membuang gaji. Pembanding gaji butuh data
 * gaji nyata, jadi lowongan terbaru yang masih ringkas diambil ulang satu per satu, berurutan, dengan jeda antarhalaman
 * supaya tidak membebani situs sumber. Hanya satu backfill berjalan dalam satu proses.
 */
export const BACKFILL_PLATFORMS = ['jobstreet', 'dealls'] as const
export const BACKFILL_MAX_LIMIT = 2000
export const BACKFILL_DELAY_MS = 800
const THIN_DESCRIPTION = 600

export interface BackfillState {
  running: boolean
  total: number
  done: number
  enriched: number
  salaryAdded: number
  failed: number
  reasons: Record<string, number>
  startedAt: string | null
  finishedAt: string | null
  startedBy: string | null
}

const fresh = (): BackfillState => ({
  running: false, total: 0, done: 0, enriched: 0, salaryAdded: 0, failed: 0, reasons: {},
  startedAt: null, finishedAt: null, startedBy: null,
})

let state: BackfillState = fresh()

export function backfillState(): BackfillState {
  return { ...state, reasons: { ...state.reasons } }
}

/** Hanya untuk tes. */
export function resetBackfillState(): void {
  state = fresh()
}

/** Pengguna yang boleh memulai backfill: daftar id dari env BACKFILL_ADMIN_IDS (dipisah koma). Kosong berarti tidak ada. */
export function isBackfillAdmin(userId: unknown, env: string | undefined = process.env.BACKFILL_ADMIN_IDS): boolean {
  if (typeof userId !== 'string' || !userId) return false
  return (env ?? '').split(',').map((s) => s.trim()).filter(Boolean).includes(userId)
}

const isThin = (r: any): boolean => {
  const d = typeof r.description === 'string' ? r.description.length : 0
  const req = Array.isArray(r.requirements) ? r.requirements.length : 0
  return d < THIN_DESCRIPTION || req === 0 || r.salary_min == null
}

/** Lowongan aktif JobStreet/Dealls terbaru yang masih ringkas atau belum bergaji. */
export async function selectBackfillTargets(db: Pick<SupabaseClient, 'from'>, limit: number): Promise<string[]> {
  const n = Math.max(1, Math.min(BACKFILL_MAX_LIMIT, Math.floor(limit)))
  const { data, error } = await db
    .from('jobs')
    .select('id, description, requirements, salary_min, external_url, created_at')
    .eq('status', 'active')
    .in('platform_source', [...BACKFILL_PLATFORMS])
    .like('external_url', 'https://%')
    .order('created_at', { ascending: false })
    .limit(n * 2)
  if (error) throw new Error(error.message)
  return ((data ?? []) as any[]).filter(isThin).slice(0, n).map((r) => String(r.id))
}

type Enrich = (db: SupabaseClient, id: string) => Promise<EnrichResult>

/**
 * Jalankan backfill berurutan. Mengembalikan false bila backfill lain masih berjalan. Galat satu lowongan tidak
 * menghentikan yang lain.
 */
export async function runBackfill(
  db: SupabaseClient,
  ids: string[],
  opts: { startedBy: string; delayMs?: number; enrich?: Enrich; sleep?: (ms: number) => Promise<void> },
): Promise<boolean> {
  if (state.running) return false
  const enrich: Enrich = opts.enrich ?? ((d, id) => enrichJob(d, id))
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const delay = opts.delayMs ?? BACKFILL_DELAY_MS
  state = { ...fresh(), running: true, total: ids.length, startedAt: new Date().toISOString(), startedBy: opts.startedBy }
  try {
    for (const id of ids) {
      try {
        const before = await db.from('jobs').select('salary_min').eq('id', id).maybeSingle()
        const r = await enrich(db, id)
        state.reasons[r.reason] = (state.reasons[r.reason] ?? 0) + 1
        if (r.enriched) {
          state.enriched++
          if (before.data?.salary_min == null && r.job?.salary_min != null) state.salaryAdded++
        } else if (r.status === 'error' || /gagal/.test(r.reason)) {
          state.failed++
        }
      } catch (e) {
        state.failed++
        const key = `galat: ${(e as Error)?.message ?? 'tidak diketahui'}`.slice(0, 80)
        state.reasons[key] = (state.reasons[key] ?? 0) + 1
      }
      state.done++
      if (state.done < ids.length) await sleep(delay)
    }
  } finally {
    state.running = false
    state.finishedAt = new Date().toISOString()
  }
  return true
}
