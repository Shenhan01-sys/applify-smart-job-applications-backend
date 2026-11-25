import { extractApplyEmail, extractUrlsFromText } from './apply-channel.js'

/**
 * Detektor indikasi penipuan (anti-scam), email gratis, tautan pendek, dan umur lowongan (ghost job)
 * yang sepenuhnya deterministik tanpa membutuhkan migrasi database (47.3 P1-05, P2-05).
 *
 * Prinsip:
 *   - Indikasi pungutan biaya mengecualikan kalimat sanggahan resmi ("tidak dipungut biaya", "gratis",
 *     "waspada penipuan") per klausa agar tidak memicu peringatan palsu pada lowongan sah Indonesia.
 *   - Domain email gratis (Gmail/Yahoo/Outlook) hanya menghasilkan peringatan tingkat `caution` (bukan blokir),
 *     karena UMKM/startup lokal kadang memang memakai Gmail.
 */

export type SafetyRiskLevel = 'low' | 'caution' | 'high'
export type SafetyFlagCode =
  | 'fee_requested'
  | 'mlm_or_unrealistic'
  | 'freemail_recruiter'
  | 'shortlink_or_messaging'
  | 'stale_posting'
  | 'missing_posted_date'

export interface JobSafetyFlag {
  code: SafetyFlagCode
  severity: 'caution' | 'high' | 'info'
  label: string
  detail: string
}

export interface JobFreshnessInfo {
  status: 'fresh' | 'stale' | 'unknown'
  ageDays: number | null
  label: string | null
}

export interface JobSafetyReport {
  riskLevel: SafetyRiskLevel
  flags: JobSafetyFlag[]
  freshness: JobFreshnessInfo
}

export interface JobSafetyInput {
  title?: string | null
  company?: string | null
  description?: string | null
  external_url?: string | null
  url?: string | null
  apply_url?: string | null
  apply_email?: string | null
  posted_at?: string | null
}

export const STALE_POSTING_DAYS = 30

const FREEMAIL_DOMAINS = new Set([
  'gmail.com',
  'googlemail.com',
  'yahoo.com',
  'yahoo.co.id',
  'ymail.com',
  'hotmail.com',
  'outlook.com',
  'live.com',
  'rocketmail.com',
])

const SHORTLINK_OR_MESSAGING_HOSTS = new Set([
  'bit.ly',
  'tinyurl.com',
  's.id',
  'cutt.ly',
  'rebrand.ly',
  'shorturl.at',
  't.ly',
  'rb.gy',
  'wa.me',
  'api.whatsapp.com',
  'chat.whatsapp.com',
  't.me',
  'telegram.me',
])

const FEE_INDICATOR_RE =
  /\b(biaya\s+(pendaftaran|administrasi|admin|seragam|training|pelatihan|tes|test|materai|registrasi)|uang\s+(pendaftaran|jaminan|muka|deposit)|wajib\s+(transfer|membayar|bayar)|transfer\s+(uang|biaya|dana)|rekening\s+pribadi|bayar\s+di\s+muka|deposit\s+awal|dipungut\s+biaya)\b/i

const FEE_DISCLAIMER_RE =
  /\b(tidak\s+(pernah\s+)?(dipungut|memungut|dikenakan|ada|meminta)|tanpa\s+(dipungut\s+)?biaya|bebas\s+biaya|gratis|free\s+of\s+charge|no\s+fee|waspada\s+penipuan|hati-?hati\s+penipuan|dilarang\s+meminta|bukan\s+untuk\s+dipungut)\b/i

const MLM_OR_UNREALISTIC_RE =
  /\b(member\s+get\s+member|rekrut\s+downline|skema\s+piramida|modal\s+awal\s+rp|tanpa\s+ijazah[^.\n]{0,40}(gaji|penghasilan)\s*(rp\s*)?(1\d|2\d|3\d|5\d)\s*(jt|juta)|penghasilan\s+(puluhan|ratusan)\s+juta\s+per\s*(hari|minggu))\b/i

function hasFeeRisk(text: string): boolean {
  if (!text) return false
  const clauses = text.split(/[\n.!?;]+/)
  for (const clause of clauses) {
    if (!FEE_INDICATOR_RE.test(clause)) continue
    if (FEE_DISCLAIMER_RE.test(clause)) continue
    return true
  }
  return false
}

function hostOf(rawUrl: string): string {
  try {
    return new URL(rawUrl).hostname.toLowerCase().replace(/^www\./, '')
  } catch {
    return ''
  }
}

export function assessJobFreshness(postedAt: string | null | undefined, now: Date = new Date()): JobFreshnessInfo {
  if (!postedAt || typeof postedAt !== 'string') {
    return { status: 'unknown', ageDays: null, label: 'Tanggal tayang tidak tercantum' }
  }
  const ts = Date.parse(postedAt)
  if (!Number.isFinite(ts)) {
    return { status: 'unknown', ageDays: null, label: 'Tanggal tayang tidak tercantum' }
  }
  const ageDays = Math.max(0, Math.floor((now.getTime() - ts) / 86_400_000))
  if (ageDays > STALE_POSTING_DAYS) {
    return { status: 'stale', ageDays, label: `Tayang ${ageDays} hari lalu (mungkin sudah tutup)` }
  }
  return { status: 'fresh', ageDays, label: null }
}

export function assessJobSafety(job: JobSafetyInput, now: Date = new Date()): JobSafetyReport {
  const title = String(job.title ?? '')
  const desc = String(job.description ?? '')
  const combined = `${title}\n${desc}`.trim()
  const flags: JobSafetyFlag[] = []

  if (hasFeeRisk(combined)) {
    flags.push({
      code: 'fee_requested',
      severity: 'high',
      label: 'Indikasi pungutan biaya',
      detail: 'Teks lowongan menyebut biaya pendaftaran/admin/transfer. Rekrutmen resmi tidak memungut biaya dari pelamar.',
    })
  }

  if (MLM_OR_UNREALISTIC_RE.test(combined)) {
    flags.push({
      code: 'mlm_or_unrealistic',
      severity: 'high',
      label: 'Pola perekrutan tidak wajar',
      detail: 'Teks lowongan mengandung pola modal awal, rekrut downline, atau klaim penghasilan tidak wajar.',
    })
  }

  const email = (typeof job.apply_email === 'string' && job.apply_email.trim()) || extractApplyEmail(desc)
  if (email) {
    const domain = email.toLowerCase().split('@')[1] ?? ''
    if (FREEMAIL_DOMAINS.has(domain)) {
      flags.push({
        code: 'freemail_recruiter',
        severity: 'caution',
        label: 'Email rekruter domain gratis',
        detail: `Alamat tujuan memakai domain gratis (${domain}). Pastikan identitas perusahaan sebelum mengirim data sensitif.`,
      })
    }
  }

  const urls = [
    ...[job.external_url, job.url, job.apply_url].filter((u): u is string => typeof u === 'string' && u.trim() !== ''),
    ...extractUrlsFromText(desc),
  ]
  const riskyHost = urls.map(hostOf).find((h) => h && SHORTLINK_OR_MESSAGING_HOSTS.has(h))
  if (riskyHost) {
    flags.push({
      code: 'shortlink_or_messaging',
      severity: 'caution',
      label: 'Tautan pendek atau chat langsung',
      detail: `Lowongan mengarahkan ke ${riskyHost}. Periksa tujuan tautan dan hindari mengirim data sensitif (KTP/OTP) lewat chat.`,
    })
  }

  const freshness = assessJobFreshness(job.posted_at, now)
  if (freshness.status === 'stale') {
    flags.push({
      code: 'stale_posting',
      severity: 'caution',
      label: `Lowongan lama (${freshness.ageDays} hari)`,
      detail: 'Lowongan sudah tayang lebih dari 30 hari; pastikan posisi masih dibuka sebelum melamar.',
    })
  } else if (freshness.status === 'unknown') {
    flags.push({
      code: 'missing_posted_date',
      severity: 'info',
      label: 'Tanggal tayang tidak tercantum',
      detail: 'Sumber lowongan tidak mencantumkan tanggal terbit.',
    })
  }

  const riskLevel: SafetyRiskLevel = flags.some((f) => f.severity === 'high')
    ? 'high'
    : flags.some((f) => f.severity === 'caution')
      ? 'caution'
      : 'low'

  return { riskLevel, flags, freshness }
}
