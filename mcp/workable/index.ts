import { BaseMCPClient, JobPosting, MCPResponse, SearchParams } from '../shared/types.js'
import { getOrFetchBoardPayload } from '../shared/board-cache.js'
import { guessExperienceLevel, htmlToText, matchesKeywords, normalizeJobType, normalizeWorkType } from '../shared/utils.js'

/**
 * Workable widget API (publik, tanpa API key).
 *   GET https://apply.workable.com/api/v1/widget/accounts/{board}?details=true
 *   -> { name, jobs: [ { title, shortcode, shortlink, url, department, city, state,
 *                        country, telecommuting, published_on, description, employment_type } ] }
 * Versi sebelumnya membaca field yang tidak ada (location.location_str, application_url)
 * sehingga lokasi selalu "Remote" — diperbaiki.
 */
export function normalizeWorkableJob(job: any, board: string, companyName?: string): JobPosting | null {
  if (!job || typeof job !== 'object' || !job.title) return null
  const location = [job.city, job.state, job.country].filter((x: any) => typeof x === 'string' && x.trim()).join(', ')
    || (job.telecommuting ? 'Remote' : 'Unknown')
  const description = htmlToText(job.description)
  const url = job.shortlink || job.url
  return {
    id: String(job.shortcode ?? job.id ?? url),
    title: String(job.title).trim(),
    company: companyName || board,
    location: job.telecommuting && !/remote/i.test(location) ? `${location}, Remote` : location,
    description,
    url,
    apply_url: url,
    posted_at: job.published_on || job.created_at,
    experience_level: guessExperienceLevel(job.title, description),
    job_type: normalizeJobType(job.employment_type),
    work_type: normalizeWorkType(job.telecommuting ? 'remote' : '', location),
    platform: 'workable',
    board,
    raw_data: { shortcode: job.shortcode ?? null, department: job.department ?? null },
  }
}

export class WorkableMCPClient extends BaseMCPClient {
  name = 'workable'
  baseUrl = 'https://apply.workable.com/api/v1'
  displayName = 'Workable'
  kind = 'ats' as const
  requiresCompany = true

  async searchJobs(params: SearchParams): Promise<MCPResponse> {
    const { company, keywords } = params
    if (!company) return { success: false, error: 'workable: parameter company (slug papan) wajib diisi' }
    try {
      const data = await getOrFetchBoardPayload(`workable:${company}`, () =>
        this.fetch(`${this.baseUrl}/widget/accounts/${encodeURIComponent(company)}?details=true`)
      )
      const jobs = (Array.isArray(data?.jobs) ? data.jobs : [])
        .map((j: any) => normalizeWorkableJob(j, company, data?.name))
        .filter((j: JobPosting | null): j is JobPosting => !!j && matchesKeywords(j, keywords))
      return { success: true, data: { jobs, total: jobs.length } }
    } catch (error: any) {
      return { success: false, error: `workable(${company}): ${error.message}` }
    }
  }

  async getJobDetails(_jobId: string): Promise<MCPResponse> {
    return { success: false, error: 'workable: detail sudah disertakan pada hasil pencarian papan (details=true)' }
  }
}
