import { FastifyInstance, FastifyPluginOptions, FastifyRequest, FastifyReply } from 'fastify'
import { createClient } from '@supabase/supabase-js'
import { supabase } from '../index.js'
import { encrypt, decrypt, signState, verifyState } from '../../services/token-crypto.js'
import { notificationsService } from '../../services/notifications.service.js'

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID || ''
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || ''
const REDIRECT_URI =
  process.env.GOOGLE_REDIRECT_URI || 'http://localhost:4000/api/oauth/google/callback'
const FRONTEND_URL = process.env.FRONTEND_URL?.split(',')[0] || 'http://localhost:5173'

const SCOPES = ['https://www.googleapis.com/auth/gmail.send'].join(' ')

/** Manually verify the bearer token for routes registered outside the auth plugin. */
async function requireUser(request: FastifyRequest, reply: FastifyReply): Promise<string | null> {
  const authHeader = request.headers.authorization
  if (!authHeader?.startsWith('Bearer ')) {
    reply.status(401).send({ error: 'Missing or invalid authorization header' })
    return null
  }
  const token = authHeader.substring(7)
  const client = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
  const { data: { user }, error } = await client.auth.getUser(token)
  if (error || !user) {
    reply.status(401).send({ error: 'Invalid token' })
    return null
  }
  return user.id
}

export async function oauthRoutes(app: FastifyInstance, _opts: FastifyPluginOptions) {
  // ---- GET /api/oauth/google — start Google OAuth (browser redirect) ----
  app.get('/google', async (request, reply) => {
    if (!CLIENT_ID) {
      return reply.status(503).send({ error: 'Gmail not configured (GOOGLE_CLIENT_ID missing)' })
    }
    // User identity comes from a short-lived signed `state` so the callback can store
    // the token against the right user without a bearer header (Google drops it).
    const uid = (request.query as any).uid as string | undefined
    if (!uid) return reply.status(400).send({ error: 'uid query param required' })
    const state = signState({ uid, exp: Date.now() + 10 * 60 * 1000 })
    const url =
      'https://accounts.google.com/o/oauth2/v2/auth?' +
      new URLSearchParams({
        client_id: CLIENT_ID,
        redirect_uri: REDIRECT_URI,
        response_type: 'code',
        scope: SCOPES,
        access_type: 'offline',
        prompt: 'consent',
        state,
      }).toString()
    return reply.redirect(url)
  })

  // ---- GET /api/oauth/google/callback — Google redirects here ----
  app.get('/google/callback', async (request, reply) => {
    const { code, state, error } = request.query as any
    if (error) return reply.redirect(`${FRONTEND_URL}/settings?gmail=error&reason=${error}`)
    if (!code || !state) return reply.status(400).send({ error: 'missing code/state' })
    if (!CLIENT_ID || !CLIENT_SECRET) {
      return reply.status(503).send({ error: 'Gmail not configured on server' })
    }

    let uid: string
    try {
      const payload = verifyState(state)
      uid = payload.uid
    } catch (e: any) {
      return reply.status(400).send({ error: `invalid state: ${e?.message}` })
    }

    // Exchange authorization code for tokens.
    const tokenResp = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        redirect_uri: REDIRECT_URI,
        grant_type: 'authorization_code',
      }),
    })
    if (!tokenResp.ok) {
      const text = await tokenResp.text()
      console.error('[oauth] token exchange failed:', tokenResp.status, text)
      return reply.redirect(`${FRONTEND_URL}/settings?gmail=error&reason=token_exchange`)
    }
    const tokens = (await tokenResp.json()) as any

    const blob = JSON.stringify({
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expiry_date: tokens.expiry_date ?? Date.now() + (tokens.expires_in ?? 3600) * 1000,
      scope: tokens.scope ?? SCOPES,
    })

    const { error: upErr } = await supabase
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
      return reply.redirect(`${FRONTEND_URL}/settings?gmail=error&reason=storage`)
    }

    await notificationsService.sendTelegram(`✅ Applify: Gmail connected for user ${uid}`)
    return reply.redirect(`${FRONTEND_URL}/settings?gmail=connected`)
  })

  // ---- GET /api/oauth/status — is the current user's Gmail connected? ----
  app.get('/status', async (request, reply) => {
    const userId = await requireUser(request, reply)
    if (!userId) return reply
    const { data } = await supabase
      .from('platform_sessions')
      .select('is_active, expires_at')
      .eq('user_id', userId)
      .eq('platform', 'gmail')
      .maybeSingle()
    const now = new Date()
    const connected = Boolean(data?.is_active && (!data?.expires_at || new Date(data.expires_at) > now))
    // A stored refresh_token lets us reconnect even after access_token expiry, so report
    // connected=true as long as a session row exists.
    return { gmail: connected || Boolean(data) }
  })

  // ---- POST /api/oauth/disconnect — revoke & delete Gmail session ----
  app.post('/disconnect', async (request, reply) => {
    const userId = await requireUser(request, reply)
    if (!userId) return reply
    // Best-effort revoke the access token at Google.
    const { data } = await supabase
      .from('platform_sessions')
      .select('session_data')
      .eq('user_id', userId)
      .eq('platform', 'gmail')
      .maybeSingle()
    if (data?.session_data?.encrypted) {
      try {
        const parsed = JSON.parse(decrypt(data.session_data.encrypted))
        if (parsed.access_token) {
          await fetch(
            `https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(parsed.access_token)}`,
            { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
          )
        }
      } catch (e: any) {
        console.warn('[oauth] revoke failed (continuing to delete):', e?.message)
      }
    }
    await supabase
      .from('platform_sessions')
      .delete()
      .eq('user_id', userId)
      .eq('platform', 'gmail')
    return { success: true }
  })
}
