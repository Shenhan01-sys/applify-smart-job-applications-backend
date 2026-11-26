import crypto from 'crypto'
import { requireSessionKey, sessionKeyProblem, SessionKeyConfigError } from './session-crypto.js'

/**
 * Token autentikasi scoped khusus Ekstensi Browser Applify (`ext_tok_v1.<payload>.<sig>`).
 *
 * Pemisahan keamanan:
 *   - Token ini HANYA ber-scope `extension:apply` dan HANYA diterima oleh rute `/api/extension/*`
 *     (kecuali `POST /api/extension/token` yang mewajibkan JWT Supabase utama).
 *   - Token ini BUKAN JWT Supabase dan akan ditolak di semua rute lain (`/api/sessions`, `/api/oauth`,
 *     `/api/ai`, `/api/approvals`, `/api/queue`, dll.) sehingga bila terkompromi di peramban tidak dapat
 *     mengambil token Gmail, cookie platform lain, atau menyetujui lamaran baru.
 *   - Fail-closed: membutuhkan `EXTENSION_TOKEN_SECRET` atau `SESSION_ENCRYPTION_KEY` minimal 32 karakter
 *     (non-placeholder), diturunkan lewat HKDF-SHA256 ke domain HMAC terpisah.
 */

export const EXTENSION_TOKEN_PREFIX = 'ext_tok_v1.'
export const EXTENSION_SCOPE = 'extension:apply' as const
export const DEFAULT_EXTENSION_TTL_SEC = 4 * 60 * 60 // 4 jam
export const MIN_EXTENSION_TTL_SEC = 60
export const MAX_EXTENSION_TTL_SEC = 8 * 60 * 60 // 8 jam

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const PLACEHOLDER_RE = [/change[-_ ]?me/i, /your[-_ ](\d+[-_ ])?(char|secret|key)/i, /encryption-key-here/i, /^applify-default-key/i]

type Env = Record<string, string | undefined>

export class ExtensionTokenConfigError extends Error {
  readonly code = 'extension_token_not_configured'
  constructor(message: string) {
    super(message)
    this.name = 'ExtensionTokenConfigError'
  }
}

export interface ExtensionTokenClaims {
  typ: 'applify_ext'
  scope: typeof EXTENSION_SCOPE
  sub: string
  jti: string
  ver: number
  iat: number
  exp: number
}

export type VerifyExtensionTokenResult =
  | { ok: true; claims: ExtensionTokenClaims; userId: string; tokenVersion: number }
  | { ok: false; reason: 'missing' | 'malformed' | 'invalid_signature' | 'invalid_claims' | 'expired' }

function resolveMasterSecret(env: Env = process.env): string {
  const dedicated = (env.EXTENSION_TOKEN_SECRET ?? '').trim()
  if (dedicated) {
    if (dedicated.length < 32 || PLACEHOLDER_RE.some((p) => p.test(dedicated))) {
      throw new ExtensionTokenConfigError('EXTENSION_TOKEN_SECRET minimal 32 karakter dan bukan placeholder.')
    }
    return dedicated
  }
  try {
    return requireSessionKey(env)
  } catch (err) {
    if (err instanceof SessionKeyConfigError) {
      throw new ExtensionTokenConfigError(
        sessionKeyProblem(env) ?? 'EXTENSION_TOKEN_SECRET atau SESSION_ENCRYPTION_KEY belum dikonfigurasi.'
      )
    }
    throw err
  }
}

function deriveHmacKey(secret: string): Buffer {
  return Buffer.from(
    crypto.hkdfSync(
      'sha256',
      Buffer.from(secret, 'utf8'),
      Buffer.from('applify/extension-token/salt'),
      Buffer.from('applify/extension-token/hmac-sha256/v1'),
      32
    )
  )
}

export function createExtensionToken(
  userId: string,
  opts?: { ttlSec?: number; ver?: number; now?: Date; env?: Env }
): { token: string; expiresAt: string; scope: typeof EXTENSION_SCOPE; ttlSeconds: number; tokenVersion: number } {
  if (!UUID_RE.test(userId)) {
    throw new Error('userId harus UUID valid untuk membuat token ekstensi')
  }
  const ver = typeof opts?.ver === 'number' && Number.isInteger(opts.ver) && opts.ver >= 1 ? opts.ver : 1
  const secret = resolveMasterSecret(opts?.env)
  const key = deriveHmacKey(secret)
  const nowSec = Math.floor((opts?.now ?? new Date()).getTime() / 1000)
  const rawTtl = Number(opts?.ttlSec ?? DEFAULT_EXTENSION_TTL_SEC)
  const ttlSec = Math.max(
    MIN_EXTENSION_TTL_SEC,
    Math.min(MAX_EXTENSION_TTL_SEC, Number.isFinite(rawTtl) ? Math.floor(rawTtl) : DEFAULT_EXTENSION_TTL_SEC)
  )
  const exp = nowSec + ttlSec

  const claims: ExtensionTokenClaims = {
    typ: 'applify_ext',
    scope: EXTENSION_SCOPE,
    sub: userId,
    jti: crypto.randomBytes(12).toString('hex'),
    ver,
    iat: nowSec,
    exp,
  }
  const payloadB64 = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url')
  const signingInput = `${EXTENSION_TOKEN_PREFIX}${payloadB64}`
  const sigB64 = crypto.createHmac('sha256', key).update(signingInput).digest('base64url')
  return {
    token: `${signingInput}.${sigB64}`,
    expiresAt: new Date(exp * 1000).toISOString(),
    scope: EXTENSION_SCOPE,
    ttlSeconds: ttlSec,
    tokenVersion: ver,
  }
}

export function verifyExtensionToken(
  token: string | null | undefined,
  opts?: { now?: Date; env?: Env }
): VerifyExtensionTokenResult {
  if (!token || typeof token !== 'string') return { ok: false, reason: 'missing' }
  const secret = resolveMasterSecret(opts?.env)
  if (!token.startsWith(EXTENSION_TOKEN_PREFIX)) return { ok: false, reason: 'malformed' }
  const rest = token.slice(EXTENSION_TOKEN_PREFIX.length)
  const dotIdx = rest.indexOf('.')
  if (dotIdx <= 0 || rest.indexOf('.', dotIdx + 1) !== -1) return { ok: false, reason: 'malformed' }

  const payloadB64 = rest.slice(0, dotIdx)
  const sigB64 = rest.slice(dotIdx + 1)
  if (!payloadB64 || !sigB64) return { ok: false, reason: 'malformed' }

  const key = deriveHmacKey(secret)
  const expectedSig = crypto.createHmac('sha256', key).update(`${EXTENSION_TOKEN_PREFIX}${payloadB64}`).digest('base64url')
  const sigBuf = Buffer.from(sigB64, 'utf8')
  const expBuf = Buffer.from(expectedSig, 'utf8')
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    return { ok: false, reason: 'invalid_signature' }
  }

  let parsed: any
  try {
    parsed = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'))
  } catch {
    return { ok: false, reason: 'malformed' }
  }

  if (
    !parsed ||
    typeof parsed !== 'object' ||
    parsed.typ !== 'applify_ext' ||
    parsed.scope !== EXTENSION_SCOPE ||
    typeof parsed.sub !== 'string' ||
    !UUID_RE.test(parsed.sub) ||
    typeof parsed.jti !== 'string' ||
    (parsed.ver !== undefined && (!Number.isInteger(parsed.ver) || parsed.ver < 1)) ||
    !Number.isFinite(parsed.iat) ||
    !Number.isFinite(parsed.exp)
  ) {
    return { ok: false, reason: 'invalid_claims' }
  }

  const nowSec = Math.floor((opts?.now ?? new Date()).getTime() / 1000)
  if (parsed.exp <= nowSec || parsed.iat > nowSec + 60) {
    return { ok: false, reason: 'expired' }
  }

  const tokenVersion = typeof parsed.ver === 'number' ? parsed.ver : 1
  return { ok: true, claims: { ...parsed, ver: tokenVersion } as ExtensionTokenClaims, userId: parsed.sub, tokenVersion }
}

export function extractBearerToken(authHeader: unknown): string | null {
  if (typeof authHeader !== 'string') return null
  if (!authHeader.startsWith('Bearer ')) return null
  const tok = authHeader.slice(7).trim()
  return tok || null
}

/**
 * Validasi origin khusus Chrome/Edge Extension di CORS server (U2B-11):
 *   - Tidak pernah melonggarkan origin web (`https://`, `http://`, `*`).
 *   - Jika `EXTENSION_ORIGINS` diisi (daftar dipisah koma), wajib cocok persis dengan daftar tersebut.
 *   - Jika kosong di produksi, staging/preview, atau lingkungan cloud (Railway/Vercel), TOLAK seluruh origin ekstensi
 *     (fail-closed): `EXTENSION_ORIGINS` wajib diisi dengan ID ekstensi Applify sendiri.
 *   - Hanya di pengembangan lokal (`NODE_ENV` kosong/`development`/`test` tanpa env cloud, atau `ALLOW_DEV_EXTENSION_ORIGINS=true`)
 *     format resmi ID ekstensi Chromium (`chrome-extension://<32-char a-p>`) diizinkan otomatis.
 */
export function isExtensionOriginAllowed(origin: string | undefined, env: Env = process.env): boolean {
  if (!origin) return false
  const configured = (env.EXTENSION_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  if (configured.length > 0) {
    return configured.includes(origin)
  }
  if ((env.ALLOW_DEV_EXTENSION_ORIGINS ?? '').trim().toLowerCase() === 'true') {
    return /^chrome-extension:\/\/[a-p]{32}$/.test(origin)
  }
  const nodeEnv = (env.NODE_ENV ?? '').trim().toLowerCase()
  const isLocalEnv = nodeEnv === '' || nodeEnv === 'development' || nodeEnv === 'test'
  const isCloudDeploy = Boolean(
    (env.RAILWAY_ENVIRONMENT ?? '').trim() ||
    (env.RAILWAY_SERVICE_ID ?? '').trim() ||
    (env.VERCEL_ENV ?? '').trim()
  )
  if (!isLocalEnv || isCloudDeploy) return false
  return /^chrome-extension:\/\/[a-p]{32}$/.test(origin)
}
