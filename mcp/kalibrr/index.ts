import { BaseMCPClient, JobPosting, MCPResponse, SearchParams } from '../shared/types.js'
import { guessExperienceLevel, htmlToText, normalizeJobType, normalizeWorkType } from '../shared/utils.js'

/**
 * Kalibrr (kalibrr.com) — portal lowongan Asia Tenggara, mayoritas lowongan Indonesia.
 *
 * Sumber data: endpoint JSON publik tanpa autentikasi yang dipakai halaman
 * job board Kalibrr sendiri:
 *   GET https://www.kalibrr.com/kjs/job_board/search?limit=&offset=&text=
 *   -> { jobs: [...], count: <total match> }
 * Bentuk respons diverifikasi 2026-10-01 (id, name, slug, company{name,code},
 * google_location.address_components{city,region,country}, activation_date,
 * is_work_from_home, description). Referensi pola: provider Kalibrr pada
 * career-ops (MIT, career-ops-hq/career-ops PR #4420).
 *
 * Otomasi lamaran: melamar di Kalibrr butuh akun Kalibrr -> dijalankan worker
 * (agent-browser) memakai sesi pengguna, tetap berhenti sebelum submit (HITL).
 */
export const KALIBRR_API = 'https://www.kalibrr.com/kjs/job_board/search'
const SITE = 'https://www.kalibrr.com'

export function normalizeKalibrrJob(job: any): JobPosting | null {
  if (!job || typeof job !== 'object') return null
  const title = typeof job.name === 'string' ? job.name.trim() : ''
  const id = job.id != null ? String(job.id) : ''
  if (!title || !id) return null

  const code = typeof job.company?.code === 'string' && job.company.code.trim() ? job.company.code.trim() : '-'
  const slug = typeof job.slug === 'string' ? job.slug.trim() : ''
  const url = `${SITE}/c/${encodeURIComponent(code)}/jobs/${encodeURIComponent(id)}${slug ? `/${encodeURIComponent(slug)}` : ''}`

  const addr = job.google_location?.address_components ?? {}
  const parts: string[] = []
  for (const key of ['city', 'region', 'country']) {
    const v = typeof addr[key] === 'string' ? addr[key].trim() : ''
    if (v && !parts.includes(v)) parts.push(v)
  }
  if (job.is_work_from_home === true) parts.push('Remote')

  const description = htmlToText([job.description, job.qualifications].filter(Boolean).join('\n'))
  const company = (job.company?.name || job.company_name || '').trim() || 'Unknown'

  return {
    id,
    title,
    company,
    location: parts.join(', ') || 'Indonesia',
    description,
    url,
    posted_at: job.activation_date || job.created_at || undefined,
    experience_level: guessExperienceLevel(title, description),
    job_type: normalizeJobType(job.tenure || job.employment_type),
    work_type: normalizeWorkType(job.is_work_from_home === true ? 'remote' : '', job.work_setup),
    platform: 'kalibrr',
    raw_data: { id: job.id, company_code: code, country: addr.country ?? null },
  }
}

export class KalibrrMCPClient extends BaseMCPClient {
  name = 'kalibrr'
  baseUrl = KALIBRR_API
  displayName = 'Kalibrr'
  kind = 'board' as const
  requiresCompany = false

  async searchJobs(params: SearchParams): Promise<MCPResponse> {
    try {
      const pageSize = Math.min(Math.max(params.limit ?? 50, 1), 100)
      const page = Math.max(params.page ?? 1, 1)
      const url = new URL(KALIBRR_API)
      url.searchParams.set('limit', String(pageSize))
      url.searchParams.set('offset', String((page - 1) * pageSize))
      if (params.keywords) url.searchParams.set('text', params.keywords)
      // Kalibrr melokalisasi hasil berdasarkan IP peminta (dari Railway hasilnya Filipina).
      // country=Indonesia mengunci hasil ke lowongan Indonesia: dari IP Indonesia 57 hasil dengan 7 Filipina
      // menjadi 50 hasil semuanya Indonesia (diverifikasi 2026-11-19). country_code=ID tidak berpengaruh.
      url.searchParams.set('country', 'Indonesia')

      const data = await this.fetch(url.href, { headers: { Referer: `${SITE}/job-board` } })
      if (!data || !Array.isArray(data.jobs)) {
        throw new Error(`respons Kalibrr tidak berisi array jobs (keys: ${Object.keys(data ?? {}).join(',')})`)
      }
      const jobs = data.jobs.map(normalizeKalibrrJob).filter(Boolean) as JobPosting[]
      return { success: true, data: { jobs, total: jobs.length, totalAvailable: data.count ?? null } }
    } catch (error: any) {
      return { success: false, error: `kalibrr: ${error.message}` }
    }
  }

  async getJobDetails(_jobId: string): Promise<MCPResponse> {
    return { success: false, error: 'kalibrr: detail diambil dari hasil pencarian (deskripsi sudah disertakan)' }
  }
}
