import { BaseMCPClient, JobPosting, MCPResponse, SearchParams } from '../shared/types.js'
import { guessExperienceLevel, htmlToText, matchesKeywords, normalizeJobType, normalizeWorkType, mapWithConcurrency } from '../shared/utils.js'

/**
 * SmartRecruiters — ATS global dengan Posting API publik resmi (tanpa API key).
 * Dipakai banyak perusahaan yang merekrut di Indonesia (mis. Grab, Cermati,
 * MCPayment, Veolia, Wall Street English).
 *
 *   GET https://api.smartrecruiters.com/v1/companies/{slug}/postings?limit=&offset=
 *     -> { totalFound, content: [ { id, name, ref, company{identifier,name},
 *                                   location{city,region,country,remote,fullLocation},
 *                                   releasedDate, typeOfEmployment{label},
 *                                   experienceLevel{label}, department{label} } ] }
 *   GET https://api.smartrecruiters.com/v1/companies/{slug}/postings/{id}
 *     -> { jobAd.sections{ companyDescription, jobDescription, qualifications, additionalInformation } }
 * Dokumentasi: https://developers.smartrecruiters.com/docs/get-job-postings
 *
 * Otomasi lamaran: formulir lamaran SmartRecruiters dapat diisi TANPA login
 * (halaman jobs.smartrecruiters.com/{slug}/{id}) -> sumber paling layak untuk
 * auto-fill oleh worker (tetap berhenti sebelum submit, HITL).
 */
const API = 'https://api.smartrecruiters.com/v1/companies'
const DETAIL_LIMIT = 15

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}

export function extractSmartRecruitersDescription(detail: any): string {
  const sections = detail?.jobAd?.sections
  if (!sections || typeof sections !== 'object') return ''
  return htmlToText(
    ['companyDescription', 'jobDescription', 'qualifications', 'additionalInformation']
      .map((k) => sections[k]?.text)
      .filter((t) => typeof t === 'string' && t.trim())
      .join('\n'),
  )
}

export function normalizeSmartRecruitersPosting(j: any, board: string): JobPosting | null {
  if (!j || typeof j !== 'object') return null
  const title = typeof j.name === 'string' ? j.name.trim() : ''
  const id = j.id != null ? String(j.id) : ''
  if (!title || !id) return null
  const slug = j.company?.identifier || board
  const loc = j.location ?? {}
  const full = loc.fullLocation || [loc.city, loc.region, loc.country].filter(Boolean).join(', ')
  const location = [full, loc.remote ? 'Remote' : ''].filter(Boolean).join(', ') || 'Unknown'
  const department = j.department?.label ?? ''
  const url = `https://jobs.smartrecruiters.com/${encodeURIComponent(slug)}/${encodeURIComponent(id)}${title ? `-${slugify(title)}` : ''}`
  return {
    id,
    title,
    company: j.company?.name || board,
    location,
    // Daftar posting tidak memuat deskripsi; diisi dari endpoint detail (lihat searchJobs).
    description: [title, department].filter(Boolean).join(' — '),
    url,
    apply_url: url,
    posted_at: j.releasedDate || undefined,
    // 47.3 P2-02: normalkan experience_level melalui guessExperienceLevel agar tidak menyimpan label mentah tak standar.
    experience_level: guessExperienceLevel(title, j.experienceLevel?.label ?? ''),
    job_type: normalizeJobType(j.typeOfEmployment?.label),
    work_type: normalizeWorkType(loc.remote ? 'remote' : '', loc.hybrid ? 'hybrid' : ''),
    platform: 'smartrecruiters',
    board,
    raw_data: { id, ref: j.ref ?? null, country: loc.country ?? null, department },
  }
}

export class SmartRecruitersMCPClient extends BaseMCPClient {
  name = 'smartrecruiters'
  baseUrl = API
  displayName = 'SmartRecruiters'
  kind = 'ats' as const
  requiresCompany = true

  async searchJobs(params: SearchParams): Promise<MCPResponse> {
    const board = params.company
    if (!board) return { success: false, error: 'smartrecruiters: parameter company (slug papan) wajib diisi' }
    try {
      const all: JobPosting[] = []
      const pageSize = 100
      for (let page = 0; page < 5; page++) {
        const data = await this.fetch(`${API}/${encodeURIComponent(board)}/postings?limit=${pageSize}&offset=${page * pageSize}`)
        const content = Array.isArray(data?.content) ? data.content : []
        all.push(...(content.map((j: any) => normalizeSmartRecruitersPosting(j, board)).filter(Boolean) as JobPosting[]))
        if (content.length < pageSize) break
      }

      // Filter lokasi dilakukan di aggregator; di sini saring kata kunci pada judul/departemen
      // lalu lengkapi deskripsi hanya untuk kandidat teratas (hemat request).
      const candidates = all.filter((j) => matchesKeywords({ title: j.title, description: j.description }, params.keywords))
      const top = candidates.slice(0, params.limit ?? DETAIL_LIMIT)
      await mapWithConcurrency(top, 4, async (job) => {
        try {
          const detail = await this.fetch(`${API}/${encodeURIComponent(board)}/postings/${encodeURIComponent(job.id)}`)
          const text = extractSmartRecruitersDescription(detail)
          if (text) job.description = text
        } catch {
          /* deskripsi opsional — biarkan ringkasan judul */
        }
      })
      return { success: true, data: { jobs: top, total: top.length, totalOnBoard: all.length } }
    } catch (error: any) {
      return { success: false, error: `smartrecruiters(${board}): ${error.message}` }
    }
  }

  async getJobDetails(jobId: string, company?: string): Promise<MCPResponse> {
    if (!company) return { success: false, error: 'smartrecruiters: company wajib untuk detail' }
    try {
      const detail = await this.fetch(`${API}/${encodeURIComponent(company)}/postings/${encodeURIComponent(jobId)}`)
      return { success: true, data: { ...normalizeSmartRecruitersPosting(detail, company), description: extractSmartRecruitersDescription(detail) } }
    } catch (error: any) {
      return { success: false, error: `smartrecruiters: ${error.message}` }
    }
  }
}
