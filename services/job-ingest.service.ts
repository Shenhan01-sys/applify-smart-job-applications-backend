import type { SupabaseClient } from '@supabase/supabase-js'
import type { RankedJob } from './job-aggregation.service.js'

/**
 * Job Ingest Service — menyimpan hasil agregasi ke tabel `jobs` (Supabase).
 *  - Deduplikasi berdasarkan `external_url` (lowongan yang sudah ada dilewati).
 *  - Hanya memakai kolom yang sudah terbukti ada di skema live (sama dengan
 *    worker/handlers/search.ts); kolom tambahan (`posted_at`, `from_ats`) dicoba
 *    lebih dulu dan otomatis dilepas bila skema live belum memilikinya.
 *  - `match_score` (integer 0-100) diisi dari skor relevansi deterministik `relevanceScore`
 *    (mcp/shared/utils.ts): bobot kata kunci pencarian (judul 3, deskripsi 1) dan skill profil (2) yang
 *    cocok dibagi bobot maksimum, x 100, dibulatkan. null bila tidak ada kata kunci dan tidak ada skill.
 *    Kolom ini milik tabel `jobs` yang dipakai bersama, jadi nilainya adalah skor untuk pengguna yang
 *    pencariannya pertama kali menyimpan lowongan itu. Lowongan yang sudah ada tidak ditimpa; hanya yang
 *    match_score-nya masih kosong diisi (backfill). Skor per pengguna selalu ada di respons pencarian
 *    (`match_score` tiap lowongan).
 */

const VALID_TYPES = ['full-time', 'part-time', 'contract', 'freelance', 'internship']
const VALID_WORKPLACE = ['on-site', 'hybrid', 'remote']

export interface IngestSummary {
  attempted: number
  inserted: number
  duplicates: number
  failed: number
  /** Lowongan lama (duplikat) yang match_score-nya kosong dan baru diisi pada pencarian ini. */
  backfilled: number
  errors: string[]
  byPlatform: Record<string, { inserted: number; duplicates: number; failed: number }>
}

/** Nilai match_score yang sah (bulat 0-100) atau null. Nilai dari luar tidak dipercaya begitu saja. */
export function validMatchScore(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null
  return Math.min(100, Math.max(0, Math.round(v)))
}

function toRow(job: RankedJob, withExtras: boolean, withScore = true) {
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
  if (withScore) row.match_score = validMatchScore(job.match_score)
  if (withExtras) {
    if (job.posted_at && !Number.isNaN(Date.parse(job.posted_at))) row.posted_at = new Date(job.posted_at).toISOString()
    row.from_ats = ['greenhouse', 'lever', 'ashby', 'workable', 'smartrecruiters'].includes(job.platform)
  }
  return row
}

export async function ingestJobs(supabase: SupabaseClient, jobs: RankedJob[]): Promise<IngestSummary> {
  const summary: IngestSummary = { attempted: jobs.length, inserted: 0, duplicates: 0, failed: 0, backfilled: 0, errors: [], byPlatform: {} }
  let extras = true
  let scoreCol = true

  for (const job of jobs) {
    const bucket = (summary.byPlatform[job.platform] ??= { inserted: 0, duplicates: 0, failed: 0 })
    const url = job.apply_url || job.url
    if (url) {
      let { data: existing, error: selErr } = scoreCol
        ? await supabase.from('jobs').select('id, match_score').eq('external_url', url).limit(1)
        : await supabase.from('jobs').select('id').eq('external_url', url).limit(1)
      if (selErr && scoreCol && /match_score/i.test(selErr.message ?? '')) {
        // Skema live tanpa kolom match_score: tetap deteksi duplikat lewat id saja.
        scoreCol = false
        ;({ data: existing } = await supabase.from('jobs').select('id').eq('external_url', url).limit(1))
      }
      const found = (existing ?? []) as Array<{ id: string; match_score?: number | null }>
      if (found.length > 0) {
        summary.duplicates++
        bucket.duplicates++
        // Isi hanya yang masih kosong; skor yang sudah ada milik pencarian sebelumnya tidak ditimpa.
        const score = validMatchScore(job.match_score)
        if (scoreCol && score !== null && found[0].match_score == null) {
          const { error: upErr } = await supabase.from('jobs').update({ match_score: score }).eq('id', found[0].id)
          if (upErr) {
            if (summary.errors.length < 10) summary.errors.push(`${job.platform}: match_score: ${upErr.message}`)
          } else {
            summary.backfilled++
          }
        }
        continue
      }
    }

    let { error } = await supabase.from('jobs').insert(toRow(job, extras, scoreCol))
    if (error && /column|schema cache|PGRST204/i.test(`${error.message} ${error.code ?? ''}`)) {
      // Skema live belum punya kolom yang dikirim -> lepas kolom itu dan ulangi sekali.
      if (/match_score/i.test(error.message ?? '')) scoreCol = false
      else extras = false
      ;({ error } = await supabase.from('jobs').insert(toRow(job, extras, scoreCol)))
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
