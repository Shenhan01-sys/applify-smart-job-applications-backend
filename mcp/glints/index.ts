import { BaseMCPClient, BROWSER_LIKE_USER_AGENT, JobPosting, MCPResponse, SearchParams } from '../shared/types.js'
import { guessExperienceLevel, normalizeWorkType } from '../shared/utils.js'

/**
 * Glints — platform karier populer di Indonesia (juga SG/MY/VN).
 *
 * Sumber data: GraphQL publik `searchJobsV3` yang dipakai halaman eksplor Glints:
 *   POST https://glints.com/api/v2-alc/graphql?op=searchJobsV3
 *   variables.data = { SearchTerm, CountryCode: 'ID', includeExternalJobs, pageSize, page }
 *   -> data.searchJobsV3 { jobsInPage[ {id,title,company{name,brandName},city{name},
 *                                      country{code,name},salaries[],createdAt} ], hasMore }
 * Query & header mengikuti provider glints pada career-ops (MIT). Catatan mereka:
 * WAF Glints kadang menolak request non-browser -> klien ini punya fallback
 * menjalankan request yang sama dari dalam halaman glints.com via Playwright
 * (backend sudah memakai Playwright untuk LinkedIn). Matikan dengan
 * GLINTS_BROWSER_FALLBACK=false.
 *
 * Otomasi lamaran: butuh akun Glints -> worker memakai sesi pengguna, HITL.
 */
export const GLINTS_API = 'https://glints.com/api/v2-alc/graphql?op=searchJobsV3'
const SITE = 'https://glints.com'

export const GLINTS_QUERY = `
query searchJobsV3($data: JobSearchConditionInput!) {
  searchJobsV3(data: $data) {
    jobsInPage {
      id
      title
      company { name brandName }
      city { name }
      country { code name }
      salaries { salaryType salaryMode maxAmount minAmount CurrencyCode }
      createdAt
    }
    expInfo
    hasMore
  }
}`

function formatSalary(salaries: any): string | undefined {
  const s = Array.isArray(salaries) ? salaries[0] : null
  if (!s || (s.minAmount == null && s.maxAmount == null)) return undefined
  const fmt = (n: any) => (n == null ? '?' : Number(n).toLocaleString('id-ID'))
  return `${s.CurrencyCode ?? 'IDR'} ${fmt(s.minAmount)} - ${fmt(s.maxAmount)}${s.salaryMode ? ` / ${String(s.salaryMode).toLowerCase()}` : ''}`
}

export function normalizeGlintsJob(item: any): JobPosting | null {
  if (!item || typeof item !== 'object') return null
  const title = typeof item.title === 'string' ? item.title.trim() : ''
  const id = item.id != null ? String(item.id).trim() : ''
  if (!title || !id) return null
  const company = (item.company?.name || item.company?.brandName || '').trim() || 'Unknown'
  const city = (item.city?.name || '').trim()
  const country = (item.country?.name || '').trim()
  const location = [city, country].filter(Boolean).join(', ') || 'Indonesia'
  // Hasil pencarian Glints tidak memuat deskripsi; judul + perusahaan dipakai sebagai konteks awal.
  const description = `${title} — ${company}${city ? ` (${city})` : ''}`
  return {
    id,
    title,
    company,
    location,
    description,
    url: `${SITE}/id/opportunities/jobs/${encodeURIComponent(id)}`,
    posted_at: item.createdAt || undefined,
    experience_level: guessExperienceLevel(title),
    job_type: 'full-time',
    work_type: normalizeWorkType(location),
    salary_range: formatSalary(item.salaries),
    platform: 'glints',
    raw_data: { id, country: item.country?.code ?? null },
  }
}

export class GlintsMCPClient extends BaseMCPClient {
  name = 'glints'
  baseUrl = GLINTS_API
  displayName = 'Glints'
  kind = 'board' as const
  requiresCompany = false

  private body(params: SearchParams) {
    return {
      operationName: 'searchJobsV3',
      query: GLINTS_QUERY,
      variables: {
        data: {
          SearchTerm: params.keywords ?? '',
          CountryCode: 'ID',
          includeExternalJobs: true,
          pageSize: Math.min(Math.max(params.limit ?? 30, 1), 50),
          page: Math.max(params.page ?? 1, 1),
        },
      },
    }
  }

  private async viaFetch(params: SearchParams): Promise<any> {
    return this.fetch(GLINTS_API, {
      method: 'POST',
      body: JSON.stringify(this.body(params)),
      headers: { Origin: SITE, Referer: `${SITE}/id/opportunities/jobs/explore`, 'Accept-Language': 'id-ID,id;q=0.9' },
    })
  }

  /** Fallback: jalankan fetch GraphQL dari dalam konteks halaman glints.com (lolos WAF). */
  private async viaBrowser(params: SearchParams): Promise<any> {
    const { chromium } = await import('playwright')
    const browser = await chromium.launch({ headless: true })
    try {
      const context = await browser.newContext({ userAgent: BROWSER_LIKE_USER_AGENT, locale: 'id-ID' })
      const page = await context.newPage()
      await page.goto(`${SITE}/id/opportunities/jobs/explore`, { waitUntil: 'domcontentloaded', timeout: 30000 })
      return await page.evaluate(
        async ({ api, body }) => {
          const r = await fetch(api, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
            credentials: 'include',
          })
          return r.json()
        },
        { api: GLINTS_API, body: this.body(params) },
      )
    } finally {
      await browser.close()
    }
  }

  async searchJobs(params: SearchParams): Promise<MCPResponse> {
    let json: any
    let via = 'fetch'
    try {
      json = await this.viaFetch(params)
    } catch (err: any) {
      if (process.env.GLINTS_BROWSER_FALLBACK === 'false') {
        return { success: false, error: `glints: ${err.message}` }
      }
      try {
        json = await this.viaBrowser(params)
        via = 'browser'
      } catch (err2: any) {
        return { success: false, error: `glints: fetch gagal (${err.message}); fallback browser gagal (${err2.message})` }
      }
    }
    const list = json?.data?.searchJobsV3?.jobsInPage
    if (!Array.isArray(list)) {
      const msg = json?.errors?.[0]?.message || JSON.stringify(json ?? {}).slice(0, 160)
      return { success: false, error: `glints: respons tidak terduga — ${msg}` }
    }
    const jobs = list.map(normalizeGlintsJob).filter(Boolean) as JobPosting[]
    return { success: true, data: { jobs, total: jobs.length, hasMore: json.data.searchJobsV3.hasMore ?? null, via } }
  }

  async getJobDetails(_jobId: string): Promise<MCPResponse> {
    return { success: false, error: 'glints: detail lengkap dibuka lewat URL lowongan (butuh browser)' }
  }
}
