import { hasTerm, matchesLocation, normalizeText, tokenize } from '../mcp/shared/utils.js'
import type { JobPosting } from '../mcp/shared/types.js'

/**
 * Job Ranking C1 — Penilaian & pemeringkatan lowongan deterministik tanpa panggilan LLM.
 *
 * Pilihan bobot: Catatan 29 C1
 *   - fit (kesesuaian peran & skill dengan sinonim ID/EN + saturasi frekuensi BM25): 0.70
 *   - freshness (usia posted_at):                                                      0.15
 *   - salary (kelengkapan & kecocokan kisaran gaji):                                  0.10
 *   - workType (kecocokan remote / hybrid / on-site):                                  0.05
 * Lalu dikalikan locationFactor (0.55..1.0) dan dikurangi seniorityPenalty (0..25), lalu dijepit 0..100.
 *
 * Mengapa Catatan 29 (0.70/0.15/0.10/0.05) dibanding Catatan 28 (0.75/0.15/0.10):
 * Catatan 28 menggabungkan gaji dan tipe kerja ke satu komponen 0.10. Memisahkan gaji (0.10) dan
 * tipe kerja (0.05) membuat alasan skor (scoreReasons) dapat menjelaskan secara terpisah mengapa
 * lowongan bergaji transparan atau remote unggul, sambil tetap menjaga fit mendominasi (70%).
 */
export const C1_RANKING_WEIGHTS = {
  fit: 0.7,
  freshness: 0.15,
  salary: 0.1,
  workType: 0.05,
} as const

const DAY_MS = 24 * 60 * 60 * 1000
const BM25_K1 = 1.2

/** Kelompok sinonim peran & keahlian lintas Bahasa Indonesia <-> Inggris. Setiap entri lowercase. */
export const ID_EN_SYNONYM_GROUPS: readonly (readonly string[])[] = [
  ['backend', 'back-end', 'back end', 'server-side', 'api engineer', 'api developer'],
  ['frontend', 'front-end', 'front end', 'ui engineer', 'web developer', 'fe developer'],
  ['fullstack', 'full-stack', 'full stack'],
  ['software engineer', 'software developer', 'programmer', 'rekayasa perangkat lunak', 'developer'],
  ['data analyst', 'analis data', 'bi analyst', 'business intelligence'],
  ['data scientist', 'ilmuwan data', 'machine learning engineer'],
  ['data engineer', 'data pipeline', 'etl engineer'],
  ['devops', 'sre', 'site reliability', 'platform engineer', 'cloud engineer', 'infrastruktur'],
  ['qa', 'quality assurance', 'sdet', 'test engineer', 'automation tester', 'penguji'],
  ['mobile developer', 'android developer', 'ios developer', 'flutter', 'react native'],
  ['ui/ux', 'ui ux', 'product designer', 'ux designer', 'ui designer', 'desainer produk'],
  ['product manager', 'manajer produk', 'product owner'],
  ['intern', 'internship', 'magang', 'pkl', 'trainee'],
  ['accountant', 'akuntan', 'accounting', 'akuntansi', 'finance', 'keuangan'],
  ['marketing', 'pemasaran', 'digital marketing', 'growth'],
  ['sales', 'penjualan', 'business development', 'account executive'],
  ['hr', 'human resources', 'sumber daya manusia', 'sdm', 'recruiter', 'talent acquisition'],
  ['javascript', 'js', 'ecmascript'],
  ['typescript', 'ts'],
  ['react', 'reactjs', 'react.js', 'react js'],
  ['next.js', 'nextjs', 'next js'],
  ['node.js', 'nodejs', 'node js', 'node'],
  ['golang', 'go language'],
  ['postgresql', 'postgres'],
  ['kubernetes', 'k8s'],
  ['docker', 'containerization', 'kontainer'],
  ['aws', 'amazon web services'],
  ['gcp', 'google cloud', 'google cloud platform'],
  ['rest api', 'restful', 'restful api'],
  ['ci/cd', 'cicd', 'continuous integration'],
  ['machine learning', 'ml', 'pembelajaran mesin'],
  ['artificial intelligence', 'ai', 'kecerdasan buatan'],
  ['excel', 'microsoft excel', 'spreadsheet'],
]

export interface RankContext {
  keywords?: string
  skills?: string[]
  location?: string
  workTypes?: string[]
  experienceLevels?: string[]
  desiredSalary?: number | null
  yearsOfExperience?: number | string | null
  nowMs?: number
}

export interface RankBreakdown {
  /** null bila tidak ada kata kunci, skill, atau teks lowongan yang bisa dibandingkan. */
  fit: number | null
  freshness: number
  /** null bila lowongan tidak mencantumkan kisaran gaji. */
  salary: number | null
  workType: number
  locationFactor: number
  seniorityPenalty: number
  weights: string
}

export interface JobRankResult {
  /** Skor hybrid deterministik C1 0..100, atau null bila tidak ada dasar kecocokan (selaras dengan matchScore frontend). */
  score: number | null
  reasons: string[]
  matchedKeywords: string[]
  matchedSkills: string[]
  matchedSynonyms: string[]
  breakdown: RankBreakdown
}

const SENIORITY_RANK: Record<string, number> = {
  intern: 0,
  junior: 1,
  mid: 2,
  senior: 3,
  lead: 4,
}

function normalizeLevel(raw?: string | null): number | null {
  const s = normalizeText(raw)
  if (!s) return null
  if (/\b(intern|internship|magang|pkl|trainee)\b/.test(s)) return SENIORITY_RANK.intern
  if (/\b(junior|jr|fresh graduate|entry|associate)\b/.test(s)) return SENIORITY_RANK.junior
  if (/\b(principal|lead|head|manager|staff|director|vp)\b/.test(s)) return SENIORITY_RANK.lead
  if (/\b(senior|sr)\b/.test(s)) return SENIORITY_RANK.senior
  if (/\b(mid|middle|intermediate|menengah)\b/.test(s)) return SENIORITY_RANK.mid
  return null
}

function parseYears(raw: number | string | null | undefined): number | null {
  if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0) return raw
  if (typeof raw === 'string' && raw.trim() !== '') {
    const n = Number(raw.trim())
    if (Number.isFinite(n) && n >= 0) return n
  }
  return null
}

function levelRangeForCandidate(ctx: RankContext): [number, number] | null {
  const explicitRanks = (ctx.experienceLevels ?? []).map(normalizeLevel).filter((n): n is number => n !== null)
  if (explicitRanks.length > 0) {
    return [Math.min(...explicitRanks), Math.max(...explicitRanks)]
  }
  const yrs = parseYears(ctx.yearsOfExperience)
  if (yrs !== null && yrs > 0) {
    if (yrs < 1) return [0, 1]
    if (yrs <= 2) return [1, 2]
    if (yrs <= 5) return [1, 3]
    if (yrs <= 8) return [2, 4]
    return [3, 4]
  }
  const kwLevel = normalizeLevel(ctx.keywords)
  if (kwLevel !== null) return [kwLevel, kwLevel]
  return null
}

/** Hitung jumlah kemunculan kata/frasa `term` pada `normalizedHaystack` (maks. 20 untuk efisiensi). */
function countTermOccurrences(normalizedHaystack: string, term: string): number {
  const t = normalizeText(term)
  if (!t || !normalizedHaystack) return 0
  if (t.includes(' ')) {
    let count = 0
    let idx = 0
    while ((idx = normalizedHaystack.indexOf(t, idx)) !== -1) {
      count++
      idx += t.length
      if (count >= 20) break
    }
    return count
  }
  const escaped = t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`(?:^|\\s)${escaped}(?=\\s|$)`, 'g')
  const matches = normalizedHaystack.match(re)
  return matches ? Math.min(matches.length, 20) : 0
}

/** Saturasi ala BM25: mengembalikan nilai 0..1 sehingga pengulangan kata di deskripsi cepat jenuh. */
function bm25Saturate(tf: number, k1 = BM25_K1): number {
  if (tf <= 0) return 0
  return (tf * (k1 + 1)) / (tf + k1) / (1 + k1) * 1.15
}

function synonymVariantsFor(term: string, queryNorm: string): string[] {
  const t = normalizeText(term)
  const variants = new Set<string>()
  for (const group of ID_EN_SYNONYM_GROUPS) {
    const matchesPhraseInQuery = group.some((alias) => alias.includes(' ') && hasTerm(queryNorm, alias))
    const matchesTerm = group.includes(t)
    if (matchesTerm || (matchesPhraseInQuery && group.some((alias) => alias.split(' ').includes(t)))) {
      for (const alias of group) {
        if (alias !== t) variants.add(alias)
      }
    }
  }
  return [...variants]
}

function computeFreshnessScore(postedAt: string | undefined, nowMs: number): { score: number; reason: string } {
  const parsed = Date.parse(postedAt ?? '')
  if (Number.isNaN(parsed)) {
    return { score: 30, reason: 'Tanggal terbit belum tercantum' }
  }
  const ageDays = Math.max(0, (nowMs - parsed) / DAY_MS)
  if (ageDays <= 1) return { score: 100, reason: 'Baru diposting (<24 jam)' }
  if (ageDays <= 3) return { score: 88, reason: 'Diposting 2–3 hari lalu' }
  if (ageDays <= 7) return { score: 72, reason: 'Diposting minggu ini' }
  if (ageDays <= 14) return { score: 52, reason: 'Diposting 1–2 minggu lalu' }
  if (ageDays <= 30) return { score: 30, reason: 'Diposting 2–4 minggu lalu' }
  return { score: 10, reason: 'Lowongan lama (>30 hari)' }
}

function computeSalaryScore(job: JobPosting, desiredSalary?: number | null): { score: number | null; reason: string | null } {
  const maxSal = typeof job.salary_max === 'number' && job.salary_max > 0 ? job.salary_max : null
  const minSal = typeof job.salary_min === 'number' && job.salary_min > 0 ? job.salary_min : null
  const upper = maxSal ?? minSal
  const hasRangeText = typeof job.salary_range === 'string' && job.salary_range.trim().length > 0

  if (upper === null && !hasRangeText) {
    return { score: null, reason: null }
  }

  if (typeof desiredSalary === 'number' && desiredSalary > 0 && upper !== null) {
    if (upper >= desiredSalary) {
      return { score: 100, reason: 'Kisaran gaji sesuai target' }
    }
    const ratio = upper / desiredSalary
    const score = Math.max(20, Math.round(ratio * 85))
    return { score, reason: 'Gaji tercantum di bawah target' }
  }

  return { score: 75, reason: 'Kisaran gaji dicantumkan transparan' }
}

function computeWorkTypeScore(job: JobPosting, preferredWorkTypes?: string[]): { score: number; reason: string | null } {
  const jobWt = normalizeText(job.work_type)
  const prefs = (preferredWorkTypes ?? []).map((w) => normalizeText(w)).filter(Boolean)
  if (prefs.length > 0) {
    if (jobWt && prefs.includes(jobWt)) {
      return { score: 100, reason: `Tipe kerja cocok (${job.work_type})` }
    }
    if (!jobWt) return { score: 50, reason: null }
    return { score: 15, reason: `Tipe kerja (${job.work_type}) kurang sesuai preferensi` }
  }
  if (jobWt === 'remote') return { score: 85, reason: 'Mendukung kerja remote' }
  if (jobWt === 'hybrid') return { score: 70, reason: 'Skema kerja hybrid' }
  return { score: 55, reason: null }
}

export function rankJobC1(job: JobPosting, ctx: RankContext): JobRankResult {
  const nowMs = ctx.nowMs ?? Date.now()
  const titleNorm = normalizeText(job.title)
  const descText = [job.description, ...(job.requirements ?? []), ...(job.skills ?? [])].filter(Boolean).join(' ')
  const descNorm = normalizeText(descText)
  const queryNorm = normalizeText(ctx.keywords)
  const kwTokens = [...new Set(tokenize(ctx.keywords))]
  const skillTokens = [...new Set((ctx.skills ?? []).map((s) => normalizeText(s)).filter((s) => s.length > 1))]

  const matchedKeywords: string[] = []
  const matchedSkills: string[] = []
  const matchedSynonyms: string[] = []

  // Cari frasa sinonim multi-kata terlebih dahulu (mis. "analis data" <-> "data analyst").
  const phraseGroupsMatched = new Set<number>()
  for (let gi = 0; gi < ID_EN_SYNONYM_GROUPS.length; gi++) {
    const group = ID_EN_SYNONYM_GROUPS[gi]
    if (group.some((alias) => hasTerm(queryNorm, alias))) {
      const hitTitle = group.some((alias) => !hasTerm(queryNorm, alias) && hasTerm(titleNorm, alias))
      const hitDesc = !hitTitle && group.some((alias) => !hasTerm(queryNorm, alias) && hasTerm(descNorm, alias))
      if (hitTitle || hitDesc) phraseGroupsMatched.add(gi)
    }
  }

  let got = 0
  let max = 0

  for (const t of kwTokens) {
    max += 3
    const titleTf = countTermOccurrences(titleNorm, t)
    const descTf = countTermOccurrences(descNorm, t)
    if (titleTf > 0) {
      // Judul langsung bernilai penuh (dengan saturasi ringan di deskripsi agar pengulangan bukan faktor penentu).
      got += 2.65 + 0.35 * Math.min(1, bm25Saturate(titleTf + Math.min(descTf, 2) * 0.25))
      matchedKeywords.push(t)
    } else if (descTf > 0) {
      // Kemunculan hanya di deskripsi tersaturasi BM25 paling tinggi ~1.15 dari 3.0 supaya spam keyword kalah vs judul.
      got += Math.min(1.15, 1.15 * bm25Saturate(descTf))
      matchedKeywords.push(t)
    } else {
      const variants = synonymVariantsFor(t, queryNorm)
      const synTitle = variants.some((v) => countTermOccurrences(titleNorm, v) > 0)
      const synDescTf = variants.reduce((acc, v) => Math.max(acc, countTermOccurrences(descNorm, v)), 0)
      if (synTitle) {
        got += 2.4
        matchedKeywords.push(t)
        matchedSynonyms.push(t)
      } else if (synDescTf > 0) {
        got += Math.min(0.95, 0.95 * bm25Saturate(synDescTf))
        matchedKeywords.push(t)
        matchedSynonyms.push(t)
      }
    }
  }

  for (const s of skillTokens) {
    max += 2
    const titleTf = countTermOccurrences(titleNorm, s)
    const descTf = countTermOccurrences(descNorm, s)
    if (titleTf > 0 || descTf > 0) {
      got += titleTf > 0 ? 2 : 1.45 + 0.55 * Math.min(1, bm25Saturate(descTf))
      matchedSkills.push(s)
    } else {
      const variants = synonymVariantsFor(s, s)
      const synHit = variants.some((v) => countTermOccurrences(titleNorm, v) > 0 || countTermOccurrences(descNorm, v) > 0)
      if (synHit) {
        got += 1.65
        matchedSkills.push(s)
        matchedSynonyms.push(s)
      }
    }
  }

  // Bonus jika frasa peran lintas bahasa cocok penuh (mis. kueri "analis data" pada judul "Data Analyst").
  if (phraseGroupsMatched.size > 0 && max > 0 && got < max) {
    got = Math.min(max, got + 0.5 * phraseGroupsMatched.size)
  }

  // Tanpa kata kunci/skill atau tanpa teks lowongan tidak ada dasar perbandingan. Jangan mengarang skor 50.
  const jobTextEmpty = !titleNorm && !descNorm
  const fitScore = max === 0 || jobTextEmpty ? null : Math.min(100, Math.max(0, Math.round((got / max) * 100)))
  const freshness = computeFreshnessScore(job.posted_at, nowMs)
  const salary = computeSalaryScore(job, ctx.desiredSalary)
  const workType = computeWorkTypeScore(job, ctx.workTypes)

  // Faktor lokasi: remote atau cocok atau tanpa preferensi = 1.0; lokasi lowongan kosong = 0.85; mismatch = 0.55.
  const prefLoc = (ctx.location ?? '').trim()
  const anyLoc = !prefLoc || /^(any|all|semua)$/i.test(prefLoc)
  let locationFactor = 1.0
  let locationReason: string | null = null
  if (!anyLoc && normalizeText(job.work_type) !== 'remote') {
    if (!job.location || !job.location.trim()) {
      locationFactor = 0.85
      locationReason = 'Lokasi belum tercantum'
    } else if (matchesLocation(job.location, prefLoc)) {
      locationFactor = 1.0
      locationReason = `Lokasi cocok (${job.location})`
    } else {
      locationFactor = 0.55
      locationReason = `Lokasi di luar target (${job.location})`
    }
  }

  // Penalti seniority mismatch bila level kandidat terdefinisi.
  let seniorityPenalty = 0
  let seniorityReason: string | null = null
  const candRange = levelRangeForCandidate(ctx)
  const jobLevel = normalizeLevel(job.experience_level) ?? normalizeLevel(`${job.title} ${job.description ?? ''}`)
  if (candRange && jobLevel !== null) {
    const [minRank, maxRank] = candRange
    const gap = jobLevel < minRank ? minRank - jobLevel : jobLevel > maxRank ? jobLevel - maxRank : 0
    if (gap === 1) {
      seniorityPenalty = 5
      seniorityReason = 'Selisih tipis tingkat senioritas (-5)'
    } else if (gap === 2) {
      seniorityPenalty = 15
      seniorityReason = 'Penalti ketidaksesuaian senioritas (-15)'
    } else if (gap >= 3) {
      seniorityPenalty = 25
      seniorityReason = 'Penalti ketidaksesuaian senioritas jauh (-25)'
    } else {
      seniorityReason = 'Tingkat pengalaman sesuai'
    }
  }

  // Komponen tanpa data tidak ikut dihitung. Bobot komponen tersedia didistribusikan ulang secara proporsional,
  // supaya gaji yang tidak dicantumkan tidak menjadi angka sintetis dan tidak menghukum lowongan.
  const components: Array<{ weight: number; score: number }> = []
  if (fitScore !== null) components.push({ weight: C1_RANKING_WEIGHTS.fit, score: fitScore })
  components.push({ weight: C1_RANKING_WEIGHTS.freshness, score: freshness.score })
  if (salary.score !== null) components.push({ weight: C1_RANKING_WEIGHTS.salary, score: salary.score })
  components.push({ weight: C1_RANKING_WEIGHTS.workType, score: workType.score })
  const totalWeight = components.reduce((sum, c) => sum + c.weight, 0)
  const effectiveWeights = [
    fitScore !== null ? C1_RANKING_WEIGHTS.fit : 0,
    C1_RANKING_WEIGHTS.freshness,
    salary.score !== null ? C1_RANKING_WEIGHTS.salary : 0,
    C1_RANKING_WEIGHTS.workType,
  ]
  const weightsLabel = totalWeight > 0
    ? effectiveWeights.map((w) => (w / totalWeight).toFixed(2)).join('/')
    : '0.00/0.00/0.00/0.00'
  const rawWeighted = totalWeight > 0
    ? components.reduce((sum, c) => sum + c.weight * c.score, 0) / totalWeight
    : 0
  const score = fitScore === null
    ? null
    : Math.min(100, Math.max(0, Math.round(rawWeighted * locationFactor - seniorityPenalty)))

  const reasons: string[] = []
  if (fitScore === null) {
    reasons.push('Data skill/kata kunci belum cukup untuk menghitung skor kecocokan')
  } else {
    reasons.push(`Kecocokan peran/skill ${fitScore}%`)
  }
  if (matchedSynonyms.length > 0) {
    reasons.push(`Kecocokan sinonim ID/EN (${[...new Set(matchedSynonyms)].slice(0, 3).join(', ')})`)
  }
  reasons.push(freshness.reason)
  if (salary.score === null) reasons.push('Kisaran gaji belum tercantum')
  if (salary.reason) reasons.push(salary.reason)
  if (workType.reason) reasons.push(workType.reason)
  if (locationReason) reasons.push(locationReason)
  if (seniorityReason) reasons.push(seniorityReason)

  return {
    score,
    reasons,
    matchedKeywords: [...new Set(matchedKeywords)],
    matchedSkills: [...new Set(matchedSkills)],
    matchedSynonyms: [...new Set(matchedSynonyms)],
    breakdown: {
      fit: fitScore,
      freshness: freshness.score,
      salary: salary.score,
      workType: workType.score,
      locationFactor,
      seniorityPenalty,
      weights: weightsLabel,
    },
  }
}
