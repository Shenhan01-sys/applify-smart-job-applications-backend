import type { SupabaseClient } from '@supabase/supabase-js'
import type { RankedJob } from './job-aggregation.service.js'
import { salaryOfPosting, toDbSalary } from './salary.js'

/**
 * Job Ingest Service — menyimpan hasil agregasi ke tabel `jobs` (Supabase).
 *  - Deduplikasi berdasarkan `external_url` (lowongan yang sudah ada tidak disisipkan lagi).
 *  - Hanya memakai kolom yang sudah terbukti ada di skema live (sama dengan worker/handlers/search.ts); kolom
 *    tambahan (`posted_at`, `from_ats`, `match_score`, `salary_*`, `requirements`) dicoba lebih dulu dan otomatis
 *    dilepas bila skema live belum memilikinya.
 *  - `match_score` (integer 0-100) diisi dari skor relevansi deterministik `relevanceScore`
 *    (mcp/shared/utils.ts): bobot kata kunci pencarian (judul 3, deskripsi 1) dan skill profil (2) yang
 *    cocok dibagi bobot maksimum, x 100, dibulatkan. null bila tidak ada kata kunci dan tidak ada skill.
 *    Kolom ini milik tabel `jobs` yang dipakai bersama, jadi nilainya adalah skor untuk pengguna yang
 *    pencariannya pertama kali menyimpan lowongan itu. Lowongan yang sudah ada tidak ditimpa; hanya yang
 *    match_score-nya masih kosong diisi (backfill). Skor per pengguna selalu ada di respons pencarian
 *    (`match_score` tiap lowongan).
 *  - Gaji (`salary_min/max/currency/period`, bilangan bulat) dan `requirements` (jsonb; dari `requirements`
 *    sumber, atau skill sumber bila tidak ada) ikut disimpan bila sumber memberinya. Pada duplikat, data yang lebih
 *    kaya melengkapi baris lama tanpa menimpa yang sudah ada: gaji hanya bila masih kosong, syarat hanya bila masih
 *    kosong, deskripsi hanya bila yang baru lebih panjang.
 */

const VALID_TYPES = ['full-time', 'part-time', 'contract', 'freelance', 'internship']
const VALID_WORKPLACE = ['on-site', 'hybrid', 'remote']

const MAX_REQUIREMENTS = 20
const MAX_REQUIREMENT_CHARS = 200
const COLUMN_ERROR = /column|schema cache|PGRST204|does not exist/i

export interface IngestSummary {
  attempted: number
  inserted: number
  duplicates: number
  failed: number
  /** Lowongan lama (duplikat) yang match_score-nya kosong dan baru diisi pada pencarian ini. */
  backfilled: number
  /** Lowongan lama (duplikat) yang gaji, syarat, atau deskripsinya dilengkapi dari hasil pencarian ini. */
  enriched: number
  errors: string[]
  byPlatform: Record<string, { inserted: number; duplicates: number; failed: number }>
}

/** Nilai match_score yang sah (bulat 0-100) atau null. Nilai dari luar tidak dipercaya begitu saja. */
export function validMatchScore(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null
  return Math.min(100, Math.max(0, Math.round(v)))
}

/** Butir syarat dari sumber: `requirements` bila ada, kalau tidak `skills`; dirapikan, tanpa duplikat, dibatasi. */
export function requirementsOf(job: { requirements?: unknown; skills?: unknown }): string[] {
  const pick = (v: unknown) =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').map((x) => x.replace(/\s+/g, ' ').trim()).filter(Boolean) : []
  const list = pick(job.requirements).length > 0 ? pick(job.requirements) : pick(job.skills)
  return [...new Set(list.map((x) => (x.length > MAX_REQUIREMENT_CHARS ? `${x.slice(0, MAX_REQUIREMENT_CHARS - 1).trimEnd()}…` : x)))].slice(
    0,
    MAX_REQUIREMENTS,
  )
}

interface Flags {
  /** posted_at, from_ats */
  extras: boolean
  /** match_score */
  score: boolean
  /** salary_*, requirements */
  detail: boolean
}

function toRow(job: RankedJob, f: Flags) {
  const row: Record<string, any> = {
    title: job.title.slice(0, 300),
    company: (job.company || 'Unknown').slice(0, 200),
    location: job.location || 'Indonesia',
    type: VALID_TYPES.includes(job.job_type ?? '') ? job.job_type : 'full-time',
    workplace_type: VALID_WORKPLACE.includes(job.work_type ?? '') ? job.work_type : null,
    description: job.description?.trim() || `${job.title} — ${job.company}`,
    platform_source: job.platform,
    external_url: job.apply_url || job.url || null,
    status: 'active',
  }
  if (f.score) row.match_score = validMatchScore(job.match_score)
  if (f.detail) {
    const sal = salaryOfPosting(job)
    if (sal) Object.assign(row, toDbSalary(sal))
    const req = requirementsOf(job)
    if (req.length > 0) row.requirements = req
  }
  if (f.extras) {
    if (job.posted_at && !Number.isNaN(Date.parse(job.posted_at))) row.posted_at = new Date(job.posted_at).toISOString()
    row.from_ats = ['greenhouse', 'lever', 'ashby', 'workable', 'smartrecruiters'].includes(job.platform)
  }
  return row
}

type Existing = {
  id: string
  match_score?: number | null
  description?: string | null
  requirements?: unknown
  salary_min?: number | null
}

/**
 * Bidang baris lama yang boleh dilengkapi dari lowongan baru. Hanya bidang yang ikut terbaca dari DB
 * (`key in found`) yang dipertimbangkan, supaya skema lama atau pembacaan sebagian tidak memicu penimpaan.
 */
export function detailPatch(found: Existing, job: RankedJob): Record<string, any> {
  const patch: Record<string, any> = {}
  if ('salary_min' in found && found.salary_min == null) {
    const sal = salaryOfPosting(job)
    if (sal) Object.assign(patch, toDbSalary(sal))
  }
  if ('requirements' in found && (!Array.isArray(found.requirements) || found.requirements.length === 0)) {
    const req = requirementsOf(job)
    if (req.length > 0) patch.requirements = req
  }
  if ('description' in found) {
    const next = job.description?.trim() ?? ''
    if (next.length > (found.description ?? '').trim().length) patch.description = next
  }
  return patch
}

// Tingkat kolom yang dibaca saat mencari duplikat; turun satu tingkat bila skema live belum punya kolomnya.
const LOOKUP_COLS = ['id, match_score, description, requirements, salary_min', 'id, match_score', 'id']

export async function ingestJobs(supabase: SupabaseClient, jobs: RankedJob[]): Promise<IngestSummary> {
  const summary: IngestSummary = { attempted: jobs.length, inserted: 0, duplicates: 0, failed: 0, backfilled: 0, enriched: 0, errors: [], byPlatform: {} }
  const flags: Flags = { extras: true, score: true, detail: true }
  let level = 0

  const lookup = async (url: string): Promise<Existing[]> => {
    for (;;) {
      const { data, error } = await supabase.from('jobs').select(LOOKUP_COLS[level]).eq('external_url', url).limit(1)
      if (error && level < LOOKUP_COLS.length - 1 && COLUMN_ERROR.test(error.message ?? '')) {
        // Skema live tanpa kolom itu: turun tingkat; duplikat tetap terdeteksi lewat id saja.
        level++
        if (level >= 1) flags.detail = false
        if (level >= 2) flags.score = false
        continue
      }
      return (data ?? []) as unknown as Existing[]
    }
  }

  for (const job of jobs) {
    const bucket = (summary.byPlatform[job.platform] ??= { inserted: 0, duplicates: 0, failed: 0 })
    const url = job.apply_url || job.url
    if (url) {
      const found = await lookup(url)
      if (found.length > 0) {
        summary.duplicates++
        bucket.duplicates++
        const row = found[0]
        // Isi hanya yang masih kosong; skor dan data yang sudah ada milik pencarian sebelumnya tidak ditimpa.
        const patch: Record<string, any> = {}
        const score = validMatchScore(job.match_score)
        if (flags.score && score !== null && row.match_score == null) patch.match_score = score
        const detail = flags.detail ? detailPatch(row, job) : {}
        const hasDetail = Object.keys(detail).length > 0
        if (hasDetail) Object.assign(patch, detail, { updated_at: new Date().toISOString() })
        if (Object.keys(patch).length > 0) {
          let { error: upErr } = await supabase.from('jobs').update(patch).eq('id', row.id)
          if (upErr && hasDetail && COLUMN_ERROR.test(upErr.message ?? '')) {
            // Kolom gaji/syarat belum ada di skema live: lepas dan ulangi hanya dengan match_score.
            flags.detail = false
            const scoreOnly = 'match_score' in patch ? { match_score: patch.match_score } : null
            upErr = scoreOnly ? (await supabase.from('jobs').update(scoreOnly).eq('id', row.id)).error : null
            if (!upErr && scoreOnly) summary.backfilled++
          } else if (upErr) {
            if (summary.errors.length < 10) summary.errors.push(`${job.platform}: update: ${upErr.message}`)
          } else {
            if ('match_score' in patch) summary.backfilled++
            if (hasDetail) summary.enriched++
          }
        }
        continue
      }
    }

    let { error } = await supabase.from('jobs').insert(toRow(job, flags))
    // Skema live belum punya kolom yang dikirim -> lepas kolom itu dan ulangi (paling banyak tiga kali).
    for (let attempt = 0; error && attempt < 3 && /column|schema cache|PGRST204/i.test(`${error.message} ${error.code ?? ''}`); attempt++) {
      const msg = error.message ?? ''
      if (flags.score && /match_score/i.test(msg)) flags.score = false
      else if (flags.detail && /salary_|requirements/i.test(msg)) flags.detail = false
      else if (flags.extras) flags.extras = false
      else break
      ;({ error } = await supabase.from('jobs').insert(toRow(job, flags)))
    }
    if (error) {
      summary.failed++
      bucket.failed++
      if (summary.errors.length < 10) summary.errors.push(`${job.platform}: ${error.message}`)
    } else {
      summary.inserted++
      bucket.inserted++
    }
  }
  return summary
}
