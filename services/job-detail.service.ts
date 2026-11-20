import type { SupabaseClient } from '@supabase/supabase-js'
import { BROWSER_LIKE_USER_AGENT } from '../mcp/shared/types.js'
import { htmlToText } from '../mcp/shared/utils.js'
import { parseSalaryLabel, periodFromMode, sanitizeSalary, toDbSalary, type ParsedSalary } from './salary.js'

/**
 * Job Detail Service — melengkapi lowongan yang tersimpan dari hasil pencarian (hanya judul, perusahaan, lokasi,
 * dan cuplikan deskripsi) dengan isi halaman lowongannya: deskripsi lengkap, syarat, gaji, dan skill.
 *
 *  - fetchJobDetail   : ambil dan urai SATU halaman lowongan (JobStreet, Dealls). Tanpa klik, tanpa login, tanpa
 *                       melewati captcha. Glints tidak didukung: halamannya dilindungi captcha.
 *  - extractRequirements : ambil butir syarat dari teks deskripsi (bagian "Kualifikasi", "Requirements", ...).
 *  - enrichJob        : pasang hasilnya ke baris `jobs`, hanya bidang yang jadi lebih baik, tanpa menimpa data bagus.
 *
 * Keamanan: URL berasal dari kolom `jobs.external_url` yang diisi hasil scraping, jadi host dibatasi ke daftar
 * putih per platform (HTTPS, tanpa port khusus), setiap lompatan redirect dicek ulang sebelum diikuti,
 * waktu tunggu 15 detik, dan isi dibatasi 3 MB.
 */

export interface JobDetail {
  descriptionHtml?: string
  descriptionText: string
  requirements: string[]
  salary: ParsedSalary | null
  skills: string[]
}

export type DetailFailure = 'unsupported' | 'not_found' | 'failed'
/** ok=true -> `detail` terisi; ok=false -> `reason` terisi. (Bukan union: tsconfig tidak strict, union boolean tidak menyempit.) */
export interface DetailResult {
  ok: boolean
  detail?: JobDetail
  reason?: DetailFailure
}

export interface FetchDetailOptions {
  timeoutMs?: number
  maxBytes?: number
}

/** Host yang boleh diambil, per platform. Platform di luar daftar ini tidak didukung. */
export const DETAIL_HOSTS: Record<string, readonly string[]> = {
  jobstreet: ['id.jobstreet.com', 'www.jobstreet.co.id', 'jobstreet.co.id'],
  dealls: ['dealls.com', 'www.dealls.com'],
}

export const DETAIL_TIMEOUT_MS = 15_000
export const DETAIL_MAX_BYTES = 3 * 1024 * 1024
const MAX_REDIRECTS = 3
const MAX_DESCRIPTION_CHARS = 20_000
const MAX_REQUIREMENTS = 15
const MAX_REQUIREMENT_CHARS = 200
const MAX_SKILLS = 20

/** Platform yang cocok untuk sebuah URL (dari host), atau null. */
export function platformForUrl(url: string | null | undefined): string | null {
  if (!url) return null
  let host: string
  try {
    host = new URL(url).hostname.toLowerCase()
  } catch {
    return null
  }
  for (const [platform, hosts] of Object.entries(DETAIL_HOSTS)) if (hosts.includes(host)) return platform
  return null
}

function isAllowed(platform: string, u: URL): boolean {
  const hosts = DETAIL_HOSTS[platform]
  return Boolean(hosts) && u.protocol === 'https:' && !u.port && !u.username && !u.password && hosts.includes(u.hostname.toLowerCase())
}

// ---------------------------------------------------------------------------------------------------------
// HTML -> teks
// ---------------------------------------------------------------------------------------------------------

function unescapeMarkup(s: string): string {
  return s.replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'").replace(/&amp;/gi, '&')
}

/**
 * HTML deskripsi -> teks per baris. Item daftar (`<li>`) diberi awalan "• " supaya masih bisa dikenali sebagai butir,
 * karena htmlToText biasa membuang penanda daftar. Deskripsi yang HTML-nya ter-escape (&lt;p&gt;) di-unescape dulu.
 */
export function descriptionToText(html: unknown): string {
  if (typeof html !== 'string' || !html.trim()) return ''
  let src = html
  if (/&lt;\/?[a-z]/i.test(src) && !/<\/?[a-z]/i.test(src)) src = unescapeMarkup(src)
  src = src.replace(/<\s*li\b[^>]*>/gi, '\n• ')
  const text = htmlToText(src)
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .join('\n')
  if (text.length <= MAX_DESCRIPTION_CHARS) return text
  const cut = text.slice(0, MAX_DESCRIPTION_CHARS)
  const nl = cut.lastIndexOf('\n')
  return (nl > MAX_DESCRIPTION_CHARS * 0.8 ? cut.slice(0, nl) : cut).trimEnd()
}

// ---------------------------------------------------------------------------------------------------------
// Syarat dari teks
// ---------------------------------------------------------------------------------------------------------

const MODIFIER = "(?:job|minimum|basic|key|preferred|required|general|technical|essential|additional|umum)"
const REQ_KEYWORD =
  "(?:kualifikasi|persyaratan|syarat|requirements?|qualifications?|skills?|kriteria|kemampuan|what you(?:'ll)? need|what we(?:'re| are) looking for|who you are|your profile|about you|yang kami cari|yang dibutuhkan)"
const REQ_HEADING = new RegExp(`^(?:${MODIFIER}\\s+){0,2}${REQ_KEYWORD}(?:\\s+\\S+){0,3}\\s*:?$`, 'i')
const OTHER_HEADING = new RegExp(
  '^(?:job\\s+)?(?:responsibilit(?:y|ies)|tanggung\\s+jawab|deskripsi|description|about(?:\\s+(?:the|us|company|this))?|tentang|' +
    "benefits?|tunjangan|fasilitas|kompensasi|compensation|we\\s+offer|what\\s+we\\s+offer|what\\s+you(?:'ll)?\\s+(?:do|get)|" +
    'your\\s+role|the\\s+role|perks|gaji|salary|lokasi|location|jam\\s+kerja|working\\s+hours|cara\\s+melamar|how\\s+to\\s+apply|' +
    'catatan|notes?|company|perusahaan|overview|ringkasan|keuntungan|tugas|job\\s+scope|scope)(?:\\s+\\S+){0,3}\\s*:?$',
  'i',
)
const BULLET = /^(?:[•·▪●◦■□✓✔►▶*–—-]|\d{1,2}[.)]|[a-z][.)])\s+/i

const wordCount = (s: string) => s.split(/\s+/).filter(Boolean).length
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s)

/**
 * Butir syarat dari teks deskripsi: baris di bawah judul yang cocok dengan kualifikasi|persyaratan|syarat|
 * requirements|qualifications|what you need|skills (dan padanannya) sampai judul bagian berikutnya.
 * Awalan butir (•, -, 1., a.) dibuang; maksimum 15 butir, tiap butir paling banyak 200 karakter. Tanpa judul
 * seperti itu hasilnya kosong (tidak menebak dari isi paragraf).
 *
 * Judul bagian berikutnya = judul yang dikenal (Responsibilities, Benefits, Tentang ...), atau, setelah ada
 * butir berawalan, baris pendek tanpa tanda baca akhir dan tanpa awalan butir.
 */
export function extractRequirements(text: unknown): string[] {
  const items: string[] = []
  let inSection = false
  let sawBullet = false
  for (const raw of String(text ?? '').split('\n')) {
    const line = raw.trim()
    if (!line) continue
    const bullet = BULLET.exec(line)
    const body = (bullet ? line.slice(bullet[0].length) : line).trim()
    if (!body) continue
    if (!bullet) {
      const bare = body.replace(/^[#*_\s]+|[*_\s]+$/g, '')
      if (bare.length <= 70 && !/[.;]$/.test(bare) && REQ_HEADING.test(bare)) {
        inSection = true
        sawBullet = false
        continue
      }
      if (inSection) {
        if (bare.length <= 70 && OTHER_HEADING.test(bare)) {
          inSection = false
          continue
        }
        // Sub-judul di dalam bagian syarat ("Pengalaman:") dilewati, bukan dimasukkan sebagai butir.
        if (/:$/.test(bare) && bare.length <= 60) continue
        if (sawBullet && bare.length <= 60 && wordCount(bare) <= 6 && !/[.;,]$/.test(bare)) {
          inSection = false
          continue
        }
      }
    }
    if (!inSection) continue
    items.push(clip(body, MAX_REQUIREMENT_CHARS))
    if (bullet) sawBullet = true
    if (items.length >= MAX_REQUIREMENTS) break
  }
  return items
}

// ---------------------------------------------------------------------------------------------------------
// Penguraian halaman
// ---------------------------------------------------------------------------------------------------------

/** Potong objek JSON seimbang yang dimulai di `start` (src[start] === '{'), sadar string dan escape. */
function balancedJson(src: string, start: number): string | null {
  let depth = 0
  let inStr = false
  for (let i = start; i < src.length; i++) {
    const c = src[i]
    if (inStr) {
      if (c === '\\') i++
      else if (c === '"') inStr = false
      continue
    }
    if (c === '"') inStr = true
    else if (c === '{') depth++
    else if (c === '}' && --depth === 0) return src.slice(start, i + 1)
  }
  return null
}

function parseJsonLoose(raw: string): any | null {
  try {
    return JSON.parse(raw)
  } catch {
    /* coba perbaikan ringan di bawah */
  }
  try {
    // `undefined` dari serializer JS dan karakter kontrol mentah di dalam string.
    return JSON.parse(raw.replace(/:\s*undefined\b/g, ':null').replace(/[\u0000-\u001f]+/g, ' '))
  } catch {
    return null
  }
}

/** Objek `window.SEEK_REDUX_DATA = {...}` dari halaman JobStreet, atau null. */
export function parseSeekReduxData(html: string): any | null {
  const marker = html.indexOf('window.SEEK_REDUX_DATA')
  if (marker < 0) return null
  const eq = html.indexOf('=', marker)
  if (eq < 0) return null
  const brace = html.indexOf('{', eq)
  if (brace < 0 || html.slice(eq + 1, brace).trim() !== '') return null
  const raw = balancedJson(html, brace)
  return raw ? parseJsonLoose(raw) : null
}

function isJobPostingNode(n: any): boolean {
  const t = n?.['@type']
  return Array.isArray(t) ? t.includes('JobPosting') : t === 'JobPosting'
}

/** Simpul JobPosting pertama dari semua blok `application/ld+json` (termasuk @graph dan larik). */
export function parseJsonLdJobPosting(html: string): any | null {
  const re = /<script\b[^>]*\btype\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null) {
    const data = parseJsonLoose(m[1].trim())
    if (!data) continue
    const stack: any[] = [data]
    while (stack.length) {
      const node = stack.shift()
      if (Array.isArray(node)) stack.push(...node)
      else if (node && typeof node === 'object') {
        if (isJobPostingNode(node)) return node
        if (Array.isArray(node['@graph'])) stack.push(...node['@graph'])
      }
    }
  }
  return null
}

function cleanSkills(v: unknown): string[] {
  const list: unknown[] = Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[,;\n]/) : []
  const out = list
    .map((x) => (typeof x === 'string' ? x : (x as any)?.name))
    .filter((x): x is string => typeof x === 'string')
    .map((x) => x.replace(/\s+/g, ' ').trim())
    .filter((x) => x.length > 0 && x.length <= 60)
  return [...new Set(out)].slice(0, MAX_SKILLS)
}

function salaryFromBaseSalary(base: any): ParsedSalary | null {
  const b = Array.isArray(base) ? base[0] : base
  if (!b || typeof b !== 'object') return null
  const v = b.value
  const currency = b.currency ?? (v && typeof v === 'object' ? v.currency : undefined)
  if (v && typeof v === 'object') {
    return sanitizeSalary({ min: v.minValue ?? v.value, max: v.maxValue ?? v.value, currency, period: periodFromMode(v.unitText) })
  }
  if (typeof v === 'number') return sanitizeSalary({ min: v, max: v, currency, period: periodFromMode(b.unitText) })
  if (typeof v === 'string') {
    const n = Number(v)
    return Number.isFinite(n) ? sanitizeSalary({ min: n, max: n, currency, period: periodFromMode(b.unitText) }) : parseSalaryLabel(v)
  }
  return null
}

function detailFromJsonLd(node: any): JobDetail | null {
  const html = typeof node?.description === 'string' ? node.description : ''
  const text = descriptionToText(html)
  if (!text) return null
  return {
    descriptionHtml: html,
    descriptionText: text,
    requirements: extractRequirements(text),
    salary: salaryFromBaseSalary(node.baseSalary),
    skills: cleanSkills(node.skills),
  }
}

function detailFromSeek(data: any): JobDetail | null {
  const job = data?.jobdetails?.result?.job
  if (!job || typeof job !== 'object') return null
  const html = typeof job.content === 'string' ? job.content : ''
  const text = descriptionToText(html) || descriptionToText(typeof job.abstract === 'string' ? job.abstract : '')
  if (!text) return null
  const label = typeof job.salary === 'string' ? job.salary : typeof job.salary?.label === 'string' ? job.salary.label : null
  return {
    descriptionHtml: html || undefined,
    descriptionText: text,
    requirements: extractRequirements(text),
    salary: parseSalaryLabel(label),
    skills: [],
  }
}

/** Isi `<script id="__NEXT_DATA__">` halaman Next.js (Dealls), atau null. */
export function parseNextData(html: string): any | null {
  const m = /<script\b[^>]*\bid\s*=\s*["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i.exec(html)
  return m ? parseJsonLoose(m[1].trim()) : null
}

/**
 * Objek lowongan di __NEXT_DATA__ Dealls (props.pageProps.dehydratedState.queries[0].state.data): ciri-cirinya
 * `role` berupa string dan salah satu dari description/responsibilities/requirements berupa string HTML.
 * Objek terjemahan i18n yang juga punya kunci `requirements` (isinya "Kualifikasi") tidak punya `role`.
 */
export function findDeallsJob(data: any): any | null {
  const queue: any[] = [data]
  let seen = 0
  while (queue.length && seen++ < 5000) {
    const o = queue.shift()
    if (!o || typeof o !== 'object') continue
    if (!Array.isArray(o) && typeof o.role === 'string' && ['description', 'responsibilities', 'requirements'].some((k) => typeof o[k] === 'string')) return o
    queue.push(...(Array.isArray(o) ? o : Object.values(o)))
  }
  return null
}

function detailFromDeallsNode(node: any): JobDetail | null {
  const asStr = (v: unknown) => (typeof v === 'string' ? v : '')
  const intro = descriptionToText(asStr(node.description))
  const resp = descriptionToText(asStr(node.responsibilities))
  const req = descriptionToText(asStr(node.requirements))
  if (!intro && !resp && !req) return null
  // Judul bagian mengikuti tampilan situs ("Deskripsi Pekerjaan", "Kualifikasi") supaya teksnya terbaca dan
  // butir syarat tetap bisa diurai ulang dari teks yang tersimpan.
  const text = [intro, resp && `Deskripsi Pekerjaan\n${resp}`, req && `Kualifikasi\n${req}`].filter(Boolean).join('\n')
  const sr = node.salaryRange
  return {
    descriptionHtml: [asStr(node.description), asStr(node.responsibilities), asStr(node.requirements)].filter(Boolean).join(''),
    descriptionText: text.length > MAX_DESCRIPTION_CHARS ? text.slice(0, MAX_DESCRIPTION_CHARS).trimEnd() : text,
    requirements: req ? extractRequirements(`Kualifikasi\n${req}`) : [],
    salary: sr && typeof sr === 'object' ? sanitizeSalary({ min: sr.start, max: sr.end, currency: 'IDR', period: 'month' }) : null,
    skills: [],
  }
}

/** Urai satu halaman lowongan menurut platformnya. null bila isinya tidak bisa dikenali. */
export function parseJobPage(platform: string, html: string): JobDetail | null {
  if (platform === 'jobstreet') {
    const seek = parseSeekReduxData(html)
    const fromSeek = seek ? detailFromSeek(seek) : null
    if (fromSeek) return fromSeek
  }
  const ld = parseJsonLdJobPosting(html)
  if (platform === 'dealls') {
    // Dealls menyajikan syarat dan tanggung jawab terpisah di __NEXT_DATA__; JSON-LD hanya teks gabungan tanpa judul.
    const next = findDeallsJob(parseNextData(html))
    const fromNext = next ? detailFromDeallsNode(next) : null
    if (fromNext) {
      if (ld) {
        fromNext.salary ??= salaryFromBaseSalary(ld.baseSalary)
        fromNext.skills = cleanSkills(ld.skills)
      }
      return fromNext
    }
  }
  return ld ? detailFromJsonLd(ld) : null
}

// ---------------------------------------------------------------------------------------------------------
// Ambil halaman
// ---------------------------------------------------------------------------------------------------------

/** Baca isi respons sampai batas byte; null bila melebihi batas. */
async function readLimited(res: Response, maxBytes: number): Promise<string | null> {
  const declared = Number(res.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel().catch(() => {})
    return null
  }
  if (!res.body) {
    const t = await res.text()
    return t.length > maxBytes ? null : t
  }
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel().catch(() => {})
      return null
    }
    chunks.push(value)
  }
  const buf = new Uint8Array(total)
  let off = 0
  for (const c of chunks) {
    buf.set(c, off)
    off += c.byteLength
  }
  return new TextDecoder('utf-8').decode(buf)
}

async function getPage(
  platform: string,
  start: URL,
  fetchImpl: typeof fetch,
  timeoutMs: number,
  maxBytes: number,
): Promise<{ ok: boolean; html?: string; reason?: DetailFailure }> {
  const signal = AbortSignal.timeout(timeoutMs)
  let url = start
  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const res = await fetchImpl(url.href, {
        redirect: 'manual',
        signal,
        headers: {
          'User-Agent': BROWSER_LIKE_USER_AGENT,
          Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5',
          'Accept-Language': 'id-ID,id;q=0.9,en;q=0.8',
        },
      })
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get('location')
        await res.body?.cancel().catch(() => {})
        if (!loc) return { ok: false, reason: 'failed' }
        const next = new URL(loc, url)
        // Host tujuan dicek SEBELUM diikuti: redirect ke host lain tidak pernah diminta.
        if (!isAllowed(platform, next)) return { ok: false, reason: 'unsupported' }
        url = next
        continue
      }
      if (res.status === 404 || res.status === 410) {
        await res.body?.cancel().catch(() => {})
        return { ok: false, reason: 'not_found' }
      }
      if (!res.ok) {
        await res.body?.cancel().catch(() => {})
        return { ok: false, reason: 'failed' }
      }
      const html = await readLimited(res, maxBytes)
      return html === null ? { ok: false, reason: 'failed' } : { ok: true, html }
    }
    return { ok: false, reason: 'failed' }
  } catch {
    return { ok: false, reason: 'failed' }
  }
}

/** Seperti fetchJobDetail, tetapi mengembalikan alasan kegagalan (dipakai enrichJob untuk pesan ke pengguna). */
export async function fetchJobDetailResult(
  platform: string,
  url: string,
  fetchImpl: typeof fetch = fetch,
  opts: FetchDetailOptions = {},
): Promise<DetailResult> {
  const p = String(platform ?? '').toLowerCase()
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return { ok: false, reason: 'unsupported' }
  }
  if (!isAllowed(p, u)) return { ok: false, reason: 'unsupported' }

  const page = await getPage(p, u, fetchImpl, opts.timeoutMs ?? DETAIL_TIMEOUT_MS, opts.maxBytes ?? DETAIL_MAX_BYTES)
  if (!page.ok) return { ok: false, reason: page.reason }
  const detail = parseJobPage(p, page.html)
  return detail ? { ok: true, detail } : { ok: false, reason: 'not_found' }
}

/** Ambil dan urai detail satu lowongan; null bila platform/host tidak didukung atau halaman gagal diambil/dikenali. */
export async function fetchJobDetail(
  platform: string,
  url: string,
  fetchImpl: typeof fetch = fetch,
  opts: FetchDetailOptions = {},
): Promise<JobDetail | null> {
  const r = await fetchJobDetailResult(platform, url, fetchImpl, opts)
  return r.ok ? r.detail : null
}

// ---------------------------------------------------------------------------------------------------------
// enrichJob
// ---------------------------------------------------------------------------------------------------------

export const ENRICH_REASONS = {
  complete: 'sudah lengkap',
  unsupported: 'situs tidak didukung',
  detailNotFound: 'detail tidak ditemukan',
  fetchFailed: 'gagal mengambil detail',
  nothingNew: 'tidak ada data baru',
  updated: 'detail lowongan diperbarui',
  saveFailed: 'gagal menyimpan detail',
  jobNotFound: 'lowongan tidak ditemukan',
  readFailed: 'gagal membaca lowongan',
} as const

export interface EnrichDeps {
  fetchImpl?: typeof fetch
  now?: () => Date
  timeoutMs?: number
  maxBytes?: number
}

export interface EnrichResult {
  /** Baris `jobs` terbaru (utuh), null bila lowongan tidak ada. */
  job: Record<string, any> | null
  enriched: boolean
  /** Penjelasan singkat berbahasa Indonesia, aman ditampilkan ke pengguna. */
  reason: string
  /** ok = lowongan ada (enriched menyatakan ada perubahan atau tidak); not_found = tidak ada; error = gagal baca DB. */
  status: 'ok' | 'not_found' | 'error'
}

/** Nilai kolom jsonb `requirements` -> larik string. */
export function requirementsList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '').map((x) => x.trim()) : []
}

/**
 * Syarat "nyata" = ada isinya dan bukan sekadar daftar tag (semua butir paling banyak 3 kata dan 30 karakter,
 * seperti nama skill dari Dealls). Daftar tag boleh diganti butir syarat yang diurai dari halaman lowongan.
 */
export function hasRealRequirements(items: string[]): boolean {
  return items.length > 0 && !items.every((i) => i.length <= 30 && wordCount(i) <= 3)
}

const sameList = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i])

export async function enrichJob(db: SupabaseClient, jobId: string, deps: EnrichDeps = {}): Promise<EnrichResult> {
  const R = ENRICH_REASONS
  const fail = (status: EnrichResult['status'], reason: string): EnrichResult => ({ job: null, enriched: false, reason, status })

  let row: Record<string, any> | null
  try {
    const { data, error } = await db.from('jobs').select('*').eq('id', jobId).maybeSingle()
    // 22P02 = id bukan UUID: lowongan seperti itu pasti tidak ada.
    if (error) return error.code === '22P02' ? fail('not_found', R.jobNotFound) : fail('error', R.readFailed)
    row = data
  } catch {
    return fail('error', R.readFailed)
  }
  if (!row) return fail('not_found', R.jobNotFound)

  const unchanged = (reason: string): EnrichResult => ({ job: row, enriched: false, reason, status: 'ok' })

  const description = typeof row.description === 'string' ? row.description : ''
  const currentReqs = requirementsList(row.requirements)
  if (description.length >= 600 && hasRealRequirements(currentReqs)) return unchanged(R.complete)

  const platform = platformForUrl(row.external_url) ?? String(row.platform_source ?? '').toLowerCase()
  if (!row.external_url || !DETAIL_HOSTS[platform]) return unchanged(R.unsupported)

  const res = await fetchJobDetailResult(platform, row.external_url, deps.fetchImpl ?? fetch, {
    timeoutMs: deps.timeoutMs,
    maxBytes: deps.maxBytes,
  })
  if (!res.ok) {
    return unchanged(res.reason === 'unsupported' ? R.unsupported : res.reason === 'not_found' ? R.detailNotFound : R.fetchFailed)
  }
  const detail = res.detail!

  const patch: Record<string, any> = {}
  if (detail.descriptionText.length > description.length) patch.description = detail.descriptionText

  if (!hasRealRequirements(currentReqs)) {
    if (detail.requirements.length > 0) {
      if (!sameList(detail.requirements, currentReqs)) patch.requirements = detail.requirements
    } else if (currentReqs.length === 0 && detail.skills.length > 0) {
      patch.requirements = detail.skills.slice(0, MAX_SKILLS)
    }
  }

  if (row.salary_min == null && row.salary_max == null && detail.salary) Object.assign(patch, toDbSalary(detail.salary))

  if (Object.keys(patch).length === 0) return unchanged(R.nothingNew)
  patch.updated_at = (deps.now?.() ?? new Date()).toISOString()

  const { data: saved, error: upErr } = await db.from('jobs').update(patch).eq('id', jobId).select('*').maybeSingle()
  if (upErr) return unchanged(R.saveFailed)
  return { job: saved ?? { ...row, ...patch }, enriched: true, reason: R.updated, status: 'ok' }
}
