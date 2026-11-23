import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import { FakeDb } from './helpers/fakeDb.ts'
import { decryptByokKey, encryptByokKey } from '../services/byok-crypto.ts'
import { createAttemptLimiter } from '../services/byok-guard.ts'
import { llmKeysRoutes, LLM_KEYS_TABLE } from '../api/routes/llm-keys.ts'

const SECRET = 'route-test-byok-secret-0123456789-abcdefghijkl'
const KEY = 'sk-ant-test-' + 'A1b2C3d4E5'.repeat(4) // fake: 52 characters
const KEY2 = 'sk-ant-test-' + 'Q9w8E7r6T5'.repeat(4)
const OPENAI_KEY = 'test-openai-' + 'Zz9Yy8Xx7W'.repeat(3)
const PROVIDER_TEXT = 'provider text that must never be used'
const T0 = Date.parse('2026-11-23T10:00:00.000Z')
const ENABLED = { BYOK_ENABLED: 'true' }
const ALL_PROVIDERS = ['anthropic', 'openai', 'gemini', 'openrouter', 'deepseek', 'moonshot', 'zhipu', 'qwen', 'mimo', 'numes', 'crowllm']
const UNVERIFIED = ['zhipu', 'qwen']
const VERIFIED_IDS = ALL_PROVIDERS.filter((id) => !UNVERIFIED.includes(id))
/** Providers without a default model: a PUT must name one. */
const NEEDS_MODEL = ['openai', 'crowllm']

let keepSecret: string | undefined
before(() => {
  keepSecret = process.env.BYOK_ENCRYPTION_KEY
  process.env.BYOK_ENCRYPTION_KEY = SECRET
})
after(() => {
  if (keepSecret === undefined) delete process.env.BYOK_ENCRYPTION_KEY
  else process.env.BYOK_ENCRYPTION_KEY = keepSecret
})

// ---------------------------------------------------------------- harness

interface FetchCall {
  url: string
  headers: Record<string, string>
  redirect?: string
}

/** Fake provider: answers with `status` (or throws when it is an Error). Records every call. */
function makeProvider(status: number | Error = 200) {
  const state = { status, calls: [] as FetchCall[] }
  const fetchImpl = (async (url: any, init: any) => {
    state.calls.push({ url: String(url), headers: { ...(init?.headers ?? {}) }, redirect: init?.redirect })
    if (state.status instanceof Error) throw state.status
    return new Response(JSON.stringify({ error: { message: PROVIDER_TEXT } }), { status: state.status })
  }) as typeof fetch
  return { state, fetchImpl }
}

/** Wraps a FakeDb and records the column list of every select(), to prove key_encrypted is not read needlessly. */
function spy(db: FakeDb) {
  const selects: Array<{ table: string; cols: string | undefined }> = []
  return {
    selects,
    db: {
      from(table: string) {
        const q: any = db.from(table)
        const select = q.select.bind(q)
        q.select = (cols?: string, o?: any) => {
          selects.push({ table, cols })
          return select(cols, o)
        }
        return q
      },
    },
  }
}

interface BuildOptions {
  db?: FakeDb
  env?: Record<string, string | undefined>
  provider?: ReturnType<typeof makeProvider>
  limiter?: ReturnType<typeof createAttemptLimiter>
  clock?: { now: number }
}

async function build(o: BuildOptions = {}) {
  const lines: string[] = []
  const db = o.db ?? new FakeDb()
  const provider = o.provider ?? makeProvider(200)
  const clock = o.clock ?? { now: T0 }
  const watched = spy(db)
  const app = Fastify({ logger: { level: 'trace', stream: { write: (s: string) => void lines.push(s) } } })
  // Same position as the real auth middleware: a preHandler hook of the parent scope. The test user comes from a header.
  app.addHook('preHandler', async (req) => {
    const id = req.headers['x-test-user']
    if (typeof id === 'string' && id) (req as any).user = { id }
  })
  await app.register(llmKeysRoutes, {
    prefix: '/api/llm-keys',
    db: watched.db,
    fetchImpl: provider.fetchImpl,
    now: () => clock.now,
    env: o.env ?? ENABLED,
    ...(o.limiter ? { limiter: o.limiter } : {}),
  })
  return { app, db, provider, clock, selects: watched.selects, logs: () => lines.join('') }
}

type Built = Awaited<ReturnType<typeof build>>

const as = (user: string) => ({ 'x-test-user': user })
const get = (b: Built, user = 'u1') => b.app.inject({ method: 'GET', url: '/api/llm-keys', headers: as(user) })
/** PUT with the consent the form always sends; a test that is about consent passes `consent` itself. */
const put = (b: Built, provider: string, body: unknown, user = 'u1') =>
  b.app.inject({
    method: 'PUT',
    url: `/api/llm-keys/${provider}`,
    payload: (body && typeof body === 'object' ? { consent: true, ...(body as object) } : body) as any,
    headers: as(user),
  })
const test_ = (b: Built, provider: string, user = 'u1') =>
  b.app.inject({ method: 'POST', url: `/api/llm-keys/${provider}/test`, headers: as(user) })
const del = (b: Built, provider: string, user = 'u1') =>
  b.app.inject({ method: 'DELETE', url: `/api/llm-keys/${provider}`, headers: as(user) })

/** A stored row as the migration shapes it. */
function storedRow(userId: string, provider: string, key: string, extra: Record<string, any> = {}) {
  return {
    id: `row-${userId}-${provider}`,
    user_id: userId,
    provider,
    key_encrypted: encryptByokKey(key, { userId, provider }),
    key_last4: key.slice(-4),
    status: 'valid',
    last_error: null,
    last_validated_at: '2026-11-01T00:00:00.000Z',
    model: null,
    data_consent_at: '2026-11-01T00:00:00.000Z',
    created_at: '2026-11-01T00:00:00.000Z',
    updated_at: '2026-11-01T00:00:00.000Z',
    ...extra,
  }
}

const rows = (b: Built) => b.db.rows(LLM_KEYS_TABLE)

// ---------------------------------------------------------------- feature flag

test('flag off: GET says enabled false, PUT and test answer 403, DELETE still works', async () => {
  const seed = new FakeDb({ [LLM_KEYS_TABLE]: [storedRow('u1', 'anthropic', KEY)] })
  const b = await build({ db: seed, env: {} })

  const list = await get(b)
  assert.equal(list.statusCode, 200)
  assert.equal(list.json().enabled, false)
  assert.equal(list.json().keys.length, 1)

  const p = await put(b, 'anthropic', { apiKey: KEY2 })
  assert.equal(p.statusCode, 403)
  assert.deepEqual(p.json(), { code: 'byok_disabled' })

  const t = await test_(b, 'anthropic')
  assert.equal(t.statusCode, 403)
  assert.deepEqual(t.json(), { code: 'byok_disabled' })

  assert.equal(b.provider.state.calls.length, 0, 'no provider call while disabled')
  assert.equal(b.db.writes.length, 0)

  const d = await del(b, 'anthropic')
  assert.equal(d.statusCode, 200)
  assert.deepEqual(d.json(), { deleted: true })
  assert.equal(rows(b).length, 0)
  await b.app.close()
})

test('flag: only the exact text "true" turns it on', async () => {
  for (const v of ['false', '1', 'TRUE', '']) {
    const b = await build({ env: { BYOK_ENABLED: v } })
    assert.equal((await put(b, 'anthropic', { apiKey: KEY })).statusCode, 403, v)
    assert.equal((await get(b)).json().enabled, false, v)
    await b.app.close()
  }
  const on = await build({ env: { BYOK_ENABLED: 'true' } })
  assert.equal((await get(on)).json().enabled, true)
  await on.app.close()
})

test('401 without a user, on every route', async () => {
  const b = await build()
  for (const [method, url] of [
    ['GET', '/api/llm-keys'],
    ['PUT', '/api/llm-keys/anthropic'],
    ['POST', '/api/llm-keys/anthropic/test'],
    ['DELETE', '/api/llm-keys/anthropic'],
  ] as const) {
    const res = await b.app.inject({ method, url, payload: method === 'PUT' ? { apiKey: KEY } : undefined })
    assert.equal(res.statusCode, 401, `${method} ${url}`)
    assert.deepEqual(res.json(), { code: 'unauthorized' })
  }
  assert.equal(b.provider.state.calls.length, 0)
  assert.equal(b.db.writes.length, 0)
  await b.app.close()
})

// ---------------------------------------------------------------- PUT: input checks

test('PUT: unknown provider is 400 unknown_provider and nothing is called', async () => {
  const b = await build()
  for (const p of ['groq', 'Anthropic', '__proto__', 'constructor']) {
    const res = await put(b, p, { apiKey: KEY })
    assert.equal(res.statusCode, 400, p)
    assert.deepEqual(res.json(), { code: 'unknown_provider' })
  }
  assert.equal(b.provider.state.calls.length, 0)
  assert.equal(b.db.writes.length, 0)
  await b.app.close()
})

test('PUT: key_format and wrong_provider, without a provider call or a write', async () => {
  const b = await build()
  const cases: Array<[string, unknown, string]> = [
    ['anthropic', {}, 'key_format'],
    ['anthropic', { apiKey: 123 }, 'key_format'],
    ['anthropic', { apiKey: 'short' }, 'key_format'],
    ['anthropic', { apiKey: 'a'.repeat(301) }, 'key_format'],
    ['anthropic', { apiKey: 'sk-ant-test-' + 'a b '.repeat(10) }, 'key_format'],
    ['anthropic', { apiKey: 'x'.repeat(30) + '$' }, 'key_format'],
    ['openai', { apiKey: KEY }, 'wrong_provider'],
    ['gemini', { apiKey: KEY }, 'wrong_provider'],
    ['openrouter', { apiKey: KEY }, 'wrong_provider'],
    ['openai', { apiKey: 'sk-or-v1-' + 'a1b2c3d4'.repeat(5) }, 'wrong_provider'],
  ]
  for (const [provider, body, code] of cases) {
    const res = await put(b, provider, body)
    assert.equal(res.statusCode, 400, `${provider} ${code}`)
    assert.deepEqual(res.json(), { code })
  }
  const noBody = await b.app.inject({ method: 'PUT', url: '/api/llm-keys/anthropic', headers: as('u1') })
  assert.equal(noBody.statusCode, 400)
  assert.deepEqual(noBody.json(), { code: 'consent_required' })
  assert.equal(b.provider.state.calls.length, 0)
  assert.equal(b.db.writes.length, 0)
  await b.app.close()
})

test('PUT: a body over the limit is refused (413) and a broken JSON body is a fixed 400', async () => {
  const b = await build()
  const big = await b.app.inject({
    method: 'PUT',
    url: '/api/llm-keys/anthropic',
    headers: { ...as('u1'), 'content-type': 'application/json' },
    payload: JSON.stringify({ apiKey: 'a'.repeat(5000) }),
  })
  assert.equal(big.statusCode, 413)
  assert.deepEqual(big.json(), { code: 'invalid_request' })

  const broken = await b.app.inject({
    method: 'PUT',
    url: '/api/llm-keys/anthropic',
    headers: { ...as('u1'), 'content-type': 'application/json' },
    payload: `{"apiKey":"${KEY}`,
  })
  assert.equal(broken.statusCode, 400)
  assert.deepEqual(broken.json(), { code: 'invalid_request' })
  assert.equal(JSON.stringify(broken.json()).includes(KEY), false)
  assert.equal(b.logs().includes(KEY), false, 'a broken body is not quoted in the log')
  assert.equal(b.provider.state.calls.length, 0)
  await b.app.close()
})

// ---------------------------------------------------------------- PUT: provider answer

test('PUT: an invalid key (401, 403) is 400 key_invalid and is never stored', async () => {
  for (const status of [401, 403]) {
    const b = await build({ provider: makeProvider(status) })
    const res = await put(b, 'anthropic', { apiKey: KEY })
    assert.equal(res.statusCode, 400, String(status))
    assert.deepEqual(res.json(), { code: 'key_invalid' })
    assert.equal(rows(b).length, 0)
    assert.equal(b.db.writes.length, 0)
    assert.equal(b.provider.state.calls.length, 1)
    await b.app.close()
  }
})

test('PUT: gemini answers an invalid key with 400, which counts as invalid; other providers keep 400 as unavailable', async () => {
  const g = await build({ provider: makeProvider(400) })
  const gr = await put(g, 'gemini', { apiKey: OPENAI_KEY })
  assert.equal(gr.statusCode, 400)
  assert.deepEqual(gr.json(), { code: 'key_invalid' })
  await g.app.close()

  const o = await build({ provider: makeProvider(400) })
  const or = await put(o, 'openai', { apiKey: OPENAI_KEY, model: 'gpt-4o' })
  assert.equal(or.statusCode, 503)
  assert.deepEqual(or.json(), { code: 'validation_unavailable' })
  await o.app.close()
})

test('PUT: provider trouble (429, 500, network error) is 503 validation_unavailable and nothing is stored', async () => {
  for (const status of [429, 500, 502, new TypeError('fetch failed')] as Array<number | Error>) {
    const b = await build({ provider: makeProvider(status) })
    const res = await put(b, 'anthropic', { apiKey: KEY })
    assert.equal(res.statusCode, 503, String(status))
    assert.deepEqual(res.json(), { code: 'validation_unavailable' })
    assert.equal(rows(b).length, 0)
    assert.equal(b.db.writes.length, 0)
    await b.app.close()
  }
})

test('PUT: no encryption secret is 500 encryption_unavailable, and the key is never sent to the provider', async () => {
  const b = await build()
  const keep = process.env.BYOK_ENCRYPTION_KEY
  try {
    for (const secret of [undefined, 'short-secret']) {
      if (secret === undefined) delete process.env.BYOK_ENCRYPTION_KEY
      else process.env.BYOK_ENCRYPTION_KEY = secret
      const res = await put(b, 'anthropic', { apiKey: KEY })
      assert.equal(res.statusCode, 500, String(secret))
      assert.deepEqual(res.json(), { code: 'encryption_unavailable' })
    }
  } finally {
    process.env.BYOK_ENCRYPTION_KEY = keep
  }
  assert.equal(b.provider.state.calls.length, 0)
  assert.equal(rows(b).length, 0)
  await b.app.close()
})

// ---------------------------------------------------------------- PUT: success

test('PUT: a valid key is stored encrypted (never plaintext) and the reply carries only the last four', async () => {
  const b = await build()
  const res = await put(b, 'anthropic', { apiKey: `  ${KEY}  ` })
  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.json(), {
    key: { provider: 'anthropic', last4: KEY.slice(-4), status: 'valid', lastValidatedAt: '2026-11-23T10:00:00.000Z', model: null },
  })

  const stored = rows(b)
  assert.equal(stored.length, 1)
  const row = stored[0]
  assert.equal(row.user_id, 'u1')
  assert.equal(row.provider, 'anthropic')
  assert.equal(row.key_last4, KEY.slice(-4))
  assert.equal(row.status, 'valid')
  assert.equal(row.last_error, null)
  assert.equal(row.last_validated_at, '2026-11-23T10:00:00.000Z')
  assert.equal(row.updated_at, '2026-11-23T10:00:00.000Z')
  assert.equal(row.model, null)
  assert.equal(row.data_consent_at, '2026-11-23T10:00:00.000Z')
  assert.notEqual(row.key_encrypted, KEY)
  assert.equal(JSON.stringify(row).includes(KEY), false, 'no plaintext anywhere in the row')
  assert.equal(decryptByokKey(row.key_encrypted, { userId: 'u1', provider: 'anthropic' }), KEY, 'trimmed key round trips')
  assert.throws(() => decryptByokKey(row.key_encrypted, { userId: 'u2', provider: 'anthropic' }))

  const body = res.body
  assert.equal(body.includes(KEY), false)
  assert.equal(body.includes(row.key_encrypted), false)
  assert.equal(body.includes('key_encrypted'), false)
  await b.app.close()
})

test('PUT: the key goes to the provider in a header, not in the URL (every verified provider)', async () => {
  const bearer = (url: string) => ({ url, header: 'Authorization', value: `Bearer ${OPENAI_KEY}` })
  const expected: Record<string, { url: string; header: string; value: string }> = {
    anthropic: { url: 'https://api.anthropic.com/v1/models?limit=1', header: 'x-api-key', value: KEY },
    openai: bearer('https://api.openai.com/v1/models'),
    gemini: { url: 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1', header: 'x-goog-api-key', value: OPENAI_KEY },
    openrouter: bearer('https://openrouter.ai/api/v1/key'),
    deepseek: bearer('https://api.deepseek.com/models'),
    moonshot: bearer('https://api.moonshot.ai/v1/models'),
    mimo: bearer('https://api.xiaomimimo.com/v1/models'),
    numes: bearer('https://api.numes.ai/api/v1/key'),
    crowllm: bearer('https://crowllm.com/v1/models'),
  }
  assert.deepEqual(Object.keys(expected), VERIFIED_IDS, 'the table covers every verified provider')
  for (const [provider, want] of Object.entries(expected)) {
    const b = await build()
    const key = provider === 'anthropic' ? KEY : OPENAI_KEY
    // openai and crowllm have no default model, so the form must send one.
    const res = await put(b, provider, { apiKey: key, ...(NEEDS_MODEL.includes(provider) ? { model: 'some-model' } : {}) })
    assert.equal(res.statusCode, 200, provider)
    assert.equal(b.provider.state.calls.length, 1)
    const call = b.provider.state.calls[0]
    assert.equal(call.url, want.url, provider)
    assert.equal(call.url.includes(key), false, `${provider}: key in URL`)
    assert.equal(call.headers[want.header], want.value, provider)
    assert.equal(call.redirect, 'manual', provider)
    assert.equal(res.json().key.provider, provider)
    assert.equal(rows(b)[0].provider, provider)
    assert.equal(decryptByokKey(rows(b)[0].key_encrypted, { userId: 'u1', provider: provider as any }), key, provider)
    await b.app.close()
  }
})

test('PUT: a second key for the same provider replaces the row (upsert), keeping one row', async () => {
  const b = await build()
  await put(b, 'anthropic', { apiKey: KEY })
  const created = rows(b)[0].created_at
  b.clock.now = T0 + 60_000
  const res = await put(b, 'anthropic', { apiKey: KEY2 })
  assert.equal(res.statusCode, 200)
  assert.equal(res.json().key.last4, KEY2.slice(-4))
  assert.equal(rows(b).length, 1)
  assert.equal(rows(b)[0].created_at, created)
  assert.equal(rows(b)[0].updated_at, '2026-11-23T10:01:00.000Z')
  assert.equal(decryptByokKey(rows(b)[0].key_encrypted, { userId: 'u1', provider: 'anthropic' }), KEY2)

  // Another provider adds a second row.
  await put(b, 'openai', { apiKey: OPENAI_KEY, model: 'gpt-4o' })
  assert.equal(rows(b).length, 2)
  await b.app.close()
})

test('PUT: replacing a stored key with an invalid one leaves the stored key untouched', async () => {
  const seed = new FakeDb({ [LLM_KEYS_TABLE]: [storedRow('u1', 'anthropic', KEY)] })
  const before = JSON.stringify(seed.rows(LLM_KEYS_TABLE))
  const b = await build({ db: seed, provider: makeProvider(401) })
  const res = await put(b, 'anthropic', { apiKey: KEY2 })
  assert.equal(res.statusCode, 400)
  assert.equal(JSON.stringify(rows(b)), before)
  await b.app.close()
})

test('PUT: a revalidated key clears an earlier invalid status', async () => {
  const seed = new FakeDb({ [LLM_KEYS_TABLE]: [storedRow('u1', 'anthropic', KEY, { status: 'invalid', last_error: 'key_invalid' })] })
  const b = await build({ db: seed })
  const res = await put(b, 'anthropic', { apiKey: KEY2 })
  assert.equal(res.statusCode, 200)
  assert.equal(rows(b)[0].status, 'valid')
  assert.equal(rows(b)[0].last_error, null)
  await b.app.close()
})

test('PUT: an insert that loses a race (23505) is retried as an update', async () => {
  const db = new FakeDb()
  const real = db.from.bind(db)
  let raced = false
  // First insert fails with a unique violation, as if another request inserted the row a moment earlier.
  ;(db as any).from = (table: string) => {
    const q: any = real(table)
    const insert = q.insert.bind(q)
    q.insert = (payload: any) => {
      if (!raced) {
        raced = true
        db.rows(table).push({ ...payload, key_encrypted: 'from-the-other-request', id: 'other' })
        return { then: (ok: any) => Promise.resolve({ data: null, error: { message: 'duplicate', code: '23505' } }).then(ok) }
      }
      return insert(payload)
    }
    return q
  }
  const b = await build({ db })
  const res = await put(b, 'anthropic', { apiKey: KEY })
  assert.equal(res.statusCode, 200)
  assert.equal(rows(b).length, 1)
  assert.equal(decryptByokKey(rows(b)[0].key_encrypted, { userId: 'u1', provider: 'anthropic' }), KEY)
  await b.app.close()
})

// ---------------------------------------------------------------- registry: unverified providers

test('unverified providers: PUT is 400 provider_unverified, nothing is read, sent or stored', async () => {
  const b = await build()
  for (const p of UNVERIFIED) {
    // Precedence: the provider is refused before the body is looked at, so even a bad body gets the same answer.
    for (const body of [{ apiKey: OPENAI_KEY }, { apiKey: 'x' }, {}, { apiKey: OPENAI_KEY, consent: false }]) {
      const res = await put(b, p, body)
      assert.equal(res.statusCode, 400, p)
      assert.deepEqual(res.json(), { code: 'provider_unverified' })
    }
  }
  assert.equal(b.provider.state.calls.length, 0, 'no key was sent anywhere')
  assert.equal(b.db.writes.length, 0)
  assert.equal(b.logs().includes(OPENAI_KEY), false)
  await b.app.close()
})

test('unverified providers: test is 404, DELETE is deleted false, GET still lists them as ids', async () => {
  const b = await build()
  for (const p of UNVERIFIED) {
    assert.equal((await test_(b, p)).statusCode, 404, p)
    assert.deepEqual((await del(b, p)).json(), { deleted: false })
  }
  assert.deepEqual((await get(b)).json().providers, ALL_PROVIDERS)
  assert.equal(b.provider.state.calls.length, 0)
  await b.app.close()
})

test('unverified providers: unknown ids are still unknown_provider, not provider_unverified', async () => {
  const b = await build()
  assert.deepEqual((await put(b, 'groq', { apiKey: KEY })).json(), { code: 'unknown_provider' })
  await b.app.close()
})

// ---------------------------------------------------------------- consent

test('consent: PUT without consent true is 400 consent_required, and nothing happens', async () => {
  const b = await build()
  const bodies: unknown[] = [
    { apiKey: KEY, consent: false },
    { apiKey: KEY, consent: 'true' },
    { apiKey: KEY, consent: 1 },
    { apiKey: KEY, consent: null },
    { apiKey: KEY, consent: 'yes' },
    { apiKey: 'x' }, // consent is asked before the key is looked at
  ]
  for (const body of bodies) {
    const res = await b.app.inject({ method: 'PUT', url: '/api/llm-keys/anthropic', payload: body as any, headers: as('u1') })
    assert.equal(res.statusCode, 400, JSON.stringify(body))
    assert.deepEqual(res.json(), { code: 'consent_required' })
  }
  assert.equal(b.provider.state.calls.length, 0)
  assert.equal(b.db.writes.length, 0)
  await b.app.close()
})

test('consent: a refusal costs no attempt', async () => {
  const b = await build()
  for (let i = 0; i < 30; i++) await b.app.inject({ method: 'PUT', url: '/api/llm-keys/anthropic', payload: { apiKey: KEY }, headers: as('u1') })
  assert.equal((await put(b, 'anthropic', { apiKey: KEY })).statusCode, 200)
  await b.app.close()
})

test('consent: the time of consent is stored with the key and renewed when the key is replaced', async () => {
  const b = await build()
  await put(b, 'anthropic', { apiKey: KEY })
  assert.equal(rows(b)[0].data_consent_at, '2026-11-23T10:00:00.000Z')
  b.clock.now = T0 + 3_600_000
  await put(b, 'anthropic', { apiKey: KEY2 })
  assert.equal(rows(b).length, 1)
  assert.equal(rows(b)[0].data_consent_at, '2026-11-23T11:00:00.000Z')
  await b.app.close()
})

test('consent: testing and deleting need no new consent, and a test does not change the consent time', async () => {
  const seed = new FakeDb({ [LLM_KEYS_TABLE]: [storedRow('u1', 'anthropic', KEY)] })
  const b = await build({ db: seed })
  assert.equal((await test_(b, 'anthropic')).statusCode, 200)
  assert.equal(rows(b)[0].data_consent_at, '2026-11-01T00:00:00.000Z')
  assert.deepEqual((await del(b, 'anthropic')).json(), { deleted: true })
  await b.app.close()
})

// ---------------------------------------------------------------- model

test('model: stored, trimmed and returned by PUT, GET and test', async () => {
  const b = await build()
  const res = await put(b, 'openrouter', { apiKey: OPENAI_KEY, model: '  qwen/qwen3-32b:free ' })
  assert.equal(res.statusCode, 200)
  assert.equal(res.json().key.model, 'qwen/qwen3-32b:free')
  assert.equal(rows(b)[0].model, 'qwen/qwen3-32b:free')

  const list = await get(b)
  assert.equal(list.json().keys[0].model, 'qwen/qwen3-32b:free')

  const tested = await test_(b, 'openrouter')
  assert.equal(tested.statusCode, 200)
  assert.equal(tested.json().key.model, 'qwen/qwen3-32b:free')
  await b.app.close()
})

test('model: absent, null and blank mean none; a replacement without a model clears the old one', async () => {
  const b = await build()
  for (const body of [{ apiKey: KEY }, { apiKey: KEY, model: null }, { apiKey: KEY, model: '' }, { apiKey: KEY, model: '   ' }]) {
    const res = await put(b, 'anthropic', body)
    assert.equal(res.statusCode, 200, JSON.stringify(body))
    assert.equal(res.json().key.model, null)
    assert.equal(rows(b)[0].model, null)
  }
  await put(b, 'anthropic', { apiKey: KEY, model: 'claude-sonnet-4-5' })
  assert.equal(rows(b)[0].model, 'claude-sonnet-4-5')
  await put(b, 'anthropic', { apiKey: KEY2 })
  assert.equal(rows(b)[0].model, null)
  await b.app.close()
})

test('model: a bad name is 400 model_format and the key is not sent to the provider', async () => {
  const b = await build()
  const bad: unknown[] = ['gpt 4', 'a'.repeat(101), 'model;rm', 'modèle', 'a\nb', '<script>', 123, true, ['gpt-4o'], { id: 'x' }]
  for (const model of bad) {
    const res = await put(b, 'openai', { apiKey: OPENAI_KEY, model })
    assert.equal(res.statusCode, 400, JSON.stringify(model))
    assert.deepEqual(res.json(), { code: 'model_format' })
  }
  assert.equal(b.provider.state.calls.length, 0)
  assert.equal(b.db.writes.length, 0)
  // Limits: 100 characters pass.
  assert.equal((await put(b, 'openai', { apiKey: OPENAI_KEY, model: 'a'.repeat(100) })).statusCode, 200)
  await b.app.close()
})

// ---------------------------------------------------------------- model_required

test('model_required: openai and crowllm without a model are 400, nothing is stored, sent or counted', async () => {
  const b = await build()
  const noModel: object[] = [
    { apiKey: OPENAI_KEY },
    { apiKey: OPENAI_KEY, model: null },
    { apiKey: OPENAI_KEY, model: '' },
    { apiKey: OPENAI_KEY, model: '   ' },
  ]
  for (const provider of NEEDS_MODEL) {
    for (const body of noModel) {
      const res = await put(b, provider, body)
      assert.equal(res.statusCode, 400, `${provider} ${JSON.stringify(body)}`)
      assert.deepEqual(res.json(), { code: 'model_required' })
    }
  }
  assert.equal(b.provider.state.calls.length, 0, 'the key was not sent to the provider')
  assert.equal(b.db.writes.length, 0)
  assert.equal(rows(b).length, 0)
  assert.equal(b.logs().includes(OPENAI_KEY), false)

  // No attempt was used: far more refusals than the limit of 10, and the user can still save.
  for (let i = 0; i < 30; i++) await put(b, 'openai', { apiKey: OPENAI_KEY })
  assert.equal((await put(b, 'openai', { apiKey: OPENAI_KEY, model: 'gpt-4o' })).statusCode, 200)
  await b.app.close()
})

test('model_required: an injected limiter with one attempt is still untouched by refusals', async () => {
  const limiter = createAttemptLimiter({ max: 1, now: () => T0 })
  const b = await build({ limiter })
  assert.equal((await put(b, 'crowllm', { apiKey: OPENAI_KEY })).statusCode, 400)
  assert.equal((await put(b, 'openai', { apiKey: OPENAI_KEY })).statusCode, 400)
  assert.equal((await put(b, 'crowllm', { apiKey: OPENAI_KEY, model: 'some-model' })).statusCode, 200)
  assert.equal((await put(b, 'crowllm', { apiKey: OPENAI_KEY, model: 'some-model' })).statusCode, 429)
  await b.app.close()
})

test('model_required: with a model openai and crowllm are saved and the model is returned', async () => {
  const b = await build()
  const o = await put(b, 'openai', { apiKey: OPENAI_KEY, model: 'gpt-4o' })
  assert.equal(o.statusCode, 200)
  assert.equal(o.json().key.model, 'gpt-4o')
  const c = await put(b, 'crowllm', { apiKey: OPENAI_KEY, model: ' some-model ' })
  assert.equal(c.statusCode, 200)
  assert.equal(c.json().key.model, 'some-model')
  assert.deepEqual(rows(b).map((r) => [r.provider, r.model]), [['openai', 'gpt-4o'], ['crowllm', 'some-model']])
  await b.app.close()
})

test('model_required: replacing a key needs the model again, and a refusal leaves the stored row untouched', async () => {
  const seed = new FakeDb({ [LLM_KEYS_TABLE]: [storedRow('u1', 'openai', OPENAI_KEY, { model: 'gpt-4o' })] })
  const before = JSON.stringify(seed.rows(LLM_KEYS_TABLE))
  const b = await build({ db: seed })
  const res = await put(b, 'openai', { apiKey: OPENAI_KEY + 'x' })
  assert.equal(res.statusCode, 400)
  assert.deepEqual(res.json(), { code: 'model_required' })
  assert.equal(JSON.stringify(rows(b)), before)
  assert.equal(b.provider.state.calls.length, 0)
  await b.app.close()
})

test('model_required: a malformed model is model_format first, and the other providers need no model', async () => {
  const b = await build()
  const bad = await put(b, 'openai', { apiKey: OPENAI_KEY, model: 'gpt 4o' })
  assert.deepEqual(bad.json(), { code: 'model_format' })
  for (const provider of VERIFIED_IDS.filter((id) => !NEEDS_MODEL.includes(id))) {
    const res = await put(b, provider, { apiKey: provider === 'anthropic' ? KEY : OPENAI_KEY })
    assert.equal(res.statusCode, 200, provider)
    assert.equal(res.json().key.model, null, provider)
  }
  await b.app.close()
})

test('model_required: it does not apply to test, GET or DELETE of a stored key', async () => {
  const seed = new FakeDb({ [LLM_KEYS_TABLE]: [storedRow('u1', 'openai', OPENAI_KEY), storedRow('u1', 'crowllm', OPENAI_KEY)] })
  const b = await build({ db: seed })
  assert.equal((await test_(b, 'openai')).statusCode, 200)
  assert.equal((await test_(b, 'crowllm')).statusCode, 200)
  assert.equal((await get(b)).json().keys.length, 2)
  assert.deepEqual((await del(b, 'crowllm')).json(), { deleted: true })
  await b.app.close()
})

// ---------------------------------------------------------------- newly verified providers

test('third-party providers: consent, format and wrong_provider apply as for the others', async () => {
  const b = await build()
  for (const provider of ['deepseek', 'moonshot', 'mimo', 'numes', 'crowllm']) {
    const noConsent = await b.app.inject({ method: 'PUT', url: `/api/llm-keys/${provider}`, payload: { apiKey: OPENAI_KEY, model: 'm1' }, headers: as('u1') })
    assert.deepEqual(noConsent.json(), { code: 'consent_required' }, provider)
    assert.deepEqual((await put(b, provider, { apiKey: 'short', model: 'm1' })).json(), { code: 'key_format' }, provider)
    assert.deepEqual((await put(b, provider, { apiKey: KEY, model: 'm1' })).json(), { code: 'wrong_provider' }, provider)
  }
  assert.equal(b.provider.state.calls.length, 0)
  assert.equal(b.db.writes.length, 0)
  await b.app.close()
})

test('third-party providers: a refused key (401) is never stored, an unavailable provider is 503', async () => {
  for (const provider of ['deepseek', 'moonshot', 'mimo', 'numes', 'crowllm']) {
    const body = { apiKey: OPENAI_KEY, model: 'm1' }
    const refused = await build({ provider: makeProvider(401) })
    const r = await put(refused, provider, body)
    assert.deepEqual(r.json(), { code: 'key_invalid' }, provider)
    assert.equal(rows(refused).length, 0)
    await refused.app.close()

    const down = await build({ provider: makeProvider(503) })
    const d = await put(down, provider, body)
    assert.equal(d.statusCode, 503, provider)
    assert.deepEqual(d.json(), { code: 'validation_unavailable' })
    assert.equal(rows(down).length, 0)
    await down.app.close()
  }
})

// ---------------------------------------------------------------- redirects

test('validation: redirects are not followed, a 3xx answer is 503 validation_unavailable and nothing is stored', async () => {
  for (const status of [301, 302, 307, 308]) {
    const b = await build({ provider: makeProvider(status) })
    const res = await put(b, 'openai', { apiKey: OPENAI_KEY, model: 'gpt-4o' })
    assert.equal(res.statusCode, 503, String(status))
    assert.deepEqual(res.json(), { code: 'validation_unavailable' })
    assert.equal(rows(b).length, 0)
    assert.equal(b.provider.state.calls.length, 1)
    assert.equal(b.provider.state.calls[0].redirect, 'manual')
    await b.app.close()
  }
})

// ---------------------------------------------------------------- GET

test('GET: lists the user own keys with the contract fields, never key_encrypted or the key', async () => {
  const seed = new FakeDb({
    [LLM_KEYS_TABLE]: [
      storedRow('u1', 'openai', OPENAI_KEY, { updated_at: '2026-11-10T00:00:00.000Z', model: 'gpt-4o' }),
      storedRow('u1', 'anthropic', KEY, { status: 'invalid', last_validated_at: null }),
      storedRow('u2', 'gemini', OPENAI_KEY),
    ],
  })
  const b = await build({ db: seed })
  const res = await get(b)
  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.json(), {
    enabled: true,
    providers: ALL_PROVIDERS,
    keys: [
      { provider: 'anthropic', last4: KEY.slice(-4), status: 'invalid', lastValidatedAt: null, updatedAt: '2026-11-01T00:00:00.000Z', model: null },
      { provider: 'openai', last4: OPENAI_KEY.slice(-4), status: 'valid', lastValidatedAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-10T00:00:00.000Z', model: 'gpt-4o' },
    ],
  })
  const text = res.body
  assert.equal(text.includes('key_encrypted'), false)
  assert.equal(text.includes(KEY), false)
  assert.equal(text.includes(OPENAI_KEY), false)
  for (const r of seed.rows(LLM_KEYS_TABLE)) assert.equal(text.includes(r.key_encrypted), false)
  assert.equal(text.includes('u2'), false)
  assert.equal(text.includes('user_id'), false)

  const selected = b.selects.filter((s) => s.table === LLM_KEYS_TABLE)
  assert.ok(selected.length > 0)
  for (const s of selected) assert.equal(String(s.cols).includes('key_encrypted'), false, `select(${s.cols})`)
  await b.app.close()
})

test('GET: empty list when the user has no keys', async () => {
  const b = await build()
  const res = await get(b)
  assert.deepEqual(res.json(), { enabled: true, providers: ALL_PROVIDERS, keys: [] })
  await b.app.close()
})

test('PUT and DELETE never select key_encrypted', async () => {
  const b = await build()
  await put(b, 'anthropic', { apiKey: KEY })
  await put(b, 'anthropic', { apiKey: KEY2 })
  await get(b)
  await del(b, 'anthropic')
  for (const s of b.selects) assert.equal(String(s.cols).includes('key_encrypted'), false, `select(${s.cols})`)
  await b.app.close()
})

// ---------------------------------------------------------------- POST /test

test('test: 404 not_found when the user has no key for that provider or the provider is unknown', async () => {
  const b = await build()
  for (const p of ['anthropic', 'groq', '__proto__']) {
    const res = await test_(b, p)
    assert.equal(res.statusCode, 404, p)
    assert.deepEqual(res.json(), { code: 'not_found' })
  }
  assert.equal(b.provider.state.calls.length, 0)
  await b.app.close()
})

test('test: a working key stays valid, the stored key is checked, and the reply is key info only', async () => {
  const seed = new FakeDb({
    [LLM_KEYS_TABLE]: [storedRow('u1', 'anthropic', KEY, { status: 'invalid', last_error: 'key_invalid', last_validated_at: null })],
  })
  const b = await build({ db: seed })
  const res = await test_(b, 'anthropic')
  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.json(), {
    result: 'valid',
    key: { provider: 'anthropic', last4: KEY.slice(-4), status: 'valid', lastValidatedAt: '2026-11-23T10:00:00.000Z', model: null },
  })
  assert.equal(b.provider.state.calls.length, 1)
  assert.equal(b.provider.state.calls[0].headers['x-api-key'], KEY, 'the decrypted stored key was used')
  assert.equal(rows(b)[0].status, 'valid')
  assert.equal(rows(b)[0].last_error, null)
  assert.equal(rows(b)[0].last_validated_at, '2026-11-23T10:00:00.000Z')
  assert.equal(rows(b)[0].updated_at, '2026-11-23T10:00:00.000Z')
  assert.equal(res.body.includes('key_encrypted'), false)
  assert.equal(res.body.includes(KEY), false)
  assert.equal(res.body.includes(rows(b)[0].key_encrypted), false)
  await b.app.close()
})

test('test: a key the provider now refuses is marked invalid with a short error code', async () => {
  for (const status of [401, 403]) {
    const seed = new FakeDb({ [LLM_KEYS_TABLE]: [storedRow('u1', 'openai', OPENAI_KEY)] })
    const b = await build({ db: seed, provider: makeProvider(status) })
    const res = await test_(b, 'openai')
    assert.equal(res.statusCode, 200, String(status))
    assert.equal(res.json().result, 'invalid')
    assert.equal(res.json().key.status, 'invalid')
    assert.equal(res.json().key.lastValidatedAt, '2026-11-23T10:00:00.000Z')
    assert.equal(rows(b)[0].status, 'invalid')
    assert.equal(rows(b)[0].last_error, 'key_invalid')
    assert.ok(rows(b)[0].last_error.length <= 40)
    assert.equal(rows(b)[0].last_validated_at, '2026-11-23T10:00:00.000Z')
    // The key itself is kept: the user can fix the problem at the provider and test again.
    assert.equal(decryptByokKey(rows(b)[0].key_encrypted, { userId: 'u1', provider: 'openai' }), OPENAI_KEY)
    await b.app.close()
  }
})

test('test: provider trouble answers unavailable and changes nothing in the row', async () => {
  for (const status of [429, 500, new Error('network down')] as Array<number | Error>) {
    const seed = new FakeDb({ [LLM_KEYS_TABLE]: [storedRow('u1', 'anthropic', KEY)] })
    const before = JSON.stringify(seed.rows(LLM_KEYS_TABLE))
    const b = await build({ db: seed, provider: makeProvider(status) })
    const res = await test_(b, 'anthropic')
    assert.equal(res.statusCode, 200, String(status))
    assert.equal(res.json().result, 'unavailable')
    assert.equal(res.json().key.status, 'valid', 'the stored status is reported as it was')
    assert.equal(res.json().key.lastValidatedAt, '2026-11-01T00:00:00.000Z')
    assert.equal(b.db.writes.length, 0)
    assert.equal(JSON.stringify(rows(b)), before)
    await b.app.close()
  }
})

test('test: a stored key that cannot be decrypted is 500 encryption_unavailable and is not sent anywhere', async () => {
  const row = storedRow('u1', 'anthropic', KEY)
  row.key_encrypted = encryptByokKey(KEY, { userId: 'someone-else', provider: 'anthropic' }) // wrong AAD
  const b = await build({ db: new FakeDb({ [LLM_KEYS_TABLE]: [row] }) })
  const res = await test_(b, 'anthropic')
  assert.equal(res.statusCode, 500)
  assert.deepEqual(res.json(), { code: 'encryption_unavailable' })
  assert.equal(b.provider.state.calls.length, 0)
  assert.equal(b.db.writes.length, 0)
  await b.app.close()
})

test('test: it selects key_encrypted (it must decrypt) and still never returns it', async () => {
  const b = await build({ db: new FakeDb({ [LLM_KEYS_TABLE]: [storedRow('u1', 'anthropic', KEY)] }) })
  const res = await test_(b, 'anthropic')
  assert.equal(res.statusCode, 200)
  assert.equal(b.selects.filter((s) => String(s.cols).includes('key_encrypted')).length, 1)
  assert.equal(res.body.includes('key_encrypted'), false)
  await b.app.close()
})

// ---------------------------------------------------------------- DELETE

test('DELETE: removes the row and answers deleted true; a second call answers deleted false', async () => {
  const seed = new FakeDb({ [LLM_KEYS_TABLE]: [storedRow('u1', 'anthropic', KEY), storedRow('u1', 'openai', OPENAI_KEY)] })
  const b = await build({ db: seed })
  const first = await del(b, 'anthropic')
  assert.equal(first.statusCode, 200)
  assert.deepEqual(first.json(), { deleted: true })
  assert.deepEqual(rows(b).map((r) => r.provider), ['openai'])
  const second = await del(b, 'anthropic')
  assert.deepEqual(second.json(), { deleted: false })
  assert.deepEqual((await del(b, 'groq')).json(), { deleted: false })
  assert.deepEqual(rows(b).map((r) => r.provider), ['openai'])
  await b.app.close()
})

// ---------------------------------------------------------------- user isolation

test('isolation: user B cannot list, test, replace or delete user A key', async () => {
  const rowA = storedRow('uA', 'anthropic', KEY)
  const seed = new FakeDb({ [LLM_KEYS_TABLE]: [rowA] })
  const b = await build({ db: seed })

  const list = await get(b, 'uB')
  assert.deepEqual(list.json().keys, [])
  assert.equal(list.body.includes(KEY.slice(-4)), false)

  const tested = await test_(b, 'anthropic', 'uB')
  assert.equal(tested.statusCode, 404)
  assert.equal(b.provider.state.calls.length, 0, 'B cannot make the server use A key')

  const deleted = await del(b, 'anthropic', 'uB')
  assert.deepEqual(deleted.json(), { deleted: false })
  assert.equal(rows(b).length, 1)
  assert.equal(rows(b)[0].user_id, 'uA')
  assert.equal(rows(b)[0].key_encrypted, rowA.key_encrypted)

  // B stores their own key for the same provider: a separate row, A row untouched.
  const put2 = await put(b, 'anthropic', { apiKey: KEY2 }, 'uB')
  assert.equal(put2.statusCode, 200)
  assert.equal(rows(b).length, 2)
  const a = rows(b).find((r) => r.user_id === 'uA')!
  assert.equal(a.key_encrypted, rowA.key_encrypted)
  assert.equal(a.key_last4, KEY.slice(-4))
  assert.equal(decryptByokKey(rows(b).find((r) => r.user_id === 'uB')!.key_encrypted, { userId: 'uB', provider: 'anthropic' }), KEY2)

  // A still sees only their own, and can delete it without touching B.
  assert.equal((await get(b, 'uA')).json().keys.length, 1)
  assert.deepEqual((await del(b, 'anthropic', 'uA')).json(), { deleted: true })
  assert.deepEqual(rows(b).map((r) => r.user_id), ['uB'])
  await b.app.close()
})

// ---------------------------------------------------------------- attempt limit

test('limit: the 11th PUT or test within an hour is 429 with Retry-After', async () => {
  const b = await build({ provider: makeProvider(401) }) // every PUT reaches the provider and fails: still counts
  for (let i = 0; i < 10; i++) {
    const res = await put(b, 'anthropic', { apiKey: KEY })
    assert.equal(res.statusCode, 400, `attempt ${i + 1}`)
  }
  const blocked = await put(b, 'anthropic', { apiKey: KEY })
  assert.equal(blocked.statusCode, 429)
  assert.deepEqual(blocked.json(), { code: 'too_many_attempts' })
  assert.equal(blocked.headers['retry-after'], '3600')
  assert.equal(b.provider.state.calls.length, 10, 'the blocked attempt never reached the provider')

  b.clock.now = T0 + 1_800_000
  const still = await put(b, 'anthropic', { apiKey: KEY })
  assert.equal(still.statusCode, 429)
  assert.equal(still.headers['retry-after'], '1800')

  // Another user is not affected.
  assert.equal((await put(b, 'anthropic', { apiKey: KEY }, 'u2')).statusCode, 400)

  // After the hour the user can try again.
  b.clock.now = T0 + 3_600_001
  assert.equal((await put(b, 'anthropic', { apiKey: KEY })).statusCode, 400)
  await b.app.close()
})

test('limit: test calls share the budget with PUT', async () => {
  const seed = new FakeDb({ [LLM_KEYS_TABLE]: [storedRow('u1', 'anthropic', KEY)] })
  const b = await build({ db: seed })
  for (let i = 0; i < 5; i++) assert.equal((await test_(b, 'anthropic')).statusCode, 200)
  for (let i = 0; i < 5; i++) assert.equal((await put(b, 'anthropic', { apiKey: KEY })).statusCode, 200)
  const blockedTest = await test_(b, 'anthropic')
  assert.equal(blockedTest.statusCode, 429)
  assert.deepEqual(blockedTest.json(), { code: 'too_many_attempts' })
  assert.ok(Number(blockedTest.headers['retry-after']) > 0)
  assert.equal((await put(b, 'anthropic', { apiKey: KEY })).statusCode, 429)
  await b.app.close()
})

test('limit: refused input costs no attempt (format errors, 404, disabled flag, GET, DELETE)', async () => {
  const b = await build()
  for (let i = 0; i < 30; i++) {
    await put(b, 'anthropic', { apiKey: 'short' })
    await put(b, 'groq', { apiKey: KEY })
    await test_(b, 'anthropic') // 404, no key stored
    await get(b)
    await del(b, 'anthropic')
  }
  const res = await put(b, 'anthropic', { apiKey: KEY })
  assert.equal(res.statusCode, 200)
  await b.app.close()
})

test('limit: an injected limiter is used', async () => {
  const limiter = createAttemptLimiter({ max: 1, now: () => T0 })
  const b = await build({ limiter })
  assert.equal((await put(b, 'anthropic', { apiKey: KEY })).statusCode, 200)
  assert.equal((await put(b, 'openai', { apiKey: OPENAI_KEY, model: 'gpt-4o' })).statusCode, 429)
  await b.app.close()
})

// ---------------------------------------------------------------- empty bodies and errors

test('POST test and DELETE accept an empty body under content-type application/json', async () => {
  const seed = new FakeDb({ [LLM_KEYS_TABLE]: [storedRow('u1', 'anthropic', KEY)] })
  const b = await build({ db: seed })
  const headers = { ...as('u1'), 'content-type': 'application/json' }
  const t = await b.app.inject({ method: 'POST', url: '/api/llm-keys/anthropic/test', headers, payload: '' })
  assert.equal(t.statusCode, 200)
  const d = await b.app.inject({ method: 'DELETE', url: '/api/llm-keys/anthropic', headers, payload: '' })
  assert.equal(d.statusCode, 200)
  assert.deepEqual(d.json(), { deleted: true })
  await b.app.close()
})

test('database errors are 500 internal_error, and their message (which may quote row data) is not logged or returned', async () => {
  const leak = `Failing row contains (${KEY}, secret-ciphertext)`
  for (const op of ['select', 'update', 'delete'] as const) {
    const seed = new FakeDb({ [LLM_KEYS_TABLE]: [storedRow('u1', 'anthropic', KEY)] })
    seed.failOn(LLM_KEYS_TABLE, op, leak, '23503')
    const b = await build({ db: seed })
    const res =
      op === 'select' ? await get(b) : op === 'update' ? await put(b, 'anthropic', { apiKey: KEY2 }) : await del(b, 'anthropic')
    assert.equal(res.statusCode, 500, op)
    assert.deepEqual(res.json(), { code: 'internal_error' })
    assert.equal(res.body.includes('secret-ciphertext'), false)
    assert.equal(res.body.includes(KEY), false)
    const logs = b.logs()
    assert.ok(logs.length > 0)
    assert.equal(logs.includes('secret-ciphertext'), false, op)
    assert.equal(logs.includes(KEY), false, op)
    assert.match(logs, /23503/)
    await b.app.close()
  }

  const insertFails = new FakeDb()
  insertFails.failOn(LLM_KEYS_TABLE, 'insert', leak, '23503')
  const b = await build({ db: insertFails })
  const res = await put(b, 'anthropic', { apiKey: KEY })
  assert.equal(res.statusCode, 500)
  assert.deepEqual(res.json(), { code: 'internal_error' })
  assert.equal(b.logs().includes('secret-ciphertext'), false)
  await b.app.close()
})

// ---------------------------------------------------------------- logs

test('logs: across every route and outcome the key, the body, the ciphertext and provider text never appear', async () => {
  const seed = new FakeDb({ [LLM_KEYS_TABLE]: [storedRow('u1', 'openai', OPENAI_KEY)] })
  const provider = makeProvider(200)
  const b = await build({ db: seed, provider })
  const seen: string[] = []
  const keep = (r: { body: string }) => void seen.push(r.body)

  keep(await put(b, 'anthropic', { apiKey: KEY })) // success
  provider.state.status = 401
  keep(await put(b, 'anthropic', { apiKey: KEY2 })) // invalid
  provider.state.status = 500
  keep(await put(b, 'anthropic', { apiKey: KEY2 })) // unavailable
  provider.state.status = new TypeError(`fetch failed for ${KEY}`) // an error that would quote the key if it were logged
  keep(await put(b, 'anthropic', { apiKey: KEY2 }))
  provider.state.status = 200
  keep(await put(b, 'anthropic', { apiKey: 'x' })) // format
  keep(await put(b, 'openai', { apiKey: KEY })) // wrong provider
  keep(await test_(b, 'anthropic'))
  keep(await test_(b, 'openai'))
  provider.state.status = 401
  keep(await test_(b, 'openai'))
  keep(await get(b))
  keep(
    await b.app.inject({
      method: 'PUT',
      url: '/api/llm-keys/anthropic',
      headers: { ...as('u1'), 'content-type': 'application/json' },
      payload: `{"apiKey":"${KEY2}`, // broken JSON that quotes the key
    }),
  )
  keep(await del(b, 'anthropic'))

  const logs = b.logs()
  assert.ok(logs.length > 0, 'the logger was active')
  const ciphertexts = seed.rows(LLM_KEYS_TABLE).map((r) => r.key_encrypted)
  for (const secret of [KEY, KEY2, OPENAI_KEY, SECRET, PROVIDER_TEXT, 'apiKey', ...ciphertexts]) {
    assert.equal(logs.includes(secret), false, `log contains ${secret.slice(0, 14)}...`)
  }
  for (const body of seen) {
    for (const secret of [KEY, KEY2, OPENAI_KEY, SECRET, PROVIDER_TEXT, 'key_encrypted']) {
      assert.equal(body.includes(secret), false, `a response contains ${secret.slice(0, 14)}...`)
    }
  }
  await b.app.close()
})
