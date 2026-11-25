import crypto from 'node:crypto'
import {
  classifyJobChannel,
  extractApplyEmail,
  extractUrlsFromText,
  isPublicHttpUrl,
  type ChannelClassification,
} from './apply-channel.js'
import { assessJobSafety, type JobSafetyReport } from './job-safety.service.js'

/**
 * Parser deterministik pratinjau ingesti lowongan off-portal (link, caption media sosial, teks poster/OCR,
 * dan tautan hasil baca QR) — fondasi 47.3 P0-01 & 48.4 BS-P3-08.
 *
 * Sifat:
 *   - Stateless (tidak menulis ke database sebelum migrasi privat DRAFT_2026-11-26_private_offportal_jobs.sql diterapkan).
 *   - Mendukung poster multi-role: satu unggahan menghasilkan 1..N kandidat lowongan dengan `source_group_id` sama
 *     dan `publication_fingerprint` deterministik per (peran + perusahaan + kontak/URL).
 *   - Memvalidasi setiap URL (sumber, teks, QR) lewat `isPublicHttpUrl` agar URL privat/IP/javascript: ditolak.
 *   - Menyertakan deteksi kontak WhatsApp (`wa.me` / `api.whatsapp.com`), formulir eksternal (Google Form/Typeform/Tally),
 *     email HR, klasifikasi kanal, serta laporan anti-scam (`assessJobSafety`).
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
}

export interface OffPortalParseResult {
  sourceGroupId: string
  sourceType: OffPortalSourceType
  acceptedUrls: string[]
  rejectedUrls: string[]
  jobs: ParsedOffPortalJob[]
}

export const MAX_OFF_PORTAL_TEXT_CHARS = 12_000
export const MAX_OFF_PORTAL_QR_URLS = 10
export const MAX_OFF_PORTAL_ROLES = 10

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

/**
 * "CV" juga bentuk badan usaha (CV Maju Jaya), jadi baris berawalan CV hanya ditolak
 * bila isinya perintah mengirim CV/resume ("CV dan portofolio ke x@y.com").
 */
function isCvSendingLine(line: string): boolean {
  if (/^\s*cv\.?\s*(?:(?:dan|atau|ke|lamaran|terbaru)\b|&)/i.test(line)) return true
  return /@/.test(line) || /\bkirim/i.test(line)
}

function extractCompany(text: string, hint?: string): string {
  if (hint && hint.trim()) return hint.trim().slice(0, 200)
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*(perusahaan|company|pt\.?|cv\.?)\s*[:\-]?\s*([^\n]{2,80})/i)
    if (!m) continue
    const label = m[1].toLowerCase()
    if (label.startsWith('cv') && isCvSendingLine(line)) continue
    const raw = (label === 'perusahaan' || label === 'company' ? m[2] : m[0]).trim()
    if (raw.length >= 2) return raw.slice(0, 200)
  }
  return 'Perusahaan (Off-Portal)'
}

function extractLocation(text: string, hint?: string): string {
  if (hint && hint.trim()) return hint.trim().slice(0, 120)
  const m = text.match(/(?:lokasi|penempatan|location)\s*[:\-]\s*([^\n]{2,80})/i)
  if (m && m[1].trim()) return m[1].trim().slice(0, 120)
  return 'Indonesia'
}

/** Ekstrak 1..N nama posisi dari poster/caption multi-role (daftar bullet/angka di bawah header posisi/lowongan). */
export function extractRoleTitles(text: string): string[] {
  if (!text.trim()) return ['Lowongan Off-Portal']
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  const roles: string[] = []

  // Cari blok daftar bernomor/bullet yang berupa nama posisi (bukan syarat panjang atau URL/email).
  let inPositionsSection = false
  for (const line of lines) {
    if (/^(posisi|lowongan|we are hiring|dibutuhkan|open position|terbuka untuk)\b/i.test(line)) {
      inPositionsSection = true
      const inline = line.replace(/^(posisi|lowongan|we are hiring|dibutuhkan|open position|terbuka untuk)\s*[:\-]?\s*/i, '').trim()
      if (inline.length >= 3 && inline.length <= 70 && !/https?:\/\/|@/i.test(inline)) {
        roles.push(inline)
      }
      continue
    }
    if (/^(kualifikasi|persyaratan|requirements|syarat|benefit|cara melamar|kirim cv|lokasi|penempatan)\b/i.test(line)) {
      inPositionsSection = false
      continue
    }
    if (inPositionsSection) {
      const bullet = line.match(/^(?:[-•*]|\d+[.)])\s+(.+)$/)
      if (bullet) {
        const title = bullet[1].trim()
        if (title.length >= 3 && title.length <= 80 && !/https?:\/\/|@/i.test(title)) {
          roles.push(title)
          if (roles.length >= MAX_OFF_PORTAL_ROLES) break
        }
      }
    }
  }

  const deduped = [...new Set(roles)]
  if (deduped.length > 0) return deduped

  // Cadangan: baris pertama non-URL yang cukup pendek.
  const first = lines.find((l) => l.length >= 3 && l.length <= 90 && !/https?:\/\/|@/i.test(l))
  return [first ?? 'Lowongan Off-Portal']
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

  const candidateUrls: string[] = []
  if (typeof input.sourceUrl === 'string' && input.sourceUrl.trim()) candidateUrls.push(input.sourceUrl.trim())
  if (Array.isArray(input.qrUrls)) {
    for (const u of input.qrUrls.slice(0, MAX_OFF_PORTAL_QR_URLS)) {
      if (typeof u === 'string' && u.trim()) candidateUrls.push(u.trim())
    }
  }
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

  const whatsappUrl = acceptedUrls.find(isWhatsAppUrl) ?? null
  const primaryApplyUrl = acceptedUrls.find((u) => !isWhatsAppUrl(u)) ?? acceptedUrls[0] ?? null
  const applyEmail = extractApplyEmail(rawText)
  const formProvider = detectFormProvider(primaryApplyUrl)
  const company = extractCompany(rawText, input.companyHint)
  const location = extractLocation(rawText, input.locationHint)
  const roleTitles = extractRoleTitles(rawText)

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
    }
  })

  return {
    sourceGroupId,
    sourceType,
    acceptedUrls,
    rejectedUrls,
    jobs,
  }
}
