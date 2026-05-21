export interface JobPosting {
  id: string
  title: string
  company: string
  location: string
  description: string
  url: string
  posted_at?: string
  experience_level?: string
  job_type?: string
  work_type?: string
  salary_range?: string
  requirements?: string[]
  skills?: string[]
  raw_data?: any
}

export interface MCPRequest {
  tool: string
  params: Record<string, any>
}

export interface MCPResponse {
  success: boolean
  data?: any
  error?: string
}

export abstract class BaseMCPClient {
  abstract name: string
  abstract baseUrl: string

  abstract searchJobs(params: {
    keywords?: string
    location?: string
    company?: string
    page?: number
    limit?: number
  }): Promise<MCPResponse>

  abstract getJobDetails(jobId: string): Promise<MCPResponse>

  protected async fetch(url: string, options?: RequestInit): Promise<any> {
    const response = await fetch(url, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...options?.headers,
      },
    })

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${await response.text()}`)
    }

    return response.json()
  }
}
