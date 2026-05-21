import { BaseMCPClient, JobPosting, MCPResponse } from '../shared/types.js'

export class WorkableMCPClient extends BaseMCPClient {
  name = 'workable'
  baseUrl = 'https://apply.workable.com/api/v1'

  async searchJobs(params: {
    keywords?: string
    location?: string
    company?: string
    page?: number
    limit?: number
  }): Promise<MCPResponse> {
    try {
      const { company, keywords, location } = params

      if (!company) {
        return {
          success: false,
          error: 'Company identifier is required for Workable API',
        }
      }

      const url = `${this.baseUrl}/widget/accounts/${company}?details=true`
      const data = await this.fetch(url)

      let jobs: JobPosting[] = data.jobs.map((job: any) => ({
        id: job.shortcode,
        title: job.title,
        company: data.account?.name || company,
        location: job.location?.location_str || 'Remote',
        description: job.description,
        url: job.application_url,
        posted_at: job.published_at,
        experience_level: this.extractExperienceLevel(job.title, job.description),
        job_type: job.employment_type || 'full-time',
        work_type: job.location?.location_str?.toLowerCase().includes('remote')
          ? 'remote'
          : 'onsite',
        requirements: job.requirements?.split('\n').filter((r: string) => r.trim()) || [],
        raw_data: job,
      }))

      if (keywords) {
        const keywordLower = keywords.toLowerCase()
        jobs = jobs.filter(
          (j) =>
            j.title.toLowerCase().includes(keywordLower) ||
            j.description.toLowerCase().includes(keywordLower)
        )
      }

      if (location) {
        const locationLower = location.toLowerCase()
        jobs = jobs.filter((j) =>
          j.location.toLowerCase().includes(locationLower)
        )
      }

      return { success: true, data: { jobs, total: jobs.length } }
    } catch (error: any) {
      return { success: false, error: error.message }
    }
  }

  async getJobDetails(jobId: string): Promise<MCPResponse> {
    try {
      return {
        success: false,
        error: 'Workable requires company context for job details',
      }
    } catch (error: any) {
      return { success: false, error: error.message }
    }
  }

  private extractExperienceLevel(title: string, content: string): string {
    const text = `${title} ${content}`.toLowerCase()
    if (text.includes('senior') || text.includes('sr.')) return 'senior'
    if (text.includes('lead') || text.includes('principal')) return 'lead'
    if (text.includes('junior') || text.includes('jr.')) return 'junior'
    if (text.includes('intern')) return 'intern'
    return 'mid'
  }
}
