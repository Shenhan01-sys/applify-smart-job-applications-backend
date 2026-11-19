/**
 * Utilitas bersama untuk klien sumber lowongan (MCP clients).
 * Semua fungsi murni (tanpa I/O) supaya mudah diuji dengan fixture.
 */

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/gi, '&')
}

/** Ubah HTML (termasuk HTML yang di-escape, mis. konten Greenhouse) menjadi teks polos. */
export function htmlToText(html: unknown): string {
  if (typeof html !== 'string' || !html) return ''
  // Greenhouse mengirim HTML ter-escape (&lt;p&gt;...) -> decode dulu supaya tag bisa dibuang.
  const src = /&lt;\/?[a-z]/i.test(html) ? decodeEntities(html) : html
  return decodeEntities(
    src
      .replace(/<\s*(script|style)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, ' ')
      .replace(/<\s*br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, '\n')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim()
}

/** Normalisasi teks untuk pencocokan kata kunci (huruf kecil, tanpa tanda baca). */
export function normalizeText(s: unknown): string {
  return String(s ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9+#./\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

const STOPWORDS = new Set([
  'and', 'or', 'the', 'of', 'for', 'in', 'at', 'a', 'an', 'to', 'with',
  'dan', 'atau', 'di', 'ke', 'dari', 'untuk', 'yang', 'dengan',
])

/** Pecah kueri kata kunci menjadi token bermakna. */
export function tokenize(query: unknown): string[] {
  return normalizeText(query)
    .split(' ')
    .map((t) => t.replace(/^[-./]+|[-./]+$/g, ''))
    .filter((t) => t.length > 1 && !STOPWORDS.has(t))
}

/**
 * Cek apakah `term` muncul sebagai kata utuh di `hay` (hay sudah dinormalisasi).
 * Token >= 4 huruf juga cocok sebagai awalan kata (engineer ~ engineers).
 */
export function hasTerm(hay: string, term: string): boolean {
  const h = ` ${hay} `.replace(/[./]/g, (m) => ` ${m} `)
  const t = term.replace(/[./]/g, (m) => ` ${m} `).replace(/\s+/g, ' ').trim()
  if (!t) return false
  if (h.includes(` ${t} `)) return true
  return t.length >= 4 && h.includes(` ${t}`)
}

/**
 * Filter kata kunci: lolos bila SEMUA token kueri muncul di judul+deskripsi.
 * Kueri kosong selalu lolos.
 */
export function matchesKeywords(job: { title?: string; description?: string }, keywords?: string): boolean {
  const tokens = tokenize(keywords)
  if (tokens.length === 0) return true
  const hay = normalizeText(`${job.title ?? ''} ${job.description ?? ''}`)
  return tokens.every((t) => hasTerm(hay, t))
}

/** Sinonim lokasi Indonesia yang umum dipakai portal. */
const LOCATION_ALIASES: Record<string, string[]> = {
  indonesia: ['indonesia', 'jakarta', 'bandung', 'surabaya', 'yogyakarta', 'jogja', 'semarang', 'medan',
    'bali', 'denpasar', 'tangerang', 'bekasi', 'depok', 'bogor', 'makassar', 'malang', 'batam', 'balikpapan'],
  jakarta: ['jakarta', 'dki jakarta', 'south jakarta', 'jakarta selatan', 'central jakarta', 'jakarta pusat',
    'jakarta barat', 'jakarta timur', 'jakarta utara', 'west jakarta', 'north jakarta', 'east jakarta'],
  yogyakarta: ['yogyakarta', 'jogja', 'jogjakarta', 'sleman', 'bantul'],
}

/**
 * Filter lokasi: lolos bila lokasi lowongan memuat lokasi yang diminta (atau aliasnya).
 * "Remote" dianggap lolos hanya bila kueri lokasi menyebut remote.
 */
export function matchesLocation(jobLocation: string | undefined, wanted?: string): boolean {
  const w = normalizeText(wanted)
  if (!w) return true
  const loc = normalizeText(jobLocation)
  const candidates = LOCATION_ALIASES[w] ?? [w]
  return candidates.some((c) => hasTerm(loc, c))
}

/**
 * Skor relevansi deterministik (0-100) berbasis *weighted keyword overlap*.
 *  - token kueri yang muncul di JUDUL berbobot 3, di deskripsi berbobot 1;
 *  - skill kandidat yang muncul di judul/deskripsi menambah bobot 2;
 * Skor = total bobot yang cocok / total bobot maksimum × 100.
 * Dapat dihitung ulang siapa pun dari data yang sama (tidak memakai LLM).
 * Skor yang sama disimpan ke `jobs.match_score` (lihat matchScoreOf dan job-ingest.service.ts).
 */
export function relevanceScore(
  job: { title?: string; description?: string },
  keywords?: string,
  skills: string[] = [],
): { score: number; matchedKeywords: string[]; matchedSkills: string[]; maxWeight: number } {
  const title = normalizeText(job.title)
  const desc = normalizeText(job.description)
  const kw = [...new Set(tokenize(keywords))]
  const sk = [...new Set(skills.map((s) => normalizeText(s)).filter((s) => s.length > 1))]

  let max = 0
  let got = 0
  const matchedKeywords: string[] = []
  const matchedSkills: string[] = []

  for (const t of kw) {
    max += 3
    if (hasTerm(title, t)) { got += 3; matchedKeywords.push(t) }
    else if (hasTerm(desc, t)) { got += 1; matchedKeywords.push(t) }
  }
  for (const s of sk) {
    max += 2
    if (hasTerm(title, s) || hasTerm(desc, s)) {
      got += 2
      matchedSkills.push(s)
    }
  }
  const score = max === 0 ? 0 : Math.round((got / max) * 100)
  // maxWeight = 0 berarti tidak ada token kueri maupun skill untuk dibandingkan: skor 0 di sini bukan
  // "tidak cocok", melainkan "tidak ada dasar penilaian" (lihat matchScoreOf).
  return { score, matchedKeywords, matchedSkills, maxWeight: max }
}

/**
 * Nilai yang boleh ditulis ke kolom integer `jobs.match_score`.
 *  - bulat dan terjepit ke 0..100;
 *  - null bila tidak ada dasar penilaian (tidak ada kata kunci dan tidak ada skill): kolom dibiarkan kosong
 *    supaya layar menampilkan "—", bukan "0%" yang seolah-olah berarti tidak cocok.
 */
export function matchScoreOf(r: { score: number; maxWeight: number }): number | null {
  if (!(r.maxWeight > 0) || !Number.isFinite(r.score)) return null
  return Math.min(100, Math.max(0, Math.round(r.score)))
}

/** Tebak tingkat pengalaman dari judul/deskripsi. */
export function guessExperienceLevel(title: string, content = ''): string {
  const text = `${title} ${content}`.toLowerCase()
  if (/\b(intern|internship|magang)\b/.test(text)) return 'intern'
  if (/\b(junior|jr\.?|fresh graduate|entry)\b/.test(text)) return 'junior'
  if (/\b(principal|lead|head|manager)\b/.test(text)) return 'lead'
  if (/\b(senior|sr\.?)\b/.test(text)) return 'senior'
  return 'mid'
}

/** Normalisasi tipe kerja ke enum tabel jobs: 'on-site' | 'hybrid' | 'remote'. */
export function normalizeWorkType(...hints: Array<string | boolean | undefined | null>): 'on-site' | 'hybrid' | 'remote' {
  const text = hints.map((h) => (typeof h === 'boolean' ? (h ? 'remote' : '') : h ?? '')).join(' ').toLowerCase()
  if (text.includes('hybrid')) return 'hybrid'
  if (text.includes('remote') || text.includes('work from home') || text.includes('wfh')) return 'remote'
  return 'on-site'
}

/** Normalisasi tipe pekerjaan ke nilai yang diterima tabel jobs. */
export function normalizeJobType(raw?: string | null): string {
  const t = String(raw ?? '').toLowerCase()
  if (t.includes('part')) return 'part-time'
  if (t.includes('contract') || t.includes('kontrak') || t.includes('temporary')) return 'contract'
  if (t.includes('intern') || t.includes('magang')) return 'internship'
  if (t.includes('freelance')) return 'freelance'
  return 'full-time'
}

/**
 * Tipe pekerjaan dari judul saja, dengan batas kata. Dipakai untuk sumber tanpa kolom tipe (Greenhouse).
 * Deskripsi tidak dipakai, karena pencocokan substring pada teks bebas salah membaca "international" atau
 * "internal" sebagai magang dan "partner" sebagai paruh waktu.
 */
export function jobTypeFromTitle(title?: string | null): string {
  const t = String(title ?? '').toLowerCase()
  if (/\bpart[\s_-]?time\b|\bparuh waktu\b/.test(t)) return 'part-time'
  if (/\b(contract|contractor|kontrak|temporary)\b/.test(t)) return 'contract'
  if (/\b(intern|interns|internship|magang)\b/.test(t)) return 'internship'
  if (/\bfreelancer?\b/.test(t)) return 'freelance'
  return 'full-time'
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Jalankan tugas async dengan batas konkurensi. */
export async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i])
    }
  })
  await Promise.all(workers)
  return out
}
