import crypto from 'crypto'
import { FastifyInstance, FastifyPluginOptions, FastifyRequest, FastifyReply } from 'fastify'
import { createClient } from '@supabase/supabase-js'
import {
  decrypt,
  encrypt,
  hashOAuthNonce,
  signState,
  timingSafeStringEqual,
  verifyState,
} from '../../services/token-crypto.js'
import { notificationsService } from '../../services/notifications.service.js'
import { primaryFrontendUrl } from '../../services/deploy-config.js'

const getDbDefault = async (): Promise<any> => (await import('../index.js')).supabase

export const OAUTH_NONCE_COOKIE = 'applify_oauth_nonce'
export const OAUTH_STATE_TTL_SEC = 600

const SCOPES = ['https://www.googleapis.com/auth/gmail.send'].join(' ')

/** Suffix hosting multi-tenant pada Public Suffix List: subdomain berbeda tetap dihitung cross-site. */
const MULTI_TENANT_SUFFIXES = [
  'vercel.app',
  'up.railway.app',
  'railway.app',
  'netlify.app',
  'herokuapp.com',
  'pages.dev',
  'workers.dev',
  'github.io',
  'onrender.com',
  'fly.dev',
  'appspot.com',
]

const CC_SECOND_LEVEL = new Set(['co', 'com', 'ac', 'or', 'net', 'org', 'gov', 'edu', 'web', 'my'])

function registrableSiteHeuristic(hostname: string): string {
  const host = hostname.toLowerCase()
  for (const suffix of MULTI_TENANT_SUFFIXES) {
    if (host === suffix || host.endsWith(`.${suffix}`)) return host
  }
  const parts = host.split('.').filter(Boolean)
  if (parts.length <= 2) return host
  const tld = parts[parts.length - 1]
  const sld = parts[parts.length - 2]
  if (tld.length === 2 && CC_SECOND_LEVEL.has(sld) && parts.length >= 3) {
    return parts.slice(-3).join('.')
  }
  return parts.slice(-2).join('.')
}

export function isHttpsOAuthRequest(
  request: Pick<FastifyRequest, 'protocol' | 'headers'>,
  redirectUri: string,
  env: Record<string, string | undefined> = process.env
): boolean {
  if ((env.NODE_ENV ?? '').trim().toLowerCase() === 'production') return true
  const fwdProto = String(request.headers['x-forwarded-proto'] ?? '').split(',')[0].trim().toLowerCase()
  if (fwdProto === 'https' || request.protocol === 'https') return true
  return redirectUri.trim().toLowerCase().startsWith('https://')
}

export function isCrossSiteOAuthOrigin(
  originHeader: unknown,
  hostHeader: unknown,
  redirectUri: string
): boolean {
  if (typeof originHeader !== 'string' || !originHeader.trim()) return false
  let originHost: string
  try {
    originHost = new URL(originHeader).hostname.toLowerCase()
  } catch {
    return false
  }
  let targetHost = ''
  if (typeof hostHeader === 'string' && hostHeader.trim()) {
    const first = hostHeader.split(',')[0].trim()
    try {
      targetHost = new URL(`http://${first}`).hostname.toLowerCase()
    } catch {
      targetHost = first.split(':')[0].toLowerCase()
    }
  }
  if (!targetHost) {
    try {
      targetHost = new URL(redirectUri).hostname.toLowerCase()
    } catch {
      return false
    }
  }
  if (originHost === targetHost) return false
  return registrableSiteHeuristic(originHost) !== registrableSiteHeuristic(targetHost)
}

export function parseCookieValue(cookieHeader: unknown, name: string): string | null {
  if (typeof cookieHeader !== 'string' || !cookieHeader.trim()) return null
  for (const part of cookieHeader.split(';')) {
    const idx = part.indexOf('=')
    if (idx <= 0) continue
    const key = part.slice(0, idx).trim()
    if (key !== name) continue
    const rawVal = part.slice(idx + 1).trim()
    try {
      return decodeURIComponent(rawVal)
    } catch {
      return rawVal
    }
  }
  return null
}

function serializeOAuthNonceCookie(
  value: string,
  opts: { callbackPath: string; maxAgeSec: number; secure: boolean; sameSite: 'Lax' | 'None'; clear?: boolean }
): string {
  const parts = [
    `${OAUTH_NONCE_COOKIE}=${encodeURIComponent(value)}`,
    'HttpOnly',
    `Path=${opts.callbackPath}`,
    `SameSite=${opts.sameSite}`,
    `Max-Age=${opts.maxAgeSec}`,
  ]
  if (opts.clear) parts.push('Expires=Thu, 01 Jan 1970 00:00:00 GMT')
  if (opts.secure || opts.sameSite === 'None') parts.push('Secure')
  return parts.join('; ')
}

export interface OAuthRoutesOptions extends FastifyPluginOptions {
  db?: any
  resolveUserId?: (request: FastifyRequest, reply: FastifyReply) => Promise<string | null>
  fetchImpl?: typeof fetch
  notify?: (msg: string) => Promise<unknown>
  env?: Record<string, string | undefined>
  callbackPath?: string
}

export async function oauthRoutes(app: FastifyInstance, opts: OAuthRoutesOptions = {}) {
  const env = opts.env ?? process.env
  const getDb = async (): Promise<any> => opts.db ?? getDbDefault()
  const fetchFn = opts.fetchImpl ?? fetch
  const notifyFn = opts.notify ?? ((msg: string) => notificationsService.sendTelegram(msg))
  const callbackPath = opts.callbackPath ?? (`${app.prefix || ''}/google/callback`.replace(/\/+/g, '/') || '/api/oauth/google/callback')

  const googleClientId = () => env.GOOGLE_CLIENT_ID || ''
  const googleClientSecret = () => env.GOOGLE_CLIENT_SECRET || ''
  const googleRedirectUri = () => env.GOOGLE_REDIRECT_URI || 'http://localhost:4000/api/oauth/google/callback'
  const frontendUrl = () => primaryFrontendUrl(env.FRONTEND_URL, 'http://localhost:5173')

  const defaultRequireUser = async (request: FastifyRequest, reply: FastifyReply): Promise<string | null> => {
    const authHeader = request.headers.authorization
    if (!authHeader?.startsWith('Bearer ')) {
      reply.status(401).send({ error: 'Missing or invalid authorization header' })
      return null
    }
    const token = authHeader.substring(7)
    const client = createClient(env.SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!)
    const { data: { user }, error } = await client.auth.getUser(token)
    if (error || !user) {
      reply.status(401).send({ error: 'Invalid token' })
      return null
    }
    return user.id
  }
  const requireUser = opts.resolveUserId ?? defaultRequireUser

  function startOAuthFlow(request: FastifyRequest, reply: FastifyReply, userId: string): string {
    const nonce = crypto.randomBytes(16).toString('hex')
    const state = signState({
      uid: userId,
      nonce,
      exp: Date.now() + OAUTH_STATE_TTL_SEC * 1000,
    })

    const secure = isHttpsOAuthRequest(request, googleRedirectUri(), env)
    const crossSite = isCrossSiteOAuthOrigin(
      request.headers.origin,
      request.headers['x-forwarded-host'] ?? request.headers.host,
      googleRedirectUri()
    )
    // Chrome/Firefox memblokir penyimpanan Set-Cookie SameSite=Lax pada respons fetch cross-site (mis. *.vercel.app -> *.up.railway.app).
    // Pada same-site / localhost tetap SameSite=Lax sesuai syarat keamanan; pada cross-site HTTPS memakai SameSite=None; Secure.
    const sameSite: 'Lax' | 'None' = crossSite && secure ? 'None' : 'Lax'

    reply.header(
      'Set-Cookie',
      serializeOAuthNonceCookie(hashOAuthNonce(nonce), {
        callbackPath,
        maxAgeSec: OAUTH_STATE_TTL_SEC,
        secure,
        sameSite,
      })
    )

    return (
      'https://accounts.google.com/o/oauth2/v2/auth?' +
      new URLSearchParams({
        client_id: googleClientId(),
        redirect_uri: googleRedirectUri(),
        response_type: 'code',
        scope: SCOPES,
        access_type: 'offline',
        prompt: 'consent',
        state,
      }).toString()
    )
  }

  function clearNonceCookie(request: FastifyRequest, reply: FastifyReply) {
    const secure = isHttpsOAuthRequest(request, googleRedirectUri(), env)
    reply.header(
      'Set-Cookie',
      serializeOAuthNonceCookie('', {
        callbackPath,
        maxAgeSec: 0,
        secure,
        sameSite: 'Lax',
        clear: true,
      })
    )
  }

  // ---- POST /api/oauth/google/init — terbitkan URL OAuth + cookie hash nonce HttpOnly ----
  app.post('/google/init', async (request, reply) => {
    const userId = await requireUser(request, reply)
    if (!userId) return reply
    if (!googleClientId()) {
      return reply.status(503).send({ error: 'Gmail not configured (GOOGLE_CLIENT_ID missing)' })
    }
    return { url: startOAuthFlow(request, reply, userId) }
  })

  // ---- GET /api/oauth/google — dikunci: menolak ?uid= mentah tanpa otorisasi JWT (Audit 11 #3) ----
  app.get('/google', async (request, reply) => {
    const userId = await requireUser(request, reply)
    if (!userId) return reply
    if (!googleClientId()) {
      return reply.status(503).send({ error: 'Gmail not configured (GOOGLE_CLIENT_ID missing)' })
    }
    return reply.redirect(startOAuthFlow(request, reply, userId))
  })

  // ---- GET /api/oauth/google/callback — Google redirects here ----
  app.get('/google/callback', async (request, reply) => {
    const { code, state, error } = request.query as any
    // Selalu hapus cookie nonce sesudah callback, baik berhasil maupun gagal.
    const cookieNonceHash = parseCookieValue(request.headers.cookie, OAUTH_NONCE_COOKIE)
    clearNonceCookie(request, reply)

    if (error) return reply.redirect(`${frontendUrl()}/settings?gmail=error&reason=${encodeURIComponent(String(error))}`)
    if (!code || !state || typeof code !== 'string' || typeof state !== 'string') {
      return reply.status(400).send({ error: 'missing code/state' })
    }
    if (!googleClientId() || !googleClientSecret()) {
      return reply.status(503).send({ error: 'Gmail not configured on server' })
    }

    let uid: string
    let nonce: string
    try {
      const payload = verifyState<{ uid?: unknown; nonce?: unknown }>(state)
      if (typeof payload?.uid !== 'string' || !payload.uid || typeof payload?.nonce !== 'string' || !payload.nonce) {
        return reply.status(400).send({ error: 'invalid state: missing nonce' })
      }
      uid = payload.uid
      nonce = payload.nonce
    } catch (e: any) {
      return reply.status(400).send({ error: `invalid state: ${e?.message}` })
    }

    const expectedNonceHash = hashOAuthNonce(nonce)
    if (!cookieNonceHash || !timingSafeStringEqual(cookieNonceHash, expectedNonceHash)) {
      return reply.status(400).send({ error: 'invalid state: oauth session mismatch' })
    }

    // Exchange authorization code for tokens.
    const tokenResp = await fetchFn('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: googleClientId(),
        client_secret: googleClientSecret(),
        redirect_uri: googleRedirectUri(),
        grant_type: 'authorization_code',
      }),
    })
    if (!tokenResp.ok) {
      const text = await tokenResp.text()
      console.error('[oauth] token exchange failed:', tokenResp.status, text)
      return reply.redirect(`${frontendUrl()}/settings?gmail=error&reason=token_exchange`)
    }
    const tokens = (await tokenResp.json()) as any

    const blob = JSON.stringify({
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expiry_date: tokens.expiry_date ?? Date.now() + (tokens.expires_in ?? 3600) * 1000,
      scope: tokens.scope ?? SCOPES,
    })

    const db = await getDb()
    const { error: upErr } = await db
      .from('platform_sessions')
      .upsert(
        {
          user_id: uid,
          platform: 'gmail',
          session_data: { encrypted: encrypt(blob) },
          is_active: true,
          expires_at: new Date(
            tokens.expiry_date ?? Date.now() + (tokens.expires_in ?? 3600) * 1000
          ).toISOString(),
          last_used_at: new Date().toISOString(),
        },
        { onConflict: 'user_id,platform' }
      )

    if (upErr) {
      console.error('[oauth] failed to persist gmail token:', upErr.message)
      return reply.redirect(`${frontendUrl()}/settings?gmail=error&reason=storage`)
    }

    await notifyFn(`✅ Applify: Gmail connected for user ${uid}`)
    return reply.redirect(`${frontendUrl()}/settings?gmail=connected`)
  })

  // ---- GET /api/oauth/status — is the current user's Gmail connected? ----
  app.get('/status', async (request, reply) => {
    const userId = await requireUser(request, reply)
    if (!userId) return reply
    const db = await getDb()
    const { data } = await db
      .from('platform_sessions')
      .select('is_active, expires_at')
      .eq('user_id', userId)
      .eq('platform', 'gmail')
      .maybeSingle()
    const now = new Date()
    const connected = Boolean(data?.is_active && (!data?.expires_at || new Date(data.expires_at) > now))
    return { gmail: connected || Boolean(data) }
  })

  // ---- POST /api/oauth/disconnect — revoke & delete Gmail session ----
  app.post('/disconnect', async (request, reply) => {
    const userId = await requireUser(request, reply)
    if (!userId) return reply
    const db = await getDb()
    const { data } = await db
      .from('platform_sessions')
      .select('session_data')
      .eq('user_id', userId)
      .eq('platform', 'gmail')
      .maybeSingle()
    if (data?.session_data?.encrypted) {
      try {
        const parsed = JSON.parse(decrypt(data.session_data.encrypted))
        if (parsed.access_token) {
          await fetchFn(
            `https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(parsed.access_token)}`,
            { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
          )
        }
      } catch (e: any) {
        console.warn('[oauth] revoke failed (continuing to delete):', e?.message)
      }
    }
    await db
      .from('platform_sessions')
      .delete()
      .eq('user_id', userId)
      .eq('platform', 'gmail')
    return { success: true }
  })
}
