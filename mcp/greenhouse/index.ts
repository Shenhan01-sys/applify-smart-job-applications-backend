import { BaseMCPClient, JobPosting, MCPResponse, SearchParams } from '../shared/types.js'
import { getOrFetchBoardPayload } from '../shared/board-cache.js'
import { guessExperienceLevel, htmlToText, jobTypeFromTitle, matchesKeywords, normalizeWorkType } from '../shared/utils.js'

/**
 * Greenhouse Job Board API (publik, tanpa API key).
 *   GET https://boards-api.greenhouse.io/v1/boards/{board}/jobs?content=true
 *   -> { jobs: [ { id, title, location{name}, absolute_url, updated_at, content(HTML ter-escape) } ], meta }
 * Formulir lamaran Greenhouse (job-boards.greenhouse.io/{board}/jobs/{id}) bisa diisi tanpa login.
 */
/**
 * URL formulir yang bisa dikirim worker. `absolute_url` bisa berupa halaman karier perusahaan
 * (contoh: careers.datadoghq.com/detail/7131726/?gh_jid=7131726). Host itu tidak ada di SUBMIT_ALLOWED_HOSTS, dan papan
 * seperti Datadog juga mengalihkan job-boards.greenhouse.io/{board}/jobs/{id} ke halaman perusahaan (302), jadi
 * lamaran terisi tetapi tidak pernah terkirim (25 November 2026). Formulir embed Greenhouse
 * (job-boards.greenhouse.io/embed/job_app?for={board}&token={id}) tidak dialihkan dan tetap di host Greenhouse.
 * Bila `absolute_url` sudah di host Greenhouse, URL itu dipakai apa adanya.
 */
export function greenhouseApplyUrl(board: unknown, id: unknown, absoluteUrl: unknown): string | null {
  const abs = typeof absoluteUrl === 'string' ? absoluteUrl.trim() : ''
  try {
    if (abs && /(^|\.)greenhouse\.io$/i.test(new URL(abs).hostname)) return abs
  } catch {
    // URL tidak sah: pakai formulir embed bila papan dan id sah.
  }
  const b = typeof board === 'string' ? board.trim() : ''
  const i = typeof id === 'number' || typeof id === 'string' ? String(id).trim() : ''
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(b) || !/^\d{1,20}$/.test(i)) return abs || null
  return `https://job-boards.greenhouse.io/embed/job_app?for=${encodeURIComponent(b)}&token=${i}`
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
    apply_url: greenhouseApplyUrl(board, job.id, job.absolute_url) ?? job.absolute_url,
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
      const data = await getOrFetchBoardPayload(`greenhouse:${company}`, () =>
        this.fetch(`${this.baseUrl}/boards/${encodeURIComponent(company)}/jobs?content=true`)
      )
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
