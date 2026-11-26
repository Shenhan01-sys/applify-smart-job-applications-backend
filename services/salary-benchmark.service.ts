import type { SupabaseClient } from '@supabase/supabase-js'
import {
  isJobAccessibleToUser,
  isMissingVisibilityColumnError,
  selectJobWithVisibility,
} from './private-job-access.js'

/**
 * Salary Benchmark — pembanding gaji untuk satu lowongan, dihitung dari lowongan aktif lain di tabel `jobs`
 * yang punya gaji dan judulnya mirip. Hanya rupiah per bulan (satuan paling umum di data; mata uang atau periode
 * lain tidak dicampur). Ini statistik dari sampel lowongan yang tersimpan, bukan survei gaji.
 *
 * Kemiripan judul: kata kunci peran diambil dari judul lowongan (tanpa kata tingkat jabatan dan kata umum),
 * baris pembanding harus memuat paling sedikit satu kata kunci; bila ada >= 5 baris yang memuat >= 2 kata kunci,
 * hanya baris itu yang dipakai. Nilai tiap baris = titik tengah (min + max) / 2.
 */

export const MIN_SAMPLE = 5
const QUERY_LIMIT = 1000

/** Kata yang tidak menunjukkan peran: tingkat jabatan, jenis kontrak, penghubung. */
const STOPWORDS = new Set([
  'senior', 'junior', 'sr', 'jr', 'staff', 'intern', 'internship', 'magang', 'lead', 'head',
  'ii', 'iii', 'iv', 'dan', 'and', 'of', 'for', 'the', 'contract', 'kontrak', 'full', 'time', 'part', 'fulltime', 'parttime',
  'remote', 'hybrid', 'onsite', 'wfh', 'wfo', 'urgent', 'hiring', 'dibutuhkan', 'lowongan', 'jakarta', 'indonesia',
])

/** Kata kunci peran dari judul: huruf kecil, hanya a-z0-9 (aman untuk filter PostgREST), tanpa stopword, >= 3 huruf. */
export function titleKeywords(title: unknown): string[] {
  const tokens = String(title ?? '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t))
  return [...new Set(tokens)].slice(0, 6)
}

/** Persentil dengan interpolasi linear (metode umum "R-7"). `sorted` harus terurut naik dan tidak kosong. */
export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN
  if (sorted.length === 1) return sorted[0]
  const pos = (sorted.length - 1) * p
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo)
}

export interface SalaryBenchmark {
  /** Jumlah lowongan pembanding. */
  n: number
  p25: number | null
  median: number | null
  p75: number | null
  currency: 'IDR'
  period: 'month'
  keywords: string[]
  /** true bila n >= 5; di bawah itu angka persentil tidak layak ditampilkan sebagai patokan. */
  sufficient: boolean
  /** Kota lowongan ini (segmen pertama lokasi, huruf kecil), null bila tidak ada. */
  city: string | null
  /** Jumlah lowongan pembanding di kota yang sama. */
  same_city_n: number
  /** Median gaji pembanding di kota yang sama, null bila tidak ada. */
  same_city_median: number | null
}

const midpoint = (r: { salary_min?: any; salary_max?: any }) => {
  const lo = Number(r.salary_min)
  const hi = r.salary_max == null ? lo : Number(r.salary_max)
  return Number.isFinite(lo) && Number.isFinite(hi) ? (lo + hi) / 2 : NaN
}

const cityOf = (location: unknown): string | null => {
  const c = String(location ?? '').split(',')[0].trim().toLowerCase()
  return c || null
}

const round = (n: number) => Math.round(n)

/** null bila lowongan tidak ada atau lowongan privat milik pengguna lain. Galat DB dilempar ke pemanggil (rute menjawab 500). */
export async function salaryBenchmark(
  db: SupabaseClient,
  jobId: string,
  opts?: { userId?: string }
): Promise<SalaryBenchmark | null> {
  const { data: job, error: jobErr } = await selectJobWithVisibility(db, jobId, 'id, title, location')
  if (jobErr) {
    if (jobErr.code === '22P02') return null
    throw new Error(jobErr.message)
  }
  if (!job) return null
  if (opts?.userId !== undefined && !isJobAccessibleToUser(job, opts.userId)) {
    return null
  }

  const keywords = titleKeywords(job.title)
  const city = cityOf(job.location)
  const empty: SalaryBenchmark = {
    n: 0, p25: null, median: null, p75: null, currency: 'IDR', period: 'month', keywords,
    sufficient: false, city, same_city_n: 0, same_city_median: null,
  }
  if (keywords.length === 0) return empty

  const basePeerCols = 'id, title, location, salary_min, salary_max, salary_currency, salary_period, external_url, platform_source'
  const queryPeers = (cols: string) =>
    db
      .from('jobs')
      .select(cols)
      .eq('status', 'active')
      .gt('salary_min', 0)
      .or('salary_currency.eq.IDR,salary_currency.is.null')
      .or('salary_period.eq.month,salary_period.is.null')
      .or(keywords.map((k) => `title.ilike.%${k}%`).join(','))
      .limit(QUERY_LIMIT)

  let peerRes: { data: any; error: any }
  try {
    peerRes = await queryPeers(`${basePeerCols}, visibility, created_by`)
    if (peerRes.error && isMissingVisibilityColumnError(peerRes.error)) {
      peerRes = await queryPeers(basePeerCols)
    }
  } catch (err) {
    if (isMissingVisibilityColumnError(err)) {
      peerRes = await queryPeers(basePeerCols)
    } else {
      throw err
    }
  }
  const { data: rawPeers, error } = peerRes
  if (error) throw new Error(error.message)
  const data = (rawPeers ?? []).filter((r: any) => isJobAccessibleToUser(r, opts?.userId))

  type Cand = { mid: number; hits: number; city: string | null }
  const cands: Cand[] = []
  for (const r of (data ?? []) as any[]) {
    if (r.id === jobId) continue
    // Hanya lowongan nyata. Baris seed UAT tidak punya external_url, gajinya bulat (5–20 jt), dan periodenya
    // 'monthly'; satu baris uji memakai platform httpbin (cek database 20 November 2026). Data itu tidak boleh
    // menjadi pembanding gaji.
    if (typeof r.external_url !== 'string' || !r.external_url.startsWith('https://')) continue
    if (String(r.platform_source ?? '').toLowerCase() === 'httpbin') continue
    // Pengaman kedua di sisi aplikasi: filter DB bisa saja tidak ketat (mata uang/periode kosong dianggap rupiah/bulan).
    if (r.salary_currency != null && String(r.salary_currency).toUpperCase() !== 'IDR') continue
    if (r.salary_period != null && r.salary_period !== 'month') continue
    const mid = midpoint(r)
    if (!(mid > 0)) continue
    const t = String(r.title ?? '').toLowerCase()
    const hits = keywords.filter((k) => t.includes(k)).length
    if (hits === 0) continue
    cands.push({ mid, hits, city: cityOf(r.location) })
  }

  const strong = cands.filter((c) => c.hits >= 2)
  const used = strong.length >= MIN_SAMPLE ? strong : cands
  const sorted = used.map((c) => c.mid).sort((a, b) => a - b)
  const local = used.filter((c) => city !== null && c.city === city).map((c) => c.mid).sort((a, b) => a - b)

  return {
    ...empty,
    n: sorted.length,
    p25: sorted.length ? round(percentile(sorted, 0.25)) : null,
    median: sorted.length ? round(percentile(sorted, 0.5)) : null,
    p75: sorted.length ? round(percentile(sorted, 0.75)) : null,
    sufficient: sorted.length >= MIN_SAMPLE,
    same_city_n: local.length,
    same_city_median: local.length ? round(percentile(local, 0.5)) : null,
  }
}
