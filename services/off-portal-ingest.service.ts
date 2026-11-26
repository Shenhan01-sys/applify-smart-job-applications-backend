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
  MAX_OFF_PORTAL_ROLES,
  OFF_PORTAL_COMPANY_PLACEHOLDER,
  OFF_PORTAL_LOCATION_DEFAULT,
  OFF_PORTAL_TITLE_PLACEHOLDER,
  extractApplyKeyUrls,
  extractCompanyName,
  extractLocationValue,
  extractRoleTitles,
  splitCaptionLines,
} from './off-portal-extract.js'

/**
 * Parser deterministik pratinjau ingesti lowongan off-portal (link, caption media sosial, teks poster/OCR,
 * dan tautan hasil baca QR) — fondasi 47.3 P0-01 & 48.4 BS-P3-08.
 *
 * Sifat:
 *   - Stateless (tidak menulis ke database sebelum migrasi privat DRAFT_2026-11-26_private_offportal_jobs.sql diterapkan).
 *   - Tidak pernah mengambil isi URL. Instagram, X, Facebook, dan LinkedIn meminta login, jadi captionnya harus ditempel pengguna.
 *   - Mendukung poster multi-role: satu unggahan menghasilkan 1..N kandidat lowongan dengan `source_group_id` sama
 *     dan `publication_fingerprint` deterministik per (peran + perusahaan + kontak/URL).
 *   - Memvalidasi setiap URL (sumber, teks, QR) lewat `isPublicHttpUrl` agar URL privat/IP/javascript: ditolak.
 *   - Tautan postingan media sosial tidak pernah dijadikan tautan lamaran. Tautan LinkedIn diberi peringatan lamar manual.
 *   - Menyertakan deteksi kontak WhatsApp (`wa.me` / `api.whatsapp.com`), formulir eksternal (Google Form/Typeform/Tally),
 *     email HR, klasifikasi kanal, serta laporan anti-scam (`assessJobSafety`).
 *   - Ekstraksi posisi, perusahaan, dan lokasi ada di `off-portal-extract.ts`.
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
export { MAX_OFF_PORTAL_ROLES, extractRoleTitles }

export const LINKEDIN_MANUAL_APPLY_WARNING =
  'Lowongan LinkedIn wajib dilamar manual di LinkedIn. Applify tidak mengisi atau mengirim lamaran di LinkedIn, jadi simpan lowongannya lalu lamar sendiri lewat tautannya.'

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

export function parseOffPortalPosting(input: OffPortalParseInput, now: Date = new Date()): OffPortalParseResult {
  const rawText = typeof input.rawText === 'string' ? input.rawText.slice(0, MAX_OFF_PORTAL_TEXT_CHARS) : ''
  const sourceType: OffPortalSourceType =
    input.sourceType === 'off_portal_poster' || input.sourceType === 'off_portal_caption'
      ? input.sourceType
      : 'off_portal_link'
  const sourceGroupId = input.sourceGroupId?.trim() || crypto.randomUUID()
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
      sourceGroupId,
      sourceType,
      acceptedUrls,
      rejectedUrls,
      jobs: [],
      socialPosts,
      needsCaption: true,
      warnings,
    }
  }
  if (socialPosts.length > 0) {
    const labels = [...new Set(socialPosts.map((p) => p.label))].join(', ')
    warnings.push(`Tautan postingan ${labels} dipakai sebagai sumber saja, bukan tautan lamaran. Tautan lamaran diambil dari isi caption.`)
  }

  const whatsappUrl = applyCandidates.find(isWhatsAppUrl) ?? null
  const primaryApplyUrl = applyCandidates.find((u) => !isWhatsAppUrl(u)) ?? applyCandidates[0] ?? null
  const applyEmail = extractApplyEmail(rawText)
  const formProvider = detectFormProvider(primaryApplyUrl)
  const companyInfo = extractCompanyName(lines, { hint: input.companyHint, applyUrl: primaryApplyUrl })
  const company = companyInfo.name
  const locationInfo = extractLocationValue(lines, rawText, input.locationHint)
  const location = locationInfo.value
  const roleTitles = extractRoleTitles(rawText)
  const primaryIsLinkedIn = isLinkedInUrl(primaryApplyUrl)

  const jobs: ParsedOffPortalJob[] = roleTitles.map((title) => {
    const description = rawText.trim() || `${title} — ${company}`
    const channel = classifyJobChannel({
      platform_source: sourceType,
      external_url: primaryApplyUrl,
      apply_email: applyEmail,
      description,
    })
    const safety = assessJobSafety(
      {
        title,
        company,
        description,
        external_url: primaryApplyUrl,
        apply_email: applyEmail,
        posted_at: now.toISOString(),
      },
      now,
    )
    const unreadFields: OffPortalUnreadField[] = []
    if (title === OFF_PORTAL_TITLE_PLACEHOLDER) unreadFields.push('title')
    if (company === OFF_PORTAL_COMPANY_PLACEHOLDER) unreadFields.push('company')
    if (!locationInfo.found) unreadFields.push('location')
    return {
      title,
      company,
      location,
      description,
      sourceType,
      sourceGroupId,
      publicationFingerprint: buildPublicationFingerprint({
        title,
        company,
        applyUrl: primaryApplyUrl,
        applyEmail,
        description,
      }),
      applyUrl: primaryApplyUrl,
      applyEmail,
      whatsappUrl,
      formProvider,
      channel,
      safety,
      unreadFields,
      warnings: primaryIsLinkedIn ? [LINKEDIN_MANUAL_APPLY_WARNING] : [],
    }
  })

  // LinkedIn yang bukan tautan lamaran utama (mis. postingan LinkedIn sebagai sumber) tetap diberi peringatan sekali di tingkat hasil.
  if (!primaryIsLinkedIn && (acceptedUrls.some((u) => isLinkedInUrl(u)) || socialPosts.some((p) => p.platform === 'linkedin_post'))) {
    warnings.push(LINKEDIN_MANUAL_APPLY_WARNING)
  }

  return {
    sourceGroupId,
    sourceType,
    acceptedUrls,
    rejectedUrls,
    jobs,
    socialPosts,
    needsCaption: false,
    warnings,
  }
}

export { OFF_PORTAL_COMPANY_PLACEHOLDER, OFF_PORTAL_LOCATION_DEFAULT, OFF_PORTAL_TITLE_PLACEHOLDER }
