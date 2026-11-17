// Penjaga mutu keluaran LLM (CV dan surat lamaran): pembersih, validator, pemeriksa dasar fakta, dan pemilih bahasa.
//
// Berkas ini TypeScript murni tanpa import dan tanpa API Deno, Node, atau browser, supaya satu isi yang sama
// dipakai backend (services/ai-pipeline.service.ts), Edge Function generate-application (salinan identik di
// supabase/functions/_shared/output-guard.ts), dan tes node:test. Tes backend memeriksa kedua salinan tetap sama.
//
// Latar belakang (analisis UAT 100 pengguna sintetis, 2026-11-17):
//   - 23 dari 100 CV berisi rantai pikir model (`<think>` tanpa penutup) dan pipeline mencatatnya berhasil.
//   - CV menambah angka persen, proyek, dan sertifikasi yang tidak ada di profil.
//   - 64 dari 100 surat lamaran berbahasa Inggris karena prompt tidak mengatur bahasa.
//   - 11 surat memuat huruf non-Latin yang menyusup di tengah kalimat.

export type OutputLanguage = 'id' | 'en'

export type ReasonCode =
  | 'empty'
  | 'reasoning_leak'
  | 'stray_script'
  | 'placeholder'
  | 'missing_sections'
  | 'too_short'
  | 'too_long'
  | 'not_a_letter'

export type WarningKind =
  | 'unsupported_percentage'
  | 'unsupported_number'
  | 'unsupported_project'
  | 'unsupported_certification'
  | 'unsupported_employer'
  | 'unsupported_institution'
  | 'language_mismatch'

/** Peringatan lunak: keluaran tetap bisa dipakai, tetapi pengguna harus memeriksanya sebelum mengirim. */
export interface OutputWarning {
  kind: WarningKind
  /** Nilai yang ditandai (maksimal 12, tanpa duplikat). */
  values: string[]
  /** Jumlah nilai berbeda yang ditandai (bisa lebih besar dari values.length). */
  count: number
  /** Kalimat siap tampil di antarmuka (Bahasa Indonesia). */
  message: string
}

export interface ValidationResult {
  valid: boolean
  reasons: ReasonCode[]
  details: string[]
  warnings: OutputWarning[]
  wordCount: number
}

export type AcceptOutcome =
  | { ok: true; text: string; warnings: OutputWarning[]; repaired: string[] }
  // fallbackText ada bila kegagalan hanya "lunak" (misalnya bahasa tidak sesuai): teks itu boleh dipakai
  // bila tidak ada model lain yang menghasilkan keluaran lebih baik.
  | { ok: false; reasons: string[]; fallbackText?: string }

// ───────────────────────────────────────────────────────────── pembersih

const REASONING_TAGS = 'think|thinking|thought|reasoning|scratchpad'
const BLOCK_RE = new RegExp(`<(${REASONING_TAGS})\\b[^>]*>[\\s\\S]*?</\\1\\s*>`, 'gi')
const CLOSE_RE = new RegExp(`</(?:${REASONING_TAGS})\\s*>`, 'gi')
const OPEN_RE = new RegExp(`<(?:${REASONING_TAGS})\\b[^>]*>`, 'i')

/**
 * Buang rantai pikir yang dibungkus tag: blok `<think>...</think>`, awalan `<think>` tanpa penutup (keluaran
 * terpotong di tengah penalaran, jadi tidak ada jawaban yang tersisa), dan teks sebelum `</think>` yatim
 * (model lupa membuka tag). Format kanal gpt-oss (`<|channel|>final<|message|>`) juga ditangani.
 */
export function stripReasoning(raw: string): { text: string; removed: boolean } {
  const original = String(raw ?? '').replace(/\r\n?/g, '\n').trim()
  let s = original

  const final = s.match(/<\|channel\|>\s*final\s*<\|message\|>([\s\S]*)$/i)
  if (final) s = final[1]

  for (let i = 0; i < 5; i++) {
    const next = s.replace(BLOCK_RE, '')
    if (next === s) break
    s = next
  }
  const closes = [...s.matchAll(CLOSE_RE)]
  if (closes.length > 0) {
    const last = closes[closes.length - 1]
    s = s.slice((last.index ?? 0) + last[0].length)
  }
  const open = OPEN_RE.exec(s)
  if (open) s = s.slice(0, open.index)
  s = s.replace(/<\|[^|>\n]*\|>/g, '').trim()

  return { text: s, removed: s !== original }
}

/** Buang pagar kode ``` yang dipasang sebagian model di sekitar seluruh jawaban. */
export function stripCodeFence(s: string): string {
  return s.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/, '').trim()
}

const PREAMBLE_COLON_RE = /^(?:sure|certainly|of course|okay|ok|here(?:'s| is| are)|below is|berikut(?: ini)?|tentu|baik)\b[^\n]*:\s*$/i
const PREAMBLE_SHORT_RE = /^(?:sure|certainly|of course|okay|ok|tentu|baik)[,!.]\s[^\n]{0,80}$/i

/** Buang kalimat pengantar model di awal ("Here is the CV:") dan garis pemisah markdown. */
export function stripPreamble(s: string): string {
  let lines = s.split('\n')
  for (let i = 0; i < 3; i++) {
    while (lines.length > 0 && lines[0].trim() === '') lines.shift()
    const first = (lines[0] ?? '').trim()
    if (PREAMBLE_COLON_RE.test(first) || PREAMBLE_SHORT_RE.test(first) || /^(?:-{3,}|\*{3,}|_{3,})$/.test(first)) {
      lines = lines.slice(1)
    } else break
  }
  return lines.join('\n').trim()
}

/** CV diminta teks polos: buang penanda tebal markdown, tanda judul `#`, dan ubah bullet `*` menjadi `-`. */
export function stripMarkdownEmphasis(s: string): string {
  return s
    .replace(/\*\*([^*\n]+)\*\*/g, '$1')
    .replace(/__([^_\n]+)__/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^(\s*)[*•]\s+/gm, '$1- ')
}

const collapseBlankLines = (s: string) => s.replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim()

export interface Sanitized {
  text: string
  /** Tindakan perbaikan yang dilakukan: reasoning_removed, code_fence_removed, preamble_removed, markdown_removed. */
  repaired: string[]
}

export function sanitizeCv(raw: string): Sanitized {
  const repaired: string[] = []
  const r = stripReasoning(raw)
  if (r.removed) repaired.push('reasoning_removed')
  let s = r.text
  const fenced = stripCodeFence(s)
  if (fenced !== s) { repaired.push('code_fence_removed'); s = fenced }
  const unpreamble = stripPreamble(s)
  if (unpreamble !== s) { repaired.push('preamble_removed'); s = unpreamble }
  const plain = stripMarkdownEmphasis(s)
  if (plain !== s) { repaired.push('markdown_removed'); s = plain }
  return { text: collapseBlankLines(s), repaired }
}

export function sanitizeLetter(raw: string): Sanitized {
  const repaired: string[] = []
  const r = stripReasoning(raw)
  if (r.removed) repaired.push('reasoning_removed')
  let s = r.text
  const fenced = stripCodeFence(s)
  if (fenced !== s) { repaired.push('code_fence_removed'); s = fenced }
  const unpreamble = stripPreamble(s)
  if (unpreamble !== s) { repaired.push('preamble_removed'); s = unpreamble }
  const plain = s.replace(/\*\*([^*\n]+)\*\*/g, '$1').replace(/__([^_\n]+)__/g, '$1')
  if (plain !== s) { repaired.push('markdown_removed'); s = plain }
  return { text: collapseBlankLines(s), repaired }
}

// ───────────────────────────────────────────────────────────── deteksi cacat teks

/**
 * Teks penalaran yang bocor tanpa tag: dibuka dengan "Thinking Process:" atau "Okay, let's ...", atau penuh
 * kata ragu khas rantai pikir ("Wait,", "Let me re-check").
 */
export function looksLikeReasoning(text: string): boolean {
  if (/<\/?(?:think|thinking|thought|reasoning|scratchpad)\b/i.test(text)) return true
  const head = text.slice(0, 400)
  if (/^\s*(?:thinking process|thought process|thinking\.\.\.|let me think|let me (?:analy[sz]e|break|start|check)|okay,? (?:so|let'?s|i need|the user)|alright,? (?:so|let'?s)|the user (?:wants|is asking|asked|has provided)|we need to|i need to (?:create|write|generate|analy[sz]e|produce))\b/i.test(head)) return true
  if (/(?:^|\n)\s*(?:thinking process|thought process|reasoning)\s*:/i.test(head)) return true
  const hesitations = text.match(/\b(?:wait,|let me re-?(?:check|read|think|evaluate)|hold on|hmm+,)/gi)
  return (hesitations?.length ?? 0) >= 3
}

const isLatinLike = (ch: string) => /[\p{Script=Latin}\p{Script=Common}\p{Script=Inherited}]/u.test(ch)

/**
 * Huruf non-Latin (Arab, Cina, Cyrillic, dst.) yang menyusup di teks Latin. `allowedContext` memuat teks yang
 * memang boleh memuatnya (misalnya nama kandidat atau perusahaan); huruf yang ada di sana tidak ditandai.
 */
export function findStrayScripts(text: string, allowedContext = ''): string[] {
  const allowed = new Set<string>()
  for (const ch of allowedContext) allowed.add(ch)
  const found = new Set<string>()
  for (const ch of text) {
    if (!/\p{L}/u.test(ch) || isLatinLike(ch) || allowed.has(ch)) continue
    found.add(ch)
    if (found.size >= 20) break
  }
  return [...found]
}

const PLACEHOLDER_RE =
  /\[(?:your|nama|name|full name|company|perusahaan|insert|tanggal|date|hiring|position|job|phone|email|location|linkedin|degree|institution|field|graduation|project|start|action|previous|earlier|certification|alamat|address)\b[^\]]{0,60}\]|\{\{[^}]*\}\}/i

export const wordCount = (s: string) => s.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length

// ───────────────────────────────────────────────────────────── bahasa

const ID_WORDS = new Set(
  `yang dan di ke dari untuk dengan pada dalam ini itu saya kami akan dapat telah sebagai oleh juga atau tidak agar
serta bagi adalah sangat lebih antara melalui hingga karena sehingga secara kepada tahun sebuah bahwa anda kita mereka
tersebut terhadap memiliki berpengalaman perusahaan lowongan posisi kami mencari kandidat`.split(/\s+/),
)
const EN_WORDS = new Set(
  `the and of to in for with on as is are was were be by that this at from or an it its my our their have has had will
can which who your you i we they more also been into through across while looking join team experience`.split(/\s+/),
)

export function detectLanguage(text: string): { lang: OutputLanguage | 'unknown'; idRatio: number; enRatio: number; tokens: number } {
  const tokens = (text.toLowerCase().match(/\p{L}+/gu) ?? [])
  const n = tokens.length || 1
  const idRatio = tokens.filter((w) => ID_WORDS.has(w)).length / n
  const enRatio = tokens.filter((w) => EN_WORDS.has(w)).length / n
  let lang: OutputLanguage | 'unknown' = 'unknown'
  if (idRatio >= 2 * enRatio && idRatio >= 0.06) lang = 'id'
  else if (enRatio >= 2 * idRatio && enRatio >= 0.06) lang = 'en'
  return { lang, idRatio, enRatio, tokens: tokens.length }
}

const normalizeLanguageName = (v: unknown): OutputLanguage | 'auto' => {
  const s = String(v ?? '').trim().toLowerCase()
  if (['id', 'id-id', 'ind', 'indonesia', 'indonesian', 'bahasa', 'bahasa indonesia'].includes(s)) return 'id'
  if (['en', 'en-us', 'en-gb', 'eng', 'english', 'inggris', 'bahasa inggris'].includes(s)) return 'en'
  return 'auto'
}

/**
 * Pilih bahasa keluaran. Permintaan eksplisit ('id' atau 'en') menang. Selain itu bawaan Bahasa Indonesia;
 * Inggris hanya bila teks lowongan jelas berbahasa Inggris (rasio kata henti Inggris minimal 0,10 dan minimal
 * 1,5 kali rasio Indonesia, dengan sedikitnya 8 kata).
 */
export function selectLanguage(opts: { requested?: unknown; jobText?: string } = {}): OutputLanguage {
  const asked = normalizeLanguageName(opts.requested)
  if (asked !== 'auto') return asked
  const d = detectLanguage(opts.jobText ?? '')
  if (d.tokens >= 8 && d.enRatio >= 0.1 && d.enRatio >= 1.5 * d.idRatio) return 'en'
  return 'id'
}

export const languageName = (lang: OutputLanguage) => (lang === 'en' ? 'English' : 'Bahasa Indonesia')

/** Kalimat instruksi bahasa untuk prompt. Nama diri, perusahaan, dan istilah teknis tidak diterjemahkan. */
export function languageInstruction(lang: OutputLanguage): string {
  return lang === 'en'
    ? 'Write the entire output in English. Keep names, company names and technical terms as they are.'
    : 'Tulis seluruh keluaran dalam Bahasa Indonesia yang baku dan profesional. Nama orang, nama perusahaan, dan istilah teknis tetap seperti aslinya. Jangan menulis dalam bahasa lain dan jangan menyisipkan huruf non-Latin.'
}

/** Aturan dasar fakta untuk prompt (CV dan surat lamaran). Bahasa Inggris karena prompt model berbahasa Inggris. */
export const GROUNDING_RULES = [
  'Use ONLY facts that appear in the candidate profile above. Do not invent anything.',
  'Do NOT invent numbers, percentages, metrics, team sizes, dates, employers, job titles, degrees, projects, certifications or awards. A number may be used only if it appears in the profile.',
  'If an achievement would normally carry a number but the profile has none, describe the work without a number.',
  'If information is missing, say so plainly (for example "Not provided") or leave that optional item out. Never fill the gap with plausible guesses.',
  'Output ONLY the final document. Do not output your reasoning, analysis, notes, <think> tags or any preamble.',
]

// ───────────────────────────────────────────────────────────── struktur CV

type SectionKey = 'summary' | 'competencies' | 'experience' | 'projects' | 'education' | 'certifications' | 'skills'

const SECTION_PATTERNS: Array<[SectionKey, RegExp]> = [
  ['summary', /^(?:PROFESSIONAL SUMMARY|CAREER SUMMARY|SUMMARY|PROFESSIONAL PROFILE|PROFILE|OBJECTIVE|CAREER OBJECTIVE|RINGKASAN(?: PROFESIONAL)?|PROFIL(?: PROFESIONAL)?|TENTANG SAYA)$/],
  ['competencies', /^(?:CORE COMPETENCIES|KEY SKILLS|CORE SKILLS|KOMPETENSI(?: INTI| UTAMA)?)$/],
  ['experience', /^(?:PROFESSIONAL EXPERIENCE|WORK EXPERIENCE|EXPERIENCE|EMPLOYMENT HISTORY|WORK HISTORY|PENGALAMAN(?: KERJA| PROFESIONAL)?|RIWAYAT (?:PEKERJAAN|KERJA))$/],
  ['projects', /^(?:KEY PROJECTS|SELECTED PROJECTS|PROJECTS|PROYEK(?: UTAMA)?|PROJEK)$/],
  ['education', /^(?:EDUCATION(?: (?:&|AND) TRAINING)?|EDUCATIONAL BACKGROUND|ACADEMIC BACKGROUND|ACADEMIC QUALIFICATIONS|PENDIDIKAN(?: (?:&|DAN) PELATIHAN)?)$/],
  ['certifications', /^(?:CERTIFICATIONS?(?: (?:&|AND) (?:ACHIEVEMENTS|AWARDS))?|ACHIEVEMENTS|SERTIFIKASI(?: (?:&|DAN) (?:CAPAIAN|PENGHARGAAN))?|CAPAIAN)$/],
  ['skills', /^(?:TECHNICAL SKILLS(?: (?:&|AND) TOOLS)?|SKILLS(?: (?:&|AND) TOOLS)?|TECHNICAL EXPERTISE|TECHNICAL PROFICIENCIES|KETERAMPILAN(?: TEKNIS)?|KEAHLIAN(?: TEKNIS)?)$/],
]

// Pencocokan longgar untuk judul yang tidak persis daftar di atas ("EDUCATION & CERTIFICATIONS", "SKILLS & TOOLS").
// Urutannya penting: judul gabungan dipetakan ke seksi pertama yang cocok. Hanya dipakai bila baris itu terlihat
// seperti judul (huruf kapital semua, bertanda markdown, atau berakhir titik dua).
const LOOSE_PATTERNS: Array<[SectionKey, RegExp]> = [
  ['projects', /\b(?:PROJECTS?|PROYEK|PROJEK)\b/],
  ['education', /\b(?:EDUCATION|EDUCATIONAL|PENDIDIKAN|ACADEMIC)\b/],
  ['certifications', /\b(?:CERTIFICATIONS?|CERTIFICATES?|SERTIFIKA\w*|ACHIEVEMENTS?|AWARDS?|CAPAIAN|PENGHARGAAN|LICENSES?)\b/],
  ['experience', /\b(?:EXPERIENCE|EMPLOYMENT|WORK HISTORY|PENGALAMAN|RIWAYAT)\b/],
  ['summary', /\b(?:SUMMARY|PROFILE|OBJECTIVE|RINGKASAN|PROFIL|ABOUT ME|TENTANG SAYA)\b/],
  ['competencies', /\b(?:COMPETENCIES|KOMPETENSI)\b/],
  ['skills', /\b(?:SKILLS?|KEAHLIAN|KETERAMPILAN|EXPERTISE|PROFICIENCIES|TOOLS)\b/],
]

const strictKey = (name: string): SectionKey | null => {
  for (const [key, re] of SECTION_PATTERNS) if (re.test(name)) return key
  return null
}

function headingKey(line: string): SectionKey | null {
  const raw = line.trim()
  if (!raw || raw.length > 60 || raw.includes('|')) return null
  const t = raw.replace(/[#*_`:]/g, ' ').replace(/\s+/g, ' ').trim().toUpperCase()
  if (t && t.length <= 40) {
    const exact = strictKey(t)
    if (exact) return exact
    const marked = /^(?:#{1,6}\s|\*\*|__)/.test(raw) || /(?:\*\*|__)$/.test(raw) || raw.endsWith(':')
    const caps = raw === raw.toUpperCase()
    if ((marked || caps) && t.split(' ').length <= 6 && !/\d/.test(t) && !/[.,;]$/.test(raw)) {
      for (const [key, re] of LOOSE_PATTERNS) if (re.test(t)) return key
    }
  }
  // "Skills: React, TypeScript": judul diikuti isi pada baris yang sama. Hanya nama judul baku yang dikenali.
  const inline = raw.match(/^[#*_\s]*([^:|]{3,40}?)[*_\s]*:\s*\S/)
  if (inline) return strictKey(inline[1].replace(/[#*_`]/g, ' ').replace(/\s+/g, ' ').trim().toUpperCase())
  return null
}

/** Baris isi per seksi (tanpa baris judul). Seksi yang tidak dikenal ikut menjadi isi seksi sebelumnya. */
export function parseCvSections(text: string): Map<SectionKey, string[]> {
  const out = new Map<SectionKey, string[]>()
  let current: SectionKey | null = null
  for (const line of text.split('\n')) {
    const key = headingKey(line)
    if (key) {
      current = key
      if (!out.has(key)) out.set(key, [])
      continue
    }
    if (current) out.get(current)!.push(line)
  }
  return out
}

export interface ValidateCvOptions {
  /** Teks yang boleh memuat huruf non-Latin (nama, perusahaan). */
  allowedContext?: string
  /** Wajibkan seksi Pendidikan (bawaan true; false bila profil memang tidak punya data pendidikan). */
  requireEducation?: boolean
  minWords?: number
}

/**
 * CV valid bila: tidak kosong, bukan penalaran bocor, tanpa huruf asing menyusup, tanpa placeholder, memuat seksi
 * Ringkasan, Pengalaman, Pendidikan (bila diharapkan), dan Keterampilan atau Kompetensi Inti, dan tidak terlalu pendek.
 * Seksi Proyek dan Sertifikasi opsional: hanya boleh ada bila profil memuatnya (diperiksa oleh checkGrounding).
 */
export function validateCv(text: string, opts: ValidateCvOptions = {}): ValidationResult {
  const reasons: ReasonCode[] = []
  const details: string[] = []
  const words = wordCount(text)
  if (!text.trim()) {
    return { valid: false, reasons: ['empty'], details: ['keluaran kosong setelah dibersihkan'], warnings: [], wordCount: 0 }
  }
  if (looksLikeReasoning(text)) {
    reasons.push('reasoning_leak')
    details.push('teks berisi penalaran model, bukan CV')
  }
  const stray = findStrayScripts(text, opts.allowedContext)
  if (stray.length > 0) {
    reasons.push('stray_script')
    details.push(`huruf non-Latin: ${stray.join(' ')}`)
  }
  const ph = text.match(PLACEHOLDER_RE)
  if (ph) {
    reasons.push('placeholder')
    details.push(`placeholder belum diisi: ${ph[0]}`)
  }
  const sections = parseCvSections(text)
  const missing: string[] = []
  if (!sections.has('summary')) missing.push('summary')
  if (!sections.has('experience')) missing.push('experience')
  if (opts.requireEducation !== false && !sections.has('education')) missing.push('education')
  if (!sections.has('skills') && !sections.has('competencies')) missing.push('skills')
  if (missing.length > 0) {
    reasons.push('missing_sections')
    details.push(`seksi hilang: ${missing.join(', ')}`)
  }
  if (words < (opts.minWords ?? 80)) {
    reasons.push('too_short')
    details.push(`hanya ${words} kata`)
  }
  return { valid: reasons.length === 0, reasons, details, warnings: [], wordCount: words }
}

export interface ValidateLetterOptions {
  language?: OutputLanguage
  allowedContext?: string
  minWords?: number
  maxWords?: number
}

/**
 * Surat lamaran valid bila: tidak kosong, bukan penalaran bocor, bukan JSON atau daftar, tanpa huruf asing menyusup,
 * tanpa placeholder, panjang wajar, dan sedikitnya tiga kalimat. Salam pembuka tidak diwajibkan karena prompt
 * meminta badan surat saja. Bahasa yang tidak sesuai permintaan hanya peringatan lunak (language_mismatch).
 */
export function validateCoverLetter(text: string, opts: ValidateLetterOptions = {}): ValidationResult {
  const reasons: ReasonCode[] = []
  const details: string[] = []
  const warnings: OutputWarning[] = []
  const words = wordCount(text)
  if (!text.trim()) {
    return { valid: false, reasons: ['empty'], details: ['keluaran kosong setelah dibersihkan'], warnings, wordCount: 0 }
  }
  if (looksLikeReasoning(text)) {
    reasons.push('reasoning_leak')
    details.push('teks berisi penalaran model, bukan surat')
  }
  const stray = findStrayScripts(text, opts.allowedContext)
  if (stray.length > 0) {
    reasons.push('stray_script')
    details.push(`huruf non-Latin: ${stray.join(' ')}`)
  }
  const ph = text.match(PLACEHOLDER_RE)
  if (ph) {
    reasons.push('placeholder')
    details.push(`placeholder belum diisi: ${ph[0]}`)
  }
  const sentences = text.split(/(?<=[.!?])\s+/).filter((x) => wordCount(x) >= 3).length
  const startsLikeData = /^\s*[{[]/.test(text)
  const headingLines = text.split('\n').filter((l) => /^\s*#{1,6}\s/.test(l)).length
  if (startsLikeData || headingLines > 0 || sentences < 3) {
    reasons.push('not_a_letter')
    details.push('bukan badan surat (JSON, judul markdown, atau kurang dari tiga kalimat)')
  }
  if (words < (opts.minWords ?? 60)) {
    reasons.push('too_short')
    details.push(`hanya ${words} kata`)
  }
  if (words > (opts.maxWords ?? 600)) {
    reasons.push('too_long')
    details.push(`${words} kata`)
  }
  if (opts.language) {
    const d = detectLanguage(text)
    if (d.lang !== 'unknown' && d.lang !== opts.language) {
      warnings.push({
        kind: 'language_mismatch',
        values: [d.lang],
        count: 1,
        message: `Bahasa surat tidak sesuai permintaan (diminta ${languageName(opts.language)}, terdeteksi ${languageName(d.lang)}).`,
      })
    }
  }
  return { valid: reasons.length === 0, reasons, details, warnings, wordCount: words }
}

// ───────────────────────────────────────────────────────────── dasar fakta (grounding)

export interface ProfileLike {
  firstName?: string
  lastName?: string
  currentTitle?: string
  email?: string
  phone?: string
  location?: string
  linkedinUrl?: string
  yearsOfExperience?: string | number
  skills?: string[]
  summary?: string
  workExperiences?: Array<{ role_title?: string; company_name?: string; start_date?: string; end_date?: string; description?: string }>
  education?: Array<{ degree?: string; field_of_study?: string; institution?: string; start_year?: number; end_year?: number }>
  projects?: string[]
  certifications?: string[]
}

export interface GroundingSource {
  /** Seluruh fakta sumber sebagai teks bebas (angka, nama proyek, dan perusahaan dicari di sini). */
  text: string
  employers?: string[]
  institutions?: string[]
  /** Angka turunan yang sah: lama kerja dari tanggal, jumlah entri, dan sejenisnya. */
  extraNumbers?: number[]
}

/** Susun sumber fakta dari profil kandidat. `now` hanya dipakai untuk menghitung lama kerja yang masih berjalan. */
export function buildGroundingSource(profile: ProfileLike, now: Date = new Date()): GroundingSource {
  const parts: string[] = []
  const add = (v: unknown) => { if (v !== undefined && v !== null && String(v).trim() !== '') parts.push(String(v)) }
  add(profile.firstName); add(profile.lastName); add(profile.currentTitle); add(profile.email); add(profile.phone)
  add(profile.location); add(profile.linkedinUrl); add(profile.yearsOfExperience)
  add((profile.skills ?? []).join(', ')); add(profile.summary)
  const extra: number[] = []
  const year = now.getFullYear()
  for (const w of profile.workExperiences ?? []) {
    add(w.role_title); add(w.company_name); add(w.start_date); add(w.end_date); add(w.description)
    const s = Number(String(w.start_date ?? '').match(/\d{4}/)?.[0])
    const e = /present|sekarang|now/i.test(String(w.end_date ?? '')) || !w.end_date ? year : Number(String(w.end_date).match(/\d{4}/)?.[0])
    if (Number.isFinite(s) && Number.isFinite(e) && e >= s) extra.push(e - s, e - s + 1)
  }
  for (const e of profile.education ?? []) {
    add(e.degree); add(e.field_of_study); add(e.institution); add(e.start_year); add(e.end_year)
    if (e.start_year && e.end_year && e.end_year >= e.start_year) extra.push(e.end_year - e.start_year)
  }
  for (const p of profile.projects ?? []) add(p)
  for (const c of profile.certifications ?? []) add(c)
  const yoe = Number(profile.yearsOfExperience)
  if (Number.isFinite(yoe)) extra.push(yoe)
  extra.push((profile.workExperiences ?? []).length, (profile.education ?? []).length, (profile.skills ?? []).length)
  return {
    text: parts.join('\n'),
    employers: (profile.workExperiences ?? []).map((w) => String(w.company_name ?? '')).filter(Boolean),
    institutions: (profile.education ?? []).map((e) => String(e.institution ?? '')).filter(Boolean),
    extraNumbers: extra,
  }
}

const normalizeForMatch = (s: string) =>
  s.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()

const containsPhrase = (haystackNorm: string, phrase: string) => {
  const p = normalizeForMatch(phrase)
  return p.length > 0 && ` ${haystackNorm} `.includes(` ${p} `)
}

interface NumberToken { raw: string; value: number; percent: boolean }

const PERCENT_AFTER = /^\s*(?:%|％|persen\b|percent\b|per cent\b)/i

function toValue(token: string): number {
  let t = token
  if (/^\d{1,3}(?:[.,]\d{3})+$/.test(t)) t = t.replace(/[.,]/g, '')
  else t = t.replace(',', '.')
  return Number(t)
}

const CONNECTORS = new Set(['and', 'dan', 'with', 'using', 'for', 'or', 'atau', 'to', 'untuk', 'dengan', '&', 'in'])

/** Angka bermakna (metrik) pada teks: tahun, nomor kontak, daftar bernomor, dan nomor versi tidak dihitung. */
function extractMetricNumbers(text: string): NumberToken[] {
  const cleaned = text
    .replace(/[‐‑‒–—−]/g, '-')
    .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, ' ')
    .replace(/https?:\/\/\S+|www\.\S+|linkedin\.com\S*/gi, ' ')
    .replace(/(?:\+\d|\b0\d)[\d\s().-]{6,}\d/g, ' ')
    .replace(/\b\d{4}-\d{2}-\d{2}\b/g, ' ')
    .replace(/\b\d+(?:[.,]\d+)?\/\d+\b/g, ' ')
    .replace(/\b\d{1,2}[-/]\d{4}\b/g, ' ')
  const out: NumberToken[] = []
  const re = /\d+(?:[.,]\d+)*/g
  let m: RegExpExecArray | null
  while ((m = re.exec(cleaned)) !== null) {
    const raw = m[0]
    const idx = m.index
    const prev = cleaned[idx - 1] ?? ''
    const rest = cleaned.slice(idx + raw.length)
    if (/[\p{L}_]/u.test(prev)) continue
    if (/[-‑–]/.test(prev) && /\p{L}/u.test(cleaned[idx - 2] ?? '')) continue
    let tail = ''
    if (/^\p{L}/u.test(rest)) {
      const suffix = rest.match(/^(?:x|k|m|b|jt|rb)(?![\p{L}])/iu)
      if (!suffix) continue
      tail = suffix[0]
    }
    const lineStart = cleaned.lastIndexOf('\n', idx - 1) + 1
    if (idx === lineStart && /^[.)]\s/.test(rest)) continue
    const value = toValue(raw)
    if (!Number.isFinite(value)) continue
    // "30-40 %" adalah rentang persen: kedua ujungnya persen.
    const percent = PERCENT_AFTER.test(rest) || /^-\d+(?:[.,]\d+)?\s*(?:%|persen\b|percent\b)/i.test(rest)
    if (!percent && Number.isInteger(value) && value >= 1950 && value <= 2100) continue
    if (!percent && !tail) {
      // Nomor versi atau standar ("React 18 dan ...", "WCAG 2.1 AA", "ISO 27001") bukan metrik capaian.
      const prevWord = cleaned.slice(0, idx).match(/([A-Za-z][A-Za-z.+#]*)\s$/)?.[1]
      if (prevWord && /^[A-Z]/.test(prevWord)) {
        const next = rest.match(/^\s*([^\s,.;:)]+)/)?.[1]?.toLowerCase()
        if (/^[A-Z]{2,}$/.test(prevWord) || !next || CONNECTORS.has(next) || /^[,.;:)]/.test(rest)) continue
      }
    }
    out.push({ raw: raw + (percent ? '%' : tail), value, percent })
  }
  return out
}

function allNumbers(text: string): { plain: Set<number>; percent: Set<number> } {
  const plain = new Set<number>()
  const percent = new Set<number>()
  const re = /\d+(?:[.,]\d+)*/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const v = toValue(m[0])
    if (!Number.isFinite(v)) continue
    plain.add(v)
    if (PERCENT_AFTER.test(text.slice(m.index + m[0].length))) percent.add(v)
  }
  return { plain, percent }
}

const MAX_VALUES = 12

function makeWarning(kind: WarningKind, values: string[], message: (list: string) => string): OutputWarning | null {
  const uniq = [...new Set(values.map((v) => v.trim()).filter(Boolean))]
  if (uniq.length === 0) return null
  return { kind, values: uniq.slice(0, MAX_VALUES), count: uniq.length, message: message(uniq.slice(0, MAX_VALUES).join('; ') + (uniq.length > MAX_VALUES ? '; ...' : '')) }
}

const NONE_ITEM_RE = /^(?:none|n\/a|not (?:provided|specified|available)|tidak (?:ada|tersedia|disebutkan|diberikan)|-+)\.?$/i

function listItems(lines: string[]): string[] {
  return lines
    .map((l) => l.replace(/^\s*(?:[-•*·▪]|\d+[.)])\s+/, '').replace(/\*\*/g, '').trim())
    .filter((l) => l && !NONE_ITEM_RE.test(l))
}

function itemName(item: string): string {
  const colon = item.indexOf(':')
  let name = colon > 0 ? item.slice(0, colon) : item.split(/\s[–—-]\s|\s\|\s/)[0]
  name = name.replace(/\s*\([^)]*\)\s*$/, '').trim()
  return name
}

/**
 * Bandingkan keluaran dengan fakta sumber. Hasilnya peringatan (bukan penolakan): angka dan persen yang tidak ada
 * di profil, serta pada CV juga proyek, sertifikasi, perusahaan, dan institusi yang tidak ada di profil.
 * `sections: false` dipakai untuk surat lamaran (hanya angka dan persen).
 */
export function checkGrounding(output: string, source: GroundingSource | string, opts: { sections?: boolean } = {}): OutputWarning[] {
  const src: GroundingSource = typeof source === 'string' ? { text: source } : source
  const warnings: OutputWarning[] = []
  const push = (w: OutputWarning | null) => { if (w) warnings.push(w) }
  const { plain, percent } = allNumbers(src.text)
  for (const n of src.extraNumbers ?? []) plain.add(n)

  const tokens = extractMetricNumbers(output)
  push(makeWarning('unsupported_percentage', tokens.filter((t) => t.percent && !percent.has(t.value)).map((t) => t.raw),
    (l) => `Angka persen ini tidak ada di profilmu: ${l}. Hapus atau ganti dengan angka yang benar sebelum mengirim.`))
  push(makeWarning('unsupported_number', tokens.filter((t) => !t.percent && !plain.has(t.value)).map((t) => t.raw),
    (l) => `Angka ini tidak ditemukan di profilmu: ${l}. Periksa kebenarannya sebelum mengirim.`))

  if (opts.sections) {
    const srcNorm = normalizeForMatch(src.text)
    const sections = parseCvSections(output)
    const candidates = (names: string[] | undefined, phrase: string) =>
      (names ?? []).some((n) => containsPhrase(normalizeForMatch(phrase), n) || containsPhrase(normalizeForMatch(n), phrase))

    const unsupported = (key: 'projects' | 'certifications') =>
      listItems(sections.get(key) ?? []).filter((item) => {
        const name = itemName(item)
        return !(containsPhrase(srcNorm, name) || containsPhrase(srcNorm, item))
      }).map(itemName)
    push(makeWarning('unsupported_project', unsupported('projects'),
      (l) => `Proyek ini tidak ada di profilmu: ${l}. Hapus bila bukan pengalamanmu.`))
    push(makeWarning('unsupported_certification', unsupported('certifications'),
      (l) => `Sertifikasi atau penghargaan ini tidak ada di profilmu: ${l}. Hapus bila bukan milikmu.`))

    // Judul pengalaman berbentuk "Peran | Perusahaan | Kota | Tanggal" (atau urutan terbalik). Bila daftar
    // perusahaan sumber ada, hanya daftar itu yang dipakai (nama peran bisa kebetulan ada di teks sumber).
    const employers: string[] = []
    const known = src.employers && src.employers.length > 0 ? src.employers : null
    for (const line of sections.get('experience') ?? []) {
      const fields = line.replace(/\*\*/g, '').split('|').map((f) => f.trim())
      if (fields.length < 3) continue
      const ok = fields.slice(0, 2).some((f) => f && (known ? candidates(known, f) : containsPhrase(srcNorm, f)))
      if (!ok) employers.push(fields[1])
    }
    push(makeWarning('unsupported_employer', employers,
      (l) => `Perusahaan ini tidak ada di riwayat kerjamu: ${l}. Perbaiki atau hapus.`))

    const institutions: string[] = []
    const INSTITUTION_RE = /(?:universitas|university|institut|institute|politeknik|polytechnic|sekolah tinggi|akademi|college|school)/i
    for (const line of sections.get('education') ?? []) {
      const fields = line.replace(/\*\*/g, '').split('|').map((f) => f.trim())
      if (fields.length < 2) continue
      const inst = fields.find((f) => INSTITUTION_RE.test(f))
      if (inst && !containsPhrase(srcNorm, inst) && !candidates(src.institutions, inst)) institutions.push(inst)
    }
    push(makeWarning('unsupported_institution', institutions,
      (l) => `Institusi ini tidak ada di data pendidikanmu: ${l}. Perbaiki atau hapus.`))
  }
  return warnings
}

/** Susun peringatan menjadi teks catatan pendek (dipakai untuk kolom ai_notes dan pesan di antarmuka). */
export function formatWarningsText(warnings: OutputWarning[]): string {
  if (warnings.length === 0) return ''
  return `Periksa sebelum dikirim:\n${warnings.map((w) => `- ${w.message}`).join('\n')}`
}

// ───────────────────────────────────────────────────────────── penerimaan keluaran (dipakai rantai model)

/** Terima atau tolak jawaban model untuk CV. Penolakan membuat rantai model mencoba model berikutnya. */
export function acceptCv(raw: string, opts: ValidateCvOptions = {}): AcceptOutcome {
  const s = sanitizeCv(raw)
  const v = validateCv(s.text, opts)
  if (!v.valid) return { ok: false, reasons: v.reasons }
  return { ok: true, text: s.text, warnings: v.warnings, repaired: s.repaired }
}

export function acceptCoverLetter(raw: string, opts: ValidateLetterOptions = {}): AcceptOutcome {
  const s = sanitizeLetter(raw)
  const v = validateCoverLetter(s.text, opts)
  if (!v.valid) return { ok: false, reasons: v.reasons }
  if (v.warnings.some((w) => w.kind === 'language_mismatch')) {
    return { ok: false, reasons: ['language_mismatch'], fallbackText: s.text }
  }
  return { ok: true, text: s.text, warnings: v.warnings, repaired: s.repaired }
}

const SCORE_KEYS = ['OVERALL_SCORE', 'ATS_COMPATIBILITY_SCORE', 'KEYWORD_MATCH_SCORE', 'CONTENT_QUALITY_SCORE', 'FORMATTING_SCORE']

/** Laporan penilaian CV dianggap sah bila skor keseluruhan dan sedikitnya tiga skor lain terbaca. */
export function acceptEvaluation(raw: string): AcceptOutcome {
  const r = stripReasoning(raw)
  if (!r.text) return { ok: false, reasons: ['empty'] }
  const found = SCORE_KEYS.filter((k) => new RegExp(`${k}\\s*:\\s*\\[?\\d+`, 'i').test(r.text))
  if (!found.includes('OVERALL_SCORE') || found.length < 4) return { ok: false, reasons: ['evaluation_unparseable'] }
  return { ok: true, text: r.text, warnings: [], repaired: r.removed ? ['reasoning_removed'] : [] }
}
