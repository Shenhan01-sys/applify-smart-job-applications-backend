import { detectSocialPostPlatform, extractUrlsFromText, hostMatchesDomain, sanitizeHttpUrl } from './apply-channel.js'

/**
 * Ekstraksi deterministik posisi, perusahaan, lokasi, dan tautan lamaran dari teks bebas lowongan off-portal
 * (caption Instagram/X/LinkedIn, grup WhatsApp, teks OCR poster). Dipakai `off-portal-ingest.service.ts`.
 *
 * Pola yang dikenali:
 *   - Pasangan "kunci: nilai" per baris atau sebaris dipisah " - " / " | " ("roles: A, B - location: Remote - apply: https://...").
 *   - Judul bernomor dengan akun: "10. @AnodosFinance", "18. Kraken / @Krak", "@acme is hiring".
 *   - Kalimat umum: "Acme is hiring a Backend Engineer", "PT Maju membuka lowongan Data Analyst", "mencari Staff Admin".
 *   - Daftar bernomor, bullet, atau emoji di bawah header "Posisi:" / "We are hiring:" atau baris pembuka berakhiran ":"
 *     ("... membuka kesempatan untuk posisi:"). Setiap butir menjadi satu posisi (maksimal 10).
 *   - Header promosi ("LOWONGAN KERJA", "WE'RE HIRING!", "OPEN RECRUITMENT", "DIBUTUHKAN SEGERA") bukan posisi dan bukan
 *     perusahaan; posisi diambil dari baris sesudahnya. Label dalam kurung ("(FIKTIF)", "(Hybrid)") dibuang dari nama perusahaan.
 *   - Awalan badan usaha PT/CV, "Perusahaan:", "Company:", serta "Remote" dan nama kota sebagai cadangan lokasi.
 *
 * Tidak ada pemanggilan jaringan atau AI. Bila sebuah bidang tidak terbaca, nilai bawaan dikembalikan dan pemanggil
 * mencatatnya di `unreadFields` agar pengguna tahu perlu memeriksa.
 */

export const OFF_PORTAL_TITLE_PLACEHOLDER = 'Lowongan Off-Portal'
export const OFF_PORTAL_COMPANY_PLACEHOLDER = 'Perusahaan (Off-Portal)'
export const OFF_PORTAL_LOCATION_DEFAULT = 'Indonesia'
export const MAX_OFF_PORTAL_ROLES = 10

export type ExtractedCompanySource = 'hint' | 'label' | 'handle' | 'phrase' | 'url' | 'fallback'

const URL_OR_EMAIL_RE = /https?:\/\/|\bwww\.|[\w.+-]+@[\w-]+\.[\w.-]+/i

/** Kunci "kunci: nilai" yang dikenali, dipakai untuk memecah caption sebaris menjadi baris-baris. */
const FIELD_KEYS = [
  'roles?',
  'open\\s+roles?',
  'positions?',
  'open\\s+positions?',
  'posisi',
  'lowongan',
  'jabatan',
  'job\\s+titles?',
  'hiring\\s+for',
  'hiring',
  'openings?',
  'vacanc(?:y|ies)',
  'jobs?',
  'locations?',
  'lokasi',
  'penempatan',
  'based\\s+in',
  'tempat\\s+kerja',
  'company',
  'perusahaan',
  'employer',
  'apply(?:\\s+(?:here|now|at|via|link|to))?',
  'how\\s+to\\s+apply',
  'cara\\s+(?:melamar|daftar)',
  'daftar(?:\\s+di)?',
  'lamar(?:\\s+di)?',
  'link(?:\\s+lamaran)?',
  'salary',
  'gaji',
  'type',
  'tipe',
  'deadline',
  'requirements?',
  'kualifikasi',
  'benefits?',
].join('|')

const INLINE_SEPARATOR_RE = new RegExp(`(?:\\s+[-–—|•·]\\s+|\\s*[,;]\\s+)(?=(?:${FIELD_KEYS})\\s*[:：])`, 'gi')
const SENTENCE_KEY_RE = new RegExp(`([.!?])\\s+(?=(?:roles?|positions?|posisi|locations?|lokasi|company|perusahaan|apply(?:\\s+\\w+)?)\\s*[:：])`, 'gi')
const KEY_VALUE_RE = new RegExp(`^(${FIELD_KEYS})\\s*[:：]\\s*(.*)$`, 'i')

// Penanda awal baris: nomor ("10."), bullet, panah, emoji.
const LEADING_MARKER_RE = /^[\s\u200d\ufe0f\p{Extended_Pictographic}\-–—•*·▪◦►▶→>]+/u
const LEADING_NUMBER_RE = /^\s*\d{1,3}\s*[.)]\s+/

export type FieldGroup = 'role' | 'location' | 'company' | 'apply' | 'other'

function groupOfKey(rawKey: string): FieldGroup {
  const key = rawKey.toLowerCase().replace(/\s+/g, ' ').trim()
  if (/^(?:roles?|open roles?|positions?|open positions?|posisi|lowongan|jabatan|job titles?|hiring for|hiring|openings?|vacanc(?:y|ies)|jobs?)$/.test(key))
    return 'role'
  if (/^(?:locations?|lokasi|penempatan|based in|tempat kerja)$/.test(key)) return 'location'
  if (/^(?:company|perusahaan|employer)$/.test(key)) return 'company'
  if (/^(?:apply(?: (?:here|now|at|via|link|to))?|how to apply|cara (?:melamar|daftar)|daftar(?: di)?|lamar(?: di)?|link(?: lamaran)?)$/.test(key))
    return 'apply'
  return 'other'
}

export interface CaptionLine {
  /** Baris asli (sudah di-trim) termasuk nomor dan bullet. */
  raw: string
  /** Baris tanpa nomor, bullet, atau emoji di awal. */
  text: string
  /** Terisi bila baris berbentuk "kunci: nilai" dengan kunci yang dikenali. */
  kv: { group: FieldGroup; key: string; value: string } | null
}

/** Pecah caption sebaris ("@x - roles: A - location: B - apply: C") menjadi baris-baris, lalu kenali pasangan kunci-nilai. */
export function splitCaptionLines(text: string): CaptionLine[] {
  const normalized = text.replace(INLINE_SEPARATOR_RE, '\n').replace(SENTENCE_KEY_RE, '$1\n')
  const lines: CaptionLine[] = []
  for (const piece of normalized.split(/\r?\n/)) {
    const raw = piece.trim()
    if (!raw) continue
    const stripped = raw.replace(LEADING_NUMBER_RE, '').replace(LEADING_MARKER_RE, '').trim()
    const m = stripped.match(KEY_VALUE_RE)
    lines.push({
      raw,
      text: stripped,
      kv: m ? { group: groupOfKey(m[1]), key: m[1].toLowerCase(), value: m[2].trim() } : null,
    })
  }
  return lines
}

function tidy(value: string): string {
  return value
    .replace(/\s+/g, ' ')
    .replace(/^[\s\-–—|•·,;:.!]+/, '')
    .replace(/[\s\-–—|•·,;:!]+$/, '')
    .trim()
}

function wordCount(value: string): number {
  return value.split(/\s+/).filter(Boolean).length
}

// ---------------------------------------------------------------------------------------------------------------------
// Header promosi ("LOWONGAN KERJA", "WE'RE HIRING!", "OPEN RECRUITMENT") bukan posisi, dan bukan nama perusahaan.
// ---------------------------------------------------------------------------------------------------------------------

// Urutan penting: frasa yang lebih panjang didahulukan supaya "lowongan kerja" tidak terpotong menjadi "lowongan".
const PROMO_PHRASES = [
  "we(?:'|’)?re\\s+hiring",
  'we\\s+are\\s+hiring',
  'now\\s+hiring',
  'open\\s+hiring',
  'open\\s+recruitment',
  '(?:is|are)\\s+hiring',
  'hiring',
  'recruitment',
  'rekrutmen',
  'job\\s+vacanc(?:y|ies)',
  'vacanc(?:y|ies)',
  'lowongan\\s+kerja',
  'info\\s+loker',
  'loker',
  'lowongan',
  'kesempatan\\s+(?:karir|karier|kerja)',
  'careers?',
  'karir',
  'karier',
  'dibutuhkan\\s+segera',
  'dibutuhkan',
  'dicari',
  'segera',
  'urgent',
  'join\\s+(?:us|our\\s+team|the\\s+team)',
  'bergabunglah',
]
const PROMO_ANY_RE = new RegExp(`\\b(?:${PROMO_PHRASES.join('|')})(?![\\p{L}])`, 'giu')
const PROMO_LEADING_RE = new RegExp(`^(?:${PROMO_PHRASES.join('|')})(?![\\p{L}])[\\s:：\\-–—|!.,•·]*`, 'iu')

/** Baris yang seluruh isinya frasa promosi, emoji, dan tanda baca ("LOWONGAN KERJA — WE'RE HIRING! 🚀"). */
export function isPromoOnlyLine(text: string): boolean {
  if (!text.trim()) return false
  return text.replace(PROMO_ANY_RE, ' ').replace(/[^\p{L}\p{N}]+/gu, '').length === 0
}

/** Buang frasa promosi di awal ("LOWONGAN KERJA: Admin" -> "Admin"). */
function stripLeadingPromo(value: string): string {
  let s = value.trim()
  for (let i = 0; i < 6; i++) {
    const next = s.replace(PROMO_LEADING_RE, '').trim()
    if (next === s) break
    s = next
  }
  return s
}

/** Buang label dalam kurung/siku ("(FIKTIF, untuk uji)", "(Hybrid)"), kecuali bentuk badan usaha "(Persero)" dan "(Tbk)". */
function stripParentheticals(value: string): string {
  return value
    .replace(/[(\[]([^()[\]]*)[)\]]/g, (m, inner: string) => (/^\s*(?:persero|tbk)\.?\s*$/i.test(inner) ? m : ' '))
    .replace(/[(\[][^()[\]]*$/, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

// Jenis pekerjaan dan mode kerja di akhir judul posisi ("Admin Operasional (Full-time)") bukan bagian nama posisi.
const EMPLOYMENT_TERMS = new Set([
  'full-time', 'full time', 'fulltime', 'part-time', 'part time', 'parttime', 'kontrak', 'contract', 'contractor', 'magang',
  'internship', 'intern', 'freelance', 'freelancer', 'tetap', 'permanent', 'remote', 'hybrid', 'onsite', 'on-site', 'wfo',
  'wfh', 'wfa', 'fresh graduate', 'fresh grad', 'penuh waktu', 'paruh waktu', 'harian', 'lepas', 'probation', 'project based',
])

function stripEmploymentSuffix(title: string): string {
  let s = title.trim()
  for (let i = 0; i < 3; i++) {
    const m = s.match(/\s*[(\[]([^()[\]]*)[)\]]\s*$/)
    if (!m) break
    const parts = m[1]
      .toLowerCase()
      .split(/\s*[\/,&+|]\s*|\s+(?:dan|atau|and|or)\s+/)
      .map((p) => p.trim())
      .filter(Boolean)
    if (parts.length === 0 || !parts.every((p) => EMPLOYMENT_TERMS.has(p))) break
    s = s.slice(0, m.index).trim()
  }
  return s
}

// ---------------------------------------------------------------------------------------------------------------------
// Tautan lamaran
// ---------------------------------------------------------------------------------------------------------------------

/** URL yang ditulis sebagai nilai "apply:" / "link:" / "daftar:" (didahulukan sebagai tautan lamaran). */
export function extractApplyKeyUrls(lines: CaptionLine[]): string[] {
  const urls: string[] = []
  for (const line of lines) {
    if (line.kv?.group !== 'apply') continue
    const value = line.kv.value
    const before = urls.length
    for (const u of extractUrlsFromText(value)) urls.push(u)
    // Tanpa skema: "apply: www.acme.com/careers" atau "apply: acme.com/jobs".
    if (urls.length === before) {
      const bare = value.match(/^(?:www\.)?[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)*\.[a-z]{2,}(?:\/\S*)?/i)
      if (bare && !/@/.test(bare[0])) {
        const safe = sanitizeHttpUrl(`https://${bare[0].replace(/[.,;:!?)]+$/, '')}`)
        if (safe) urls.push(safe)
      }
    }
  }
  return urls
}

// ---------------------------------------------------------------------------------------------------------------------
// Posisi
// ---------------------------------------------------------------------------------------------------------------------

// Header tanpa tanda ":" hanya untuk frasa yang jelas; kata umum (roles, positions, hiring, jobs) wajib diikuti ":" atau "-".
const ROLE_HEADER_RE =
  /^(?:posisi|lowongan(?:\s+kerja)?|we(?:'|’)?re hiring|we are hiring|dibutuhkan|terbuka untuk|(?:open\s+)?roles?(?=\s*[:\-–—])|(?:open\s+)?positions?(?=\s*[:\-–—])|jabatan(?=\s*[:\-–—])|job\s+titles?(?=\s*[:\-–—])|hiring\s+for(?=\s*[:\-–—])|hiring(?=\s*[:\-–—])|(?:jobs?|openings?|vacanc(?:y|ies))(?=\s*[:\-–—]))\b/i
const ROLE_SECTION_END_RE =
  /^(?:kualifikasi|persyaratan|requirements?|syarat|benefits?|cara melamar|how to apply|kirim cv|lokasi|locations?|penempatan|apply|company|perusahaan|salary|gaji|deadline|tentang|about)\b/i
const ROLE_NOISE_RE = /^(?:now|asap|urgent|immediately|segera|sekarang|here|ini|dibuka|open|ya|yuk|nih|guys|everyone)\W*$/i
const ROLE_WORD_RE = new RegExp(
  `\\b(?:${[
    'engineers?', 'developers?', 'programmers?', 'designers?', 'managers?', 'analysts?', 'admin(?:istrator)?', 'staff', 'officers?',
    'specialists?', 'executives?', 'assistants?', 'interns?', 'internship', 'magang', 'marketing', 'sales', 'accountants?', 'akuntan',
    'kasir', 'drivers?', 'supervisors?', 'leads?', 'heads?', 'directors?', 'consultants?', 'researchers?', 'scientists?', 'architects?',
    'writers?', 'editors?', 'operators?', 'teknisi', 'barista', 'koki', 'customer', 'support', 'recruiters?', 'hrd?', 'qa', 'devops',
    'product', 'content', 'creative', 'pelayan', 'sekretaris', 'apoteker', 'perawat', 'guru', 'dosen', 'kurir', 'gudang',
    'coordinators?', 'koordinator', 'agents?', 'representatives?', 'associates?', 'technicians?', 'mechanics?', 'cashiers?',
    'waiters?', 'chefs?', 'cooks?', 'tutors?', 'trainers?', 'auditors?', 'lawyers?', 'strategists?', 'producers?', 'animators?',
    'illustrators?', 'photographers?', 'videographers?', 'copywriters?', 'buyers?', 'planners?', 'clerks?', 'secretary', 'receptionist',
    'resepsionis', 'satpam', 'security', 'cleaning', 'helper', 'packing', 'penjaga', 'penjahit', 'tukang',
  ].join('|')})\\b`,
  'i',
)
const GREETING_LINE_RE =
  /^(?:halo|hai|hi|hello|hey|selamat|dear|kepada|yth|assalamualaikum|info|loker|lowongan kerja|vacancy|urgent|dicari|check|cek|yuk|ayo|guys|gaes|teman|thread|\d+\s*\/\s*\d+)\b/i
const NON_TITLE_LINE_RE =
  /^(?:kirim|send|email|e-mail|hubungi|contact|info|apply|daftar|lamar|cara|kualifikasi|persyaratan|requirements?|syarat|benefits?|salary|gaji|deadline|lokasi|location|penempatan)\b/i

/** Potong di akhir kalimat pertama, kecuali titik singkatan seperti "Sr." atau "Jr.". */
function firstSentence(value: string): string {
  const m = value.match(/(?<!\b[A-Za-z]{1,3})[.!?]\s+(?=[A-Z0-9])/)
  return m && m.index !== undefined ? value.slice(0, m.index) : value
}

function cleanRoleToken(value: string): string {
  return tidy(
    value
      .trim()
      .replace(/[\s‍️\p{Extended_Pictographic}]+$/u, '')
      .replace(/^(?:and|dan|&|\+)\s+/i, '')
      .replace(/[.!]+$/, ''),
  )
}

function isPlausibleRole(token: string): boolean {
  return token.length >= 3 && token.length <= 80 && !URL_OR_EMAIL_RE.test(token) && !ROLE_NOISE_RE.test(token) && /[A-Za-z]/.test(token)
}

/** Pecah daftar posisi ("A, B; C | D") di koma tingkat atas. Koma di dalam kurung dan tanda "/" tanpa spasi tidak memecah. */
export function splitRoleList(value: string): string[] {
  const text = firstSentence(value.replace(/\s+/g, ' ').trim())
  const parts: string[] = []
  let depth = 0
  let current = ''
  for (const ch of text) {
    if (ch === '(' || ch === '[' || ch === '{') depth++
    else if (ch === ')' || ch === ']' || ch === '}') depth = Math.max(0, depth - 1)
    if (depth === 0 && (ch === ',' || ch === ';' || ch === '|' || ch === '•' || ch === '·')) {
      parts.push(current)
      current = ''
      continue
    }
    current += ch
  }
  parts.push(current)
  const roles: string[] = []
  for (const part of parts) {
    for (const piece of part.split(/\s+\/\s+/)) {
      const token = cleanRoleToken(piece)
      if (isPlausibleRole(token)) roles.push(token)
    }
  }
  return roles
}

const PHRASE_ROLE_PATTERNS: RegExp[] = [
  /\bhiring\s+(?:for\s+)?(?:an?|the)\s+(.{3,90})$/i,
  /\bhiring\s+for\s+(.{3,90})$/i,
  /\b(?:looking\s+for|seeking|mencari|membutuhkan|butuh)\s+(?:an?\s+|seorang\s+|the\s+)?(.{3,90})$/i,
  /\b(?:membuka|buka|ada)\s+lowongan\s+(?:kerja\s+)?(?:untuk\s+)?(?:posisi\s+)?(.{3,90})$/i,
  /\blowongan\s+(?:kerja\s+)?(.{3,60}?)\s+(?:di|at)\s+\S/i,
  /\bjoin(?:ing)?\s+.{2,40}?\s+as\s+(?:an?\s+)?(.{3,60})$/i,
  /\bbergabung\s+(?:dengan|di|bersama)\s+.{2,40}?\s+sebagai\s+(.{3,60})$/i,
  // "Dicari cepat! Staff Admin & Kasir di Kopi Ruang Kerja": kata seru setelah "dicari" bukan akhir frasa.
  /\bdicari\b[\s!:,.-]*(?:(?:cepat|segera|urgent|banget)\b[\s!:,.-]*)*(.{3,90})$/i,
]

// "Mencari kandidat untuk bergabung" menyebut orang secara umum, bukan nama posisi.
const GENERIC_PEOPLE_RE =
  /^(?:kandidat|calon(?:\s+karyawan)?|karyawan|pegawai|pelamar|tenaga(?:\s+kerja)?|orang|talenta?|talents?|candidates?|people|anggota(?:\s+tim)?|rekan|teman(?:\s+baru)?|member(?:\s+baru)?|tim|team)\b/i

function rolesFromPhrase(lineText: string): string[] {
  for (const re of PHRASE_ROLE_PATTERNS) {
    const m = lineText.match(re)
    if (!m) continue
    let phrase = firstSentence(m[1])
    phrase = phrase.split(/\s+(?:to|untuk|yang|who|that|with|dengan|for|di|at|in|on|@|—|–)\s+/i)[0]
    phrase = phrase.replace(/\s[-–—]\s.*$/, '')
    const roles = splitRoleList(phrase).filter((r) => wordCount(r) <= 7 && !(GENERIC_PEOPLE_RE.test(r) && !ROLE_WORD_RE.test(r)))
    if (roles.length > 0) return roles
  }
  return []
}

// Baris pembuka daftar posisi tanpa kata "Posisi:" ("... membuka kesempatan untuk posisi:", "Kami mencari kandidat ...:").
const INTRO_LINE_RE = /[:：]\s*$/
const INTRO_EXPLICIT_RE = /\b(?:posisi|jabatan|positions?|roles?|lowongan|dibutuhkan|dicari)\b/i
const INTRO_GENERIC_RE = /\b(?:mencari|membutuhkan|butuh|hiring|membuka|merekrut|rekrut\w*|bergabung|join|bidang|kandidat|looking\s+for|seeking)\b/i
const LIST_MARKER_RE = /^(?:[-•*▪◦►▶→]|\d{1,3}[.)])\s+/
const EMOJI_MARKER_RE = /^[\p{Extended_Pictographic}]/u

/** Baris biasa tepat sesudah header/pembuka yang masuk akal sebagai satu nama posisi ("Junior Business Analyst"). */
function looksLikeRoleLine(line: CaptionLine): boolean {
  const t = line.text
  if (line.kv || t.length < 3 || t.length > 80 || wordCount(t) > 8) return false
  if (URL_OR_EMAIL_RE.test(t) || /^[#@]/.test(t) || /(?:^|\s)@\w+/.test(t)) return false
  if (NON_TITLE_LINE_RE.test(t) || ROLE_SECTION_END_RE.test(t) || isPromoOnlyLine(t)) return false
  if (/\b(?:is|are|sedang|lagi)\s+(?:now\s+)?hiring\b|\bmembuka\b|\bmerekrut\b|\bmencari\b/i.test(t)) return false
  return ROLE_WORD_RE.test(t)
}

interface RoleSection {
  /** true bila dibuka header/pembuka yang menyebut "posisi"/"dibutuhkan": butir bullet apa adanya dianggap posisi. */
  explicit: boolean
  /** Baris biasa berikutnya masih boleh menjadi satu posisi ("baris berikut sesudah header"). */
  justOpened: boolean
  /** Baris biasa sebelumnya diterima sebagai posisi, jadi baris pendek berikutnya yang mirip posisi juga diterima. */
  plainRun: boolean
  items: string[]
}

/** Ekstrak 1..N nama posisi dari poster/caption (kunci "roles:", header + daftar, atau kalimat umum). */
export function extractRoleTitles(text: string): string[] {
  if (!text.trim()) return [OFF_PORTAL_TITLE_PLACEHOLDER]
  const lines = splitCaptionLines(text)
  const roles: string[] = []
  const push = (list: string[]): boolean => {
    for (const r of list) {
      roles.push(r)
      if (roles.length >= MAX_OFF_PORTAL_ROLES) return true
    }
    return false
  }

  // 1. Header posisi ("Posisi:", "Dibutuhkan:", "We are hiring:"), baris pembuka ("... untuk posisi:"), atau header
  //    promosi ("LOWONGAN KERJA") yang diikuti baris posisi. Butir bernomor atau berbutir di bawahnya menjadi posisi sendiri-sendiri.
  // Dibungkus objek supaya penyempitan tipe TypeScript tidak salah paham atas perubahan di dalam closure.
  const state: { section: RoleSection | null } = { section: null }
  let full = false
  const flush = (): void => {
    const sec = state.section
    state.section = null
    if (!sec || sec.items.length === 0) return
    // Daftar yang dibuka kalimat umum ("Kami mencari ...:") hanya dipakai bila butirnya memang tampak seperti nama posisi.
    const roleish = sec.items.filter((t) => ROLE_WORD_RE.test(t)).length
    if (!sec.explicit && roleish * 2 < sec.items.length) return
    if (push(sec.items)) full = true
  }
  const open = (explicit: boolean): void => {
    flush()
    state.section = { explicit, justOpened: true, plainRun: false, items: [] }
  }
  for (const line of lines) {
    if (full) break
    const t = line.text
    const listMarker = LIST_MARKER_RE.test(line.raw)
    const emojiMarker = !listMarker && EMOJI_MARKER_RE.test(line.raw)
    const canBeItem = !line.kv && !ROLE_SECTION_END_RE.test(t) && !isPromoOnlyLine(t) && !URL_OR_EMAIL_RE.test(t)

    // Butir daftar di dalam bagian posisi didahulukan, supaya butir "Hiring Manager" tidak dianggap header.
    const sec = state.section
    if (sec && canBeItem) {
      if (listMarker || (emojiMarker && ROLE_WORD_RE.test(t))) {
        const title = stripEmploymentSuffix(t)
        if (title.length >= 3 && title.length <= 80) sec.items.push(title)
        sec.justOpened = false
        sec.plainRun = false
        continue
      }
      if ((sec.justOpened || (sec.plainRun && wordCount(t) <= 5)) && !emojiMarker && looksLikeRoleLine(line)) {
        sec.items.push(stripEmploymentSuffix(t))
        sec.justOpened = false
        sec.plainRun = true
        continue
      }
      // Daftar umum berakhir di baris biasa pertama sesudah butirnya.
      if (!sec.explicit && sec.items.length > 0 && !emojiMarker) flush()
    }

    if (isPromoOnlyLine(t)) {
      open(true)
      continue
    }
    if (ROLE_HEADER_RE.test(t)) {
      open(true)
      const rest = t.replace(ROLE_HEADER_RE, '')
      // "WE'RE HIRING! Join X as Y": tanda seru menutup header, sisanya bukan daftar posisi.
      let inline = /^\s*[!?.]/.test(rest) ? '' : stripLeadingPromo(rest.replace(/^\s*[:：\-–—]?\s*/, '').trim())
      if (!/[\p{L}\p{N}]/u.test(inline) || /^(?:di|at|untuk|for|yang|dengan|with|pt|cv)\b/i.test(inline) || /[:：]\s*$/.test(inline)) inline = ''
      // "LOWONGAN KERJA - Studio Kreasi": sesudah tanda hubung, tanpa kata jabatan, yang menyusul adalah nama perusahaan.
      else if (/^(?:lowongan|we)/i.test(t) && /^\s*[-–—|]/.test(rest) && !ROLE_WORD_RE.test(inline)) inline = ''
      if (inline) {
        if (state.section) state.section.justOpened = false
        if (push(splitRoleList(inline))) full = true
      }
      continue
    }
    if (!line.kv && INTRO_LINE_RE.test(t) && (INTRO_EXPLICIT_RE.test(t) || INTRO_GENERIC_RE.test(t))) {
      open(INTRO_EXPLICIT_RE.test(t))
      continue
    }
    if (ROLE_SECTION_END_RE.test(t)) {
      flush()
      continue
    }
    if (state.section) {
      state.section.justOpened = false
      state.section.plainRun = false
    }
  }
  flush()
  const fromHeaders = [...new Set(roles)]
  if (fromHeaders.length > 0) return fromHeaders.slice(0, MAX_OFF_PORTAL_ROLES)

  // 2. Kalimat umum: "X is hiring a Backend Engineer", "membuka lowongan Data Analyst", "mencari Staff Admin".
  for (const line of lines) {
    const found = rolesFromPhrase(line.text)
    if (found.length > 0) return [...new Set(found)].slice(0, MAX_OFF_PORTAL_ROLES)
  }

  // 3. Cadangan: baris pertama yang masuk akal sebagai judul (bukan nama perusahaan, akun, kunci lain, atau ajakan).
  for (const line of lines) {
    const t = line.text
    if (t.length < 3 || t.length > 90 || URL_OR_EMAIL_RE.test(t)) continue
    if (line.kv || isPromoOnlyLine(t)) continue
    if (/^#/.test(t) || /^@/.test(t) || /(?:^|\s)@\w+/.test(t)) continue
    if (NON_TITLE_LINE_RE.test(t) || ROLE_SECTION_END_RE.test(t)) continue
    if (/\b(?:is|are|sedang|lagi)\s+(?:now\s+)?hiring\b|\bhiring!*$|\bmembuka\b|\bmerekrut\b/i.test(t)) continue
    if (/^(?:pt|cv)(?:\.|\s)/i.test(t)) continue
    if (GREETING_LINE_RE.test(t) || wordCount(t) > 10) continue
    // Tanpa kata jabatan, baris pertama bisa saja bukan nama posisi. Lebih jujur ditandai "belum terbaca".
    if (!ROLE_WORD_RE.test(t) || /^(?:we(?:'|’)?re|we are)\s+hiring\b/i.test(t)) continue
    return [t]
  }
  return [OFF_PORTAL_TITLE_PLACEHOLDER]
}

// ---------------------------------------------------------------------------------------------------------------------
// Perusahaan
// ---------------------------------------------------------------------------------------------------------------------

/**
 * "CV" juga bentuk badan usaha (CV Maju Jaya), jadi baris berawalan CV hanya ditolak
 * bila isinya perintah mengirim CV/resume ("CV dan portofolio ke x@y.com").
 */
function isCvSendingLine(line: string): boolean {
  if (/^\s*cv\.?\s*(?:(?:dan|atau|ke|lamaran|terbaru)\b|&)/i.test(line)) return true
  return /@/.test(line) || /\bkirim/i.test(line)
}

const COMPANY_STOPWORDS =
  /^(?:we|our|us|kami|kita|they|who|company|perusahaan|tim|team|the|a|an|saya|aku|kamu|anda|you|i|this|ini|itu|dia|di|at|hiring|jobs?|lowongan|info|loker|urgent|hello|halo|hi)$/i

function cutCompanyTail(raw: string): string {
  // Label dalam kurung ("(FIKTIF, untuk uji)", "(Yogyakarta)", "(Hybrid)") bukan bagian nama perusahaan.
  let s = stripParentheticals(raw.trim())
  s = s.split(URL_OR_EMAIL_RE)[0]
  s = s.split(/\s+(?:membuka|sedang|lagi|mencari|merekrut|membutuhkan|butuh|dibutuhkan|menerima|is\s+hiring|are\s+hiring|hiring|open|kirim|buka)\b/i)[0]
  s = s.split(/\s+[-–—|•]\s+|[,;|]\s+|\.\s+(?=[A-Z])/)[0]
  return tidy(s)
}

function leadingCapitalizedName(chunk: string): string | null {
  const m = chunk.trim().match(/^([A-Z0-9][\w&.'’-]*(?:\s+(?:[A-Z0-9][\w&.'’-]*|&)){0,4})/)
  if (!m) return null
  const name = tidy(m[1])
  return validCompanyName(name) ? name : null
}

function validCompanyName(name: string): boolean {
  if (name.length < 2 || name.length > 60) return false
  if (URL_OR_EMAIL_RE.test(name)) return false
  if (wordCount(name) > 6) return false
  const first = name.split(/\s+/)[0].replace(/['’].*$/, '')
  if (COMPANY_STOPWORDS.test(name) || COMPANY_STOPWORDS.test(first)) return false
  // "lowongan di Surabaya" atau "di Jakarta Selatan" menyebut kota, bukan perusahaan.
  const withoutArea = name.replace(/\b(?:kota|kabupaten|kab\.?|raya|pusat|utara|selatan|barat|timur|tengah)\b/gi, ' ').replace(/\s+/g, ' ').trim()
  if (!withoutArea || KNOWN_CITIES.some((c) => c.toLowerCase() === withoutArea.toLowerCase())) return false
  return /[A-Za-z]/.test(name)
}

const HANDLE_LINE_RE =
  /^(?:(.{2,40}?)\s*[\/|]\s*)?@([A-Za-z0-9_]{2,30})(?=\s*$|\s*[-–—:|(]|\s+(?:is|are|sedang|lagi|membuka|buka|hiring|merekrut)\b)/i
const HANDLE_HIRING_RE = /(?<![\w.])@([A-Za-z0-9_]{2,30})\s+(?:is|are|sedang|lagi|membuka|buka|hiring|merekrut)\b/i
const NAME_HIRING_RE =
  /^(.{2,45}?)\s+(?:(?:is|are|sedang|lagi)\s+(?:now\s+)?)?(?:hiring|membuka|merekrut|mencari|membutuhkan|buka\s+lowongan)\b/i
const NAME_AFTER_RE =
  /(?:hiring\s+at|lowongan(?:\s+kerja)?\s+di|bergabung\s+(?:dengan|di|bersama)|join(?:ing)?|kerja\s+di|karir\s+di)\s+(.{2,50})/i
// "Dicari cepat! Staff Admin & Kasir di Kopi Ruang Kerja": nama tempat sesudah "di" pada kalimat "dicari/dibutuhkan".
const NAME_AFTER_WANTED_RE = /\b(?:dicari|dibutuhkan)\b[^\n]*?\s+di\s+(.{2,50})/i
// "OPEN RECRUITMENT — Studio Kreasi Harmoni": header promosi yang diikuti nama perusahaan.
const PROMO_NAME_HEADER_RE =
  /^(?:open\s+recruitment|open\s+hiring|lowongan\s+kerja|info\s+loker|loker|job\s+vacanc(?:y|ies)|vacanc(?:y|ies)|rekrutmen|recruitment|kesempatan\s+(?:karir|karier|kerja)|careers?|karir|karier)\s*[-–—|:•]\s*(.+)$/i

const GENERIC_URL_HOSTS = [
  'forms.gle',
  'google.com',
  'bit.ly',
  'tinyurl.com',
  's.id',
  'cutt.ly',
  'rebrand.ly',
  'shorturl.at',
  'wa.me',
  'whatsapp.com',
  't.me',
  'telegram.me',
  'linktr.ee',
  'typeform.com',
  'tally.so',
  'airtable.com',
  'canva.com',
  'lnkd.in',
  'linkedin.com',
  't.co',
  'notion.so',
  'github.com',
  'medium.com',
]
const PATH_SLUG_HOSTS = [
  'greenhouse.io',
  'lever.co',
  'ashbyhq.com',
  'workable.com',
  'smartrecruiters.com',
  'jobvite.com',
  'rippling.com',
  'gem.com',
  'dover.com',
  'wellfound.com',
]
const SUBDOMAIN_NAME_HOSTS = [
  'notion.site',
  'breezy.hr',
  'recruitee.com',
  'bamboohr.com',
  'myworkdayjobs.com',
  'teamtailor.com',
  'freshteam.com',
  'personio.de',
  'personio.com',
  'pinpointhq.com',
  'jobs.workable.com',
]
const TWO_PART_SUFFIXES = new Set(['co.id', 'or.id', 'ac.id', 'go.id', 'web.id', 'sch.id', 'my.id', 'co.uk', 'com.au', 'co.jp', 'com.sg', 'co.nz', 'com.my'])
const NAME_PREFIX_LABELS = new Set(['www', 'careers', 'career', 'jobs', 'job', 'apply', 'hiring', 'work', 'join', 'talent', 'recruit', 'karir', 'lowongan'])

function prettifySlug(slug: string): string | null {
  const cleaned = decodeURIComponent(slug)
    .replace(/\.(?:com|io|co|org|net|ai|xyz|fi|app|dev)$/i, '')
    .replace(/[-_]+/g, ' ')
    .trim()
  if (cleaned.length < 2 || cleaned.length > 40 || !/[a-z]/i.test(cleaned)) return null
  return cleaned.replace(/\b[a-z]/g, (c) => c.toUpperCase())
}

/** Cadangan terakhir: nama perusahaan dari tautan lamaran (slug ATS, subdomain situs karier, atau domain situsnya). */
export function companyFromUrl(rawUrl: string | null | undefined): string | null {
  const safe = sanitizeHttpUrl(rawUrl)
  if (!safe) return null
  try {
    const u = new URL(safe)
    const host = u.hostname.toLowerCase().replace(/^www\./, '')
    if (hostMatchesDomain(host, GENERIC_URL_HOSTS) || detectSocialPostPlatform(safe)) return null
    const labels = host.split('.')
    if (hostMatchesDomain(host, PATH_SLUG_HOSTS)) {
      const slug = u.pathname.split('/').filter(Boolean)[0]
      return slug ? prettifySlug(slug) : null
    }
    if (hostMatchesDomain(host, SUBDOMAIN_NAME_HOSTS)) {
      const sub = labels[0]
      return sub && !NAME_PREFIX_LABELS.has(sub) ? prettifySlug(sub) : null
    }
    const tail2 = labels.slice(-2).join('.')
    const suffixLen = TWO_PART_SUFFIXES.has(tail2) ? 2 : 1
    const base = labels[labels.length - suffixLen - 1]
    if (!base || NAME_PREFIX_LABELS.has(base) || base.length < 2) return null
    return prettifySlug(base)
  } catch {
    return null
  }
}

export interface ExtractedCompany {
  name: string
  source: ExtractedCompanySource
}

export function extractCompanyName(lines: CaptionLine[], opts: { hint?: string; applyUrl?: string | null } = {}): ExtractedCompany {
  if (opts.hint && opts.hint.trim()) return { name: opts.hint.trim().slice(0, 200), source: 'hint' }

  // 1. Label eksplisit: "Perusahaan: X", "Company: X", atau awalan badan usaha PT/CV.
  for (const line of lines) {
    if (line.kv?.group === 'company' && line.kv.value) {
      const name = cutCompanyTail(line.kv.value)
      if (name.length >= 2) return { name: name.slice(0, 200), source: 'label' }
      continue
    }
    const m = line.text.match(/^(pt|cv)(\.?)(?=[\s:\-]|$)\s*[:\-]?\s*(.+)$/i)
    if (!m) continue
    if (m[1].toLowerCase() === 'cv' && isCvSendingLine(line.text)) continue
    const rest = cutCompanyTail(m[3])
    if (rest.length >= 2) return { name: `${m[1]}${m[2]} ${rest}`.slice(0, 200), source: 'label' }
  }

  // 1b. "PT Nama Perusahaan" di tengah kalimat: "Hi guys, PT Kreasi Nusantara lagi buka lowongan ...". Hanya PT bergaya huruf besar.
  for (const line of lines) {
    if (line.kv) continue
    const m = line.text.match(/(?<![\w.])PT\.?\s+([A-Z][\w&'’-]*(?:\s+[A-Z][\w&'’-]*){0,3})/)
    if (m && validCompanyName(m[1])) return { name: `PT ${m[1]}`, source: 'label' }
  }

  // 1c. Header promosi diikuti nama: "OPEN RECRUITMENT — Studio Kreasi Harmoni (label)". Kata jabatan berarti itu posisi, bukan perusahaan.
  for (const line of lines) {
    if (line.kv) continue
    const m = line.text.match(PROMO_NAME_HEADER_RE)
    if (!m) continue
    const name = cutCompanyTail(m[1])
    if (name.length >= 2 && validCompanyName(name) && !ROLE_WORD_RE.test(name)) return { name: name.slice(0, 200), source: 'phrase' }
  }

  // 2. Akun media sosial: "10. @AnodosFinance", "18. Kraken / @Krak", "@acme is hiring".
  for (const line of lines) {
    const handleLine = line.text.match(HANDLE_LINE_RE)
    if (handleLine) {
      const label = handleLine[1] ? tidy(handleLine[1]) : ''
      if (label && validCompanyName(label)) return { name: label, source: 'handle' }
      return { name: handleLine[2], source: 'handle' }
    }
    const hiring = line.text.match(HANDLE_HIRING_RE)
    if (hiring) return { name: hiring[1], source: 'handle' }
  }

  // 3. Kalimat: "Acme Corp is hiring ...", "PT Maju membuka lowongan ...", "hiring at Acme", "lowongan di Acme".
  for (const line of lines) {
    if (line.kv) continue
    if (isPromoOnlyLine(line.text)) continue
    const lead = line.text.match(NAME_HIRING_RE)
    if (lead) {
      const name = leadingCapitalizedName(stripParentheticals(lead[1]))
      if (name && name === tidy(stripParentheticals(lead[1]))) return { name, source: 'phrase' }
    }
    const after = line.text.match(NAME_AFTER_RE) ?? line.text.match(NAME_AFTER_WANTED_RE)
    if (after) {
      const name = leadingCapitalizedName(after[1])
      if (name) return { name, source: 'phrase' }
    }
  }

  // 4. Nama dari tautan lamaran.
  const fromUrl = companyFromUrl(opts.applyUrl)
  if (fromUrl) return { name: fromUrl, source: 'url' }
  return { name: OFF_PORTAL_COMPANY_PLACEHOLDER, source: 'fallback' }
}

// ---------------------------------------------------------------------------------------------------------------------
// Lokasi
// ---------------------------------------------------------------------------------------------------------------------

/** Bersihkan nilai lokasi dari tautan, email, ekor "apply: ...", dan tagar. Kosong bila tidak ada sisanya. */
export function cleanLocationValue(value: string): string {
  let s = value
  s = s.replace(/https?:\/\/\S*/gi, ' ').replace(/\bwww\.\S*/gi, ' ').replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, ' ')
  s = s.replace(
    /\s*[-–—|•·,;(]?\s*\b(?:apply|link|cara\s+melamar|how\s+to\s+apply|daftar|lamar|kirim|contact|hubungi|email)\b.*$/i,
    '',
  )
  s = s.replace(/#\w+/g, ' ')
  s = s.replace(/\(\s*\)/g, ' ').replace(/\(\s*$/, ' ')
  // Kurung tutup tanpa pasangan terbawa dari kalimat sekitarnya: "(Penempatan: Sleman, Remote):" -> "Sleman, Remote".
  let depth = 0
  s = [...s]
    .filter((ch) => {
      if (ch === '(') depth++
      else if (ch === ')') {
        if (depth === 0) return false
        depth--
      }
      return true
    })
    .join('')
  // Titik akhir kalimat bukan bagian lokasi ("Yogyakarta (Di kantor).").
  return tidy(s).replace(/\.+$/, '').trim().slice(0, 120)
}

const KNOWN_CITIES = [
  'Jakarta',
  'Bandung',
  'Surabaya',
  'Yogyakarta',
  'Jogja',
  'Semarang',
  'Medan',
  'Denpasar',
  'Bali',
  'Malang',
  'Tangerang',
  'Bekasi',
  'Depok',
  'Bogor',
  'Makassar',
  'Batam',
  'Palembang',
  'Balikpapan',
  'Pontianak',
  'Manado',
  'Banjarmasin',
  'Pekanbaru',
  'Padang',
  'Lampung',
]
const CITY_RE = new RegExp(`\\b(${KNOWN_CITIES.join('|')})\\b`)

export interface ExtractedLocation {
  value: string
  found: boolean
}

export function extractLocationValue(lines: CaptionLine[], text: string, hint?: string): ExtractedLocation {
  if (hint && hint.trim()) return { value: hint.trim().slice(0, 120), found: true }

  for (const line of lines) {
    if (line.kv?.group !== 'location') continue
    const cleaned = cleanLocationValue(line.kv.value)
    if (cleaned.length >= 2) return { value: cleaned, found: true }
  }
  // Bentuk lain: "Lokasi - Jakarta", "Work location: ...", atau penanda pin.
  const loose = text.match(/(?:lokasi|penempatan|location)\s*[:\-]\s*([^\n]{2,80})/i)
  if (loose) {
    const cleaned = cleanLocationValue(loose[1])
    if (cleaned.length >= 2) return { value: cleaned, found: true }
  }
  const pin = text.match(/📍\s*([^\n]{2,80})/)
  if (pin) {
    const cleaned = cleanLocationValue(pin[1])
    if (cleaned.length >= 2) return { value: cleaned, found: true }
  }
  if (/\b(?:fully\s+|100%\s+)?remote\b|\bwfh\b|work\s+from\s+home/i.test(text)) return { value: 'Remote', found: true }
  const city = text.match(CITY_RE)
  if (city) return { value: city[1], found: true }
  return { value: OFF_PORTAL_LOCATION_DEFAULT, found: false }
}
