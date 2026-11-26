import { BaseMCPClient, JobPosting, MCPResponse, SearchParams } from '../shared/types.js'
import { guessExperienceLevel, htmlToText, matchesKeywords, normalizeJobType, normalizeWorkType } from '../shared/utils.js'

/**
 * Ashby public Job Posting API (terdokumentasi, tanpa API key). Menggantikan
 * endpoint GraphQL internal (non-user-graphql) yang dipakai versi sebelumnya.
 *   GET https://api.ashbyhq.com/posting-api/job-board/{board}?includeCompensation=true
 *   -> { jobs: [ { id, title, location, secondaryLocations[{location}], department,
 *                  isRemote, workplaceType, employmentType, descriptionPlain,
 *                  descriptionHtml, publishedAt, jobUrl, applyUrl } ] }
 */
export function extractAshbyCompensation(comp: any): { salary_min?: number; salary_max?: number; salary_currency?: string } {
  if (!comp || typeof comp !== 'object') return {}
  const comps: any[] = Array.isArray(comp.summaryComponents)
    ? comp.summaryComponents
    : Array.isArray(comp.compensationTiers?.[0]?.components)
      ? comp.compensationTiers[0].components
      : []
  const salaryComp = comps.find((c) => /salary/i.test(String(c?.compensationType ?? ''))) ?? comps[0]
  if (!salaryComp) return {}
  const min = Number(salaryComp.minValue)
  const max = Number(salaryComp.maxValue)
  const currency = typeof salaryComp.currencyCode === 'string' && salaryComp.currencyCode.trim() ? salaryComp.currencyCode.trim().toUpperCase() : undefined
  const out: { salary_min?: number; salary_max?: number; salary_currency?: string } = {}
  if (Number.isFinite(min) && min > 0) out.salary_min = Math.round(min)
  if (Number.isFinite(max) && max > 0) out.salary_max = Math.round(max)
  if (currency && (out.salary_min || out.salary_max)) out.salary_currency = currency
  return out
}

export function normalizeAshbyJob(job: any, board: string, companyName?: string): JobPosting | null {
  if (!job || typeof job !== 'object' || !job.title) return null
  const locs = [job.location, ...(Array.isArray(job.secondaryLocations) ? job.secondaryLocations.map((s: any) => s?.location) : [])]
    .filter((l: any) => typeof l === 'string' && l.trim())
  const country = job.address?.postalAddress?.addressCountry
  if (country && !locs.some((l: string) => l.includes(country))) locs.push(country)
  const location = locs.join(', ') || (job.isRemote ? 'Remote' : 'Unknown')
  const description = job.descriptionPlain || htmlToText(job.descriptionHtml)
  const salary = extractAshbyCompensation(job.compensation)
  return {
    id: String(job.id),
    title: String(job.title).trim(),
    company: companyName || board,
    location,
    description,
    url: job.jobUrl || job.applyUrl,
    apply_url: job.applyUrl || job.jobUrl,
    posted_at: job.publishedAt,
    experience_level: guessExperienceLevel(job.title, description),
    job_type: normalizeJobType(job.employmentType),
    work_type: normalizeWorkType(job.workplaceType, job.isRemote === true && !job.workplaceType ? 'remote' : ''),
    ...salary,
    platform: 'ashby',
    board,
    raw_data: { id: job.id, department: job.department ?? null },
  }
}

export class AshbyMCPClient extends BaseMCPClient {
  name = 'ashby'
  baseUrl = 'https://api.ashbyhq.com/posting-api/job-board'
  displayName = 'Ashby'
  kind = 'ats' as const
  requiresCompany = true

  async searchJobs(params: SearchParams): Promise<MCPResponse> {
    const { company, keywords } = params
    if (!company) return { success: false, error: 'ashby: parameter company (slug papan) wajib diisi' }
    try {
      const data = await this.fetch(`${this.baseUrl}/${encodeURIComponent(company)}?includeCompensation=true`)
      const jobs = (Array.isArray(data?.jobs) ? data.jobs : [])
        .map((j: any) => normalizeAshbyJob(j, company))
        .filter((j: JobPosting | null): j is JobPosting => !!j && matchesKeywords(j, keywords))
      return { success: true, data: { jobs, total: jobs.length } }
    } catch (error: any) {
      return { success: false, error: `ashby(${company}): ${error.message}` }
    }
  }

  async getJobDetails(_jobId: string): Promise<MCPResponse> {
    return { success: false, error: 'ashby: detail sudah disertakan pada hasil pencarian papan' }
  }
}
