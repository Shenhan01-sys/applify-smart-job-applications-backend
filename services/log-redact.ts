/**
 * Penyamaran query string rahasia di log permintaan Fastify (temuan H-01, audit 26 Nov 2026).
 *
 * Fastify mencatat `req.url` lengkap pada baris "incoming request". Alamat OAuth membawa kredensial di query string:
 * `?ticket=` (api/routes/oauth.ts, berlaku 120 detik), `?code=` dan `?state=` di callback Google, dan token ekstensi.
 * Log produksi dibaca siapa pun yang punya akses log Railway, jadi nilai-nilai itu diganti `[REDACTED]` sebelum
 * ditulis. Nama parameter dan sisa alamat tetap utuh supaya log masih berguna untuk penelusuran.
 */

export const REDACTED = '[REDACTED]'

/** Nama parameter query (huruf kecil) yang nilainya tidak boleh masuk log. */
const SENSITIVE_QUERY_KEYS = new Set([
  'code',
  'state',
  'ticket',
  'token',
  'access_token',
  'refresh_token',
  'id_token',
])

function decodeKey(raw: string): string {
  try {
    return decodeURIComponent(raw.replace(/\+/g, ' ')).toLowerCase()
  } catch {
    return raw.toLowerCase()
  }
}

/** Mengganti nilai parameter sensitif pada `url` (path + query) dengan `[REDACTED]`. Bagian `#fragment` dibuang. */
export function redactUrlForLog(url: string): string {
  if (typeof url !== 'string') return url
  const hash = url.indexOf('#')
  const noHash = hash === -1 ? url : url.slice(0, hash)
  const q = noHash.indexOf('?')
  if (q === -1) return noHash
  const path = noHash.slice(0, q)
  const query = noHash
    .slice(q + 1)
    .split('&')
    .map((pair) => {
      const eq = pair.indexOf('=')
      const rawKey = eq === -1 ? pair : pair.slice(0, eq)
      return SENSITIVE_QUERY_KEYS.has(decodeKey(rawKey)) ? `${rawKey}=${REDACTED}` : pair
    })
    .join('&')
  return `${path}?${query}`
}

/** Bentuk sama dengan serializer `req` bawaan Fastify 5, dengan `url` dan `remoteAddress` (H-16) disamarkan. */
export function serializeRequestForLog(req: any) {
  return {
    method: req.method,
    url: redactUrlForLog(req.url),
    version: req.headers && req.headers['accept-version'],
    host: req.host,
    remoteAddress: req.ip ? REDACTED : undefined,
    remotePort: req.socket ? req.socket.remotePort : undefined,
  }
}

/** Dipasang di `logger.serializers` pada Fastify (api/index.ts). */
export const requestLogSerializers = { req: serializeRequestForLog }
