import type { SupabaseClient } from '@supabase/supabase-js'
import type { RankedJob } from './job-aggregation.service.js'

/**
 * Job Ingest Service — menyimpan hasil agregasi ke tabel `jobs` (Supabase).
 *  - Deduplikasi berdasarkan `external_url` (lowongan yang sudah ada dilewati).
 *  - Hanya memakai kolom yang sudah terbukti ada di skema live (sama dengan
 *    worker/handlers/search.ts); kolom tambahan (`posted_at`, `from_ats`) dicoba
 *    lebih dulu dan otomatis dilepas bila skema live belum memilikinya.
 *  - `match_score` TIDAK diisi: skor relevansi bersifat per-pengguna, sedangkan
 *    kolom jobs.match_score global. Skor dikembalikan di respons API saja.
 */

const VALID_TYPES = ['full-time', 'part-time', 'contract', 'freelance', 'internship']
const VALID_WORKPLACE = ['on-site', 'hybrid', 'remote']

export interface IngestSummary {
  attempted: number
  inserted: number
  duplicates: number
  failed: number
  errors: string[]
  byPlatform: Record<string, { inserted: number; duplicates: number; failed: number }>
}

function toRow(job: RankedJob, withExtras: boolean) {
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
  if (withExtras) {
    if (job.posted_at && !Number.isNaN(Date.parse(job.posted_at))) row.posted_at = new Date(job.posted_at).toISOString()
    row.from_ats = ['greenhouse', 'lever', 'ashby', 'workable', 'smartrecruiters'].includes(job.platform)
  }
  return row
}

export async function ingestJobs(supabase: SupabaseClient, jobs: RankedJob[]): Promise<IngestSummary> {
  const summary: IngestSummary = { attempted: jobs.length, inserted: 0, duplicates: 0, failed: 0, errors: [], byPlatform: {} }
  let extras = true

  for (const job of jobs) {
    const bucket = (summary.byPlatform[job.platform] ??= { inserted: 0, duplicates: 0, failed: 0 })
    const url = job.apply_url || job.url
    if (url) {
      const { data: existing } = await supabase.from('jobs').select('id').eq('external_url', url).limit(1)
      if (existing && existing.length > 0) {
        summary.duplicates++
        bucket.duplicates++
        continue
      }
    }

    let { error } = await supabase.from('jobs').insert(toRow(job, extras))
    if (error && extras && /column|schema cache|PGRST204/i.test(`${error.message} ${error.code ?? ''}`)) {
      // Skema live belum punya posted_at/from_ats -> ulangi tanpa kolom tambahan.
      extras = false
      ;({ error } = await supabase.from('jobs').insert(toRow(job, false)))
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
