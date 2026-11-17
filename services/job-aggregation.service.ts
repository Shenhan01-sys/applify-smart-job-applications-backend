import { mcpRegistry, BoardEntry } from './mcp-registry.js'
import { JobPosting } from '../mcp/shared/types.js'
import { mapWithConcurrency, matchScoreOf, matchesKeywords, matchesLocation, relevanceScore } from '../mcp/shared/utils.js'

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
  /** Batas lowongan per sumber setelah filter (default 25). */
  limitPerSource?: number
  /** Batas papan per sumber ATS (default 8). */
  maxBoardsPerSource?: number
}

export interface RankedJob extends JobPosting {
  platform: string
  relevance: number
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
/** Urutan stabil: relevansi menurun, lalu tanggal terbit terbaru (tanggal tidak valid = 0). */
export const byRelevanceThenDate = (a: RankedJob, b: RankedJob) =>
  b.relevance - a.relevance || timeOf(b.posted_at) - timeOf(a.posted_at)

export async function aggregateJobs(params: AggregateParams): Promise<AggregateResult> {
  const t0 = Date.now()
  const keywords = (params.keywords ?? '').trim()
  const location = (params.location ?? 'Indonesia').trim()
  const locFilter = /^(any|all|semua|)$/i.test(location) ? '' : location
  const limit = params.limitPerSource ?? 25
  const maxBoards = params.maxBoardsPerSource ?? 8

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
      const res = await client.searchJobs({ keywords, location: locFilter, limit: Math.max(limit, 30) })
      if (!res.success) stat.errors.push(res.error || 'gagal')
      else raw.push(...((res.data?.jobs ?? []) as JobPosting[]))
    }

    stat.fetched = raw.length
    const kept = raw
      .filter((j) => matchesLocation(j.location, locFilter))
      // Sumber 'board' sudah memfilter kata kunci di server (pencarian semantik portal),
      // jadi filter ketat hanya untuk ATS yang mengembalikan seluruh isi papan.
      .filter((j) => client.kind !== 'ats' || matchesKeywords(j, keywords))
      .map((j) => {
        const r = relevanceScore(j, keywords, params.skills ?? [])
        return {
          ...j,
          platform,
          relevance: r.score,
          match_score: matchScoreOf(r),
          matchedKeywords: r.matchedKeywords,
          matchedSkills: r.matchedSkills,
        }
      })
      // Peringkat dulu, baru dipotong, supaya yang tersisa adalah lowongan paling relevan per sumber.
      .sort(byRelevanceThenDate)
      .slice(0, limit)
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
