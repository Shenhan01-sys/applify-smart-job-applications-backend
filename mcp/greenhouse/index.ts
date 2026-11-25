import { BaseMCPClient, JobPosting, MCPResponse, SearchParams } from '../shared/types.js'
import { guessExperienceLevel, htmlToText, jobTypeFromTitle, matchesKeywords, normalizeWorkType } from '../shared/utils.js'

/**
 * Greenhouse Job Board API (publik, tanpa API key).
 *   GET https://boards-api.greenhouse.io/v1/boards/{board}/jobs?content=true
 *   -> { jobs: [ { id, title, location{name}, absolute_url, updated_at, content(HTML ter-escape) } ], meta }
 * Formulir lamaran Greenhouse (job-boards.greenhouse.io/{board}/jobs/{id}) bisa diisi tanpa login.
 */
/**
 * Formulir Greenhouse yang di-host Greenhouse sendiri. `absolute_url` bisa berupa halaman karier perusahaan
 * (contoh: careers.datadoghq.com/detail/7131726/?gh_jid=7131726). Worker hanya mengirim lamaran di host yang ada di
 * SUBMIT_ALLOWED_HOSTS, jadi lamaran dari halaman perusahaan terisi tetapi tidak pernah terkirim (25 November 2026).
 */
export function greenhouseHostedUrl(board: unknown, id: unknown): string | null {
  const b = typeof board === 'string' ? board.trim() : ''
  const i = typeof id === 'number' || typeof id === 'string' ? String(id).trim() : ''
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(b) || !/^\d{1,20}$/.test(i)) return null
  return `https://job-boards.greenhouse.io/${b}/jobs/${i}`
}

export function normalizeGreenhouseJob(job: any, board: string, companyName?: string): JobPosting | null {
  if (!job || typeof job !== 'object' || !job.title) return null
  const description = htmlToText(job.content)
  const location = job.location?.name || 'Unknown'
  return {
    id: String(job.id),
    title: String(job.title).trim(),
    company: companyName || board,
    location,
    description,
    url: job.absolute_url,
    apply_url: greenhouseHostedUrl(board, job.id) ?? job.absolute_url,
    posted_at: job.updated_at,
    experience_level: guessExperienceLevel(job.title, description),
    job_type: jobTypeFromTitle(job.title),
    work_type: normalizeWorkType(location),
    platform: 'greenhouse',
    board,
    raw_data: { id: job.id, board },
  }
}

export class GreenhouseMCPClient extends BaseMCPClient {
  name = 'greenhouse'
  baseUrl = 'https://boards-api.greenhouse.io/v1'
  displayName = 'Greenhouse'
  kind = 'ats' as const
  requiresCompany = true

  async searchJobs(params: SearchParams): Promise<MCPResponse> {
    const { company, keywords } = params
    if (!company) return { success: false, error: 'greenhouse: parameter company (slug papan) wajib diisi' }
    try {
      const data = await this.fetch(`${this.baseUrl}/boards/${encodeURIComponent(company)}/jobs?content=true`)
      const jobs = (Array.isArray(data?.jobs) ? data.jobs : [])
        .map((j: any) => normalizeGreenhouseJob(j, company, data?.name))
        .filter((j: JobPosting | null): j is JobPosting => !!j && matchesKeywords(j, keywords))
      return { success: true, data: { jobs, total: jobs.length } }
    } catch (error: any) {
      return { success: false, error: `greenhouse(${company}): ${error.message}` }
    }
  }

  async getJobDetails(jobId: string, company?: string): Promise<MCPResponse> {
    if (!company) return { success: false, error: 'greenhouse: company wajib untuk detail' }
    try {
      const job = await this.fetch(`${this.baseUrl}/boards/${encodeURIComponent(company)}/jobs/${encodeURIComponent(jobId)}`)
      return { success: true, data: normalizeGreenhouseJob(job, company) }
    } catch (error: any) {
      return { success: false, error: `greenhouse: ${error.message}` }
    }
  }
}
