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

/** Permintaan pencarian tidak bisa dijalankan karena masukan pengguna kurang (jawaban HTTP 400). */
export class SearchInputError extends Error {
  readonly statusCode = 400
  constructor(
    message: string,
    readonly code: string
  ) {
    super(message)
    this.name = 'SearchInputError'
  }
}

export const KEYWORDS_REQUIRED_MESSAGE =
  'Kata kunci pencarian belum ada. Isi jabatan di profil atau kata kunci di Pengaturan Otomasi, lalu coba lagi.'

const MAX_DERIVED_TITLE_LENGTH = 60

/**
 * Kata kunci cadangan dari profil untuk pengguna baru yang belum mengisi kata kunci: jabatan sekarang (atau
 * headline bila pendek, karena kolom jabatan sering kosong) lalu tiga skill dengan tingkat kemahiran tertinggi.
 * Kosong bila profil belum memuat salah satunya.
 */
export function deriveKeywordsFromProfile(
  profile: { current_title?: unknown; headline?: unknown } | null | undefined,
  skillRows: Array<{ name?: unknown; proficiency_level?: unknown }> | null | undefined
): string {
  const clean = (v: unknown) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '')
  let title = clean(profile?.current_title)
  if (!title) {
    const headline = clean(profile?.headline)
    if (headline && headline.length <= MAX_DERIVED_TITLE_LENGTH) title = headline
  }
  const topSkills = (skillRows ?? [])
    .map((r, index) => ({ name: clean(r?.name), level: Number(r?.proficiency_level ?? 0) || 0, index }))
    .filter((r) => r.name)
    .sort((a, b) => b.level - a.level || a.index - b.index)
    .slice(0, 3)
    .map((r) => r.name)
  const seen = new Set<string>()
  const parts: string[] = []
  for (const part of [title, ...topSkills]) {
    const key = part.toLowerCase()
    if (!part || seen.has(key)) continue
    seen.add(key)
    parts.push(part)
  }
  return parts.join(' ')
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
      supabase.from('user_skills').select('name, proficiency_level').eq('user_id', userId),
    ])

    // Kata kunci: dari permintaan, lalu Pengaturan Otomasi, lalu (pengguna baru) dari profil. Kosong semua = 400,
    // karena pencarian tanpa kata kunci hanya menghasilkan lowongan acak yang tidak relevan.
    const fromRequest = typeof params.keywords === 'string' ? params.keywords.trim() : ''
    const fromSettings = Array.isArray(settings?.search_keywords)
      ? settings.search_keywords.filter((k: unknown) => typeof k === 'string' && k.trim()).join(' ').trim()
      : ''
    let keywords = fromRequest || fromSettings
    let keywordsSource: 'request' | 'settings' | 'profile' = fromRequest ? 'request' : 'settings'
    if (!keywords) {
      const { data: profile } = await supabase.from('profiles').select('current_title, headline').eq('id', userId).maybeSingle()
      keywords = deriveKeywordsFromProfile(profile, skillRows)
      keywordsSource = 'profile'
    }
    if (!keywords) throw new SearchInputError(KEYWORDS_REQUIRED_MESSAGE, 'keywords_required')
    const location = params.location ?? settings?.search_location ?? 'Indonesia'
    const skills = (skillRows ?? []).map((s: any) => s.name).filter(Boolean)
    const blacklistCompanies = (settings?.blacklist_companies ?? []).map((c: string) => c.toLowerCase())
    const blacklistWords = (settings?.blacklist_words ?? []).map((w: string) => w.toLowerCase())
    const workTypes: string[] = settings?.work_type_filter ?? []
    const levels: string[] = settings?.experience_level_filter ?? []

    const result = await aggregateJobs({
      keywords,
      location,
      platforms: params.platforms,
      companies: params.companies,
      skills,
      workTypes,
      experienceLevels: levels,
      desiredSalary: typeof settings?.desired_salary === 'number' ? settings.desired_salary : null,
      yearsOfExperience: settings?.years_of_experience ?? null,
      limitPerSource: params.limitPerSource,
      pages: params.pages,
    })

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
      keywords_source: keywordsSource,
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
      console.error('Failed to log action:', String((error as any)?.code ?? (error as any)?.message ?? 'db_error').slice(0, 120))
    }
  }
}

export const automationService = new AutomationService()
