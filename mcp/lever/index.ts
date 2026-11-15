import { BaseMCPClient, JobPosting, MCPResponse, SearchParams } from '../shared/types.js'
import { guessExperienceLevel, htmlToText, matchesKeywords, normalizeJobType, normalizeWorkType } from '../shared/utils.js'

/**
 * Lever Postings API (publik, tanpa API key).
 *   GET https://api.lever.co/v0/postings/{board}?mode=json
 *   -> [ { id, text, categories{location,commitment,team,department}, descriptionPlain,
 *          description, lists[{text,content}], hostedUrl, applyUrl, createdAt, workplaceType } ]
 * Formulir lamaran Lever (jobs.lever.co/{board}/{id}/apply) bisa diisi tanpa login.
 */
export function normalizeLeverPosting(job: any, board: string, companyName?: string): JobPosting | null {
  if (!job || typeof job !== 'object' || !job.text) return null
  const lists = Array.isArray(job.lists)
    ? job.lists.map((l: any) => `${l?.text ?? ''}\n${htmlToText(l?.content)}`).join('\n')
    : ''
  const description = [job.descriptionPlain || htmlToText(job.description), lists].filter(Boolean).join('\n').trim()
  const location = job.categories?.location || (Array.isArray(job.categories?.allLocations) ? job.categories.allLocations.join(', ') : '') || 'Unknown'
  const requirements = (Array.isArray(job.lists) ? job.lists : [])
    .filter((l: any) => /requirement|qualification|kualifikasi|persyaratan/i.test(l?.text ?? ''))
    .flatMap((l: any) => htmlToText(l.content).split('\n').map((s: string) => s.trim()).filter(Boolean))
  return {
    id: String(job.id),
    title: String(job.text).trim(),
    company: companyName || board,
    location,
    description,
    url: job.hostedUrl || job.applyUrl,
    apply_url: job.applyUrl || job.hostedUrl,
    posted_at: job.createdAt ? new Date(job.createdAt).toISOString() : undefined,
    experience_level: guessExperienceLevel(job.text, description),
    job_type: normalizeJobType(job.categories?.commitment),
    work_type: normalizeWorkType(job.workplaceType, location),
    requirements,
    platform: 'lever',
    board,
    raw_data: { id: job.id, team: job.categories?.team ?? null },
  }
}

export class LeverMCPClient extends BaseMCPClient {
  name = 'lever'
  baseUrl = 'https://api.lever.co/v0/postings'
  displayName = 'Lever'
  kind = 'ats' as const
  requiresCompany = true

  async searchJobs(params: SearchParams): Promise<MCPResponse> {
    const { company, keywords } = params
    if (!company) return { success: false, error: 'lever: parameter company (slug papan) wajib diisi' }
    try {
      const data = await this.fetch(`${this.baseUrl}/${encodeURIComponent(company)}?mode=json`)
      const jobs = (Array.isArray(data) ? data : [])
        .map((j: any) => normalizeLeverPosting(j, company))
        .filter((j: JobPosting | null): j is JobPosting => !!j && matchesKeywords(j, keywords))
      return { success: true, data: { jobs, total: jobs.length } }
    } catch (error: any) {
      return { success: false, error: `lever(${company}): ${error.message}` }
    }
  }

  async getJobDetails(jobId: string, company?: string): Promise<MCPResponse> {
    if (!company) return { success: false, error: 'lever: company wajib untuk detail' }
    try {
      const job = await this.fetch(`${this.baseUrl}/${encodeURIComponent(company)}/${encodeURIComponent(jobId)}?mode=json`)
      return { success: true, data: normalizeLeverPosting(job, company) }
    } catch (error: any) {
      return { success: false, error: `lever: ${error.message}` }
    }
  }
}
