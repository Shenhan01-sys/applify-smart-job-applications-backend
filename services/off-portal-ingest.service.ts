import crypto from 'node:crypto'
import {
  SOCIAL_POST_PLATFORM_LABELS,
  classifyJobChannel,
  detectSocialPostPlatform,
  extractApplyEmail,
  extractUrlsFromText,
  isLinkedInUrl,
  isPublicHttpUrl,
  type ChannelClassification,
  type SocialPostPlatform,
} from './apply-channel.js'
import { assessJobSafety, type JobSafetyReport } from './job-safety.service.js'
import {
  MAX_OFF_PORTAL_CANDIDATES,
  MAX_OFF_PORTAL_ROLES,
  OFF_PORTAL_COMPANY_PLACEHOLDER,
  OFF_PORTAL_LOCATION_DEFAULT,
  OFF_PORTAL_TITLE_PLACEHOLDER,
  extractApplyKeyUrls,
  extractBlockCompany,
  extractCompanyName,
  extractLocationValue,
  extractRoleTitles,
  normalizeCopiedPostText,
  splitCaptionLines,
  splitCompanyBlocks,
  type CaptionLine,
  type CompanyBlock,
} from './off-portal-extract.js'
import {
  OFF_PORTAL_AI_TIMEOUT_MS,
  normalizeOffPortalAiOutput,
  offPortalAiTriggers,
  withOffPortalAiTimeout,
  type OffPortalAiCandidate,
  type OffPortalAiExtractor,
} from './off-portal-ai.service.js'

/**
 * Parser deterministik pratinjau ingesti lowongan off-portal (link, caption media sosial, teks poster/OCR,
 * dan tautan hasil baca QR) — fondasi 47.3 P0-01 & 48.4 BS-P3-08.
 *
 * Sifat:
 *   - Stateless (tidak menulis ke database sebelum migrasi privat DRAFT_2026-11-26_private_offportal_jobs.sql diterapkan).
 *   - Tidak pernah mengambil isi URL. Instagram, X, Facebook, dan LinkedIn meminta login, jadi captionnya harus ditempel pengguna.
 *   - Mendukung poster multi-role: satu unggahan menghasilkan 1..N kandidat lowongan dengan `source_group_id` sama
 *     dan `publication_fingerprint` deterministik per (peran + perusahaan + kontak/URL).
 *   - Mendukung tempelan multi-perusahaan (utas X "1. @akun - roles: ... - apply: ..."): tiap butir bernomor dibaca sebagai
 *     kelompok sendiri dengan perusahaan, posisi, lokasi, tautan, dan deskripsinya sendiri. Kandidat tidak pernah mewarisi
 *     tautan, email, atau perusahaan dari butir lain. Batas 50 kandidat per tempelan (`MAX_OFF_PORTAL_CANDIDATES`);
 *     kelebihannya dilaporkan di `warnings` beserta jumlah aslinya.
 *   - Memvalidasi setiap URL (sumber, teks, QR) lewat `isPublicHttpUrl` agar URL privat/IP/javascript: ditolak.
 *   - Tautan postingan media sosial tidak pernah dijadikan tautan lamaran. Tautan LinkedIn diberi peringatan lamar manual.
 *   - Menyertakan deteksi kontak WhatsApp (`wa.me` / `api.whatsapp.com`), formulir eksternal (Google Form/Typeform/Tally),
 *     email HR, klasifikasi kanal, serta laporan anti-scam (`assessJobSafety`).
 *   - Ekstraksi posisi, perusahaan, dan lokasi ada di `off-portal-extract.ts`.
 *   - `parseOffPortalPosting` murni aturan dan sinkron. `parseOffPortalPostingWithAi` menjalankannya, lalu memanggil cadangan AI
 *     (`off-portal-ai.service.ts`) hanya bila aturan gagal membaca lowongan. Kandidat bertanda `extraction: 'rules' | 'ai'`.
 */

export type OffPortalSourceType = 'off_portal_link' | 'off_portal_poster' | 'off_portal_caption'

export interface OffPortalParseInput {
  rawText?: string
  sourceUrl?: string
  sourceType?: OffPortalSourceType
  qrUrls?: string[]
  companyHint?: string
  locationHint?: string
  sourceGroupId?: string
}

export type OffPortalUnreadField = 'title' | 'company' | 'location'
/** Bidang yang bisa diisi cadangan AI. */
export type OffPortalAiField = 'title' | 'company' | 'location' | 'applyUrl' | 'applyEmail'
export type OffPortalExtraction = 'rules' | 'ai'

export interface ParsedOffPortalJob {
  title: string
  company: string
  location: string
  description: string
  sourceType: OffPortalSourceType
  sourceGroupId: string
  publicationFingerprint: string
  applyUrl: string | null
  applyEmail: string | null
  whatsappUrl: string | null
  formProvider: 'google_forms' | 'typeform' | 'tally' | 'airtable' | null
  channel: ChannelClassification
  safety: JobSafetyReport
  /** Bidang yang tidak terbaca dari teks dan memakai nilai bawaan; pengguna perlu memeriksanya. */
  unreadFields: OffPortalUnreadField[]
  /** Peringatan khusus lowongan ini, mis. LinkedIn wajib dilamar manual. */
  warnings: string[]
  /** Sumber kandidat: parser aturan, atau cadangan AI (hanya bila parser aturan gagal membaca lowongan). */
  extraction: OffPortalExtraction
  /** Bidang yang diisi AI (kosong bila `extraction` 'rules'). Isinya perlu diperiksa pengguna. */
  aiFields: OffPortalAiField[]
}

export interface OffPortalSocialPost {
  url: string
  platform: SocialPostPlatform
  label: string
}

export interface OffPortalParseResult {
  sourceGroupId: string
  sourceType: OffPortalSourceType
  acceptedUrls: string[]
  rejectedUrls: string[]
  jobs: ParsedOffPortalJob[]
  /** Tautan postingan media sosial yang ditemukan. Bukan tautan lamaran, hanya sumber. */
  socialPosts: OffPortalSocialPost[]
  /** true bila hanya ada tautan postingan sosial tanpa teks: pengguna harus menempel caption. */
  needsCaption: boolean
  warnings: string[]
}

export const MAX_OFF_PORTAL_TEXT_CHARS = 12_000
export const MAX_OFF_PORTAL_QR_URLS = 10
export { MAX_OFF_PORTAL_CANDIDATES, MAX_OFF_PORTAL_ROLES, extractRoleTitles }

export const LINKEDIN_MANUAL_APPLY_WARNING =
  'Lowongan LinkedIn wajib dilamar manual di LinkedIn. Applify tidak mengisi atau mengirim lamaran di LinkedIn, jadi simpan lowongannya lalu lamar sendiri lewat tautannya.'

const AI_FIELD_LABELS: Record<OffPortalAiField, string> = {
  title: 'posisi',
  company: 'perusahaan',
  location: 'lokasi',
  applyUrl: 'tautan lamaran',
  applyEmail: 'email lamaran',
}

export const OFF_PORTAL_AI_RESULT_WARNING =
  'Sebagian isi lowongan dibaca dengan bantuan AI karena aturan sederhana tidak menemukannya. Periksa posisi, perusahaan, dan lokasinya sebelum menyimpan.'

function aiJobWarning(fields: readonly OffPortalAiField[]): string {
  return `Dibaca dengan bantuan AI karena aturan sederhana tidak menemukannya: ${fields.map((f) => AI_FIELD_LABELS[f]).join(', ')}. Periksa sebelum menyimpan.`
}

export function buildSocialCaptionRequiredMessage(posts: OffPortalSocialPost[]): string {
  const labels = [...new Set(posts.map((p) => p.label))].join(', ')
  return `Tautan postingan ${labels} tidak bisa dibaca otomatis karena platform itu meminta login. Buka postingannya, salin caption lengkapnya, lalu tempel di kolom caption. Tautan postingan bukan tautan lamaran, jadi tidak dipakai untuk melamar.`
}

const WHATSAPP_HOSTS = new Set(['wa.me', 'api.whatsapp.com', 'chat.whatsapp.com'])

function detectFormProvider(rawUrl: string | null): ParsedOffPortalJob['formProvider'] {
  if (!rawUrl) return null
  try {
    const u = new URL(rawUrl)
    const host = u.hostname.toLowerCase().replace(/^www\./, '')
    if (host === 'forms.gle' || (host === 'docs.google.com' && u.pathname.includes('/forms/'))) return 'google_forms'
    if (host === 'typeform.com' || host.endsWith('.typeform.com')) return 'typeform'
    if (host === 'tally.so') return 'tally'
    if (host === 'airtable.com' || host.endsWith('.airtable.com')) return 'airtable'
    return null
  } catch {
    return null
  }
}

function isWhatsAppUrl(rawUrl: string): boolean {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase().replace(/^www\./, '')
    return WHATSAPP_HOSTS.has(host)
  } catch {
    return false
  }
}

export function buildPublicationFingerprint(parts: {
  title: string
  company: string
  applyUrl: string | null
  applyEmail: string | null
  description: string
}): string {
  const norm = (s: string | null | undefined) =>
    String(s ?? '')
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim()
  const payload = [
    norm(parts.title),
    norm(parts.company),
    norm(parts.applyUrl),
    norm(parts.applyEmail),
    norm(parts.description).slice(0, 400),
  ].join('|')
  return crypto.createHash('sha256').update(payload, 'utf8').digest('hex')
}

interface JobBase {
  sourceType: OffPortalSourceType
  sourceGroupId: string
  now: Date
}

interface JobSpec {
  title: string
  company: string
  location: string
  locationFound: boolean
  description: string
  applyUrl: string | null
  applyEmail: string | null
  whatsappUrl: string | null
  extraction?: OffPortalExtraction
  aiFields?: OffPortalAiField[]
}

/** Satu kandidat dari bidang yang sudah ditentukan. Dipakai bersama oleh jalur aturan (satu lowongan, multi-perusahaan) dan cadangan AI. */
function buildJob(base: JobBase, s: JobSpec): ParsedOffPortalJob {
  const channel = classifyJobChannel({
    platform_source: base.sourceType,
    external_url: s.applyUrl,
    apply_email: s.applyEmail,
    description: s.description,
  })
  const safety = assessJobSafety(
    {
      title: s.title,
      company: s.company,
      description: s.description,
      external_url: s.applyUrl,
      apply_email: s.applyEmail,
      posted_at: base.now.toISOString(),
    },
    base.now,
  )
  const unreadFields: OffPortalUnreadField[] = []
  if (s.title === OFF_PORTAL_TITLE_PLACEHOLDER) unreadFields.push('title')
  if (s.company === OFF_PORTAL_COMPANY_PLACEHOLDER) unreadFields.push('company')
  if (!s.locationFound) unreadFields.push('location')
  const aiFields = s.aiFields ?? []
  const warnings: string[] = []
  if (isLinkedInUrl(s.applyUrl)) warnings.push(LINKEDIN_MANUAL_APPLY_WARNING)
  if (aiFields.length > 0) warnings.push(aiJobWarning(aiFields))
  return {
    title: s.title,
    company: s.company,
    location: s.location,
    description: s.description,
    sourceType: base.sourceType,
    sourceGroupId: base.sourceGroupId,
    publicationFingerprint: buildPublicationFingerprint({
      title: s.title,
      company: s.company,
      applyUrl: s.applyUrl,
      applyEmail: s.applyEmail,
      description: s.description,
    }),
    applyUrl: s.applyUrl,
    applyEmail: s.applyEmail,
    whatsappUrl: s.whatsappUrl,
    formProvider: detectFormProvider(s.applyUrl),
    channel,
    safety,
    unreadFields,
    warnings,
    extraction: s.extraction ?? 'rules',
    aiFields,
  }
}

/** Tautan lamaran dari satu blok perusahaan: hanya URL di blok itu (kunci "apply:" dulu), publik, dan bukan postingan sosial. */
function blockApplyUrls(lines: CaptionLine[], blockText: string): string[] {
  const out: string[] = []
  for (const u of [...extractApplyKeyUrls(lines), ...extractUrlsFromText(blockText)]) {
    if (!out.includes(u) && isPublicHttpUrl(u) && !detectSocialPostPlatform(u)) out.push(u)
  }
  return out
}

/**
 * Kandidat dari tempelan multi-perusahaan. Setiap blok dibaca sendiri: perusahaan (nama tanpa @), posisi, lokasi, tautan
 * lamaran, email, dan deskripsi hanya dari teks blok itu. Blok tanpa tautan atau email tidak meminjam milik blok lain;
 * kanalnya dibiarkan kosong supaya pengguna melihatnya apa adanya. `locationHint` hanya mengisi blok tanpa lokasi.
 */
function jobsFromCompanyBlocks(blocks: CompanyBlock[], base: JobBase, locationHint: string | undefined, warnings: string[]): ParsedOffPortalJob[] {
  const hint = locationHint?.trim() ? locationHint.trim().slice(0, 120) : ''
  const jobs: ParsedOffPortalJob[] = []
  let total = 0
  let lastCompany = 0
  blocks.forEach((block, index) => {
    const lines = splitCaptionLines(block.text)
    const urls = blockApplyUrls(lines, block.text)
    const whatsappUrl = urls.find(isWhatsAppUrl) ?? null
    const applyUrl = urls.find((u) => !isWhatsAppUrl(u)) ?? urls[0] ?? null
    const applyEmail = extractApplyEmail(block.text)
    const company = extractBlockCompany(lines, applyUrl).name
    const loc = extractLocationValue(lines, block.text)
    const location = loc.found || !hint ? loc.value : hint
    const titles = extractRoleTitles(block.text, MAX_OFF_PORTAL_CANDIDATES)
    total += titles.length
    for (const title of titles) {
      if (jobs.length >= MAX_OFF_PORTAL_CANDIDATES) break
      jobs.push(
        buildJob(base, {
          title,
          company,
          location,
          locationFound: loc.found || Boolean(hint),
          description: block.text,
          applyUrl,
          applyEmail,
          whatsappUrl,
        }),
      )
      lastCompany = index + 1
    }
  })
  if (total > jobs.length) {
    warnings.push(
      `Caption memuat ${total} lowongan dari ${blocks.length} perusahaan. Yang ditampilkan ${jobs.length} pertama (sampai perusahaan ke-${lastCompany}). Tempel sisanya sebagai caption terpisah.`,
    )
  }
  return jobs
}

/** Konteks parser aturan yang dipakai cadangan AI untuk membangun ulang kandidat. Null untuk tempelan multi-perusahaan. */
interface AiMergeContext {
  rawText: string
  base: JobBase
  description: string
  company: string
  location: string
  locationFound: boolean
  applyUrl: string | null
  applyEmail: string | null
  whatsappUrl: string | null
}

interface Analysis {
  result: OffPortalParseResult
  ai: AiMergeContext | null
}

function analyzeOffPortalPosting(input: OffPortalParseInput, now: Date): Analysis {
  // Salinan halaman web memecah teks di setiap mention dan tautan, dan membawa sisa antarmuka X. Dirapikan sekali di sini supaya
  // semua pembacaan sesudahnya (blok perusahaan, tautan, lokasi, deskripsi, cadangan AI) melihat teks yang sama.
  const rawText = normalizeCopiedPostText(typeof input.rawText === 'string' ? input.rawText.slice(0, MAX_OFF_PORTAL_TEXT_CHARS) : '')
  const sourceType: OffPortalSourceType =
    input.sourceType === 'off_portal_poster' || input.sourceType === 'off_portal_caption'
      ? input.sourceType
      : 'off_portal_link'
  const sourceGroupId = input.sourceGroupId?.trim() || crypto.randomUUID()
  const base: JobBase = { sourceType, sourceGroupId, now }
  const lines = splitCaptionLines(rawText)

  // Urutan kandidat tautan: tautan yang diisi pengguna, QR, nilai "apply:" di teks, lalu tautan lain di teks.
  const candidateUrls: string[] = []
  if (typeof input.sourceUrl === 'string' && input.sourceUrl.trim()) candidateUrls.push(input.sourceUrl.trim())
  if (Array.isArray(input.qrUrls)) {
    for (const u of input.qrUrls.slice(0, MAX_OFF_PORTAL_QR_URLS)) {
      if (typeof u === 'string' && u.trim()) candidateUrls.push(u.trim())
    }
  }
  for (const u of extractApplyKeyUrls(lines)) candidateUrls.push(u)
  for (const u of extractUrlsFromText(rawText)) candidateUrls.push(u)

  const acceptedUrls: string[] = []
  const rejectedUrls: string[] = []
  const seen = new Set<string>()
  for (const raw of candidateUrls) {
    if (seen.has(raw)) continue
    seen.add(raw)
    if (isPublicHttpUrl(raw)) {
      acceptedUrls.push(raw)
    } else {
      rejectedUrls.push(raw)
    }
  }

  // Tautan postingan media sosial hanya sumber. Isinya tidak bisa dibaca server (butuh login) dan bukan tautan lamaran.
  const socialPosts: OffPortalSocialPost[] = []
  const applyCandidates: string[] = []
  for (const url of acceptedUrls) {
    const platform = detectSocialPostPlatform(url)
    if (platform) socialPosts.push({ url, platform, label: SOCIAL_POST_PLATFORM_LABELS[platform] })
    else applyCandidates.push(url)
  }

  const warnings: string[] = []
  const hasText = rawText.trim().length > 0

  if (!hasText && socialPosts.length > 0 && applyCandidates.length === 0) {
    warnings.push(buildSocialCaptionRequiredMessage(socialPosts))
    if (socialPosts.some((p) => p.platform === 'linkedin_post')) warnings.push(LINKEDIN_MANUAL_APPLY_WARNING)
    return {
      result: {
        sourceGroupId,
        sourceType,
        acceptedUrls,
        rejectedUrls,
        jobs: [],
        socialPosts,
        needsCaption: true,
        warnings,
      },
      ai: null,
    }
  }
  if (socialPosts.length > 0) {
    const labels = [...new Set(socialPosts.map((p) => p.label))].join(', ')
    warnings.push(`Tautan postingan ${labels} dipakai sebagai sumber saja, bukan tautan lamaran. Tautan lamaran diambil dari isi caption.`)
  }

  const blocks = splitCompanyBlocks(rawText)
  let jobs: ParsedOffPortalJob[]
  let primaryIsLinkedIn = false
  let ai: AiMergeContext | null = null

  if (blocks) {
    // Tempelan multi-perusahaan: tiap blok berdiri sendiri. Cadangan AI tidak dipakai di sini, karena AI bisa salah menempelkan
    // posisi atau tautan ke perusahaan lain, dan kesalahan seperti itu lebih buruk daripada bidang yang ditandai "belum terbaca".
    jobs = jobsFromCompanyBlocks(blocks, base, input.locationHint, warnings)
  } else {
    const whatsappUrl = applyCandidates.find(isWhatsAppUrl) ?? null
    const primaryApplyUrl = applyCandidates.find((u) => !isWhatsAppUrl(u)) ?? applyCandidates[0] ?? null
    const applyEmail = extractApplyEmail(rawText)
    const companyInfo = extractCompanyName(lines, { hint: input.companyHint, applyUrl: primaryApplyUrl })
    const company = companyInfo.name
    const locationInfo = extractLocationValue(lines, rawText, input.locationHint)
    const location = locationInfo.value
    const roleTitles = extractRoleTitles(rawText)
    primaryIsLinkedIn = isLinkedInUrl(primaryApplyUrl)

    jobs = roleTitles.map((title) => {
      const description = rawText.trim() || `${title} — ${company}`
      return buildJob(base, {
        title,
        company,
        location,
        locationFound: locationInfo.found,
        description,
        applyUrl: primaryApplyUrl,
        applyEmail,
        whatsappUrl,
      })
    })
    ai = {
      rawText,
      base,
      description: rawText.trim(),
      company,
      location,
      locationFound: locationInfo.found,
      applyUrl: primaryApplyUrl,
      applyEmail,
      whatsappUrl,
    }
  }

  // LinkedIn yang bukan tautan lamaran utama (mis. postingan LinkedIn sebagai sumber) tetap diberi peringatan sekali di tingkat hasil.
  if (!primaryIsLinkedIn && (acceptedUrls.some((u) => isLinkedInUrl(u)) || socialPosts.some((p) => p.platform === 'linkedin_post'))) {
    warnings.push(LINKEDIN_MANUAL_APPLY_WARNING)
  }

  return {
    result: {
      sourceGroupId,
      sourceType,
      acceptedUrls,
      rejectedUrls,
      jobs,
      socialPosts,
      needsCaption: false,
      warnings,
    },
    ai,
  }
}

export function parseOffPortalPosting(input: OffPortalParseInput, now: Date = new Date()): OffPortalParseResult {
  return analyzeOffPortalPosting(input, now).result
}

// ───────────────────────────────────────────────────────────── cadangan AI

export interface OffPortalAiOptions {
  /** Pemanggil AI. Kosong atau null: hasil aturan dikembalikan tanpa percobaan AI. */
  extract?: OffPortalAiExtractor | null
  userId?: string
  /** Batas total satu pemanggilan AI (ms). Bawaan 15 detik. */
  timeoutMs?: number
  /** Penulis log (satu baris, tanpa isi lowongan). Bawaan: console.warn. */
  log?: (line: string) => void
}

function mostCommon(values: Array<string | null>): string | null {
  const counts = new Map<string, number>()
  for (const v of values) if (v) counts.set(v, (counts.get(v) ?? 0) + 1)
  let best: string | null = null
  let bestCount = 0
  for (const [v, c] of counts) {
    if (c > bestCount) {
      best = v
      bestCount = c
    }
  }
  return best
}

/**
 * Gabungkan kandidat AI (sudah divalidasi) ke hasil aturan. AI hanya mengisi yang kosong:
 *   - Aturan tidak menemukan satu pun posisi (kosong atau semua nilai bawaan): kandidat dibangun dari AI. Perusahaan dan lokasi
 *     yang sudah terbaca aturan tetap dipakai; tautan lamaran dari AI (yang tertulis di teks) didahulukan atas tebakan pertama aturan.
 *   - Aturan menemukan posisi: posisi tidak berubah. Hanya perusahaan yang kosong dan lokasi yang belum terbaca diisi dari AI.
 */
function mergeAiCandidates(result: OffPortalParseResult, ctx: AiMergeContext, candidates: OffPortalAiCandidate[]): OffPortalParseResult {
  const rulesHaveTitle = result.jobs.some((j) => j.title !== OFF_PORTAL_TITLE_PLACEHOLDER)
  let jobs: ParsedOffPortalJob[]

  if (!rulesHaveTitle) {
    jobs = candidates.map((c) => {
      const aiFields: OffPortalAiField[] = ['title']
      let company = ctx.company
      if (company === OFF_PORTAL_COMPANY_PLACEHOLDER && c.company) {
        company = c.company
        aiFields.push('company')
      }
      let location = ctx.location
      let locationFound = ctx.locationFound
      if (!locationFound && c.location) {
        location = c.location
        locationFound = true
        aiFields.push('location')
      }
      const applyUrl = c.applyUrl ?? ctx.applyUrl
      if (c.applyUrl && c.applyUrl !== ctx.applyUrl) aiFields.push('applyUrl')
      const applyEmail = ctx.applyEmail ?? c.applyEmail
      if (!ctx.applyEmail && c.applyEmail) aiFields.push('applyEmail')
      return buildJob(ctx.base, {
        title: c.title,
        company,
        location,
        locationFound,
        description: ctx.description || `${c.title} — ${company}`,
        applyUrl,
        applyEmail,
        whatsappUrl: ctx.whatsappUrl,
        extraction: 'ai',
        aiFields,
      })
    })
  } else {
    const aiCompany = mostCommon(candidates.map((c) => c.company))
    const aiLocation = mostCommon(candidates.map((c) => c.location))
    jobs = result.jobs.map((job) => {
      const aiFields: OffPortalAiField[] = []
      let company = job.company
      if (company === OFF_PORTAL_COMPANY_PLACEHOLDER && aiCompany) {
        company = aiCompany
        aiFields.push('company')
      }
      let location = job.location
      let locationFound = !job.unreadFields.includes('location')
      if (!locationFound && aiLocation) {
        location = aiLocation
        locationFound = true
        aiFields.push('location')
      }
      if (aiFields.length === 0) return job
      return buildJob(ctx.base, {
        title: job.title,
        company,
        location,
        locationFound,
        description: job.description,
        applyUrl: job.applyUrl,
        applyEmail: job.applyEmail,
        whatsappUrl: job.whatsappUrl,
        extraction: 'ai',
        aiFields,
      })
    })
  }

  if (!jobs.some((j) => j.extraction === 'ai')) return result
  return { ...result, jobs, warnings: [...result.warnings, OFF_PORTAL_AI_RESULT_WARNING] }
}

/**
 * Parser aturan, lalu cadangan AI bila aturan gagal membaca lowongan yang jelas ada di teks (lihat `offPortalAiTriggers`).
 * Tidak pernah melempar karena AI: batas laju, kunci habis, JSON rusak, jawaban tidak sah, atau lewat 15 detik semuanya
 * mengembalikan hasil aturan apa adanya. Hasil aturan yang sudah lengkap tidak memanggil AI dan tidak ditimpa.
 */
export async function parseOffPortalPostingWithAi(
  input: OffPortalParseInput,
  now: Date = new Date(),
  ai: OffPortalAiOptions = {},
): Promise<OffPortalParseResult> {
  const { result, ai: ctx } = analyzeOffPortalPosting(input, now)
  if (!ai.extract || !ctx) return result
  const reasons = offPortalAiTriggers(result.jobs, ctx.rawText)
  if (reasons.length === 0) return result

  try {
    const raw = await withOffPortalAiTimeout(
      Promise.resolve().then(() => ai.extract!({ rawText: ctx.rawText, userId: ai.userId, reasons })),
      ai.timeoutMs ?? OFF_PORTAL_AI_TIMEOUT_MS,
    )
    if (raw === null || raw === undefined) return result
    const candidates = normalizeOffPortalAiOutput(raw, ctx.rawText)
    if (candidates.length === 0) return result
    return mergeAiCandidates(result, ctx, candidates)
  } catch (e) {
    // Pesan galat bisa memuat potongan isi permintaan; hanya nama galatnya yang dicatat.
    const line = `[off-portal-ai] gagal (${(e as Error)?.name ?? 'Error'}), memakai parser aturan`
    if (ai.log) ai.log(line)
    else console.warn(line)
    return result
  }
}

export { OFF_PORTAL_COMPANY_PLACEHOLDER, OFF_PORTAL_LOCATION_DEFAULT, OFF_PORTAL_TITLE_PLACEHOLDER }
