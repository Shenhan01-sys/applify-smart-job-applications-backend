import { BaseMCPClient, JobPosting, MCPResponse } from '../shared/types.js'

export class AshbyMCPClient extends BaseMCPClient {
  name = 'ashby'
  baseUrl = 'https://jobs.ashbyhq.com/api/non-user-graphql'

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
          error: 'Company identifier is required for Ashby API',
        }
      }

      const query = `
        query {
          jobBoardWithToken(token: "${company}") {
            jobPostings {
              id
              title
              locationName
              departmentName
              description
              employmentType
              publishedAt
              isRemote
              applyUrl
            }
          }
        }
      `

      const response = await fetch(this.baseUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query }),
      })

      const data = await response.json()

      let jobs: JobPosting[] =
        data.data?.jobBoardWithToken?.jobPostings.map((job: any) => ({
          id: job.id,
          title: job.title,
          company: job.departmentName || company,
          location: job.locationName || (job.isRemote ? 'Remote' : 'Unknown'),
          description: job.description,
          url: job.applyUrl,
          posted_at: job.publishedAt,
          experience_level: 'mid',
          job_type: job.employmentType || 'full-time',
          work_type: job.isRemote ? 'remote' : 'onsite',
          raw_data: job,
        })) || []

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
        error: 'Ashby requires company context for job details',
      }
    } catch (error: any) {
      return { success: false, error: error.message }
    }
  }
}
