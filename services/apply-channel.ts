import { isValidApplyEmail } from './email-address.js'
import { isJobAccessibleToUser, selectJobWithVisibility } from './private-job-access.js'

/**
 * Klasifikasi kanal lamaran untuk satu lowongan (`jobs` row).
 *
 * Tujuan Stage 1 (split-channel routing):
 *   - Jujur sejak awal sebelum pengguna menekan Apply: mana lowongan ATS publik (bisa diisi worker headless),
 *     mana lowongan email langsung (`email_apply` Gmail), mana portal butuh login pengguna (`auth_portal`:
 *     ekstensi browser Chrome/Edge), dan mana LinkedIn (wajib manual-only).
 *   - Jika `external_url` menunjuk ke agregator/portal/situs karier tetapi deskripsi memuat tautan ATS publik
 *     langsung (`boards.greenhouse.io`, `jobs.lever.co`, `jobs.ashbyhq.com`, dll.) atau email rekruter valid,
 *     kanal dapat ditingkatkan ke tautan/email langsung tersebut.
 */
export type ApplyChannel = 'public_ats' | 'email_direct' | 'auth_portal' | 'external_web'

export interface JobChannelInput {
  id?: string | null
  platform?: string | null
  platform_source?: string | null
  external_url?: string | null
  url?: string | null
  apply_url?: string | null
  apply_email?: string | null
  resolved_apply_url?: string | null
  description?: string | null
}

export interface ChannelClassification {
  channel: ApplyChannel
  platform: string
  applyUrl: string | null
  resolvedApplyUrl: string | null
  applyEmail: string | null
  autoWorkerSupported: boolean
  emailApplySupported: boolean
  extensionSupported: boolean
  manualOnly: boolean
  /** E2E-07: True untuk ATS korporasi kompleks (Workday/iCIMS/Taleo/SuccessFactors) yang bersifat eksperimental di ekstensi. */
  experimentalExtension?: boolean
  reason: string
}

import {
  EXTENSION_LOGIN_PORTAL_DOMAINS,
  KNOWN_ATS_DOMAINS,
  OTHER_AUTH_PORTAL_DOMAINS,
  PUBLIC_ATS_DOMAINS,
} from './domain-manifest.generated.js'

export { EXTENSION_LOGIN_PORTAL_DOMAINS, PUBLIC_ATS_DOMAINS }

/**
 * Host yang benar-benar bisa dibuka dan diisi Ekstensi Browser: portal login (JobStreet, Glints, Kalibrr,
 * Dealls) dan ATS dikenal. Daftarnya sama dengan `optional_host_permissions` di extension/manifest.json (keduanya
 * dibangkitkan dari shared/domains.json). Host di luar daftar ini tidak bisa diberi izin oleh ekstensi, jadi
 * lowongannya tidak boleh dikirim ke antrean `extension_apply`.
 */
export const EXTENSION_HOST_DOMAINS: readonly string[] = [...EXTENSION_LOGIN_PORTAL_DOMAINS, ...KNOWN_ATS_DOMAINS]

/**
 * E2E-07: ATS korporasi multi-langkah / Shadow DOM tertutup yang tumpang tindih antara daftar ATS dikenal
 * dan portal autentikasi di shared/domains.json. Tetap didukung ekstensi, namun diberi tanda eksperimental
 * dan anjuran melamar manual bila formulir gagal diisi penuh.
 */
export const CORPORATE_COMPLEX_ATS_DOMAINS = [
  'myworkdayjobs.com',
  'workday.com',
  'icims.com',
  'taleo.net',
  'successfactors.com',
  'successfactors.eu',
] as const

export function isCorporateComplexAtsHost(hostname: string): boolean {
  return Boolean(hostname) && hostMatchesDomain(hostname, CORPORATE_COMPLEX_ATS_DOMAINS)
}

export const AUTH_PORTAL_DOMAINS = [
  'linkedin.com',
  ...EXTENSION_LOGIN_PORTAL_DOMAINS,
  ...OTHER_AUTH_PORTAL_DOMAINS,
] as const

const AUTH_PORTAL_PLATFORMS = new Set([
  'linkedin',
  'jobstreet',
  'kalibrr',
  'glints',
  'karir',
  'dealls',
  'techinasia',
  'workday',
  'indeed',
  'glassdoor',
])

const PUBLIC_ATS_PLATFORMS = new Set([
  'greenhouse',
  'lever',
  'ashby',
  'workable',
  'smartrecruiters',
  'recruitee',
  'breezy',
  'bamboohr',
])

const IGNORED_EMAIL_LOCAL = new Set([
  'noreply',
  'no-reply',
  'donotreply',
  'do-not-reply',
  'mailer-daemon',
  'notification',
  'notifications',
  'support',
  'privacy',
  'security',
  'abuse',
])

const IGNORED_EMAIL_DOMAINS = [
  'example.com',
  'example.org',
  'example.net',
  'sentry.io',
  'wixpress.com',
  'w3.org',
  'schema.org',
]

export function hostMatchesDomain(hostname: string, domains: readonly string[]): boolean {
  const host = hostname.toLowerCase().replace(/^www\./, '')
  if (!host) return false
  return domains.some((d) => host === d || host.endsWith(`.${d}`))
}

export function sanitizeHttpUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  if (!trimmed) return null
  try {
    const u = new URL(trimmed)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    return u.toString()
  } catch {
    return null
  }
}

/** Akhiran nama host yang tidak pernah menjadi situs lowongan publik (jaringan lokal atau internal). */
const NON_PUBLIC_HOST_SUFFIXES = ['localhost', 'local', 'localdomain', 'internal', 'intranet', 'lan', 'corp', 'home', 'home.arpa']

/**
 * URL http(s) yang pantas disimpan sebagai tautan lowongan: berhost nama domain publik, tanpa kredensial
 * di URL, bukan IP literal (IPv4 dalam bentuk apa pun maupun IPv6), bukan `localhost`, dan bukan nama host
 * satu label atau berakhiran jaringan lokal/internal. Pemeriksaan ini hanya membaca teks URL; resolusi DNS
 * yang diarahkan ke IP privat tidak terdeteksi di sini.
 */
export function isPublicHttpUrl(raw: unknown): boolean {
  const safe = sanitizeHttpUrl(raw)
  if (!safe) return false
  const u = new URL(safe)
  if (u.username || u.password) return false
  const host = u.hostname.toLowerCase().replace(/\.+$/, '')
  if (!host || host.startsWith('[')) return false
  const labels = host.split('.')
  if (labels.length < 2) return false
  // WHATWG URL menormalkan 0x7f.1 atau 2130706433 menjadi 127.0.0.1; label akhir tanpa huruf berarti IP literal.
  if (!/[a-z]/.test(labels[labels.length - 1])) return false
  return !NON_PUBLIC_HOST_SUFFIXES.some((s) => host === s || host.endsWith(`.${s}`))
}

/** Host adalah portal login yang diisi ekstensi (JobStreet, Glints, Kalibrr, Dealls) atau subdomainnya. */
export function isLoginPortalHost(hostname: string): boolean {
  return hostMatchesDomain(hostname, EXTENSION_LOGIN_PORTAL_DOMAINS)
}

/** Host (atau subdomainnya) ada di daftar yang bisa dibuka ekstensi. */
export function isExtensionHost(hostname: string): boolean {
  return hostMatchesDomain(hostname, EXTENSION_HOST_DOMAINS)
}

/** URL lamaran http(s) yang hostnya bisa dibuka ekstensi. LinkedIn tidak pernah masuk daftar. */
export function isExtensionUrl(rawUrl: unknown): boolean {
  const safe = sanitizeHttpUrl(rawUrl)
  if (!safe) return false
  return isExtensionHost(new URL(safe).hostname)
}

export function isLinkedInHost(hostname: string): boolean {
  return hostMatchesDomain(hostname, ['linkedin.com'])
}

export function isLinkedInUrl(rawUrl: unknown): boolean {
  const safe = sanitizeHttpUrl(rawUrl)
  if (!safe) return false
  return isLinkedInHost(new URL(safe).hostname)
}

export type SocialPostPlatform = 'instagram' | 'x' | 'facebook' | 'threads' | 'tiktok' | 'linkedin_post'

export const SOCIAL_POST_PLATFORM_LABELS: Record<SocialPostPlatform, string> = {
  instagram: 'Instagram',
  x: 'X (Twitter)',
  facebook: 'Facebook',
  threads: 'Threads',
  tiktok: 'TikTok',
  linkedin_post: 'LinkedIn',
}

/**
 * Tautan ke postingan atau profil media sosial (Instagram, X/Twitter, Facebook, Threads, TikTok, postingan LinkedIn).
 * Server tidak bisa membaca isinya karena platform-platform ini meminta login, dan tautan seperti ini bukan
 * tautan lamaran. Halaman lowongan LinkedIn (`/jobs`, `/company/.../jobs`) bukan termasuk, tetapi tetap manual-only.
 */
export function detectSocialPostPlatform(rawUrl: unknown): SocialPostPlatform | null {
  const safe = sanitizeHttpUrl(rawUrl)
  if (!safe) return null
  const u = new URL(safe)
  const host = u.hostname
  if (hostMatchesDomain(host, ['instagram.com', 'instagr.am'])) return 'instagram'
  if (hostMatchesDomain(host, ['x.com', 'twitter.com'])) return 'x'
  if (hostMatchesDomain(host, ['facebook.com', 'fb.com', 'fb.me', 'fb.watch'])) return 'facebook'
  if (hostMatchesDomain(host, ['threads.net', 'threads.com'])) return 'threads'
  if (hostMatchesDomain(host, ['tiktok.com'])) return 'tiktok'
  if (isLinkedInHost(host) && /^\/(?:posts|feed\/update|pulse|embed\/feed)(?:\/|$)/i.test(u.pathname)) return 'linkedin_post'
  return null
}

export function isSocialPostUrl(rawUrl: unknown): boolean {
  return detectSocialPostPlatform(rawUrl) !== null
}

export function isPublicAtsUrl(rawUrl: unknown): boolean {
  const safe = sanitizeHttpUrl(rawUrl)
  if (!safe) return false
  return hostMatchesDomain(new URL(safe).hostname, PUBLIC_ATS_DOMAINS)
}

/** Portal Uji Applify: halaman lamaran tiruan milik Applify untuk uji coba (worker, bukan ekstensi; selaras FE J5-06). */
const TEST_PORTAL_HOST = 'applify-smart-job-applications.vercel.app'
const TEST_PORTAL_PATH = '/uji-portal'

export function isTestPortalUrl(rawUrl: unknown): boolean {
  const safe = sanitizeHttpUrl(rawUrl)
  if (!safe) return false
  const u = new URL(safe)
  return u.hostname.toLowerCase() === TEST_PORTAL_HOST && (u.pathname === TEST_PORTAL_PATH || u.pathname.startsWith(`${TEST_PORTAL_PATH}/`))
}

const WHATSAPP_HOSTS = ['wa.me', 'api.whatsapp.com', 'chat.whatsapp.com'] as const

export function isWhatsAppUrl(rawUrl: unknown): boolean {
  const safe = sanitizeHttpUrl(rawUrl)
  if (!safe) return false
  return hostMatchesDomain(new URL(safe).hostname, WHATSAPP_HOSTS)
}

/** True untuk formulir Google Forms publik (termasuk /u/N/forms/ dan shortlink forms.gle). */
export function isGoogleFormUrl(rawUrl: unknown): boolean {
  const safe = sanitizeHttpUrl(rawUrl)
  if (!safe) return false
  const u = new URL(safe)
  const host = u.hostname.toLowerCase().replace(/^www\./, '')
  if (host === 'forms.gle') return true
  return host === 'docs.google.com' && /^\/(?:u\/\d+\/)?forms\//i.test(u.pathname)
}

export function extractUrlsFromText(text: string): string[] {
  if (!text) return []
  const matches = text.match(/https?:\/\/[^\s<>"'\])}`]+/gi) ?? []
  const seen = new Set<string>()
  const urls: string[] = []
  for (const m of matches) {
    const cleaned = m.replace(/[.,;:!?)]+$/, '')
    const safe = sanitizeHttpUrl(cleaned)
    if (!safe || seen.has(safe)) continue
    seen.add(safe)
    urls.push(safe)
  }
  return urls
}

export function extractPublicAtsUrl(description: string): string | null {
  for (const url of extractUrlsFromText(description)) {
    if (isPublicAtsUrl(url)) return url
  }
  return null
}

export function extractApplyEmail(description: string): string | null {
  if (!description) return null
  const matches = description.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,63}/g) ?? []
  for (const raw of matches) {
    const candidate = raw.trim().replace(/[.,;:!?)]+$/, '')
    if (!isValidApplyEmail(candidate)) continue
    const [local, domain] = candidate.toLowerCase().split('@')
    if (IGNORED_EMAIL_LOCAL.has(local)) continue
    if (IGNORED_EMAIL_DOMAINS.some((d) => domain === d || domain.endsWith(`.${d}`))) continue
    return candidate
  }
  return null
}

export function classifyJobChannel(job: JobChannelInput): ChannelClassification {
  const platform = String(job.platform ?? job.platform_source ?? '')
    .trim()
    .toLowerCase()
  const description = String(job.description ?? '')
  const primaryUrl =
    sanitizeHttpUrl(job.external_url) ?? sanitizeHttpUrl(job.url) ?? sanitizeHttpUrl(job.apply_url)
  const storedResolvedAts = isPublicAtsUrl(job.resolved_apply_url) ? sanitizeHttpUrl(job.resolved_apply_url) : null
  const descAtsUrl = extractPublicAtsUrl(description)
  const resolvedAtsUrl = isPublicAtsUrl(primaryUrl) ? primaryUrl : storedResolvedAts ?? descAtsUrl
  const applyEmail = isValidApplyEmail(job.apply_email) ? job.apply_email : extractApplyEmail(description)

  // Kebijakan LinkedIn manual-only: baik worker headless maupun ekstensi menolak auto-apply di LinkedIn.
  if (isLinkedInUrl(primaryUrl) || (platform === 'linkedin' && !primaryUrl)) {
    return {
      channel: 'auth_portal',
      platform: platform || 'linkedin',
      applyUrl: primaryUrl,
      resolvedApplyUrl: resolvedAtsUrl,
      applyEmail,
      autoWorkerSupported: false,
      emailApplySupported: false,
      extensionSupported: false,
      manualOnly: true,
      reason: 'Lowongan LinkedIn hanya dilamar manual demi keamanan akun (worker dan ekstensi tidak dijalankan di domain LinkedIn).',
    }
  }

  // Portal Uji Applify diproses agen (worker), bukan ekstensi (selaras frontend J5-06).
  if (isTestPortalUrl(primaryUrl)) {
    return {
      channel: 'external_web',
      platform: platform || 'portal-uji',
      applyUrl: primaryUrl,
      resolvedApplyUrl: null,
      applyEmail: null,
      autoWorkerSupported: true,
      emailApplySupported: false,
      extensionSupported: false,
      manualOnly: false,
      reason: 'Formulir uji milik Applify. Agen server yang mengisinya tanpa Ekstensi Browser.',
    }
  }

  // Label platform ATS pada URL portal login (data campur aduk) tidak boleh mengirim lowongan itu ke worker.
  const primaryOnLoginPortal = Boolean(primaryUrl) && isLoginPortalHost(new URL(primaryUrl as string).hostname)

  if (resolvedAtsUrl || (platform && PUBLIC_ATS_PLATFORMS.has(platform) && primaryUrl && !primaryOnLoginPortal)) {
    const targetUrl = resolvedAtsUrl ?? primaryUrl
    return {
      channel: 'public_ats',
      platform: platform || 'ats',
      applyUrl: targetUrl,
      resolvedApplyUrl: resolvedAtsUrl,
      applyEmail,
      autoWorkerSupported: Boolean(targetUrl),
      emailApplySupported: Boolean(applyEmail),
      extensionSupported: isExtensionUrl(targetUrl),
      manualOnly: false,
      reason:
        resolvedAtsUrl && primaryUrl && resolvedAtsUrl !== primaryUrl
          ? 'Tautan ATS publik ditemukan di deskripsi; pengisian otomatis agen dan ekstensi tersedia.'
          : 'Formulir ATS publik; pengisian otomatis agen dan ekstensi Chrome/Edge tersedia.',
    }
  }

  if (applyEmail) {
    return {
      channel: 'email_direct',
      platform: platform || 'email',
      applyUrl: primaryUrl,
      resolvedApplyUrl: null,
      applyEmail,
      autoWorkerSupported: false,
      emailApplySupported: true,
      extensionSupported: isExtensionUrl(primaryUrl),
      manualOnly: false,
      reason: `Alamat email rekruter (${applyEmail}) terdeteksi; dapat dikirim via Gmail Applify setelah persetujuan.`,
    }
  }

  const primaryHost = primaryUrl ? new URL(primaryUrl).hostname : ''
  const isPortal =
    (primaryHost && hostMatchesDomain(primaryHost, AUTH_PORTAL_DOMAINS)) ||
    (platform ? AUTH_PORTAL_PLATFORMS.has(platform) : false)

  if (isPortal) {
    const viaExtension = isExtensionUrl(primaryUrl)
    const experimentalExtension = viaExtension && isCorporateComplexAtsHost(primaryHost)
    return {
      channel: 'auth_portal',
      platform: platform || primaryHost || 'portal',
      applyUrl: primaryUrl,
      resolvedApplyUrl: null,
      applyEmail: null,
      autoWorkerSupported: false,
      emailApplySupported: false,
      extensionSupported: viaExtension,
      manualOnly: false,
      ...(experimentalExtension ? { experimentalExtension: true } : {}),
      reason: experimentalExtension
        ? 'Portal ATS korporasi kompleks ini bersifat eksperimental untuk Ekstensi Browser; melamar manual di situs perusahaan disarankan bila formulir multi-langkah gagal.'
        : viaExtension
          ? 'Portal membutuhkan sesi masuk akun pelamar; gunakan Ekstensi Browser Applify langsung di tab Chrome/Edge milikmu.'
          : 'Portal membutuhkan sesi masuk akun pelamar dan belum didukung Ekstensi Browser Applify; lamar manual di situsnya.',
    }
  }

  if (isWhatsAppUrl(primaryUrl)) {
    return {
      channel: 'external_web',
      platform: 'whatsapp',
      applyUrl: primaryUrl,
      resolvedApplyUrl: null,
      applyEmail: null,
      autoWorkerSupported: false,
      emailApplySupported: false,
      extensionSupported: false,
      manualOnly: true,
      reason: 'Lamaran lewat tautan WhatsApp hanya dikirim manual langsung oleh pelamar (tidak dijalankan oleh agen maupun ekstensi).',
    }
  }

  // Google Forms dijalankan worker terlebih dahulu (formulir publik) dan mendukung handoff ke Ekstensi Browser
  // bila formulir meminta login Google, unggah berkas, CAPTCHA, atau ada pertanyaan wajib tanpa jawaban.
  if (isGoogleFormUrl(primaryUrl)) {
    return {
      channel: 'external_web',
      platform: 'google_forms',
      applyUrl: primaryUrl,
      resolvedApplyUrl: null,
      applyEmail: null,
      autoWorkerSupported: true,
      emailApplySupported: false,
      extensionSupported: true,
      manualOnly: false,
      reason:
        'Formulir Google Form publik. Agen server mengisinya terlebih dahulu setelah disetujui, dan beralih ke Ekstensi Browser bila formulir meminta login Google, unggah berkas, CAPTCHA, atau pertanyaan wajib tambahan.',
    }
  }

  const externalViaExtension = isExtensionUrl(primaryUrl)
  const externalExperimental = externalViaExtension && isCorporateComplexAtsHost(primaryHost)
  return {
    channel: 'external_web',
    platform: platform || primaryHost || 'web',
    applyUrl: primaryUrl,
    resolvedApplyUrl: null,
    applyEmail: null,
    autoWorkerSupported: false,
    emailApplySupported: false,
    extensionSupported: externalViaExtension,
    manualOnly: false,
    ...(externalExperimental ? { experimentalExtension: true } : {}),
    reason: !primaryUrl
      ? 'Lowongan belum memiliki tautan lamaran eksternal.'
      : externalExperimental
        ? 'ATS korporasi eksternal ini bersifat eksperimental untuk Ekstensi Browser; melamar manual di situs perusahaan disarankan bila formulir multi-langkah gagal.'
        : externalViaExtension
          ? 'Situs karier eksternal; gunakan Ekstensi Browser Applify agar tahan terhadap login/CAPTCHA, atau lamar manual.'
          : 'Situs karier eksternal yang belum didukung Ekstensi Browser Applify; lamar manual di situsnya.',
  }
}

/**
 * Lowongan ini harus dikerjakan Ekstensi Browser (antrean `extension_apply`): bukan LinkedIn (`manualOnly`),
 * bukan email langsung (`email_direct`), bukan ATS publik yang diisi worker, dan hostnya ada di daftar yang
 * bisa dibuka ekstensi.
 */
export function routesToExtension(c: ChannelClassification | null | undefined): boolean {
  return Boolean(c && c.channel !== 'email_direct' && !c.manualOnly && !c.autoWorkerSupported && c.extensionSupported)
}

export type ApprovalDispatchTarget = 'worker' | 'extension' | 'email_direct' | 'manual'

/**
 * Menentukan target eksekusi saat pengguna menekan Setujui (`POST /api/approvals/:id/approve`):
 *   - `manual`       : LinkedIn / `manualOnly` — persetujuan dicatat tetapi TIDAK mengantrekan worker/ekstensi.
 *   - `email_direct` : lamaran lewat email rekruter — persetujuan dicatat, pengiriman lewat panel Email Apply.
 *   - `extension`    : portal login / ATS yang dirutekan ke ekstensi browser (`extension_apply`).
 *   - `worker`       : ATS publik (atau cadangan bila metadata lowongan tidak terbaca) -> antrean `apply`.
 */
export function approvalDispatchTarget(c: ChannelClassification | null | undefined): ApprovalDispatchTarget {
  if (!c) return 'worker'
  if (c.manualOnly) return 'manual'
  if (c.channel === 'email_direct') return 'email_direct'
  if (routesToExtension(c)) return 'extension'
  return 'worker'
}

export async function resolveApplyChannel(
  db: { from(table: string): any },
  jobId: string,
  opts?: { userId?: string }
): Promise<ChannelClassification | null> {
  const { data: job, error } = await selectJobWithVisibility(
    db,
    jobId,
    'id, platform_source, title, company, external_url, description'
  )

  if (error) {
    if (error.code === '22P02') return null
    throw new Error(`channel lookup failed: ${error.message}`)
  }
  if (!job) return null
  if (opts?.userId !== undefined && !isJobAccessibleToUser(job, opts.userId)) {
    return null
  }
  return classifyJobChannel(job)
}
