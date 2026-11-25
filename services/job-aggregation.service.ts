import { mcpRegistry, BoardEntry } from './mcp-registry.js'
import { JobPosting } from '../mcp/shared/types.js'
import { mapWithConcurrency, matchScoreOf, matchesKeywords, matchesLocation, relevanceScore } from '../mcp/shared/utils.js'
import { rankJobC1, type RankBreakdown } from './job-ranking.service.js'

/**
 * Job Aggregation Service — mengagregasi lowongan lintas sumber (klien MCP),
 * menormalkan, memfilter lokasi/kata kunci, menghapus duplikat, dan
 * memeringkat dengan skor relevansi deterministik (weighted keyword overlap).
 *
 * Murni (tanpa akses DB) supaya bisa dipakai oleh API Fastify, MCP server,
 * worker, maupun skrip smoke test. Penyimpanan ke tabel `jobs` ada di
 * job-ingest.service.ts.
 */

export interface AggregateParams {
  keywords?: string
  /** Default 'Indonesia'. Isi 'any' untuk tanpa filter lokasi. */
  location?: string
  /** Default: semua sumber non-browser (LinkedIn butuh sesi sehingga opt-in). */
  platforms?: string[]
  /** Override papan ATS per sumber, mis. { greenhouse: ['acommerce'] }. */
  companies?: Record<string, string[]>
  /** Skill kandidat untuk pembobotan relevansi. */
  skills?: string[]
  /** Preferensi tipe kerja (remote/hybrid/on-site) untuk peringkat C1. */
  workTypes?: string[]
  /** Preferensi level pengalaman untuk penalti seniority mismatch C1. */
  experienceLevels?: string[]
  /** Target gaji kandidat (opsional). */
  desiredSalary?: number | null
  /** Tahun pengalaman kandidat untuk deteksi level senioritas. */
  yearsOfExperience?: number | string | null
  /** Timestamp acuan (ms) untuk determinisme freshness dalam pengujian. */
  nowMs?: number
  /** Batas lowongan per sumber setelah filter (default 25). */
  limitPerSource?: number
  /** Batas papan per sumber ATS (default 8). */
  maxBoardsPerSource?: number
  /** Jumlah halaman hasil per sumber portal (default 1, maksimum MAX_PAGES). Sumber ATS tidak memakainya. */
  pages?: number
}

export const MAX_PAGES = 5
/** Jeda antarhalaman pada sumber yang sama (ms). Diubah lewat env supaya tes tidak menunggu. */
const PAGE_DELAY_MS = Number(process.env.SEARCH_PAGE_DELAY_MS ?? 800)
const sleep = (ms: number) => (ms > 0 ? new Promise<void>((r) => setTimeout(r, ms)) : Promise.resolve())

export interface RankedJob extends JobPosting {
  platform: string
  relevance: number
  /** Skor peringkat hybrid C1 (0..100), atau null bila tidak ada dasar kecocokan. */
  rank_score?: number | null
  /** Alasan skor C1 yang mudah diaudit pengguna (camelCase & snake_case untuk kompatibilitas UI/API). */
  score_reasons?: string[]
  scoreReasons?: string[]
  score_breakdown?: RankBreakdown
  /**
   * Nilai untuk kolom `jobs.match_score`: relevance bulat 0-100, atau null bila pencarian tidak punya kata
   * kunci dan pengguna tidak punya skill (tidak ada yang dibandingkan). Disimpan oleh job-ingest.service.ts.
   */
  match_score: number | null
  matchedKeywords: string[]
  matchedSkills: string[]
}

export interface SourceStat {
  platform: string
  displayName: string
  kind: string
  boards: string[]
  fetched: number
  afterFilter: number
  errors: string[]
  ms: number
}

export interface AggregateResult {
  query: { keywords: string; location: string; platforms: string[] }
  jobs: RankedJob[]
  total: number
  stats: SourceStat[]
  startedAt: string
  durationMs: number
}

const timeOf = (s?: string) => {
  const t = Date.parse(s ?? '')
  return Number.isNaN(t) ? 0 : t
}
const numericRank = (job: RankedJob): number | null =>
  typeof job.rank_score === 'number' && Number.isFinite(job.rank_score) ? job.rank_score : null

/**
 * Urutan stabil: lowongan dengan skor hybrid C1 numerik selalu di atas yang berskor null, lalu skor menurun,
 * lalu relevansi legacy, lalu tanggal terbit terbaru. Tidak ada NaN dari perbandingan null.
 */
export const byRelevanceThenDate = (a: RankedJob, b: RankedJob) => {
  const ar = numericRank(a)
  const br = numericRank(b)
  if (ar !== null && br !== null) return br - ar || b.relevance - a.relevance || timeOf(b.posted_at) - timeOf(a.posted_at)
  if (ar !== null) return -1
  if (br !== null) return 1
  return b.relevance - a.relevance || timeOf(b.posted_at) - timeOf(a.posted_at)
}

export async function aggregateJobs(params: AggregateParams): Promise<AggregateResult> {
  const t0 = Date.now()
  const keywords = (params.keywords ?? '').trim()
  const location = (params.location ?? 'Indonesia').trim()
  const locFilter = /^(any|all|semua|)$/i.test(location) ? '' : location
  const limit = params.limitPerSource ?? 25
  const maxBoards = params.maxBoardsPerSource ?? 8
  const pages = Math.min(Math.max(Math.floor(params.pages ?? 1), 1), MAX_PAGES)

  const available = mcpRegistry.describe()
  const requested = params.platforms?.length
    ? params.platforms.map((p) => p.toLowerCase())
    : available.filter((s) => s.kind !== 'browser').map((s) => s.name)
  const platforms = requested.filter((p) => mcpRegistry.get(p))

  const stats: SourceStat[] = []
  const collected: RankedJob[] = []

  await mapWithConcurrency(platforms, 4, async (platform) => {
    const client = mcpRegistry.get(platform)!
    const s0 = Date.now()
    const stat: SourceStat = {
      platform,
      displayName: client.displayName || platform,
      kind: client.kind,
      boards: [],
      fetched: 0,
      afterFilter: 0,
      errors: [],
      ms: 0,
    }
    const raw: JobPosting[] = []

    if (client.requiresCompany) {
      const override = params.companies?.[platform]
      const boards: BoardEntry[] = (override?.length ? override.map((slug) => ({ slug })) : mcpRegistry.boardsFor(platform)).slice(0, maxBoards)
      stat.boards = boards.map((b) => b.slug)
      if (boards.length === 0) stat.errors.push('tidak ada papan (company) terdaftar untuk sumber ini')
      await mapWithConcurrency(boards, 3, async (board) => {
        const res = await client.searchJobs({ keywords, company: board.slug, limit: 50 })
        if (!res.success) {
          stat.errors.push(res.error || `gagal: ${board.slug}`)
          return
        }
        for (const j of (res.data?.jobs ?? []) as JobPosting[]) {
          raw.push({ ...j, board: board.slug, company: board.name && j.company === board.slug ? board.name : j.company })
        }
      })
    } else {
      // Halaman 1..pages; berhenti bila halaman kosong atau gagal. Jeda antarhalaman supaya tidak membanjiri portal.
      for (let page = 1; page <= pages; page++) {
        if (page > 1) await sleep(PAGE_DELAY_MS)
        const res = await client.searchJobs({ keywords, location: locFilter, limit: Math.max(limit, 30), page })
        if (!res.success) {
          stat.errors.push(res.error || 'gagal')
          break
        }
        const got = (res.data?.jobs ?? []) as JobPosting[]
        raw.push(...got)
        if (got.length === 0) break
      }
    }

    stat.fetched = raw.length
    const kept = raw
      .filter((j) => matchesLocation(j.location, locFilter))
      // Sumber 'board' sudah memfilter kata kunci di server (pencarian semantik portal),
      // jadi filter ketat hanya untuk ATS yang mengembalikan seluruh isi papan.
      .filter((j) => client.kind !== 'ats' || matchesKeywords(j, keywords))
      .map((j) => {
        const legacy = relevanceScore(j, keywords, params.skills ?? [])
        const c1 = rankJobC1(j, {
          keywords,
          skills: params.skills ?? [],
          location: locFilter || location,
          workTypes: params.workTypes,
          experienceLevels: params.experienceLevels,
          desiredSalary: params.desiredSalary,
          yearsOfExperience: params.yearsOfExperience,
          nowMs: params.nowMs ?? t0,
        })
        return {
          ...j,
          platform,
          relevance: legacy.score,
          rank_score: c1.score,
          score_reasons: c1.reasons,
          scoreReasons: c1.reasons,
          score_breakdown: c1.breakdown,
          match_score: matchScoreOf(legacy),
          matchedKeywords: c1.matchedKeywords,
          matchedSkills: c1.matchedSkills,
        }
      })
      // Peringkat dulu, baru dipotong, supaya yang tersisa adalah lowongan paling relevan per sumber.
      .sort(byRelevanceThenDate)
      .slice(0, client.requiresCompany ? limit : limit * pages)
    stat.afterFilter = kept.length
    stat.ms = Date.now() - s0
    collected.push(...kept)
    stats.push(stat)
  })

  // Deduplikasi lintas sumber berdasarkan URL (fallback: judul+perusahaan).
  const seen = new Set<string>()
  const jobs = collected
    .filter((j) => {
      const key = (j.url || `${j.title}|${j.company}`).toLowerCase()
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .sort(byRelevanceThenDate)

  stats.sort((a, b) => platforms.indexOf(a.platform) - platforms.indexOf(b.platform))
  return {
    query: { keywords, location: locFilter || 'any', platforms },
    jobs,
    total: jobs.length,
    stats,
    startedAt: new Date(t0).toISOString(),
    durationMs: Date.now() - t0,
  }
}
