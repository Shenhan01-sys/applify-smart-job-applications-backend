import { isValidApplyEmail } from './email-address.js'

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
  reason: string
}

export const PUBLIC_ATS_DOMAINS = [
  'greenhouse.io',
  'lever.co',
  'ashbyhq.com',
  'workable.com',
  'smartrecruiters.com',
  'recruitee.com',
  'breezy.hr',
  'bamboohr.com',
  'jazzhr.com',
] as const

/**
 * Portal lowongan Indonesia yang butuh login pengguna dan diisi oleh EKSTENSI browser (pengguna masuk sendiri,
 * ekstensi mengisi formulir di tabnya). Ini bukan ATS publik: tidak pernah masuk `PUBLIC_ATS_DOMAINS`, tidak pernah
 * `autoWorkerSupported`, dan worker tidak boleh mengirim lamaran di sana. Subdomain ikut (`id.jobstreet.com`).
 *
 * Daftar ini DISALIN ke `extension/src/lib/atsDomains.ts` (`LOGIN_PORTAL_DOMAINS`) dan `worker/src/lib/pageGuard.ts`
 * (`LOGIN_PORTAL_HOSTS`, yang memblokir kirim). Ubah ketiganya bersamaan; tes ekstensi membandingkan salinannya.
 */
export const EXTENSION_LOGIN_PORTAL_DOMAINS = [
  'jobstreet.com',
  'jobstreet.co.id',
  'glints.com',
  'kalibrr.com',
  'kalibrr.id',
  'dealls.com',
] as const

export const AUTH_PORTAL_DOMAINS = [
  'linkedin.com',
  ...EXTENSION_LOGIN_PORTAL_DOMAINS,
  'karir.com',
  'techinasia.com',
  'indeed.com',
  'glassdoor.com',
  'myworkdayjobs.com',
  'workday.com',
  'icims.com',
  'taleo.net',
  'successfactors.com',
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

/** Host adalah portal login yang diisi ekstensi (JobStreet, Glints, Kalibrr, Dealls) atau subdomainnya. */
export function isLoginPortalHost(hostname: string): boolean {
  return hostMatchesDomain(hostname, EXTENSION_LOGIN_PORTAL_DOMAINS)
}

export function isLinkedInHost(hostname: string): boolean {
  return hostMatchesDomain(hostname, ['linkedin.com'])
}

export function isLinkedInUrl(rawUrl: unknown): boolean {
  const safe = sanitizeHttpUrl(rawUrl)
  if (!safe) return false
  return isLinkedInHost(new URL(safe).hostname)
}

export function isPublicAtsUrl(rawUrl: unknown): boolean {
  const safe = sanitizeHttpUrl(rawUrl)
  if (!safe) return false
  return hostMatchesDomain(new URL(safe).hostname, PUBLIC_ATS_DOMAINS)
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
      extensionSupported: Boolean(targetUrl),
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
      extensionSupported: Boolean(primaryUrl),
      manualOnly: false,
      reason: `Alamat email rekruter (${applyEmail}) terdeteksi; dapat dikirim via Gmail Applify setelah persetujuan.`,
    }
  }

  const primaryHost = primaryUrl ? new URL(primaryUrl).hostname : ''
  const isPortal =
    (primaryHost && hostMatchesDomain(primaryHost, AUTH_PORTAL_DOMAINS)) ||
    (platform ? AUTH_PORTAL_PLATFORMS.has(platform) : false)

  if (isPortal) {
    return {
      channel: 'auth_portal',
      platform: platform || primaryHost || 'portal',
      applyUrl: primaryUrl,
      resolvedApplyUrl: null,
      applyEmail: null,
      autoWorkerSupported: false,
      emailApplySupported: false,
      extensionSupported: Boolean(primaryUrl),
      manualOnly: false,
      reason: 'Portal membutuhkan sesi masuk akun pelamar; gunakan Ekstensi Browser Applify langsung di tab Chrome/Edge milikmu.',
    }
  }

  return {
    channel: 'external_web',
    platform: platform || primaryHost || 'web',
    applyUrl: primaryUrl,
    resolvedApplyUrl: null,
    applyEmail: null,
    autoWorkerSupported: false,
    emailApplySupported: false,
    extensionSupported: Boolean(primaryUrl),
    manualOnly: false,
    reason: primaryUrl
      ? 'Situs karier eksternal; gunakan Ekstensi Browser Applify agar tahan terhadap login/CAPTCHA, atau lamar manual.'
      : 'Lowongan belum memiliki tautan lamaran eksternal.',
  }
}

export async function resolveApplyChannel(
  db: { from(table: string): any },
  jobId: string
): Promise<ChannelClassification | null> {
  const { data: job, error } = await db
    .from('jobs')
    .select('id, platform_source, title, company, external_url, description')
    .eq('id', jobId)
    .maybeSingle()

  if (error) throw new Error(`channel lookup failed: ${error.message}`)
  if (!job) return null
  return classifyJobChannel(job)
}
