import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import axios from 'axios'

/**
 * Rantai Numes/Gemini di depan OpenRouter dan Groq, dan Anthropic paling akhir, tanpa jaringan: axios.post diganti
 * naskah per model (dan per kunci Numes). Nilai kunci di sini palsu.
 */
process.env.OPENROUTER_API_KEY = 'or-test-not-real'
process.env.OPENROUTER_MODEL = 'm1'
process.env.OPENROUTER_FALLBACK_MODELS = 'm1,m2'
process.env.GROQ_FALLBACK_MODELS = 'g1'
process.env.GEMINI_API_KEY = 'gem-test-not-real'
process.env.ANTHROPIC_API_KEY = 'ant-test-not-real'
delete process.env.GROQ_API_KEY
delete process.env.FREE_MODELS
delete process.env.PRO_MODELS
for (const k of ['NUMES_API_KEY', 'NUMES_API_KEY_2', 'NUMES_API_KEY_3', 'NUMES_API_KEY_4', 'NUMES_API_KEY_5', 'NUMES_API_KEYS']) delete process.env[k]

const { DEFAULT_FREE_MODELS, DEFAULT_PRO_MODELS, parseModelList, premiumChain, premiumChainParts, resolvePremiumModel } = await import('../services/ai-providers.ts')
const { aiPipelineService } = await import('../services/ai-pipeline.service.ts')
const { tracingService } = await import('../services/tracing.service.ts')
const { resetNumesPools, NUMES_COOLDOWN_RATE_MS, NUMES_MODEL_COOLDOWN_MS } = await import('../services/numes-keys.ts')
;(tracingService as any).traceAIGeneration = async () => ({ traceId: 't', generationId: 'g' })

const LETTER = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'uat', 'letter-indonesian-greeting-user018.txt'), 'utf8')

const NK1 = 'nk-one-not-real'
const NK2 = 'nk-two-not-real'
const NK3 = 'nk-three-not-real'
const GLM = 'z-ai/glm-5.3-flash:free'
const DSK = 'deepseek/deepseek-v4.1-flash:free'

type Reply = string | number | Error | { status: number; headers?: Record<string, string>; data?: any }
type Script = Reply | ((authorization: string) => Reply)
type Call = { url: string; model: string; headers: any; timeout: any; temperature?: number; max_tokens?: number; auth: string }
let calls: Call[]
let script: Record<string, Script>

;(axios as any).get = async () => ({ status: 500, data: {} })
;(axios as any).post = async (url: string, body: any, cfg: any) => {
  const auth = String(cfg?.headers?.Authorization ?? '')
  calls.push({ url, model: body.model, headers: cfg?.headers, timeout: cfg?.timeout, temperature: body.temperature, max_tokens: body.max_tokens, auth })
  let reply: Reply | undefined = typeof script[body.model] === 'function' ? (script[body.model] as (a: string) => Reply)(auth) : (script[body.model] as Reply | undefined)
  // Batas waktu axios (ECONNABORTED): server menggantung sampai batas waktunya habis, jadi waktu tiruan maju sebanyak itu.
  if (reply instanceof Error && (reply as any).code === 'ECONNABORTED') skew += Number((reply as any).elapsedMs ?? cfg?.timeout ?? 0)
  if (reply instanceof Error) throw reply
  if (typeof reply === 'number') return { status: reply, data: { error: 'x' }, headers: {} }
  if (reply !== undefined && typeof reply === 'object') return { status: reply.status, data: reply.data ?? { error: 'x' }, headers: reply.headers ?? {} }
  return { status: 200, data: { choices: [{ message: { content: reply ?? '' } }] }, headers: {} }
}

const realNow = Date.now.bind(Date)
let skew = 0
Date.now = () => realNow() + skew

const captured: string[] = []
const realWarn = console.warn
const realLog = console.log
const realError = console.error
const capture = (...a: unknown[]) => void captured.push(a.map(String).join(' '))

beforeEach(() => {
  calls = []
  script = {}
  skew = 0
  captured.length = 0
  console.warn = capture
  console.log = capture
  console.error = capture
  delete process.env.FREE_MODELS
  delete process.env.PRO_MODELS
  delete process.env.GROQ_API_KEY
  for (const k of ['NUMES_API_KEY', 'NUMES_API_KEY_2', 'NUMES_API_KEY_3', 'NUMES_API_KEY_4', 'NUMES_API_KEY_5', 'NUMES_API_KEYS']) delete process.env[k]
  resetNumesPools()
  ;(aiPipelineService as any).tierClient = undefined
})

afterEach(() => {
  console.warn = realWarn
  console.log = realLog
  console.error = realError
})

const setNumesKeys = (...keys: string[]) => {
  const names = ['NUMES_API_KEY', 'NUMES_API_KEY_2', 'NUMES_API_KEY_3']
  keys.forEach((k, i) => (process.env[names[i]] = k))
}
const setPro = () => {
  ;(aiPipelineService as any).tierClient = {
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { ai_model_tier: 'pro' } }) }) }) }),
  }
}

const params = (userId?: string) => ({
  jobTitle: 'Frontend Developer',
  company: 'PT Contoh',
  jobDescription: 'Bangun antarmuka dengan React dan TypeScript. Kami butuh orang yang teliti dan mau belajar.',
  userProfile: { firstName: 'Budi', lastName: 'Uji', yearsOfExperience: '2', skills: ['React', 'TypeScript'], summary: 'Frontend developer.' },
  language: 'id',
  userId,
})

// ───────────────────────────────────────────────────────────── resolusi dan urutan bawaan

test('resolvePremiumModel: numes, gemini, dan anthropic ke endpoint kompatibel OpenAI; tanpa kunci atau entri OpenRouter: null', () => {
  const keys = { gemini: 'g', anthropic: 'a', numes: [NK1] }
  const n = resolvePremiumModel(`numes:${GLM}`, keys)!
  assert.equal(n.provider, 'numes')
  assert.equal(n.url, 'https://api.numes.ai/api/v1/chat/completions')
  assert.equal(n.model, GLM, 'nama model Numes memuat / dan :')
  assert.equal(n.headers.Authorization, undefined, 'kunci Numes dipasang per percobaan oleh kolam kunci')
  assert.ok(n.pool && n.pool.size === 1)
  const g = resolvePremiumModel('gemini:gemini-3.5-flash-lite', keys)!
  assert.equal(g.url, 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions')
  assert.equal(g.model, 'gemini-3.5-flash-lite')
  assert.equal(g.headers.Authorization, 'Bearer g')
  const a = resolvePremiumModel('anthropic:claude-haiku-5-5', keys)!
  assert.equal(a.url, 'https://api.anthropic.com/v1/chat/completions')
  assert.equal(a.model, 'claude-haiku-5-5')
  assert.equal(resolvePremiumModel('gemini:x', { anthropic: 'a' }), null)
  assert.equal(resolvePremiumModel(`numes:${GLM}`, { gemini: 'g' }), null, 'tanpa kunci Numes: dilewati')
  assert.equal(resolvePremiumModel(`numes:${GLM}`, { numes: [] }), null)
  assert.equal(resolvePremiumModel('openrouter/free', keys), null)
  assert.equal(resolvePremiumModel('google/gemma-4-31b-it:free', keys), null)
})

test('bawaan: Numes dulu, lalu Gemini, Anthropic hanya di ujung; kedua paket sama urutannya', () => {
  assert.equal(
    DEFAULT_FREE_MODELS,
    `numes:${GLM},numes:${DSK},gemini:gemini-3.5-flash-lite,anthropic:claude-haiku-5-5`
  )
  assert.equal(
    DEFAULT_PRO_MODELS,
    `numes:${GLM},numes:${DSK},gemini:gemini-4-hydrogen,gemini:gemini-4-argon,anthropic:claude-sonnet-5-5,anthropic:claude-haiku-5-5`
  )
  for (const list of [DEFAULT_FREE_MODELS, DEFAULT_PRO_MODELS].map((l) => parseModelList(undefined, l))) {
    const providers = list.map((e) => e.split(':')[0])
    assert.equal(providers[0], 'numes')
    const firstClaude = providers.indexOf('anthropic')
    assert.ok(providers.slice(firstClaude).every((p) => p === 'anthropic'), 'Anthropic hanya di ujung rantai')
    assert.ok(!DEFAULT_PRO_MODELS.includes('deepseek/deepseek-v4-pro'))
  }
})

test('premiumChain: dengan semua kunci Numes dan Gemini dulu, Anthropic di belakang; tanpa kunci Numes dilewati', () => {
  const keys = { gemini: 'g', anthropic: 'a', numes: [NK1, NK2] }
  assert.deepEqual(premiumChain('free', keys, {}).map((r) => r.entry), [`numes:${GLM}`, `numes:${DSK}`, 'gemini:gemini-3.5-flash-lite', 'anthropic:claude-haiku-5-5'])
  assert.deepEqual(premiumChain('pro', keys, {}).map((r) => r.entry), [
    `numes:${GLM}`, `numes:${DSK}`, 'gemini:gemini-4-hydrogen', 'gemini:gemini-4-argon', 'anthropic:claude-sonnet-5-5', 'anthropic:claude-haiku-5-5',
  ])
  // tanpa kunci Numes: persis rantai lama tanpa Numes
  assert.deepEqual(premiumChain('free', { gemini: 'g', anthropic: 'a' }, {}).map((r) => r.entry), ['gemini:gemini-3.5-flash-lite', 'anthropic:claude-haiku-5-5'])
  assert.deepEqual(premiumChain('pro', { anthropic: 'a' }, {}).map((r) => r.entry), ['anthropic:claude-sonnet-5-5', 'anthropic:claude-haiku-5-5'])
  assert.deepEqual(premiumChain('free', {}, {}), [])
  // dua kolam Numes dari kunci yang sama adalah kolam yang sama (putaran bertahan)
  const [a, b] = premiumChain('free', keys, {})
  assert.equal(a.pool, b.pool)
})

test('FREE_MODELS / PRO_MODELS menimpa bawaan, dan Anthropic tetap dipindah ke belakang', () => {
  const keys = { gemini: 'g', anthropic: 'a', numes: [NK1] }
  assert.deepEqual(premiumChain('pro', keys, { PRO_MODELS: 'anthropic:claude-haiku-5-5' }).map((r) => r.entry), ['anthropic:claude-haiku-5-5'])
  const parts = premiumChainParts('free', keys, { FREE_MODELS: 'anthropic:ca,gemini:g1,numes:a/b,anthropic:cb,numes:c/d:free' })
  assert.deepEqual(parts.first.map((r) => r.entry), ['gemini:g1', 'numes:a/b', 'numes:c/d:free'])
  assert.deepEqual(parts.last.map((r) => r.entry), ['anthropic:ca', 'anthropic:cb'])
  assert.deepEqual(premiumChain('free', keys, { FREE_MODELS: 'anthropic:ca,gemini:g1' }).map((r) => r.entry), ['gemini:g1', 'anthropic:ca'])
  assert.deepEqual(parseModelList(' ', 'a,b'), ['a', 'b'])
})

// ───────────────────────────────────────────────────────────── rantai sungguhan lewat aiPipelineService

test('paket Free tanpa kunci Numes (perilaku lama): Gemini menjawab, OpenRouter tidak dipanggil', async () => {
  script['gemini-3.5-flash-lite'] = LETTER
  const doc = await aiPipelineService.generateCoverLetter(params())
  assert.equal(doc.model, 'gemini:gemini-3.5-flash-lite')
  assert.deepEqual(calls.map((c) => c.model), ['gemini-3.5-flash-lite'])
  assert.match(calls[0].url, /generativelanguage\.googleapis\.com/)
  assert.equal(calls[0].timeout, 25_000, 'batas waktu per panggilan')
})

test('paket Free dengan kunci Numes: Numes GLM menjawab lebih dulu, Gemini dan Anthropic tidak disentuh', async () => {
  setNumesKeys(NK1, NK2, NK3)
  script[GLM] = LETTER
  const doc = await aiPipelineService.generateCoverLetter(params())
  assert.equal(doc.model, `numes:${GLM}`)
  assert.deepEqual(calls.map((c) => c.model), [GLM])
  assert.equal(calls[0].url, 'https://api.numes.ai/api/v1/chat/completions')
  assert.equal(calls[0].auth, `Bearer ${NK1}`)
  assert.equal(calls[0].headers['Content-Type'], 'application/json')
  assert.equal(typeof calls[0].temperature, 'number', 'Numes menerima temperature')
  assert.equal(calls[0].max_tokens, 1500)
  assert.equal(calls[0].timeout, 12_000, 'Numes: batas waktu 12 detik per percobaan, bukan 25 detik Gemini')
})

test('kunci Numes berputar tiap panggilan (round-robin): kunci 1, 2, 3, lalu 1 lagi', async () => {
  setNumesKeys(NK1, NK2, NK3)
  script[GLM] = LETTER
  for (let i = 0; i < 4; i++) await aiPipelineService.generateCoverLetter(params())
  assert.deepEqual(calls.map((c) => c.auth), [NK1, NK2, NK3, NK1].map((k) => `Bearer ${k}`))
})

for (const [name, reply] of [
  ['429', 429],
  ['402', { status: 402, data: { error: { code: 402, message: 'insufficient credits', metadata: { error_type: 'insufficient_credits' } } } }],
  ['401', { status: 401, data: { error: { code: 401, message: 'invalid credentials', metadata: { error_type: 'invalid_credentials' } } } }],
  ['403', { status: 403, data: { error: { code: 403, message: 'x', metadata: { error_type: 'verified_email_required' } } } }],
] as Array<[string, Reply]>) {
  test(`Numes: ${name} pada kunci 1 = model yang sama dicoba lagi dengan kunci 2, Gemini tidak disentuh`, async () => {
    setNumesKeys(NK1, NK2, NK3)
    script[GLM] = (auth) => (auth === `Bearer ${NK1}` ? reply : LETTER)
    const doc = await aiPipelineService.generateCoverLetter(params())
    assert.equal(doc.model, `numes:${GLM}`)
    assert.deepEqual(calls.map((c) => [c.model, c.auth]), [[GLM, `Bearer ${NK1}`], [GLM, `Bearer ${NK2}`]])
  })
}

/** Batas waktu axios. Tanpa `elapsedMs` server menggantung sampai batas waktunya habis (waktu tiruan maju sebanyak itu). */
const TIMEOUT = (elapsedMs?: number) => Object.assign(new Error('timeout of 12000ms exceeded'), { code: 'ECONNABORTED', elapsedMs })
const JSON_OK = JSON.stringify({ full_name: 'Tokoh Sintetis', skills: ['Python'] })

test('Numes: 503 (galat server) pada kunci 1 melepas model itu, kunci 2 tidak dicoba, model berikutnya dipakai', async () => {
  setNumesKeys(NK1, NK2, NK3)
  script[GLM] = 503
  script[DSK] = LETTER
  const doc = await aiPipelineService.generateCoverLetter(params())
  assert.equal(doc.model, `numes:${DSK}`)
  assert.deepEqual(calls.map((c) => [c.model, c.auth]), [[GLM, `Bearer ${NK1}`], [DSK, `Bearer ${NK2}`]])
})

test('Numes: batas waktu pada kunci 1 = kunci 2 TIDAK dicoba (modelnya yang lambat), model Numes berikutnya dipakai', async () => {
  setNumesKeys(NK1, NK2, NK3)
  script[GLM] = TIMEOUT(1_000) // sambungan putus cepat: jatah Numes masih ada untuk model berikutnya
  script[DSK] = LETTER
  const doc = await aiPipelineService.generateCoverLetter(params())
  assert.equal(doc.model, `numes:${DSK}`)
  assert.deepEqual(calls.map((c) => [c.model, c.auth, c.timeout]), [[GLM, `Bearer ${NK1}`, 12_000], [DSK, `Bearer ${NK2}`, 12_000]])
  assert.match(captured.join('\n'), /key 1\/3 -> timeout, giving up on this model/)
  assert.doesNotMatch(captured.join('\n'), /trying next key/)
})

test('Numes: model yang kena batas waktu didinginkan 5 menit; permintaan berikutnya melewatinya tanpa menunggu, lalu dicoba lagi', async () => {
  setNumesKeys(NK1, NK2)
  script[GLM] = TIMEOUT(1_000)
  script[DSK] = LETTER
  await aiPipelineService.generateCoverLetter(params())
  assert.deepEqual(calls.map((c) => c.model), [GLM, DSK])
  calls.length = 0
  skew += 60_000
  await aiPipelineService.generateCoverLetter(params())
  assert.deepEqual(calls.map((c) => c.model), [DSK], 'GLM dilewati tanpa panggilan')
  assert.match(captured.join('\n'), /numes:z-ai\/glm-5\.3-flash:free: model was too slow, cooling down/)
  calls.length = 0
  skew += NUMES_MODEL_COOLDOWN_MS
  await aiPipelineService.generateCoverLetter(params())
  assert.equal(calls[0].model, GLM, 'sesudah 5 menit GLM dicoba lagi')
})

test('Numes lambat di SEMUA entri: jatah Numes (15 detik) habis, Gemini tetap dipanggil dengan batas waktu penuh', async () => {
  setNumesKeys(NK1, NK2, NK3)
  script[GLM] = TIMEOUT()
  script[DSK] = TIMEOUT()
  script['gemini-3.5-flash-lite'] = LETTER
  const doc = await aiPipelineService.generateCoverLetter(params())
  assert.equal(doc.model, 'gemini:gemini-3.5-flash-lite')
  // GLM: 12 detik lalu dilepas; sisa jatah 3 detik < 4 detik, jadi DeepSeek dilewati tanpa panggilan; Gemini menjawab
  assert.deepEqual(calls.map((c) => c.model), [GLM, 'gemini-3.5-flash-lite'])
  assert.equal(calls[1].timeout, 25_000)
  assert.equal(skew, 12_000, 'Numes hanya memakai 12 detik')
})

test('Numes lambat di semua entri dengan deadline 34 detik: Numes paling banyak 40% (13,6 detik), Gemini mendapat sisa waktunya', async () => {
  setNumesKeys(NK1, NK2)
  script[GLM] = TIMEOUT()
  script[DSK] = TIMEOUT()
  script['gemini-3.5-flash-lite'] = JSON_OK
  const out = await aiPipelineService.completeJson({ system: 's', user: 'u', deadlineAt: Date.now() + 34_000 })
  assert.equal(out.model, 'gemini:gemini-3.5-flash-lite')
  assert.deepEqual(calls.map((c) => c.model), [GLM, 'gemini-3.5-flash-lite'])
  assert.equal(calls[0].timeout, 12_000)
  assert.ok(calls[1].timeout! >= 20_000 && calls[1].timeout! <= 22_000, `Gemini timeout=${calls[1].timeout}`)
})

test('Numes: deadline pendek memangkas batas waktu percobaan Numes ke jatahnya (40%); jatah di bawah 4 detik = Numes dilewati, Gemini langsung', async () => {
  setNumesKeys(NK1)
  script[GLM] = JSON_OK
  await aiPipelineService.completeJson({ system: 's', user: 'u', deadlineAt: Date.now() + 12_000 })
  assert.equal(calls[0].model, GLM)
  assert.equal(calls[0].timeout, 4_800, '40% dari 12 detik')
  calls.length = 0
  script['gemini-3.5-flash-lite'] = JSON_OK
  const out = await aiPipelineService.completeJson({ system: 's', user: 'u', deadlineAt: Date.now() + 8_000 })
  assert.equal(out.model, 'gemini:gemini-3.5-flash-lite')
  assert.deepEqual(calls.map((c) => c.model), ['gemini-3.5-flash-lite'], 'jatah Numes 3,2 detik terlalu pendek: tidak dipanggil')
})

test('Numes: kunci yang kena 429 didinginkan; panggilan berikutnya melewatinya sampai 60 detik berlalu', async () => {
  setNumesKeys(NK1, NK2, NK3)
  script[GLM] = (auth) => (auth === `Bearer ${NK3}` ? LETTER : 429)
  await aiPipelineService.generateCoverLetter(params()) // K1 429, K2 429, K3 ok
  assert.deepEqual(calls.map((c) => c.auth), [NK1, NK2, NK3].map((k) => `Bearer ${k}`))
  calls.length = 0
  await aiPipelineService.generateCoverLetter(params())
  assert.deepEqual(calls.map((c) => c.auth), [`Bearer ${NK3}`], 'K1 dan K2 dilewati, tidak dicoba lagi')
  calls.length = 0
  skew += NUMES_COOLDOWN_RATE_MS + 1
  await aiPipelineService.generateCoverLetter(params())
  assert.equal(calls[0].auth, `Bearer ${NK1}`, 'sesudah masa dingin K1 dipakai lagi')
})

test('Numes: semua kunci gagal pada GLM = DeepSeek dicoba (dengan kunci bergilir), lalu Gemini', async () => {
  setNumesKeys(NK1, NK2)
  script[GLM] = 429
  script[DSK] = 503
  script['gemini-3.5-flash-lite'] = LETTER
  const doc = await aiPipelineService.generateCoverLetter(params())
  assert.equal(doc.model, 'gemini:gemini-3.5-flash-lite')
  // GLM: K1 lalu K2 (keduanya 429, didinginkan). DeepSeek: semua kunci dingin, jadi Numes dilewati tanpa panggilan.
  assert.deepEqual(calls.map((c) => c.model), [GLM, GLM, 'gemini-3.5-flash-lite'])
})

test('Numes: 5xx tidak mendinginkan kunci maupun model; model berikutnya mulai dari kunci yang bergilir (kunci 2)', async () => {
  setNumesKeys(NK1, NK2)
  script[GLM] = 503
  script[DSK] = (auth) => (auth === `Bearer ${NK2}` ? LETTER : 503)
  const doc = await aiPipelineService.generateCoverLetter(params())
  assert.equal(doc.model, `numes:${DSK}`)
  assert.deepEqual(calls.map((c) => [c.model, c.auth]), [[GLM, `Bearer ${NK1}`], [DSK, `Bearer ${NK2}`]])
  calls.length = 0
  script[GLM] = LETTER
  await aiPipelineService.generateCoverLetter(params())
  assert.equal(calls[0].model, GLM, 'GLM tidak didinginkan oleh 503')
})

test('Anthropic hanya sesudah Numes, Gemini, OpenRouter, dan Groq gagal semuanya', async () => {
  process.env.GROQ_API_KEY = 'groq-test-not-real'
  setNumesKeys(NK1)
  script[GLM] = 503
  script[DSK] = 503
  script['gemini-3.5-flash-lite'] = 429
  script['m1'] = 503
  script['m2'] = ''
  script['g1'] = ''
  script['claude-haiku-5-5'] = LETTER
  const doc = await aiPipelineService.generateCoverLetter(params())
  assert.equal(doc.model, 'anthropic:claude-haiku-5-5')
  assert.deepEqual(calls.map((c) => c.model), [GLM, DSK, 'gemini-3.5-flash-lite', 'm1', 'm2', 'g1', 'claude-haiku-5-5'])
  assert.equal(calls.at(-1)!.temperature, undefined, 'Claude menolak temperature (400), jadi tidak dikirim')
  assert.ok((calls.at(-1)!.max_tokens ?? 0) >= 1600, 'Claude diberi ruang untuk penalaran tersembunyi')
})

test('Anthropic tidak dipanggil sama sekali selama salah satu penyedia lain menjawab (OpenRouter menjawab)', async () => {
  setNumesKeys(NK1)
  script[GLM] = 503
  script[DSK] = 503
  script['gemini-3.5-flash-lite'] = Object.assign(new Error('timeout of 25000ms exceeded'), { code: 'ECONNABORTED' })
  script['m1'] = LETTER
  const doc = await aiPipelineService.generateCoverLetter(params())
  assert.equal(doc.model, 'openrouter:m1')
  assert.ok(!calls.some((c) => /anthropic/.test(c.url)), 'api.anthropic.com tidak disentuh')
})

test('Anthropic tidak dipanggil bila Groq menjawab', async () => {
  process.env.GROQ_API_KEY = 'groq-test-not-real'
  script['gemini-3.5-flash-lite'] = 429
  script['m1'] = 503
  script['m2'] = 503
  script['g1'] = LETTER
  const doc = await aiPipelineService.generateCoverLetter(params())
  assert.equal(doc.model, 'groq:g1')
  assert.ok(!calls.some((c) => /anthropic/.test(c.url)))
})

test('urutan Anthropic tetap di ujung walau FREE_MODELS menaruhnya di depan', async () => {
  process.env.FREE_MODELS = 'anthropic:claude-haiku-5-5,gemini:gemini-3.5-flash-lite'
  script['gemini-3.5-flash-lite'] = 429
  script['m1'] = LETTER
  const doc = await aiPipelineService.generateCoverLetter(params())
  assert.equal(doc.model, 'openrouter:m1')
  assert.deepEqual(calls.map((c) => c.model), ['gemini-3.5-flash-lite', 'm1'])
})

test('Free: Gemini dan Claude gagal (timeout, jawaban kosong) setelah rantai OpenRouter dan Groq juga gagal = galat jelas, tidak ada yang disimpan', async () => {
  script['gemini-3.5-flash-lite'] = Object.assign(new Error('timeout of 25000ms exceeded'), { code: 'ECONNABORTED' })
  script['claude-haiku-5-5'] = ''
  script['m1'] = 503
  script['m2'] = 503
  await assert.rejects(() => aiPipelineService.generateCoverLetter(params()), /AI generation failed/)
  assert.deepEqual(calls.map((c) => c.model), ['gemini-3.5-flash-lite', 'm1', 'm2', 'claude-haiku-5-5'])
})

test('paket Pro (subscriptions.ai_model_tier = pro): Numes, Gemini 4, OpenRouter, lalu Claude Sonnet paling akhir', async () => {
  setPro()
  setNumesKeys(NK1)
  script[GLM] = 503
  script[DSK] = 429
  script['gemini-4-hydrogen'] = 503
  script['gemini-4-argon'] = 429
  script['m1'] = 503
  script['m2'] = 503
  script['claude-sonnet-5-5'] = LETTER
  const doc = await aiPipelineService.generateCoverLetter(params('u-pro'))
  assert.equal(doc.model, 'anthropic:claude-sonnet-5-5')
  assert.deepEqual(calls.map((c) => c.model), [GLM, DSK, 'gemini-4-hydrogen', 'gemini-4-argon', 'm1', 'm2', 'claude-sonnet-5-5'])
  assert.ok(calls.every((c) => !/deepseek-v4-pro/i.test(c.model)))
})

test('tanpa kunci Numes tidak ada panggilan ke api.numes.ai dan tidak ada galat', async () => {
  script['gemini-3.5-flash-lite'] = LETTER
  await aiPipelineService.generateCoverLetter(params())
  assert.ok(!calls.some((c) => /numes\.ai/.test(c.url)))
})

test('log tidak pernah memuat nilai kunci Numes, hanya nomor kunci', async () => {
  setNumesKeys(NK1, NK2, NK3)
  script[GLM] = 429
  script[DSK] = 503
  script['gemini-3.5-flash-lite'] = LETTER
  await aiPipelineService.generateCoverLetter(params())
  const all = captured.join('\n')
  for (const key of [NK1, NK2, NK3, 'gem-test-not-real', 'or-test-not-real']) assert.ok(!all.includes(key), `log memuat nilai kunci: ${key}`)
  assert.match(all, /key 1\/3/)
  assert.match(all, /key 2\/3/)
})

test('tierFor: tanpa userId, tanpa data, atau galat database: free', async () => {
  assert.equal(await aiPipelineService.tierFor(undefined), 'free')
  ;(aiPipelineService as any).tierClient = { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }) }) }
  assert.equal(await aiPipelineService.tierFor('u'), 'free')
  ;(aiPipelineService as any).tierClient = { from: () => { throw new Error('db down') } }
  assert.equal(await aiPipelineService.tierFor('u'), 'free')
})
