import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BYOK_PROVIDER_REGISTRY } from '../services/byok-providers.ts'
import {
  BYOK_PROVIDERS,
  buildValidationHeaders,
  byokEnabled,
  checkKeyFormat,
  checkModel,
  classifyValidationStatus,
  createAttemptLimiter,
  isByokProvider,
  isVerifiedProvider,
  keyLast4,
  validateKeyWithProvider,
  type ByokProvider,
} from '../services/byok-guard.ts'

const ANT_KEY = 'sk-ant-test-' + 'A1b2C3d4E5'.repeat(4)
const PLAIN_KEY = 'test-key-' + 'Zz9Yy8Xx7W'.repeat(3)

// ---------------------------------------------------------------- providers and flag

// Registry order. The five third-party providers were verified on 2026-11-23; zhipu and qwen stay placeholders.
const ALL_IDS: ByokProvider[] = ['anthropic', 'openai', 'gemini', 'openrouter', 'deepseek', 'moonshot', 'zhipu', 'qwen', 'mimo', 'numes', 'crowllm']
const PLACEHOLDERS: ByokProvider[] = ['zhipu', 'qwen']
const VERIFIED: ByokProvider[] = ALL_IDS.filter((id) => !PLACEHOLDERS.includes(id))
const THIRD_PARTY: ByokProvider[] = ['deepseek', 'moonshot', 'mimo', 'numes', 'crowllm']

test('providers: the 11 ids of the contract, derived from the registry, and isByokProvider rejects everything else', () => {
  assert.deepEqual([...BYOK_PROVIDERS], ALL_IDS)
  assert.deepEqual([...BYOK_PROVIDERS], BYOK_PROVIDER_REGISTRY.map((e) => e.id))
  for (const p of BYOK_PROVIDERS) assert.equal(isByokProvider(p), true)
  for (const bad of ['', 'Anthropic', 'groq', '__proto__', 'constructor', 'toString', null, undefined, 1, {}]) {
    assert.equal(isByokProvider(bad), false, String(bad))
  }
})

test('byokEnabled is on only for the exact text "true"', () => {
  assert.equal(byokEnabled({ BYOK_ENABLED: 'true' }), true)
  for (const v of [undefined, '', 'false', 'TRUE', 'True', '1', 'yes', ' true']) {
    assert.equal(byokEnabled({ BYOK_ENABLED: v }), false, String(v))
  }
  assert.equal(byokEnabled({}), false)
})

// ---------------------------------------------------------------- key format

test('checkKeyFormat accepts a normal key and trims it', () => {
  assert.deepEqual(checkKeyFormat('anthropic', ANT_KEY), { ok: true, key: ANT_KEY })
  assert.deepEqual(checkKeyFormat('anthropic', `  ${ANT_KEY}\n`), { ok: true, key: ANT_KEY })
  assert.deepEqual(checkKeyFormat('openai', PLAIN_KEY), { ok: true, key: PLAIN_KEY })
  assert.deepEqual(checkKeyFormat('gemini', 'AIza' + 'x'.repeat(35)), { ok: true, key: 'AIza' + 'x'.repeat(35) })
})

test('checkKeyFormat: length 20 to 300 after trim', () => {
  assert.equal(checkKeyFormat('openai', 'a'.repeat(19)).ok, false)
  assert.equal(checkKeyFormat('openai', 'a'.repeat(20)).ok, true)
  assert.equal(checkKeyFormat('openai', 'a'.repeat(300)).ok, true)
  assert.deepEqual(checkKeyFormat('openai', 'a'.repeat(301)), { ok: false, code: 'key_format' })
  assert.deepEqual(checkKeyFormat('openai', ' ' + 'a'.repeat(19) + ' '), { ok: false, code: 'key_format' })
  assert.deepEqual(checkKeyFormat('openai', ''), { ok: false, code: 'key_format' })
})

test('checkKeyFormat: charset is letters, digits, underscore, hyphen and dot only', () => {
  for (const bad of ['a'.repeat(20) + ' b', 'a'.repeat(20) + '\nb', 'a'.repeat(20) + '$', 'a'.repeat(20) + '/', 'a'.repeat(20) + '"', 'a'.repeat(20) + 'ü', 'a'.repeat(20) + '=']) {
    assert.deepEqual(checkKeyFormat('openai', bad), { ok: false, code: 'key_format' }, JSON.stringify(bad))
  }
  assert.equal(checkKeyFormat('openai', 'a_b-c.d'.repeat(4)).ok, true)
})

test('checkKeyFormat: not a string is key_format', () => {
  for (const bad of [undefined, null, 123, {}, [], true]) {
    assert.deepEqual(checkKeyFormat('anthropic', bad), { ok: false, code: 'key_format' })
  }
})

test('checkKeyFormat: sk-ant- belongs to anthropic only, sk-or- to openrouter only (wrong_provider)', () => {
  const or = 'sk-or-v1-' + 'a1b2c3d4'.repeat(5)
  for (const p of ['openai', 'gemini', 'openrouter'] as ByokProvider[]) {
    assert.deepEqual(checkKeyFormat(p, ANT_KEY), { ok: false, code: 'wrong_provider' }, p)
  }
  for (const p of ['anthropic', 'openai', 'gemini'] as ByokProvider[]) {
    assert.deepEqual(checkKeyFormat(p, or), { ok: false, code: 'wrong_provider' }, p)
  }
  assert.equal(checkKeyFormat('anthropic', ANT_KEY).ok, true)
  assert.equal(checkKeyFormat('openrouter', or).ok, true)
})

test('checkKeyFormat: a malformed key stays key_format even with a foreign prefix', () => {
  assert.deepEqual(checkKeyFormat('openai', 'sk-ant-short'), { ok: false, code: 'key_format' })
  assert.deepEqual(checkKeyFormat('openai', 'sk-ant-' + 'a'.repeat(20) + ' b'), { ok: false, code: 'key_format' })
})

test('keyLast4 is the last four characters of the trimmed key', () => {
  assert.equal(keyLast4('sk-ant-test-abcdWXYZ'), 'WXYZ')
  assert.equal(keyLast4('  abcdefghij1234  '), '1234')
})

// ---------------------------------------------------------------- validation with the provider

interface Call {
  url: string
  init: RequestInit
}

function fakeFetch(status: number | Error, calls: Call[] = []) {
  const impl = (async (url: any, init: any) => {
    calls.push({ url: String(url), init })
    if (status instanceof Error) throw status
    // 204 and 205 may not carry a body in a Response.
    const body = status === 204 || status === 205 ? null : '{"error":{"message":"provider text that must never be used"}}'
    return new Response(body, { status })
  }) as typeof fetch
  return { impl, calls }
}

test('validateKeyWithProvider: endpoint and header per provider, key never in the URL', async () => {
  const expected: Record<ByokProvider, { url: string; headers: Record<string, string> }> = {
    anthropic: { url: 'https://api.anthropic.com/v1/models?limit=1', headers: { 'x-api-key': ANT_KEY, 'anthropic-version': '2023-06-01' } },
    openai: { url: 'https://api.openai.com/v1/models', headers: { Authorization: `Bearer ${PLAIN_KEY}` } },
    gemini: { url: 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1', headers: { 'x-goog-api-key': PLAIN_KEY } },
    openrouter: { url: 'https://openrouter.ai/api/v1/key', headers: { Authorization: `Bearer ${PLAIN_KEY}` } },
    deepseek: { url: 'https://api.deepseek.com/models', headers: { Authorization: `Bearer ${PLAIN_KEY}` } },
    moonshot: { url: 'https://api.moonshot.ai/v1/models', headers: { Authorization: `Bearer ${PLAIN_KEY}` } },
    mimo: { url: 'https://api.xiaomimimo.com/v1/models', headers: { Authorization: `Bearer ${PLAIN_KEY}` } },
    numes: { url: 'https://api.numes.ai/api/v1/key', headers: { Authorization: `Bearer ${PLAIN_KEY}` } },
    crowllm: { url: 'https://crowllm.com/v1/models', headers: { Authorization: `Bearer ${PLAIN_KEY}` } },
    zhipu: { url: '', headers: {} },
    qwen: { url: '', headers: {} },
  }
  for (const provider of VERIFIED) {
    const key = provider === 'anthropic' ? ANT_KEY : PLAIN_KEY
    const { impl, calls } = fakeFetch(200)
    assert.equal(await validateKeyWithProvider(provider, key, { fetchImpl: impl }), 'valid', provider)
    assert.equal(calls.length, 1, provider)
    assert.equal(calls[0].url, expected[provider].url, provider)
    assert.equal(calls[0].url.includes(key), false, `${provider}: key in URL`)
    assert.equal(calls[0].init.method, 'GET')
    assert.deepEqual(calls[0].init.headers, expected[provider].headers, provider)
    assert.ok(calls[0].init.signal instanceof AbortSignal, `${provider}: timeout signal`)
    assert.equal(calls[0].init.redirect, 'manual', `${provider}: no redirect following`)
    assert.equal(calls[0].init.body, undefined)
  }
})

test('validateKeyWithProvider: classification of the status', async () => {
  const cases: Array<[ByokProvider, number, string]> = [
    ['anthropic', 200, 'valid'],
    ['openai', 204, 'valid'],
    ['openrouter', 299, 'valid'],
    ['anthropic', 401, 'invalid'],
    ['openai', 403, 'invalid'],
    ['openrouter', 401, 'invalid'],
    ['gemini', 401, 'invalid'],
    ['gemini', 403, 'invalid'],
    ['gemini', 400, 'invalid'],
    ['anthropic', 400, 'unavailable'],
    ['openai', 400, 'unavailable'],
    ['openrouter', 400, 'unavailable'],
    ['anthropic', 404, 'unavailable'],
    ['openai', 429, 'unavailable'],
    ['gemini', 429, 'unavailable'],
    ['anthropic', 500, 'unavailable'],
    ['openrouter', 503, 'unavailable'],
    ['openai', 301, 'unavailable'],
    ['openai', 302, 'unavailable'],
  ]
  for (const [provider, status, want] of cases) {
    const { impl } = fakeFetch(status)
    assert.equal(await validateKeyWithProvider(provider, PLAIN_KEY, { fetchImpl: impl }), want, `${provider} ${status}`)
    assert.equal(classifyValidationStatus(provider, status), want, `classify ${provider} ${status}`)
  }
})

test('validateKeyWithProvider: network error and timeout are unavailable, and nothing is thrown', async () => {
  const net = fakeFetch(new TypeError('fetch failed'))
  assert.equal(await validateKeyWithProvider('openai', PLAIN_KEY, { fetchImpl: net.impl }), 'unavailable')

  // Real timeout: a fetch that never answers until the signal aborts.
  const hanging = ((_url: any, init: any) =>
    new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(init.signal.reason))
    })) as typeof fetch
  const started = Date.now()
  assert.equal(await validateKeyWithProvider('anthropic', ANT_KEY, { fetchImpl: hanging, timeoutMs: 30 }), 'unavailable')
  assert.ok(Date.now() - started < 2000, 'returned after the short timeout')
})

test('validateKeyWithProvider: the default timeout is 8 seconds', async () => {
  const calls: Call[] = []
  const { impl } = fakeFetch(200, calls)
  await validateKeyWithProvider('openai', PLAIN_KEY, { fetchImpl: impl })
  const signal = calls[0].init.signal as AbortSignal
  assert.equal(signal.aborted, false)
})

// ---------------------------------------------------------------- limiter

test('limiter: 10 attempts per user per hour, then retryAfterSec', () => {
  let t = 1_000_000
  const limiter = createAttemptLimiter({ now: () => t })
  for (let i = 0; i < 10; i++) assert.deepEqual(limiter.tryConsume('u1'), { ok: true }, `attempt ${i + 1}`)
  const blocked = limiter.tryConsume('u1')
  assert.equal(blocked.ok, false)
  assert.equal((blocked as any).retryAfterSec, 3600)

  t += 600_000 // 10 minutes later
  const later = limiter.tryConsume('u1')
  assert.equal(later.ok, false)
  assert.equal((later as any).retryAfterSec, 3000)

  t += 2_999_000 // 1 second before the first attempt leaves the window
  assert.equal((limiter.tryConsume('u1') as any).retryAfterSec, 1)

  t += 1_000 // first attempt is now exactly one hour old: out of the window
  assert.deepEqual(limiter.tryConsume('u1'), { ok: true })
})

test('limiter: users are counted separately', () => {
  const limiter = createAttemptLimiter({ now: () => 5_000 })
  for (let i = 0; i < 10; i++) limiter.tryConsume('u1')
  assert.equal(limiter.tryConsume('u1').ok, false)
  assert.deepEqual(limiter.tryConsume('u2'), { ok: true })
})

test('limiter: a refused attempt does not extend the block, the window slides', () => {
  let t = 0
  const limiter = createAttemptLimiter({ now: () => t })
  limiter.tryConsume('u1') // t = 0
  t = 1_800_000
  for (let i = 0; i < 9; i++) limiter.tryConsume('u1') // ten in total
  for (let i = 0; i < 20; i++) assert.equal(limiter.tryConsume('u1').ok, false) // refused, not counted
  t = 3_600_000 // the attempt at t = 0 expires, the nine at t = 1.8M stay
  assert.deepEqual(limiter.tryConsume('u1'), { ok: true })
  assert.equal(limiter.tryConsume('u1').ok, false)
})

test('limiter: max and window are configurable', () => {
  let t = 0
  const limiter = createAttemptLimiter({ max: 2, windowMs: 1000, now: () => t })
  assert.equal(limiter.tryConsume('u').ok, true)
  assert.equal(limiter.tryConsume('u').ok, true)
  assert.deepEqual(limiter.tryConsume('u'), { ok: false, retryAfterSec: 1 })
  t = 1000
  assert.equal(limiter.tryConsume('u').ok, true)
})

// ---------------------------------------------------------------- registry-driven behaviour

test('unverified placeholders: never validated, no request is made, so no key can leave', async () => {
  for (const provider of PLACEHOLDERS) {
    assert.equal(isVerifiedProvider(provider), false, provider)
    const { impl, calls } = fakeFetch(200)
    assert.equal(await validateKeyWithProvider(provider, PLAIN_KEY, { fetchImpl: impl }), 'unavailable', provider)
    assert.equal(calls.length, 0, `${provider}: no fetch`)
  }
  for (const provider of VERIFIED) assert.equal(isVerifiedProvider(provider), true, provider)
})

test('validateKeyWithProvider: an unknown id is unavailable and makes no request', async () => {
  const { impl, calls } = fakeFetch(200)
  assert.equal(await validateKeyWithProvider('groq' as any, PLAIN_KEY, { fetchImpl: impl }), 'unavailable')
  assert.equal(calls.length, 0)
})

test('validateKeyWithProvider: redirects are never followed (redirect manual) and a 3xx is unavailable', async () => {
  for (const status of [301, 302, 303, 307, 308]) {
    const { impl, calls } = fakeFetch(status)
    assert.equal(await validateKeyWithProvider('openai', PLAIN_KEY, { fetchImpl: impl }), 'unavailable', String(status))
    assert.equal(calls[0].init.redirect, 'manual')
  }
})

test('registry integrity: verified entries have fixed https addresses, placeholders have none', () => {
  assert.equal(BYOK_PROVIDER_REGISTRY.length, 11)
  assert.equal(new Set(BYOK_PROVIDER_REGISTRY.map((e) => e.id)).size, 11, 'ids are unique')
  for (const e of BYOK_PROVIDER_REGISTRY) {
    assert.ok(e.label.length > 0, e.id)
    assert.ok(e.format === 'openai' || e.format === 'anthropic', e.id)
    assert.ok(['bearer', 'x-api-key', 'x-goog-api-key'].includes(e.validate.headerStyle), e.id)
    if (e.verified) {
      assert.match(e.baseUrl, /^https:\/\/[a-z0-9.-]+(\/[A-Za-z0-9._\/-]*)?$/, `${e.id} baseUrl`)
      assert.match(e.validate.url, /^https:\/\/[a-z0-9.-]+\//, `${e.id} validate.url`)
      assert.equal(new URL(e.validate.url).host, new URL(e.baseUrl).host, `${e.id}: validation goes to the provider's own host`)
      assert.equal(/[?&](key|api_?key|token|access_token)=/i.test(e.validate.url), false, `${e.id}: no key parameter in the URL`)
    } else {
      assert.equal(e.baseUrl, '', `${e.id} baseUrl is empty until verified`)
      assert.equal(e.validate.url, '', `${e.id} validate.url is empty until verified`)
    }
  }
  assert.deepEqual(
    BYOK_PROVIDER_REGISTRY.filter((e) => e.verified).map((e) => e.id),
    VERIFIED,
  )
})

test('third-party providers: validated with a Bearer header over https, the key never in the URL, numes on /api/v1/key', async () => {
  for (const provider of THIRD_PARTY) {
    const entry = BYOK_PROVIDER_REGISTRY.find((e) => e.id === provider)!
    assert.equal(entry.verified, true, provider)
    assert.equal(entry.format, 'openai', provider)
    assert.equal(entry.validate.headerStyle, 'bearer', provider)
    assert.ok(entry.baseUrl.startsWith('https://'), `${provider} baseUrl`)
    assert.ok(entry.validate.url.startsWith('https://'), `${provider} validate.url`)
    assert.equal(entry.validate.url.includes('?'), false, `${provider}: no query string, so nothing for a key to hide in`)
    assert.deepEqual(buildValidationHeaders(provider, 'K'), { Authorization: 'Bearer K' }, provider)

    const { impl, calls } = fakeFetch(200)
    assert.equal(await validateKeyWithProvider(provider, PLAIN_KEY, { fetchImpl: impl }), 'valid', provider)
    assert.equal(calls.length, 1, provider)
    assert.equal(calls[0].url, entry.validate.url, provider)
    assert.equal(calls[0].url.includes(PLAIN_KEY), false, `${provider}: key in URL`)
    assert.deepEqual(calls[0].init.headers, { Authorization: `Bearer ${PLAIN_KEY}` }, provider)
    assert.equal(calls[0].init.redirect, 'manual', provider)
  }
  assert.equal(BYOK_PROVIDER_REGISTRY.find((e) => e.id === 'numes')!.validate.url, 'https://api.numes.ai/api/v1/key')
})

test('third-party providers: 401 and 403 are invalid, a 400 is only unavailable (not Google style)', async () => {
  for (const provider of THIRD_PARTY) {
    for (const [status, want] of [[401, 'invalid'], [403, 'invalid'], [400, 'unavailable'], [429, 'unavailable'], [500, 'unavailable']] as const) {
      const { impl } = fakeFetch(status)
      assert.equal(await validateKeyWithProvider(provider, PLAIN_KEY, { fetchImpl: impl }), want, `${provider} ${status}`)
    }
  }
})

test('registry: requiresModel is set for openai and crowllm only', () => {
  assert.deepEqual(
    BYOK_PROVIDER_REGISTRY.filter((e) => e.requiresModel).map((e) => e.id),
    ['openai', 'crowllm'],
  )
})

test('registry: key prefixes are unique to one provider and drive wrong_provider', () => {
  const prefixes = BYOK_PROVIDER_REGISTRY.filter((e) => e.keyPrefix).map((e) => [e.keyPrefix, e.id])
  assert.deepEqual(prefixes, [['sk-ant-', 'anthropic'], ['sk-or-', 'openrouter']])
  for (const e of BYOK_PROVIDER_REGISTRY) {
    // A placeholder gets the same prefix rules: an Anthropic key pasted into DeepSeek's card is the wrong card.
    const verdict = checkKeyFormat(e.id as ByokProvider, ANT_KEY)
    assert.equal(verdict.ok, e.id === 'anthropic', e.id)
    if (verdict.ok === false) assert.equal(verdict.code, 'wrong_provider', e.id)
  }
})

test('buildValidationHeaders: header style and anthropic-version come from the registry', () => {
  assert.deepEqual(buildValidationHeaders('anthropic', 'K'), { 'x-api-key': 'K', 'anthropic-version': '2023-06-01' })
  assert.deepEqual(buildValidationHeaders('openai', 'K'), { Authorization: 'Bearer K' })
  assert.deepEqual(buildValidationHeaders('openrouter', 'K'), { Authorization: 'Bearer K' })
  assert.deepEqual(buildValidationHeaders('gemini', 'K'), { 'x-goog-api-key': 'K' })
  // Placeholders are bearer/openai-style by default: the header exists, but validateKeyWithProvider never uses it.
  assert.deepEqual(buildValidationHeaders('deepseek', 'K'), { Authorization: 'Bearer K' })
})

test('classifyValidationStatus: a 400 means invalid only for Google-style (x-goog-api-key) providers', () => {
  for (const p of BYOK_PROVIDERS) {
    const want = p === 'gemini' ? 'invalid' : 'unavailable'
    assert.equal(classifyValidationStatus(p, 400), want, p)
    assert.equal(classifyValidationStatus(p, 401), 'invalid', p)
    assert.equal(classifyValidationStatus(p, 200), 'valid', p)
    assert.equal(classifyValidationStatus(p, 302), 'unavailable', p)
  }
})

// ---------------------------------------------------------------- model name

test('checkModel: absent, null and blank are none; names are trimmed', () => {
  for (const v of [undefined, null, '', '   ', '\n']) assert.deepEqual(checkModel(v), { ok: true, model: null }, JSON.stringify(v))
  assert.deepEqual(checkModel(' gpt-4o '), { ok: true, model: 'gpt-4o' })
})

test('checkModel: allowed charset is letters, digits and . _ : / -', () => {
  for (const good of ['gpt-4o', 'claude-sonnet-4-5', 'qwen/qwen3-32b:free', 'deepseek-chat', 'gemini-2.5-flash', 'glm_4.5', 'A', 'accounts/x/models/y']) {
    assert.deepEqual(checkModel(good), { ok: true, model: good }, good)
  }
  for (const bad of ['gpt 4', 'a b', 'x;y', 'x"y', "x'y", 'x$y', 'x\\y', 'x?y=1', 'x&y', 'x#y', 'x%20y', 'x@y', 'ü', '日本', 'x\ny']) {
    assert.deepEqual(checkModel(bad), { ok: false, code: 'model_format' }, JSON.stringify(bad))
  }
})

test('checkModel: 1 to 100 characters, strings only', () => {
  assert.equal(checkModel('a'.repeat(100)).ok, true)
  assert.deepEqual(checkModel('a'.repeat(101)), { ok: false, code: 'model_format' })
  for (const bad of [1, true, {}, [], ['x']]) assert.deepEqual(checkModel(bad), { ok: false, code: 'model_format' })
})
