import { BaseMCPClient, JobPosting, MCPResponse, SearchParams } from '../shared/types.js'
import { guessExperienceLevel, htmlToText, normalizeJobType, normalizeWorkType } from '../shared/utils.js'
import { parseSalaryLabel, salaryFields } from '../../services/salary.js'

/**
 * JobStreet Indonesia (SEEK Group) — portal lowongan terbesar di Indonesia.
 *
 * Versi lama klien ini men-scrape halaman dengan Playwright + selector CSS yang
 * sudah tidak cocok dengan situs. Diganti ke SEEK v5 JobSearch API yang dipakai
 * front-end JobStreet sendiri (publik, tanpa token):
 *   GET https://id.jobstreet.com/api/jobsearch/v5/search
 *       ?siteKey=ID-Main&keywords=&where=&pageSize=&page=
 *   -> { data: [ { id, title, advertiser{description}, companyName,
 *                  locations[{label}], listingDate, teaser, bulletPoints,
 *                  workTypes[], workArrangements{data[{label{text}}]} } ], totalCount }
 * URL detail Indonesia memakai prefix locale /id/: https://id.jobstreet.com/id/job/<id>.
 * Referensi pola: provider jobstreet pada career-ops (MIT, diverifikasi live 2026-08-28).
 *
 * Otomasi lamaran: butuh akun JobStreet (SEEK) -> worker memakai sesi pengguna, HITL.
 */
export const JOBSTREET_API = 'https://id.jobstreet.com/api/jobsearch/v5/search'
const ORIGIN = 'https://id.jobstreet.com'

export function normalizeJobStreetItem(item: any): JobPosting | null {
  if (!item || typeof item !== 'object') return null
  const title = typeof item.title === 'string' ? item.title.trim() : ''
  const id = item.id != null ? String(item.id).trim() : ''
  if (!title || !id) return null

  const company = (item.advertiser?.description || item.companyName || '').trim() || 'Unknown'
  const location = (item.locations?.[0]?.label || item.location || '').trim() || 'Indonesia'
  const bullets = Array.isArray(item.bulletPoints) ? item.bulletPoints.join('\n') : ''
  const description = htmlToText([item.teaser, bullets].filter(Boolean).join('\n'))
  const arrangement = Array.isArray(item.workArrangements?.data)
    ? item.workArrangements.data.map((d: any) => d?.label?.text ?? '').join(' ')
    : ''
  const workTypes = Array.isArray(item.workTypes) ? item.workTypes.join(' ') : ''

  return {
    id,
    title,
    company,
    location,
    description,
    url: `${ORIGIN}/id/job/${encodeURIComponent(id)}`,
    posted_at: item.listingDate || undefined,
    experience_level: guessExperienceLevel(title, description),
    job_type: normalizeJobType(workTypes),
    work_type: normalizeWorkType(arrangement, location),
    salary_range: item.salaryLabel || undefined,
    ...salaryFields(parseSalaryLabel(item.salaryLabel)),
    platform: 'jobstreet',
    raw_data: { id, roleId: item.roleId ?? null, workTypes: item.workTypes ?? [] },
  }
}

export class JobStreetMCPClient extends BaseMCPClient {
  name = 'jobstreet'
  baseUrl = JOBSTREET_API
  displayName = 'JobStreet'
  kind = 'board' as const
  requiresCompany = false

  async searchJobs(params: SearchParams): Promise<MCPResponse> {
    try {
      const url = new URL(JOBSTREET_API)
      url.searchParams.set('siteKey', 'ID-Main')
      if (params.keywords) url.searchParams.set('keywords', params.keywords)
      // "Indonesia" bukan filter kota yang dikenali SEEK — biarkan kosong (sudah ID-Main).
      if (params.location && !/^indonesia$/i.test(params.location.trim())) {
        url.searchParams.set('where', params.location)
      }
      url.searchParams.set('pageSize', String(Math.min(Math.max(params.limit ?? 30, 1), 100)))
      url.searchParams.set('page', String(Math.max(params.page ?? 1, 1)))
      url.searchParams.set('locale', 'id-ID')

      const data = await this.fetch(url.href, {
        headers: { 'Accept-Language': 'id-ID,id;q=0.9,en;q=0.8', Referer: `${ORIGIN}/id/jobs` },
      })
      if (!data || !Array.isArray(data.data)) {
        throw new Error(`respons SEEK v5 tidak berisi array data (keys: ${Object.keys(data ?? {}).join(',')})`)
      }
      const jobs = data.data.map(normalizeJobStreetItem).filter(Boolean) as JobPosting[]
      return { success: true, data: { jobs, total: jobs.length, totalAvailable: data.totalCount ?? null } }
    } catch (error: any) {
      return { success: false, error: `jobstreet: ${error.message}` }
    }
  }

  async getJobDetails(_jobId: string): Promise<MCPResponse> {
    return { success: false, error: 'jobstreet: detail lengkap dibuka lewat URL lowongan (butuh browser)' }
  }
}
