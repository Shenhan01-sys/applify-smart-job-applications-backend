import type { FastifyInstance } from 'fastify'

/**
 * Header keamanan HTTP bawaan tanpa paket tambahan (audit 48.3 BS-08.1, 48.5 J5-18).
 * Menambahkan X-Content-Type-Options, X-Frame-Options, Referrer-Policy, dan Permissions-Policy
 * tanpa menimpa header yang sudah dipasang rute secara eksplisit.
 */
export const DEFAULT_SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
}

export function installSecurityHeaders(app: FastifyInstance): void {
  app.addHook('onSend', async (_request, reply, payload) => {
    for (const [name, value] of Object.entries(DEFAULT_SECURITY_HEADERS)) {
      if (!reply.getHeader(name)) {
        reply.header(name, value)
      }
    }
    return payload
  })
}

/**
 * Konfigurasi `trustProxy` Fastify (audit 48.3 BS-08.1).
 * Di produksi/Railway (balik reverse proxy), default `true` kecuali dimatikan eksplisit `TRUST_PROXY=false`.
 * Di lokal/test, default `false` kecuali diaktifkan eksplisit `TRUST_PROXY=true` atau angka hop positif.
 */
export function trustProxyFromEnv(env: Record<string, string | undefined> = process.env): boolean | number {
  const raw = (env.TRUST_PROXY ?? '').trim().toLowerCase()
  if (raw === 'true' || raw === 'yes' || raw === '1') return true
  if (raw === 'false' || raw === 'no' || raw === '0') return false
  if (raw && /^\d+$/.test(raw)) {
    const hops = Number(raw)
    if (Number.isInteger(hops) && hops > 0 && hops <= 10) return hops
  }
  return (env.NODE_ENV ?? '').trim().toLowerCase() === 'production' || Boolean(env.RAILWAY_ENVIRONMENT || env.RAILWAY_SERVICE_ID)
}
