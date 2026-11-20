import type { SupabaseClient } from '@supabase/supabase-js'
import { aggregateJobs, AggregateResult } from './job-aggregation.service.js'
import { ingestJobs, IngestSummary } from './job-ingest.service.js'

export interface SearchParams {
  keywords?: string
  location?: string
  platforms?: string[]
  companies?: Record<string, string[]>
  userId: string
  /** Simpan hasil ke tabel jobs (default true). */
  persist?: boolean
  limitPerSource?: number
  /** Halaman hasil per sumber portal (default 1, maksimum 5). */
  pages?: number
}

export class AutomationService {
  /**
   * `client` hanya diisi di tes. Tanpa itu, klien Supabase milik server dimuat saat pertama dipakai
   * (bukan saat modul di-import, supaya modul ini bisa di-import tanpa menyalakan server).
   */
  constructor(private readonly client?: SupabaseClient) {}

  private async db(): Promise<SupabaseClient> {
    return this.client ?? ((await import('../api/index.js')).supabase as SupabaseClient)
  }

  /**
   * Cari lowongan lintas sumber (klien MCP), terapkan preferensi pengguna
   * (blacklist, tipe kerja), peringkat relevansi terhadap kata kunci + skill
   * pengguna, lalu (opsional) simpan ke tabel jobs. Skill profil (`user_skills`) dibaca di sini, tempat yang
   * sama dengan penyimpanan, dan dipakai untuk skor `match_score` tiap lowongan yang disimpan
   * (lihat job-ingest.service.ts dan relevanceScore di mcp/shared/utils.ts).
   */
  async searchJobs(params: SearchParams): Promise<AggregateResult & { ingest: IngestSummary | null }> {
    const { userId } = params
    const supabase = await this.db()

    const [{ data: settings }, { data: skillRows }] = await Promise.all([
      supabase.from('user_automation_settings').select('*').eq('user_id', userId).maybeSingle(),
      supabase.from('user_skills').select('name').eq('user_id', userId),
    ])

    const keywords =
      params.keywords ??
      (Array.isArray(settings?.search_keywords) ? settings.search_keywords.join(' ') : '') ??
      ''
    const location = params.location ?? settings?.search_location ?? 'Indonesia'
    const skills = (skillRows ?? []).map((s: any) => s.name).filter(Boolean)

    const result = await aggregateJobs({
      keywords,
      location,
      platforms: params.platforms,
      companies: params.companies,
      skills,
      limitPerSource: params.limitPerSource,
      pages: params.pages,
    })

    // Preferensi pengguna
    const blacklistCompanies = (settings?.blacklist_companies ?? []).map((c: string) => c.toLowerCase())
    const blacklistWords = (settings?.blacklist_words ?? []).map((w: string) => w.toLowerCase())
    const workTypes: string[] = settings?.work_type_filter ?? []
    const levels: string[] = settings?.experience_level_filter ?? []

    result.jobs = result.jobs.filter((j) => {
      if (blacklistCompanies.includes((j.company ?? '').toLowerCase())) return false
      const text = `${j.title} ${j.description}`.toLowerCase()
      if (blacklistWords.some((w: string) => text.includes(w))) return false
      if (workTypes.length && j.work_type && !workTypes.includes(j.work_type)) return false
      if (levels.length && j.experience_level && !levels.includes(j.experience_level)) return false
      return true
    })
    result.total = result.jobs.length

    const ingest = params.persist === false ? null : await ingestJobs(supabase, result.jobs)

    await this.logAction(userId, 'scan', 'multiple', '', '', 'success', {
      keywords,
      location,
      platforms: result.query.platforms,
      results_count: result.total,
      stats: result.stats.map((s) => ({ platform: s.platform, fetched: s.fetched, kept: s.afterFilter, errors: s.errors.length })),
      ingest: ingest
        ? { inserted: ingest.inserted, duplicates: ingest.duplicates, failed: ingest.failed, backfilled: ingest.backfilled, enriched: ingest.enriched }
        : null,
    })

    return { ...result, ingest }
  }

  async logAction(
    userId: string,
    action: string,
    platform: string,
    jobId: string,
    jobTitle: string,
    status: string,
    details?: any
  ) {
    try {
      const supabase = await this.db()
      await supabase.from('application_logs').insert({
        user_id: userId,
        action,
        platform,
        job_id: jobId,
        job_title: jobTitle,
        status,
        details,
      })
    } catch (error) {
      console.error('Failed to log action:', error)
    }
  }
}

export const automationService = new AutomationService()
