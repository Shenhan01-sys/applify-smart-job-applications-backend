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
/** Umur tiket mulai OAuth (navigasi langsung ke backend). Pendek dan sekali pakai. */
export const OAUTH_START_TTL_SEC = 120

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

  /**
   * Alur dua langkah agar cookie nonce selalu first-party (24 Nov 2026). Dulu cookie di-set pada respons fetch
   * dari frontend (vercel.app) ke backend (railway.app); Brave, Safari, dan Chrome dengan blokir cookie pihak
   * ketiga membuangnya, sehingga callback selalu gagal session_mismatch. Sekarang POST /google/init (butuh JWT)
   * hanya menerbitkan tiket bertanda tangan, berlaku 120 detik dan sekali pakai; peramban lalu dinavigasi ke
   * GET /google/start?ticket=... di host backend, yang memasang cookie nonce sebagai cookie first-party
   * (SameSite=Lax) dan meneruskan ke Google. Callback tetap memeriksa state + nonce seperti sebelumnya.
   */
  const startPath = callbackPath.replace(/\/callback$/, '/start')
  const usedStartTickets = new Map<string, number>()
  const callbackOrigin = () => {
    try {
      return new URL(googleRedirectUri()).origin
    } catch {
      return ''
    }
  }
  function issueStartUrl(userId: string): string {
    const ticket = signState({
      purpose: 'gmail_start',
      uid: userId,
      jti: crypto.randomBytes(12).toString('hex'),
      exp: Date.now() + OAUTH_START_TTL_SEC * 1000,
    })
    return `${callbackOrigin()}${startPath}?ticket=${encodeURIComponent(ticket)}`
  }
  const failRedirect = (reply: FastifyReply, reason: string) =>
    reply.redirect(`${frontendUrl()}/settings?gmail=error&reason=${encodeURIComponent(reason)}`)

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
    return { url: issueStartUrl(userId) }
  })

  // ---- GET /api/oauth/google/start — navigasi langsung peramban: tiket sekali pakai -> cookie nonce first-party -> Google ----
  app.get('/google/start', async (request, reply) => {
    const { ticket } = (request.query ?? {}) as { ticket?: unknown }
    if (!googleClientId()) return failRedirect(reply, 'not_configured')
    if (typeof ticket !== 'string' || !ticket) return failRedirect(reply, 'invalid_state')
    let payload: { purpose?: unknown; uid?: unknown; jti?: unknown; exp?: unknown }
    try {
      payload = verifyState(ticket, OAUTH_START_TTL_SEC)
    } catch {
      return failRedirect(reply, 'invalid_state')
    }
    // State OAuth biasa (uid + nonce) tidak boleh dipakai sebagai tiket, dan sebaliknya (tiket tidak punya nonce).
    if (payload?.purpose !== 'gmail_start' || typeof payload.uid !== 'string' || !payload.uid || typeof payload.jti !== 'string') {
      return failRedirect(reply, 'invalid_state')
    }
    const now = Date.now()
    for (const [jti, exp] of usedStartTickets) if (exp < now) usedStartTickets.delete(jti)
    if (usedStartTickets.has(payload.jti)) return failRedirect(reply, 'invalid_state')
    usedStartTickets.set(payload.jti, typeof payload.exp === 'number' ? payload.exp : now + OAUTH_START_TTL_SEC * 1000)
    return reply.redirect(startOAuthFlow(request, reply, payload.uid))
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

    // Semua kegagalan callback kembali ke halaman Pengaturan dengan kode alasan tetap, bukan JSON mentah di tab
    // OAuth. Validasi state dan nonce tetap ketat (tidak ada penukaran kode atau penyimpanan token pada kegagalan);
    // yang berubah hanya bentuk jawabannya. Teks galat internal tidak ikut dikirim.
    const fail = (reason: string) => reply.redirect(`${frontendUrl()}/settings?gmail=error&reason=${encodeURIComponent(reason)}`)

    if (error) return fail(String(error).slice(0, 80))
    if (!code || !state || typeof code !== 'string' || typeof state !== 'string') {
      return fail('missing_params')
    }
    if (!googleClientId() || !googleClientSecret()) {
      return fail('not_configured')
    }

    let uid: string
    let nonce: string
    try {
      const payload = verifyState<{ uid?: unknown; nonce?: unknown }>(state)
      if (typeof payload?.uid !== 'string' || !payload.uid || typeof payload?.nonce !== 'string' || !payload.nonce) {
        return fail('invalid_state')
      }
      uid = payload.uid
      nonce = payload.nonce
    } catch {
      return fail('invalid_state')
    }

    const expectedNonceHash = hashOAuthNonce(nonce)
    if (!cookieNonceHash || !timingSafeStringEqual(cookieNonceHash, expectedNonceHash)) {
      return fail('session_mismatch')
    }

    // Exchange authorization code for tokens.
    let tokens: any
    try {
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
        console.error('[oauth] token exchange failed:', tokenResp.status, text.slice(0, 300))
        return fail('token_exchange')
      }
      tokens = await tokenResp.json()
    } catch (e: any) {
      console.error('[oauth] token exchange error:', e?.name ?? 'Error')
      return fail('token_exchange')
    }
    if (!tokens?.access_token) return fail('token_exchange')

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
      return fail('storage')
    }

    try {
      await notifyFn(`✅ Applify: Gmail connected for user ${uid}`)
    } catch (e: any) {
      console.warn('[oauth] connect notification failed:', e?.name ?? 'Error')
    }
    return reply.redirect(`${frontendUrl()}/settings?gmail=connected`)
  })

  // ---- GET /api/oauth/status — is the current user's Gmail connected? ----
  // `needs_reconnect`: refresh terakhir ditolak Google dengan invalid_grant (cabut akses, sandi diganti, token
  // kedaluwarsa). Worker menandai baris `platform_sessions` (session_data.refresh_failed = 'invalid_grant');
  // menyambungkan ulang menimpa session_data sehingga penanda hilang. Isi blob terenkripsi tidak pernah dikirim.
  app.get('/status', async (request, reply) => {
    const userId = await requireUser(request, reply)
    if (!userId) return reply
    const db = await getDb()
    const { data } = await db
      .from('platform_sessions')
      .select('is_active, expires_at, session_data')
      .eq('user_id', userId)
      .eq('platform', 'gmail')
      .maybeSingle()
    const needsReconnect = Boolean(data) && data?.session_data?.refresh_failed === 'invalid_grant'
    if (needsReconnect) return { gmail: false, connected: false, needs_reconnect: true }
    const now = new Date()
    const connected = Boolean(data?.is_active && (!data?.expires_at || new Date(data.expires_at) > now))
    return { gmail: connected || Boolean(data), connected: connected || Boolean(data), needs_reconnect: false }
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
