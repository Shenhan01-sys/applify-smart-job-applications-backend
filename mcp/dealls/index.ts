import { BaseMCPClient, JobPosting, MCPResponse, SearchParams } from '../shared/types.js'
import { guessExperienceLevel, normalizeJobType, normalizeWorkType } from '../shared/utils.js'

/**
 * Dealls (dealls.com) — portal lowongan Indonesia (grup Sejutacita), banyak untuk fresh graduate dan magang.
 *
 * Sumber data: API publik tanpa autentikasi yang dipakai halaman eksplor Dealls sendiri:
 *   GET https://api.sejutacita.id/v1/explore-job/job?page=&limit=&sortParam=mostRelevant&sortBy=asc&search=
 *   -> { data: { docs: [ { id, slug, role, employmentTypes[], workplaceType, publishedAt, status,
 *                          country{name}, city{name}, company{name,slug} } ], totalDocs, totalPages, page } }
 * Bentuk respons diverifikasi 2026-11-19. `limit` maksimum 50 (nilai 100 mengembalikan galat), `page` mulai dari 1.
 * URL detail: https://dealls.com/loker/<slug>~<company.slug> (dibuka 200 pada pemeriksaan yang sama).
 * Hasil pencarian tidak memuat deskripsi; judul + perusahaan dipakai sebagai konteks awal.
 *
 * Otomasi lamaran: butuh akun Dealls -> worker memakai sesi pengguna, HITL (belum ada handler khusus).
 */
export const DEALLS_API = 'https://api.sejutacita.id/v1/explore-job/job'
const SITE = 'https://dealls.com'

export function normalizeDeallsJob(item: any): JobPosting | null {
  if (!item || typeof item !== 'object') return null
  const title = typeof item.role === 'string' ? item.role.trim() : ''
  const id = item.id != null ? String(item.id).trim() : ''
  const slug = typeof item.slug === 'string' ? item.slug.trim() : ''
  if (!title || !id || !slug) return null
  if (item.status && item.status !== 'active') return null

  const company = (item.company?.name || '').trim() || 'Unknown'
  const companySlug = typeof item.company?.slug === 'string' ? item.company.slug.trim() : ''
  const city = (item.city?.name || '').trim()
  const country = (item.country?.name || '').trim()
  const workplace = typeof item.workplaceType === 'string' ? item.workplaceType : ''
  const location = [city, country].filter(Boolean).join(', ') || 'Indonesia'
  const types = Array.isArray(item.employmentTypes) ? item.employmentTypes.join(' ') : ''
  const description = `${title} — ${company}${city ? ` (${city})` : ''}`
  const path = companySlug ? `${encodeURIComponent(slug)}~${encodeURIComponent(companySlug)}` : encodeURIComponent(slug)

  return {
    id,
    title,
    company,
    location: /remote/i.test(workplace) ? `${location}, Remote` : location,
    description,
    url: `${SITE}/loker/${path}`,
    posted_at: item.publishedAt || item.createdAt || undefined,
    experience_level: guessExperienceLevel(title),
    // employmentTypes memakai camelCase (fullTime, partTime, internship); pisahkan agar normalizeJobType mengenalinya.
    job_type: normalizeJobType(types.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase()),
    work_type: normalizeWorkType(workplace, location),
    platform: 'dealls',
    raw_data: { id, workplaceType: workplace || null, employmentTypes: item.employmentTypes ?? [] },
  }
}

export class DeallsMCPClient extends BaseMCPClient {
  name = 'dealls'
  baseUrl = DEALLS_API
  displayName = 'Dealls'
  kind = 'board' as const
  requiresCompany = false

  async searchJobs(params: SearchParams): Promise<MCPResponse> {
    try {
      const url = new URL(DEALLS_API)
      url.searchParams.set('page', String(Math.max(params.page ?? 1, 1)))
      url.searchParams.set('limit', String(Math.min(Math.max(params.limit ?? 30, 1), 50)))
      url.searchParams.set('sortParam', 'mostRelevant')
      url.searchParams.set('sortBy', 'asc')
      if (params.keywords) url.searchParams.set('search', params.keywords)

      const data = await this.fetch(url.href, { headers: { Origin: SITE, Referer: `${SITE}/` } })
      const docs = data?.data?.docs
      if (!Array.isArray(docs)) {
        throw new Error(`respons Dealls tidak berisi data.docs (keys: ${Object.keys(data ?? {}).join(',')})`)
      }
      const jobs = docs.map(normalizeDeallsJob).filter(Boolean) as JobPosting[]
      return { success: true, data: { jobs, total: jobs.length, totalAvailable: data.data.totalDocs ?? null } }
    } catch (error: any) {
      return { success: false, error: `dealls: ${error.message}` }
    }
  }

  async getJobDetails(_jobId: string): Promise<MCPResponse> {
    return { success: false, error: 'dealls: detail lengkap dibuka lewat URL lowongan (butuh browser)' }
  }
}
