import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import axios from 'axios'
import { FakeDb } from './helpers/fakeDb.ts'

/**
 * Anggaran waktu (deadlineAt) dan penyedia yang pasti gagal pada rantai model yang SUNGGUHAN
 * (aiPipelineService.completeJson), tanpa jaringan: axios.post diganti naskah per model dan jam diajukan
 * lewat Date.now. Dipakai impor PDF LinkedIn supaya pengguna tidak menunggu 90 detik lebih sebelum parser aturan.
 */
process.env.OPENROUTER_API_KEY = 'test-key-not-real'
process.env.OPENROUTER_MODEL = 'm1'
process.env.OPENROUTER_FALLBACK_MODELS = 'm1,m2,m3,m4,m5,m6'
process.env.GROQ_FALLBACK_MODELS = 'g1,g2'
delete process.env.AI_OPENROUTER_TIMEOUT_MS
delete process.env.GROQ_API_KEY
delete process.env.GEMINI_API_KEY
delete process.env.ANTHROPIC_API_KEY
for (const k of ['NUMES_API_KEY', 'NUMES_API_KEY_2', 'NUMES_API_KEY_3', 'NUMES_API_KEY_4', 'NUMES_API_KEY_5', 'NUMES_API_KEYS']) delete process.env[k]
delete process.env.FREE_MODELS

const { aiPipelineService, AiBudgetExhaustedError } = await import('../services/ai-pipeline.service.ts')

type Call = { url: string; model: string; timeout: number | undefined }
type Reply = { status: number; content?: string } | Error
let calls: Call[]
let script: Record<string, Reply>
let skew = 0 // ms yang "berlalu" menurut Date.now, ditambah oleh panggilan tiruan
let costMs = 0

const realNow = Date.now.bind(Date)
Date.now = () => realNow() + skew

const GOOD = JSON.stringify({ full_name: 'Tokoh Sintetis', skills: ['Python'] })

;(axios as any).get = async () => ({ status: 500, data: {} }) // daftar model tidak tersedia: rantai dipakai apa adanya
;(axios as any).post = async (url: string, body: any, cfg: any) => {
  calls.push({ url, model: body.model, timeout: cfg?.timeout })
  skew += costMs
  const reply = script[body.model] ?? { status: 200, content: GOOD }
  if (reply instanceof Error) throw reply
  return { status: reply.status, data: reply.status === 200 ? { choices: [{ message: { content: reply.content ?? GOOD } }] } : { error: 'x' } }
}

beforeEach(() => {
  calls = []
  script = {}
  skew = 0
  costMs = 0
  ;(aiPipelineService as any).tierClient = new FakeDb({ subscriptions: [] })
})

async function withEnv<T>(env: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const saved: Record<string, string | undefined> = {}
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k]
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  try {
    return await fn()
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
}

const run = (deadlineAt?: number) => aiPipelineService.completeJson({ system: 's', user: 'u', deadlineAt })

// ───────────────────────────────────────────────────────────── deadline

test('tanpa deadline: perilaku lama, batas waktu OpenRouter tetap 40 detik', async () => {
  const out = await run()
  assert.equal(out.model, 'openrouter:m1')
  assert.equal(calls[0].timeout, 40_000)
})

test('deadline: batas waktu tiap panggilan dipendekkan ke sisa waktu, tidak pernah lebih dari batas dasar', async () => {
  await run(Date.now() + 10_000)
  assert.ok(calls[0].timeout! <= 10_000 && calls[0].timeout! >= 9_000, `timeout=${calls[0].timeout}`)
  calls = []
  await run(Date.now() + 120_000)
  assert.equal(calls[0].timeout, 40_000, 'sisa waktu panjang: batas dasar yang berlaku')
})

test('deadline: sisa waktu terlalu pendek = tidak ada panggilan sama sekali, galat AiBudgetExhausted', async () => {
  await assert.rejects(run(Date.now() + 500), (e: any) => e instanceof AiBudgetExhaustedError && e.name === 'AiBudgetExhausted')
  await assert.rejects(run(Date.now() - 1), (e: any) => e.name === 'AiBudgetExhausted')
  assert.equal(calls.length, 0)
})

test('deadline: rantai berhenti memulai model baru begitu anggaran habis, dan panggilan terakhir hanya diberi sisa waktu', async () => {
  costMs = 15_000 // tiap panggilan gagal sesudah 15 detik
  for (const m of ['m1', 'm2', 'm3', 'm4', 'm5', 'm6']) script[m] = new Error('boom')
  await assert.rejects(run(Date.now() + 40_000), (e: any) => e.name === 'AiBudgetExhausted')
  assert.deepEqual(calls.map((c) => c.model), ['m1', 'm2', 'm3'])
  const t = calls.map((c) => c.timeout!)
  assert.ok(t[0] > 39_000 && t[0] <= 40_000, `t0=${t[0]}`)
  assert.ok(t[1] > 24_000 && t[1] <= 25_000, `t1=${t[1]}`)
  assert.ok(t[2] > 9_000 && t[2] <= 10_000, `t2=${t[2]}`)
})

test('deadline: Groq juga berhenti dan diberi batas waktu hanya bila rantai punya deadline', async () => {
  await withEnv({ GROQ_API_KEY: 'groq-test-key' }, async () => {
    for (const m of ['m1', 'm2', 'm3', 'm4', 'm5', 'm6']) script[m] = { status: 500 }
    const out = await run(Date.now() + 60_000)
    assert.equal(out.model, 'groq:g1')
    const groq = calls.find((c) => c.model === 'g1')!
    assert.ok(groq.timeout! <= 60_000 && groq.timeout! >= 2_000, `groq timeout=${groq.timeout}`)

    calls = []
    const noDeadline = await run()
    assert.equal(noDeadline.model, 'groq:g1')
    assert.equal(calls.find((c) => c.model === 'g1')!.timeout, undefined, 'tanpa deadline Groq tetap tanpa batas (perilaku lama)')
  })
})

// ───────────────────────────────────────────────────────────── penyedia yang pasti gagal

const PREMIUM_ENV = { GEMINI_API_KEY: 'gk', ANTHROPIC_API_KEY: 'ak', FREE_MODELS: 'gemini:ga,gemini:gb,anthropic:ca' }
// Anthropic paling akhir: rantai OpenRouter (m1..m6) jalan lebih dulu, jadi di sini semuanya dibuat gagal.
const OPENROUTER_DOWN: Record<string, Reply> = Object.fromEntries(['m1', 'm2', 'm3', 'm4', 'm5', 'm6'].map((m) => [m, { status: 503 }]))
const OPENROUTER_CALLS = ['m1', 'm2', 'm3', 'm4', 'm5', 'm6']

test('penyedia: kunci Gemini ditolak (401) = model Gemini berikutnya dilewati, OpenRouter dicoba, lalu Anthropic paling akhir', async () => {
  await withEnv(PREMIUM_ENV, async () => {
    script = { ...OPENROUTER_DOWN, ga: { status: 401 }, ca: { status: 200, content: GOOD } }
    const out = await run()
    assert.deepEqual(calls.map((c) => c.model), ['ga', ...OPENROUTER_CALLS, 'ca'])
    assert.equal(out.model, 'anthropic:ca')
  })
})

test('penyedia: server tidak terjangkau (ENOTFOUND) = model berikutnya di penyedia sama dilewati', async () => {
  await withEnv(PREMIUM_ENV, async () => {
    script = {
      ...OPENROUTER_DOWN,
      ga: Object.assign(new Error('getaddrinfo ENOTFOUND generativelanguage.googleapis.com'), { code: 'ENOTFOUND' }),
      ca: { status: 200, content: GOOD },
    }
    const out = await run()
    assert.deepEqual(calls.map((c) => c.model), ['ga', ...OPENROUTER_CALLS, 'ca'])
    assert.equal(out.model, 'anthropic:ca')
  })
})

test('penyedia: Anthropic tidak disentuh selama OpenRouter menjawab', async () => {
  await withEnv(PREMIUM_ENV, async () => {
    script = { ga: { status: 401 }, ca: { status: 200, content: GOOD } }
    const out = await run()
    assert.deepEqual(calls.map((c) => c.model), ['ga', 'm1'])
    assert.equal(out.model, 'openrouter:m1')
  })
})

test('penyedia: batas waktu satu model (ECONNABORTED) TIDAK menghentikan model lain di penyedia sama (perilaku lama)', async () => {
  await withEnv(PREMIUM_ENV, async () => {
    script = { ga: Object.assign(new Error('timeout of 25000ms exceeded'), { code: 'ECONNABORTED' }), gb: { status: 200, content: GOOD } }
    const out = await run()
    assert.deepEqual(calls.map((c) => c.model), ['ga', 'gb'])
    assert.equal(out.model, 'gemini:gb')
  })
})

test('penyedia: OpenRouter menolak kunci (401) = sisa rantai OpenRouter dilewati, Groq langsung dipakai', async () => {
  await withEnv({ GROQ_API_KEY: 'groq-test-key' }, async () => {
    script = { m1: { status: 401 }, g1: { status: 200, content: GOOD } }
    const out = await run()
    assert.deepEqual(calls.map((c) => c.model), ['m1', 'g1'])
    assert.equal(out.model, 'groq:g1')
  })
})

test('penyedia: OpenRouter tidak terjangkau = rantainya dilewati; tanpa Groq galatnya jelas, bukan menunggu enam model', async () => {
  script = { m1: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) }
  await assert.rejects(run(), /AI generation failed/)
  assert.deepEqual(calls.map((c) => c.model), ['m1'])
})

test('penyedia: kegagalan biasa (500) tetap mencoba model berikutnya seperti sebelumnya', async () => {
  script = { m1: { status: 500 }, m2: { status: 200, content: GOOD } }
  const out = await run()
  assert.deepEqual(calls.map((c) => c.model), ['m1', 'm2'])
  assert.equal(out.model, 'openrouter:m2')
})
