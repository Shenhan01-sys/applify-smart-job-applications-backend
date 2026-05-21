import { BaseMCPClient, JobPosting, MCPResponse } from '../shared/types.js'

export class LeverMCPClient extends BaseMCPClient {
  name = 'lever'
  baseUrl = 'https://api.lever.co/v0/postings'

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
          error: 'Company identifier is required for Lever API',
        }
      }

      const url = `${this.baseUrl}/${company}?mode=json`
      const data = await this.fetch(url)

      let jobs: JobPosting[] = data.map((job: any) => ({
        id: job.id,
        title: job.text,
        company: job.categories?.team || company,
        location: job.categories?.location || 'Remote',
        description: job.description,
        url: job.applyUrl || job.hostedUrl,
        posted_at: job.createdAt,
        experience_level: this.extractExperienceLevel(job.text, job.description),
        job_type: job.categories?.commitment || 'full-time',
        work_type: this.extractWorkType(job.categories?.location),
        requirements: job.lists?.find((l: any) => l.text?.toLowerCase().includes('requirement'))?.content
          ?.split('\n')
          .filter((r: string) => r.trim()) || [],
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
        error: 'Lever requires company context for job details',
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

  private extractWorkType(location: string): string {
    if (!location) return 'onsite'
    const loc = location.toLowerCase()
    if (loc.includes('remote')) return 'remote'
    if (loc.includes('hybrid')) return 'hybrid'
    return 'onsite'
  }
}
