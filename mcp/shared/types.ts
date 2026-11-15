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
  /** Platform id asal lowongan (mis. 'kalibrr', 'greenhouse'). Diisi oleh registry/aggregator. */
  platform?: string
  /** Slug papan perusahaan (khusus ATS: greenhouse/lever/ashby/workable/smartrecruiters). */
  board?: string
  /** URL formulir lamaran bila berbeda dari halaman lowongan. */
  apply_url?: string
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

export interface SearchParams {
  keywords?: string
  location?: string
  /** Slug papan perusahaan; WAJIB untuk klien ATS (requiresCompany = true). */
  company?: string
  page?: number
  limit?: number
}

/**
 * Kategori sumber lowongan:
 *  - 'ats'     : papan karier per perusahaan lewat API publik ATS (butuh `company`).
 *  - 'board'   : portal lowongan (agregator) lewat endpoint pencarian publik.
 *  - 'browser' : butuh sesi browser (Playwright) — mis. LinkedIn.
 */
export type SourceKind = 'ats' | 'board' | 'browser'

export abstract class BaseMCPClient {
  abstract name: string
  abstract baseUrl: string
  /** Nama tampilan untuk UI/dokumentasi. */
  displayName = ''
  kind: SourceKind = 'ats'
  /** True bila searchJobs() hanya bisa jalan dengan parameter `company` (slug papan). */
  requiresCompany = false

  abstract searchJobs(params: SearchParams): Promise<MCPResponse>

  abstract getJobDetails(jobId: string, company?: string): Promise<MCPResponse>

  protected async fetch(url: string, options?: RequestInit & { timeoutMs?: number }): Promise<any> {
    const { timeoutMs = 20000, ...init } = options || {}
    const response = await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        Accept: 'application/json',
        'User-Agent': BROWSER_LIKE_USER_AGENT,
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...init.headers,
      },
    })

    if (!response.ok) {
      const body = await response.text().catch(() => '')
      throw new Error(`HTTP ${response.status}: ${body.slice(0, 200)}`)
    }

    return response.json()
  }
}

export const BROWSER_LIKE_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
