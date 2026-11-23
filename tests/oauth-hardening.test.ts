import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import Fastify from 'fastify'
import { hashOAuthNonce, signState, timingSafeStringEqual, verifyState } from '../services/token-crypto.js'
import { OAUTH_NONCE_COOKIE, oauthRoutes } from '../api/routes/oauth.js'
import { makeExtensionTestDb } from './extension-test-db.js'

const ORIG_SESSION_KEY = process.env.SESSION_ENCRYPTION_KEY

function withEncryptionKey<T>(fn: () => Promise<T>): Promise<T> {
  process.env.SESSION_ENCRYPTION_KEY = 'oauth-hardening-test-encryption-key-32bytes'
  return fn().finally(() => {
    if (ORIG_SESSION_KEY === undefined) delete process.env.SESSION_ENCRYPTION_KEY
    else process.env.SESSION_ENCRYPTION_KEY = ORIG_SESSION_KEY
  })
}

function cookiePairFromSetCookie(setCookie: string | string[] | undefined): string {
  const raw = Array.isArray(setCookie) ? setCookie[0] : setCookie
  assert.ok(raw, 'Set-Cookie header wajib ada')
  return raw.split(';')[0]
}

test('token-crypto: timingSafeStringEqual dan verifyState menolak signature palsu, panjang beda, dot ganda, atau kedaluwarsa', async () => {
  await withEncryptionKey(async () => {
    assert.equal(timingSafeStringEqual('abc', 'abc'), true)
    assert.equal(timingSafeStringEqual('abc', 'abd'), false)
    assert.equal(timingSafeStringEqual('abc', 'abcd'), false)
    assert.equal(timingSafeStringEqual('abc', 123 as any), false)

    const token = signState({ uid: 'u1', nonce: 'n1', exp: Date.now() + 60_000 })
    assert.equal(verifyState(token).uid, 'u1')

    assert.throws(() => verifyState(token + '.extra'), /malformed/)
    const tampered = token.slice(0, -2) + (token.endsWith('aa') ? 'bb' : 'aa')
    assert.throws(() => verifyState(tampered), /invalid state signature/)
    assert.throws(() => verifyState('a.b'), /invalid state signature/)

    const expiredExp = signState({ uid: 'u1', exp: Date.now() - 1 })
    assert.throws(() => verifyState(expiredExp), /expired/)

    const expiredIat = signState({ uid: 'u1', iat: Date.now() - 700_000 })
    assert.throws(() => verifyState(expiredIat, 600), /expired/)
  })
})

test('OAuth Gmail: cookie HttpOnly hanya menyimpan hash nonce, SameSite=Lax same-site, dan memblokir callback tanpa/beda cookie', async () => {
  await withEncryptionKey(async () => {
    const store = makeExtensionTestDb({ platform_sessions: [] })
    const dbWithUpsert = {
      ...store.db,
      from(table: string) {
        if (table !== 'platform_sessions') return store.db.from(table)
        return {
          ...store.db.from(table),
          async upsert(row: Record<string, any>) {
            const list = store.tables.platform_sessions
            const idx = list.findIndex((r) => r.user_id === row.user_id && r.platform === row.platform)
            if (idx >= 0) list[idx] = { ...list[idx], ...row }
            else list.push(row)
            return { error: null }
          },
        }
      },
    }
    let googleExchangeCalls = 0
    const fakeFetch: typeof fetch = (async () => {
      googleExchangeCalls++
      return new Response(JSON.stringify({ access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3600 }), { status: 200 })
    }) as typeof fetch

    const app = Fastify()
    await app.register(oauthRoutes, {
      prefix: '/api/oauth',
      db: dbWithUpsert,
      resolveUserId: async (req, reply) => {
        if (req.headers.authorization === 'Bearer valid-victim') return 'victim-uid'
        if (req.headers.authorization === 'Bearer valid-attacker') return 'attacker-uid'
        reply.status(401).send({ error: 'Unauthorized' })
        return null
      },
      fetchImpl: fakeFetch,
      notify: async () => {},
      env: {
        NODE_ENV: 'production',
        FRONTEND_URL: 'https://app.applify.id',
        GOOGLE_CLIENT_ID: 'gid-test',
        GOOGLE_CLIENT_SECRET: 'gsec-test',
        GOOGLE_REDIRECT_URI: 'https://api.applify.id/api/oauth/google/callback',
      },
    })

    // 1. Same-site init (`app.applify.id` -> `api.applify.id`) menerbitkan cookie HttpOnly, SameSite=Lax, Secure, Path sempit.
    const initVictim = await app.inject({
      method: 'POST',
      url: '/api/oauth/google/init',
      headers: { authorization: 'Bearer valid-victim', origin: 'https://app.applify.id', host: 'api.applify.id' },
    })
    assert.equal(initVictim.statusCode, 200)
    const setCookieHeader = String(initVictim.headers['set-cookie'])
    assert.match(setCookieHeader, /HttpOnly/)
    assert.match(setCookieHeader, /SameSite=Lax/)
    assert.match(setCookieHeader, /Secure/)
    assert.match(setCookieHeader, /Path=\/api\/oauth\/google\/callback/)
    assert.match(setCookieHeader, /Max-Age=600/)

    const authUrl = new URL(initVictim.json().url)
    const state = authUrl.searchParams.get('state')!
    const decoded = verifyState<{ uid: string; nonce: string }>(state)
    const rawCookieValue = setCookieHeader.split(';')[0].split('=')[1]
    assert.notEqual(rawCookieValue, decoded.nonce, 'cookie tidak boleh menyimpan nonce mentah')
    assert.equal(rawCookieValue, hashOAuthNonce(decoded.nonce))

    // 2. Serangan login-CSRF: penyerang memberi link bertanda tangan miliknya ke korban -> korban tidak punya cookie yang cocok -> 400 + cookie dihapus.
    const initAttacker = await app.inject({
      method: 'POST',
      url: '/api/oauth/google/init',
      headers: { authorization: 'Bearer valid-attacker', host: 'api.applify.id' },
    })
    const attackerState = new URL(initAttacker.json().url).searchParams.get('state')!

    const noCookieRes = await app.inject({
      method: 'GET',
      url: `/api/oauth/google/callback?code=c1&state=${encodeURIComponent(attackerState)}`,
    })
    assert.equal(noCookieRes.statusCode, 400)
    assert.match(String(noCookieRes.headers['set-cookie']), /Max-Age=0/)
    assert.equal(googleExchangeCalls, 0)

    const mismatchRes = await app.inject({
      method: 'GET',
      url: `/api/oauth/google/callback?code=c1&state=${encodeURIComponent(attackerState)}`,
      headers: { cookie: cookiePairFromSetCookie(setCookieHeader) },
    })
    assert.equal(mismatchRes.statusCode, 400)
    assert.match(String(mismatchRes.headers['set-cookie']), /Max-Age=0/)
    assert.equal(googleExchangeCalls, 0)
    assert.equal(store.tables.platform_sessions.length, 0)

    // 3. Callback error query param tetap menghapus cookie.
    const deniedRes = await app.inject({
      method: 'GET',
      url: '/api/oauth/google/callback?error=access_denied',
      headers: { cookie: cookiePairFromSetCookie(setCookieHeader) },
    })
    assert.equal(deniedRes.statusCode, 302)
    assert.match(String(deniedRes.headers['set-cookie']), /Max-Age=0/)

    // 4. Callback sah dengan cookie milik korban berhasil, menyimpan token ke victim-uid, dan menghapus cookie.
    const okRes = await app.inject({
      method: 'GET',
      url: `/api/oauth/google/callback?code=c-ok&state=${encodeURIComponent(state)}`,
      headers: { cookie: cookiePairFromSetCookie(setCookieHeader) },
    })
    assert.equal(okRes.statusCode, 302)
    assert.equal(okRes.headers.location, 'https://app.applify.id/settings?gmail=connected')
    assert.match(String(okRes.headers['set-cookie']), /Max-Age=0/)
    assert.match(String(okRes.headers['set-cookie']), new RegExp(`^${OAUTH_NONCE_COOKIE}=;`))
    assert.equal(googleExchangeCalls, 1)
    assert.equal(store.tables.platform_sessions[0].user_id, 'victim-uid')

    // 5. Lintas situs HTTPS (*.vercel.app -> *.up.railway.app) memakai SameSite=None; Secure agar peramban menyimpan cookie dari fetch().
    const crossSiteInit = await app.inject({
      method: 'POST',
      url: '/api/oauth/google/init',
      headers: {
        authorization: 'Bearer valid-victim',
        origin: 'https://applify-web.vercel.app',
        host: 'applify-api.up.railway.app',
      },
    })
    assert.equal(crossSiteInit.statusCode, 200)
    const crossCookie = String(crossSiteInit.headers['set-cookie'])
    assert.match(crossCookie, /SameSite=None/)
    assert.match(crossCookie, /Secure/)
    assert.match(crossCookie, /HttpOnly/)
    assert.match(crossCookie, /Path=\/api\/oauth\/google\/callback/)

    // Sanity hash helper matches SHA-256 hex
    assert.equal(hashOAuthNonce('abc'), crypto.createHash('sha256').update('abc').digest('hex'))
    await app.close()
  })
})
