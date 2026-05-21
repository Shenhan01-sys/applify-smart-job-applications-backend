import { BaseMCPClient, JobPosting, MCPResponse } from '../shared/types.js'

export class GreenhouseMCPClient extends BaseMCPClient {
  name = 'greenhouse'
  baseUrl = 'https://boards-api.greenhouse.io/v1'

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
          error: 'Company identifier is required for Greenhouse API',
        }
      }

      const url = `${this.baseUrl}/boards/${company}/jobs?content=true`
      const data = await this.fetch(url)

      let jobs: JobPosting[] = data.jobs.map((job: any) => ({
        id: job.id.toString(),
        title: job.title,
        company: data.name || company,
        location: job.location?.name || 'Remote',
        description: job.content,
        url: job.absolute_url,
        posted_at: job.updated_at,
        experience_level: this.extractExperienceLevel(job.title, job.content),
        job_type: this.extractJobType(job.title, job.content),
        work_type: this.extractWorkType(job.location?.name),
        raw_data: job,
      }))

      // Filter by keywords if provided
      if (keywords) {
        const keywordLower = keywords.toLowerCase()
        jobs = jobs.filter(
          (j) =>
            j.title.toLowerCase().includes(keywordLower) ||
            j.description.toLowerCase().includes(keywordLower)
        )
      }

      // Filter by location if provided
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
      // Greenhouse doesn't have a direct single job API
      // We need company context - this is a simplified version
      return {
        success: false,
        error: 'Greenhouse requires company context for job details',
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

  private extractJobType(title: string, content: string): string {
    const text = `${title} ${content}`.toLowerCase()
    if (text.includes('full-time') || text.includes('full time')) return 'full-time'
    if (text.includes('part-time') || text.includes('part time')) return 'part-time'
    if (text.includes('contract')) return 'contract'
    if (text.includes('internship')) return 'internship'
    return 'full-time'
  }

  private extractWorkType(location: string): string {
    if (!location) return 'onsite'
    const loc = location.toLowerCase()
    if (loc.includes('remote')) return 'remote'
    if (loc.includes('hybrid')) return 'hybrid'
    return 'onsite'
  }
}
