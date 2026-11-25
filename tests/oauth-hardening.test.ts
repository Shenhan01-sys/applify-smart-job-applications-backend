import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import Fastify from 'fastify'
import { decrypt as decryptForTest, encrypt as encryptForTest, hashOAuthNonce, signState, timingSafeStringEqual, verifyState } from '../services/token-crypto.js'
import { OAUTH_NONCE_COOKIE, SCOPES, oauthRoutes } from '../api/routes/oauth.js'
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
    const fakeFetch: typeof fetch = (async (url: any) => {
      if (!String(url).includes('/oauth2/v2/userinfo')) googleExchangeCalls++
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

    // Alur dua langkah: init (fetch, JWT) hanya menerbitkan tiket; navigasi GET /google/start memasang cookie first-party.
    const startFlow = async (headers: Record<string, string>) => {
      const init = await app.inject({ method: 'POST', url: '/api/oauth/google/init', headers })
      assert.equal(init.statusCode, 200)
      assert.equal(init.headers['set-cookie'], undefined, 'init (fetch lintas situs) tidak lagi memasang cookie')
      const startUrl = new URL(init.json().url)
      assert.equal(startUrl.origin, 'https://api.applify.id', 'tiket diarahkan ke host callback')
      assert.equal(startUrl.pathname, '/api/oauth/google/start')
      // Navigasi tingkat atas: tanpa header Origin.
      const start = await app.inject({ method: 'GET', url: startUrl.pathname + startUrl.search, headers: { host: startUrl.host } })
      return { init, start, startUrl }
    }

    // 1. Init + start menerbitkan cookie HttpOnly, SameSite=Lax, Secure, Path sempit, lalu 302 ke Google.
    const victimFlow = await startFlow({ authorization: 'Bearer valid-victim', origin: 'https://app.applify.id', host: 'api.applify.id' })
    assert.equal(victimFlow.start.statusCode, 302)
    const initVictim = { json: () => ({ url: String(victimFlow.start.headers.location) }) }
    assert.match(initVictim.json().url, /^https:\/\/accounts\.google\.com\//)
    const setCookieHeader = String(victimFlow.start.headers['set-cookie'])
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

    // 2. Serangan login-CSRF: penyerang memberi link bertanda tangan miliknya ke korban -> korban tidak punya cookie yang cocok -> ditolak (kembali ke Pengaturan dengan reason=session_mismatch) + cookie dihapus.
    const attackerFlow = await startFlow({ authorization: 'Bearer valid-attacker', host: 'api.applify.id' })
    const attackerState = new URL(String(attackerFlow.start.headers.location)).searchParams.get('state')!

    // 2b. Tiket sekali pakai; tiket bukan state OAuth dan state OAuth bukan tiket.
    const replay = await app.inject({ method: 'GET', url: victimFlow.startUrl.pathname + victimFlow.startUrl.search })
    assert.equal(replay.statusCode, 302)
    assert.match(String(replay.headers.location), /gmail=error&reason=invalid_state/)
    const stateAsTicket = await app.inject({ method: 'GET', url: `/api/oauth/google/start?ticket=${encodeURIComponent(attackerState)}` })
    assert.match(String(stateAsTicket.headers.location), /reason=invalid_state/)
    const freshTicket = new URL((await app.inject({ method: 'POST', url: '/api/oauth/google/init', headers: { authorization: 'Bearer valid-victim' } })).json().url).searchParams.get('ticket')!
    const ticketAsState = await app.inject({
      method: 'GET',
      url: `/api/oauth/google/callback?code=c1&state=${encodeURIComponent(freshTicket)}`,
      headers: { cookie: cookiePairFromSetCookie(setCookieHeader) },
    })
    assert.match(String(ticketAsState.headers.location), /reason=invalid_state/)
    assert.equal(googleExchangeCalls, 0)
    const noTicket = await app.inject({ method: 'GET', url: '/api/oauth/google/start' })
    assert.match(String(noTicket.headers.location), /reason=invalid_state/)

    const noCookieRes = await app.inject({
      method: 'GET',
      url: `/api/oauth/google/callback?code=c1&state=${encodeURIComponent(attackerState)}`,
    })
    assert.equal(noCookieRes.statusCode, 302)
    assert.equal(noCookieRes.headers.location, 'https://app.applify.id/settings?gmail=error&reason=session_mismatch')
    assert.match(String(noCookieRes.headers['set-cookie']), /Max-Age=0/)
    assert.equal(googleExchangeCalls, 0)

    const mismatchRes = await app.inject({
      method: 'GET',
      url: `/api/oauth/google/callback?code=c1&state=${encodeURIComponent(attackerState)}`,
      headers: { cookie: cookiePairFromSetCookie(setCookieHeader) },
    })
    assert.equal(mismatchRes.statusCode, 302)
    assert.equal(mismatchRes.headers.location, 'https://app.applify.id/settings?gmail=error&reason=session_mismatch')
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

    // 5. Lintas situs (*.vercel.app -> backend): init tidak memasang cookie; start (navigasi first-party) memasang
    //    cookie SameSite=Lax, yang tidak dibuang Brave/Safari/Chrome tanpa cookie pihak ketiga.
    const crossFlow = await startFlow({ authorization: 'Bearer valid-victim', origin: 'https://applify-web.vercel.app', host: 'applify-api.up.railway.app' })
    const crossCookie = String(crossFlow.start.headers['set-cookie'])
    assert.match(crossCookie, /SameSite=Lax/)
    assert.match(crossCookie, /Secure/)
    assert.match(crossCookie, /HttpOnly/)
    assert.match(crossCookie, /Path=\/api\/oauth\/google\/callback/)

    // Sanity hash helper matches SHA-256 hex
    assert.equal(hashOAuthNonce('abc'), crypto.createHash('sha256').update('abc').digest('hex'))
    await app.close()
  })
})

// ---- Kegagalan callback kembali ke Pengaturan, bukan JSON mentah; status memberi tahu perlu sambung ulang -------------

const OAUTH_ENV = {
  NODE_ENV: 'production',
  FRONTEND_URL: 'https://app.applify.id',
  GOOGLE_CLIENT_ID: 'gid-test',
  GOOGLE_CLIENT_SECRET: 'gsec-test',
  GOOGLE_REDIRECT_URI: 'https://api.applify.id/api/oauth/google/callback',
}

async function buildOAuthApp(opts: { db?: any; fetchImpl?: typeof fetch; env?: Record<string, string | undefined> } = {}) {
  const app = Fastify()
  await app.register(oauthRoutes, {
    prefix: '/api/oauth',
    db: opts.db ?? makeExtensionTestDb({ platform_sessions: [] }).db,
    resolveUserId: async (req, reply) => {
      if (req.headers.authorization === 'Bearer valid') return 'user-1'
      reply.status(401).send({ error: 'Unauthorized' })
      return null
    },
    fetchImpl: opts.fetchImpl ?? ((async () => new Response('{}', { status: 400 })) as typeof fetch),
    notify: async () => {},
    env: opts.env ?? OAUTH_ENV,
  })
  return app
}

test('OAuth callback: parameter hilang, state rusak, atau server belum dikonfigurasi: redirect ke Pengaturan dengan kode alasan, tanpa teks galat', async () => {
  await withEncryptionKey(async () => {
    const app = await buildOAuthApp()
    const go = (query: string) => app.inject({ method: 'GET', url: `/api/oauth/google/callback${query}` })
    const loc = (res: any) => String(res.headers.location)

    const noParams = await go('')
    assert.equal(noParams.statusCode, 302)
    assert.equal(loc(noParams), 'https://app.applify.id/settings?gmail=error&reason=missing_params')
    assert.match(String(noParams.headers['set-cookie']), /Max-Age=0/)

    const noState = await go('?code=abc')
    assert.equal(loc(noState), 'https://app.applify.id/settings?gmail=error&reason=missing_params')

    const garbage = await go('?code=abc&state=bukan.state.valid')
    assert.equal(garbage.statusCode, 302)
    assert.equal(loc(garbage), 'https://app.applify.id/settings?gmail=error&reason=invalid_state')
    assert.equal(garbage.body.includes('signature'), false)

    const expired = signState({ uid: 'user-1', nonce: 'n', exp: Date.now() - 1000 })
    const expiredRes = await go(`?code=abc&state=${encodeURIComponent(expired)}`)
    assert.equal(loc(expiredRes), 'https://app.applify.id/settings?gmail=error&reason=invalid_state')

    const noNonce = signState({ uid: 'user-1', exp: Date.now() + 60_000 })
    const noNonceRes = await go(`?code=abc&state=${encodeURIComponent(noNonce)}`)
    assert.equal(loc(noNonceRes), 'https://app.applify.id/settings?gmail=error&reason=invalid_state')

    const unconfigured = await buildOAuthApp({ env: { ...OAUTH_ENV, GOOGLE_CLIENT_SECRET: '' } })
    const unconfiguredRes = await unconfigured.inject({ method: 'GET', url: '/api/oauth/google/callback?code=abc&state=x' })
    assert.equal(loc(unconfiguredRes), 'https://app.applify.id/settings?gmail=error&reason=not_configured')
    await app.close()
    await unconfigured.close()
  })
})

test('OAuth callback: penukaran kode gagal (HTTP 400 atau jaringan putus) kembali dengan reason=token_exchange dan tidak menyimpan token', async () => {
  await withEncryptionKey(async () => {
    for (const fetchImpl of [
      (async () => new Response('{"error":"invalid_grant"}', { status: 400 })) as typeof fetch,
      (async () => {
        throw new TypeError('fetch failed')
      }) as typeof fetch,
    ]) {
      const store = makeExtensionTestDb({ platform_sessions: [] })
      const app = await buildOAuthApp({ db: store.db, fetchImpl })
      const init = await app.inject({ method: 'POST', url: '/api/oauth/google/init', headers: { authorization: 'Bearer valid', host: 'api.applify.id' } })
      const startUrl = new URL(init.json().url)
      const start = await app.inject({ method: 'GET', url: startUrl.pathname + startUrl.search })
      const state = new URL(String(start.headers.location)).searchParams.get('state')!
      const res = await app.inject({
        method: 'GET',
        url: `/api/oauth/google/callback?code=c1&state=${encodeURIComponent(state)}`,
        headers: { cookie: cookiePairFromSetCookie(start.headers['set-cookie']) },
      })
      assert.equal(res.statusCode, 302)
      assert.equal(res.headers.location, 'https://app.applify.id/settings?gmail=error&reason=token_exchange')
      assert.equal(store.tables.platform_sessions.length, 0)
      await app.close()
    }
  })
})

test('OAuth status: token yang refresh-nya ditolak (invalid_grant) melapor connected:false, needs_reconnect:true; tanpa blob terenkripsi', async () => {
  const future = new Date(Date.now() + 3600_000).toISOString()
  const store = makeExtensionTestDb({
    platform_sessions: [
      { id: 's1', user_id: 'user-1', platform: 'gmail', is_active: true, expires_at: future, session_data: { encrypted: 'BLOB-RAHASIA', refresh_failed: 'invalid_grant' } },
    ],
  })
  const app = await buildOAuthApp({ db: store.db })
  const res = await app.inject({ method: 'GET', url: '/api/oauth/status', headers: { authorization: 'Bearer valid' } })
  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.json(), { gmail: false, connected: false, needs_reconnect: true, email: null })
  assert.equal(res.body.includes('BLOB-RAHASIA'), false)

  // Tersambung normal, tanpa penanda.
  store.tables.platform_sessions[0].session_data = { encrypted: 'BLOB-RAHASIA' }
  const ok = await app.inject({ method: 'GET', url: '/api/oauth/status', headers: { authorization: 'Bearer valid' } })
  assert.deepEqual(ok.json(), { gmail: true, connected: true, needs_reconnect: false, email: null })

  // Belum pernah tersambung.
  store.tables.platform_sessions.length = 0
  const none = await app.inject({ method: 'GET', url: '/api/oauth/status', headers: { authorization: 'Bearer valid' } })
  assert.deepEqual(none.json(), { gmail: false, connected: false, needs_reconnect: false, email: null })
  await app.close()
})

// ---- Temuan #7: status Gmail jujur untuk is_active=false dan refresh_token kosong ------------------------------------

function blobOf(fields: Record<string, unknown>): string {
  return encryptForTest(JSON.stringify(fields))
}

test('OAuth status (#7): is_active=false TIDAK dilaporkan tersambung; needs_reconnect:true', async () => {
  const future = new Date(Date.now() + 3600_000).toISOString()
  const store = makeExtensionTestDb({
    platform_sessions: [{ id: 's1', user_id: 'user-1', platform: 'gmail', is_active: false, expires_at: future, session_data: { encrypted: 'BLOB' } }],
  })
  const app = await buildOAuthApp({ db: store.db })
  const res = await app.inject({ method: 'GET', url: '/api/oauth/status', headers: { authorization: 'Bearer valid' } })
  assert.deepEqual(res.json(), { gmail: false, connected: false, needs_reconnect: true, email: null })
  await app.close()
})

test('OAuth status (#7): access token kedaluwarsa tanpa refresh_token -> needs_reconnect; dengan refresh_token -> tersambung', async () => {
  await withEncryptionKey(async () => {
    const past = new Date(Date.now() - 3600_000).toISOString()
    const store = makeExtensionTestDb({
      platform_sessions: [{ id: 's1', user_id: 'user-1', platform: 'gmail', is_active: true, expires_at: past, session_data: { encrypted: blobOf({ access_token: 'at' }) } }],
    })
    const app = await buildOAuthApp({ db: store.db })
    const get = () => app.inject({ method: 'GET', url: '/api/oauth/status', headers: { authorization: 'Bearer valid' } })
    assert.deepEqual((await get()).json(), { gmail: false, connected: false, needs_reconnect: true, email: null })
    store.tables.platform_sessions[0].session_data = { encrypted: blobOf({ access_token: 'at', refresh_token: 'rt' }) }
    assert.deepEqual((await get()).json(), { gmail: true, connected: true, needs_reconnect: false, email: null })
    // invalid_grant tetap needs_reconnect
    store.tables.platform_sessions[0].session_data = { encrypted: blobOf({ refresh_token: 'rt' }), refresh_failed: 'invalid_grant' }
    assert.deepEqual((await get()).json(), { gmail: false, connected: false, needs_reconnect: true, email: null })
    await app.close()
  })
})

async function runCallback(opts: { tokenBody: Record<string, unknown>; existing?: Record<string, unknown> }) {
  const store = makeExtensionTestDb({ platform_sessions: [] })
  if (opts.existing) {
    store.tables.platform_sessions.push({ id: 's0', user_id: 'user-1', platform: 'gmail', is_active: true, expires_at: new Date(Date.now() + 1000).toISOString(), session_data: { encrypted: blobOf(opts.existing) } })
  }
  const db = {
    ...store.db,
    from(table: string) {
      if (table !== 'platform_sessions') return store.db.from(table)
      const q = store.db.from(table)
      return Object.assign(Object.create(q), {
        async upsert(row: Record<string, any>) {
          const list = store.tables.platform_sessions
          const idx = list.findIndex((r) => r.user_id === row.user_id && r.platform === row.platform)
          if (idx >= 0) list[idx] = { ...list[idx], ...row }
          else list.push({ id: `s${list.length}`, ...row })
          return { error: null }
        },
      })
    },
  }
  const app = await buildOAuthApp({
    db,
    fetchImpl: (async () => new Response(JSON.stringify({ access_token: 'at-new', expires_in: 3600, ...opts.tokenBody }), { status: 200 })) as typeof fetch,
  })
  const start = await app.inject({ method: 'GET', url: '/api/oauth/google', headers: { authorization: 'Bearer valid' } })
  const state = new URL(String(start.headers.location)).searchParams.get('state')!
  const cookie = cookiePairFromSetCookie(start.headers['set-cookie'])
  const res = await app.inject({ method: 'GET', url: `/api/oauth/google/callback?code=abc&state=${encodeURIComponent(state)}`, headers: { cookie } })
  await app.close()
  return { res, row: store.tables.platform_sessions[0] }
}

test('OAuth callback (#7): tanpa refresh_token dari Google dan tanpa yang lama -> tidak aktif, redirect no_refresh_token', async () => {
  await withEncryptionKey(async () => {
    const { res, row } = await runCallback({ tokenBody: {} })
    assert.match(String(res.headers.location), /gmail=error&reason=no_refresh_token/)
    assert.equal(row.is_active, false)
    assert.equal(row.session_data.refresh_failed, 'missing_refresh_token')
  })
})

test('OAuth callback (#7): tanpa refresh_token baru tetapi ada yang lama -> refresh_token lama dipertahankan, tetap aktif', async () => {
  await withEncryptionKey(async () => {
    const { res, row } = await runCallback({ tokenBody: {}, existing: { access_token: 'old', refresh_token: 'rt-old' } })
    assert.match(String(res.headers.location), /gmail=connected/)
    assert.equal(row.is_active, true)
    assert.equal(row.session_data.refresh_failed, undefined)
    const parsed = JSON.parse(decryptForTest(row.session_data.encrypted))
    assert.equal(parsed.refresh_token, 'rt-old')
    assert.equal(parsed.access_token, 'at-new')
  })
})

test('OAuth callback (#7): refresh_token baru dari Google dipakai', async () => {
  await withEncryptionKey(async () => {
    const { res, row } = await runCallback({ tokenBody: { refresh_token: 'rt-new' }, existing: { refresh_token: 'rt-old' } })
    assert.match(String(res.headers.location), /gmail=connected/)
    assert.equal(JSON.parse(decryptForTest(row.session_data.encrypted)).refresh_token, 'rt-new')
  })
})

// ---- GAP-10: alamat Gmail pengirim (userinfo.email) ------------------------------------------------------------------

async function runCallbackWithFetch(opts: { userinfo: () => Response | Promise<Response>; existingSessionData?: Record<string, unknown> }) {
  const store = makeExtensionTestDb({ platform_sessions: [] })
  if (opts.existingSessionData) {
    store.tables.platform_sessions.push({ id: 's0', user_id: 'user-1', platform: 'gmail', is_active: true, expires_at: new Date(Date.now() + 1000).toISOString(), session_data: opts.existingSessionData })
  }
  const db = {
    ...store.db,
    from(table: string) {
      if (table !== 'platform_sessions') return store.db.from(table)
      const q = store.db.from(table)
      return Object.assign(Object.create(q), {
        async upsert(row: Record<string, any>) {
          const list = store.tables.platform_sessions
          const idx = list.findIndex((r) => r.user_id === row.user_id && r.platform === row.platform)
          if (idx >= 0) list[idx] = { ...list[idx], ...row }
          else list.push({ id: `s${list.length}`, ...row })
          return { error: null }
        },
      })
    },
  }
  const calls: string[] = []
  const app = await buildOAuthApp({
    db,
    fetchImpl: (async (url: any) => {
      calls.push(String(url))
      if (String(url).includes('/oauth2/v2/userinfo')) return opts.userinfo()
      return new Response(JSON.stringify({ access_token: 'at-new', refresh_token: 'rt-new', expires_in: 3600 }), { status: 200 })
    }) as typeof fetch,
  })
  const start = await app.inject({ method: 'GET', url: '/api/oauth/google', headers: { authorization: 'Bearer valid' } })
  const state = new URL(String(start.headers.location)).searchParams.get('state')!
  const cookie = cookiePairFromSetCookie(start.headers['set-cookie'])
  const res = await app.inject({ method: 'GET', url: `/api/oauth/google/callback?code=abc&state=${encodeURIComponent(state)}`, headers: { cookie } })
  const status = await app.inject({ method: 'GET', url: '/api/oauth/status', headers: { authorization: 'Bearer valid' } })
  await app.close()
  return { res, row: store.tables.platform_sessions[0], calls, status }
}

test('OAuth GAP-10: SCOPES mencakup gmail.send dan userinfo.email', () => {
  const scopes = SCOPES.split(' ')
  assert.ok(scopes.includes('https://www.googleapis.com/auth/gmail.send'))
  assert.ok(scopes.includes('https://www.googleapis.com/auth/userinfo.email'))
})

test('OAuth GAP-10: callback mengambil userinfo, menyimpan gmail_email (lowercase) dan /status mengembalikannya', async () => {
  await withEncryptionKey(async () => {
    const { res, row, calls, status } = await runCallbackWithFetch({
      userinfo: () => new Response(JSON.stringify({ email: '  Pelamar@Gmail.COM ' }), { status: 200 }),
    })
    assert.match(String(res.headers.location), /gmail=connected/)
    assert.ok(calls.some((u) => u.includes('/oauth2/v2/userinfo')))
    assert.equal(row.session_data.gmail_email, 'pelamar@gmail.com')
    assert.deepEqual(status.json(), { gmail: true, connected: true, needs_reconnect: false, email: 'pelamar@gmail.com' })
    assert.equal(status.body.includes(row.session_data.encrypted), false)
  })
})

test('OAuth GAP-10: userinfo gagal (HTTP 500 atau jaringan putus) tetap tersambung, gmail_email null', async () => {
  await withEncryptionKey(async () => {
    for (const userinfo of [
      () => new Response('{}', { status: 500 }),
      () => { throw new Error('network down') },
    ]) {
      const { res, row, status } = await runCallbackWithFetch({ userinfo })
      assert.match(String(res.headers.location), /gmail=connected/)
      assert.equal(row.is_active, true)
      assert.equal(row.session_data.gmail_email, null)
      assert.deepEqual(status.json(), { gmail: true, connected: true, needs_reconnect: false, email: null })
    }
  })
})

test('OAuth GAP-10: gmail_email lama dipertahankan bila callback tidak mendapat email baru', async () => {
  await withEncryptionKey(async () => {
    const { row, status } = await runCallbackWithFetch({
      userinfo: () => new Response('{}', { status: 500 }),
      existingSessionData: { encrypted: 'old', gmail_email: 'lama@gmail.com' },
    })
    assert.equal(row.session_data.gmail_email, 'lama@gmail.com')
    assert.equal(status.json().email, 'lama@gmail.com')
  })
})

test('OAuth GAP-10: /status email null untuk sesi lama tanpa gmail_email dan saat needs_reconnect', async () => {
  const future = new Date(Date.now() + 3600_000).toISOString()
  const store = makeExtensionTestDb({
    platform_sessions: [{ id: 's1', user_id: 'user-1', platform: 'gmail', is_active: true, expires_at: future, session_data: { encrypted: 'BLOB' } }],
  })
  const app = await buildOAuthApp({ db: store.db })
  const get = () => app.inject({ method: 'GET', url: '/api/oauth/status', headers: { authorization: 'Bearer valid' } })
  assert.deepEqual((await get()).json(), { gmail: true, connected: true, needs_reconnect: false, email: null })
  store.tables.platform_sessions[0].session_data = { encrypted: 'BLOB', gmail_email: 'a@gmail.com', refresh_failed: 'invalid_grant' }
  assert.deepEqual((await get()).json(), { gmail: false, connected: false, needs_reconnect: true, email: null })
  await app.close()
})
