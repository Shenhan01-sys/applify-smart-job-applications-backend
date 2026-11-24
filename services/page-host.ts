import {
  PUBLIC_ATS_DOMAINS,
  classifyJobChannel,
  hostMatchesDomain,
  sanitizeHttpUrl,
  type JobChannelInput,
} from './apply-channel.js'

/**
 * Mengikat halaman yang sedang dibuka ekstensi ke lowongan milik persetujuan (temuan keamanan 4).
 *
 * Tanpa pemeriksaan ini, satu persetujuan untuk lowongan A bisa dipakai menekan Submit di tab mana pun yang
 * sedang aktif. Aturan (fail closed, tanpa daftar sufiks publik penuh):
 *   1. Host halaman sama persis dengan host lowongan (`external_url`, tautan lamaran terpilih, atau tautan ATS
 *      yang ditemukan di deskripsi), mengabaikan awalan `www.`.
 *   2. Domain terdaftar sama (mis. `careers.acme.com` dan `apply.acme.com`). Pada ATS yang tiap perusahaannya
 *      memakai subdomain sendiri (`acme.bamboohr.com`, `acme.wd5.myworkdayjobs.com`) host harus sama persis,
 *      karena domain terdaftarnya dipakai bersama ratusan perusahaan.
 *   3. Lowongan berasal dari situs non-ATS (agregator atau situs karier) dan halaman berada di host ATS yang
 *      dikenal. Bila lowongan sendiri sudah di sebuah ATS, halaman di vendor ATS lain ditolak.
 *   4. Lowongan dan halaman sama-sama di keluarga domain satu portal login yang sama (`jobstreet.co.id` dan
 *      `jobstreet.com`, `kalibrr.id` dan `kalibrr.com`): tautan lama dialihkan ke domain baru oleh portalnya.
 *      Portal lain, atau portal dan situs perusahaan, tetap ditolak.
 * Lowongan tanpa satu pun URL ditolak. LinkedIn diblokir lebih awal oleh pemanggil.
 */

import {
  KNOWN_ATS_DOMAINS,
  LOGIN_PORTAL_FAMILIES,
} from './domain-manifest.generated.js'

export { KNOWN_ATS_DOMAINS }

/** ATS yang memberi tiap perusahaan subdomain sendiri: kecocokan domain saja tidak cukup, host harus sama persis. */
const TENANT_SUBDOMAIN_ATS_DOMAINS: readonly string[] = [
  'bamboohr.com',
  'recruitee.com',
  'breezy.hr',
  'jazzhr.com',
  'applytojob.com',
  'teamtailor.com',
  'pinpointhq.com',
  'myworkdayjobs.com',
  'icims.com',
  'taleo.net',
  'successfactors.com',
  'successfactors.eu',
  'keka.com',
  'freshteam.com',
  'personio.de',
  'personio.com',
]

/** Sufiks publik tingkat dua yang lazim; domain terdaftar memakai tiga label di bawahnya (acme.co.id). */
const SECOND_LEVEL_LABELS = new Set(['co', 'com', 'net', 'org', 'ac', 'go', 'or', 'web', 'my', 'sch', 'biz', 'edu', 'gov', 'mil', 'ltd', 'plc'])

/** Layanan hosting bersama: subdomainnya milik pihak berbeda, jadi domain terdaftarnya memakai tiga label. */
const SHARED_HOSTING_SUFFIXES: readonly string[] = [
  'github.io',
  'vercel.app',
  'netlify.app',
  'herokuapp.com',
  'pages.dev',
  'workers.dev',
  'web.app',
  'firebaseapp.com',
  'blogspot.com',
  'wixsite.com',
  'webflow.io',
  'notion.site',
  'myshopify.com',
  'azurewebsites.net',
  'cloudfront.net',
  'amazonaws.com',
  'appspot.com',
  'onrender.com',
  'fly.dev',
  'railway.app',
  'glitch.me',
  'repl.co',
  'ngrok.io',
  'ngrok-free.app',
  'trycloudflare.com',
]

export function normalizeHost(hostname: string): string {
  return String(hostname ?? '')
    .trim()
    .toLowerCase()
    .replace(/\.$/, '')
    .replace(/^www\./, '')
}

const isIpLike = (host: string): boolean => /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || host.includes(':') || host.startsWith('[')

/** Perkiraan domain terdaftar tanpa daftar sufiks publik penuh. IP dan nama satu label dikembalikan apa adanya. */
export function registrableDomain(hostname: string): string {
  const host = normalizeHost(hostname)
  if (!host || isIpLike(host)) return host
  const labels = host.split('.').filter(Boolean)
  if (labels.length <= 2) return labels.join('.')
  const shared = SHARED_HOSTING_SUFFIXES.find((s) => host === s || host.endsWith(`.${s}`))
  if (shared) return labels.slice(-(shared.split('.').length + 1)).join('.')
  const tld = labels[labels.length - 1]
  const sld = labels[labels.length - 2]
  if (tld.length === 2 && SECOND_LEVEL_LABELS.has(sld)) return labels.slice(-3).join('.')
  return labels.slice(-2).join('.')
}

export const isKnownAtsHostname = (hostname: string): boolean => {
  const host = normalizeHost(hostname)
  return Boolean(host) && !isIpLike(host) && hostMatchesDomain(host, KNOWN_ATS_DOMAINS)
}

const tenantAtsDomain = (hostname: string): string | null =>
  TENANT_SUBDOMAIN_ATS_DOMAINS.find((d) => hostMatchesDomain(normalizeHost(hostname), [d])) ?? null

/** Keluarga portal login untuk host ini (mis. `id.jobstreet.com` -> `jobstreet.com`, `jobstreet.co.id`), atau null. */
const portalFamily = (hostname: string): readonly string[] | null =>
  LOGIN_PORTAL_FAMILIES.find((family) => hostMatchesDomain(normalizeHost(hostname), family)) ?? null

export type PageJobMatch =
  | { ok: true; rule: 'same_host' | 'same_site' | 'same_portal' | 'known_ats' }
  | { ok: false; rule: 'no_job_url' | 'invalid_page_url' | 'different_site' }

/** URL halaman lamaran yang sah untuk lowongan ini: `external_url` ditambah tautan yang dipilih penggolong kanal. */
export function jobUrlHosts(job: JobChannelInput): string[] {
  const classified = classifyJobChannel(job)
  const urls = [job.external_url, classified.applyUrl, classified.resolvedApplyUrl]
  const hosts = new Set<string>()
  for (const raw of urls) {
    const safe = sanitizeHttpUrl(raw)
    if (!safe) continue
    const host = normalizeHost(new URL(safe).hostname)
    if (host) hosts.add(host)
  }
  return [...hosts]
}

export function pageMatchesJob(pageUrl: unknown, job: JobChannelInput | null | undefined): PageJobMatch {
  const safePage = sanitizeHttpUrl(pageUrl)
  if (!safePage) return { ok: false, rule: 'invalid_page_url' }
  const pageHost = normalizeHost(new URL(safePage).hostname)
  if (!pageHost) return { ok: false, rule: 'invalid_page_url' }
  if (!job) return { ok: false, rule: 'no_job_url' }

  const jobHosts = jobUrlHosts(job)
  if (jobHosts.length === 0) return { ok: false, rule: 'no_job_url' }

  if (jobHosts.includes(pageHost)) return { ok: true, rule: 'same_host' }

  const pageSite = registrableDomain(pageHost)
  for (const jobHost of jobHosts) {
    if (registrableDomain(jobHost) !== pageSite) continue
    // Domain yang sama belum cukup di ATS multi-tenant: perusahaan lain berbagi domain itu.
    if (tenantAtsDomain(jobHost) || tenantAtsDomain(pageHost)) continue
    return { ok: true, rule: 'same_site' }
  }

  const pageFamily = portalFamily(pageHost)
  if (pageFamily && jobHosts.some((h) => portalFamily(h) === pageFamily)) return { ok: true, rule: 'same_portal' }

  const jobOnAts = jobHosts.some((h) => isKnownAtsHostname(h))
  if (!jobOnAts && isKnownAtsHostname(pageHost)) return { ok: true, rule: 'known_ats' }

  return { ok: false, rule: 'different_site' }
}
