import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
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
delete process.env.AI_GROQ_TIMEOUT_MS
delete process.env.AI_CHAIN_BUDGET_MS
delete process.env.GROQ_API_KEY
delete process.env.GEMINI_API_KEY
delete process.env.ANTHROPIC_API_KEY
for (const k of ['NUMES_API_KEY', 'NUMES_API_KEY_2', 'NUMES_API_KEY_3', 'NUMES_API_KEY_4', 'NUMES_API_KEY_5', 'NUMES_API_KEYS']) delete process.env[k]
delete process.env.FREE_MODELS

const { aiPipelineService, AiBudgetExhaustedError } = await import('../services/ai-pipeline.service.ts')
const { tracingService } = await import('../services/tracing.service.ts')
;(tracingService as any).traceAIGeneration = async () => ({ traceId: 't', generationId: 'g' })

const HERE = path.dirname(fileURLToPath(import.meta.url))
const fx = (name: string) => fs.readFileSync(path.join(HERE, 'fixtures', 'uat', name), 'utf8')
const VALID_CV = fx('cv-valid-user001.txt')
const ID_LETTER = fx('letter-indonesian-greeting-user018.txt')

const EVAL_OK = `OVERALL_SCORE: 85
ATS_COMPATIBILITY_SCORE: 85
KEYWORD_MATCH_SCORE: 70
CONTENT_QUALITY_SCORE: 75
FORMATTING_SCORE: 80

STRENGTHS:
- Jelas

WEAKNESSES:
- Singkat

MISSING_KEYWORDS:
- Kubernetes

RECOMMENDATIONS:
- Tambah proyek

LENGTH_ASSESSMENT: Satu halaman.

SUMMARY: Cukup baik untuk posisi ini.`

type Call = { url: string; model: string; timeout: number | undefined; signal: AbortSignal | undefined }
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
  calls.push({ url, model: body.model, timeout: cfg?.timeout, signal: cfg?.signal })
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
  ;(aiPipelineService as any).lastModelUsed = null
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

test('tanpa deadline: perilaku lama, batas waktu OpenRouter tetap 40 detik dan membawa AbortSignal', async () => {
  const out = await run()
  assert.equal(out.model, 'openrouter:m1')
  assert.equal(calls[0].timeout, 40_000)
  assert.ok(calls[0].signal instanceof AbortSignal)
})

test('deadline: batas waktu tiap panggilan dipendekkan ke sisa waktu, tidak pernah lebih dari batas dasar', async () => {
  await run(Date.now() + 10_000)
  assert.ok(calls[0].timeout! <= 10_000 && calls[0].timeout! >= 9_000, `timeout=${calls[0].timeout}`)
  assert.ok(calls[0].signal instanceof AbortSignal)
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

test('deadline: Groq juga selalu memakai batas waktu + AbortSignal baik dengan deadline maupun tanpa deadline', async () => {
  await withEnv({ GROQ_API_KEY: 'groq-test-key' }, async () => {
    for (const m of ['m1', 'm2', 'm3', 'm4', 'm5', 'm6']) script[m] = { status: 500 }
    const out = await run(Date.now() + 60_000)
    assert.equal(out.model, 'groq:g1')
    const groq = calls.find((c) => c.model === 'g1')!
    assert.ok(groq.timeout! <= 25_000 && groq.timeout! >= 2_000, `groq timeout=${groq.timeout}`)
    assert.ok(groq.signal instanceof AbortSignal)

    calls = []
    const noDeadline = await run()
    assert.equal(noDeadline.model, 'groq:g1')
    const groqNoDeadline = calls.find((c) => c.model === 'g1')!
    assert.equal(groqNoDeadline.timeout, 25_000, 'tanpa deadline Groq tetap memakai batas waktu bawaan yang aman')
    assert.ok(groqNoDeadline.signal instanceof AbortSignal, 'tanpa deadline Groq tetap membawa AbortSignal.timeout')
    assert.ok(calls.every((c) => c.signal instanceof AbortSignal))
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
    assert.ok(calls.every((c) => c.signal instanceof AbortSignal && typeof c.timeout === 'number' && c.timeout > 0))
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

// ───────────────────────────────────────────────────────────── penerusan deadlineAt di seluruh entry point

const cvProfile = {
  firstName: 'Siti',
  lastName: 'Yoga',
  currentTitle: 'Frontend Engineer',
  yearsOfExperience: '11',
  skills: ['React', 'TypeScript', 'Tailwind'],
  summary: '11 tahun sebagai Frontend Engineer di Bogor',
  workExperiences: [{ role_title: 'Frontend Engineer', company_name: 'Perusahaan Teknologi A', start_date: '2016-03-01' }],
  education: [{ degree: 'Ilmu Komputer', field_of_study: 'Ilmu Komputer', institution: 'Universitas Padjadjaran', start_year: 2012, end_year: 2016 }],
}
const coverLetterInput = {
  jobTitle: 'Akuntan',
  company: 'Deloitte Indonesia',
  jobDescription: 'Menyusun laporan keuangan dan audit internal untuk klien.',
  userProfile: { firstName: 'Eko', lastName: 'Dimas', yearsOfExperience: '11', skills: ['Akuntansi'], summary: 'Akuntan di Bandung' },
}

test('entry point meneruskan deadlineAt: sisa waktu habis = AiBudgetExhausted tanpa panggilan model', async () => {
  const expired = () => Date.now() + 500
  await assert.rejects(aiPipelineService.generateCoverLetter({ ...coverLetterInput, deadlineAt: expired() }), AiBudgetExhaustedError)
  await assert.rejects(
    aiPipelineService.regenerateCoverLetter({
      original: ID_LETTER,
      instructions: 'ringkas',
      jobTitle: 'Akuntan',
      company: 'Deloitte Indonesia',
      jobDescription: 'Audit',
      deadlineAt: expired(),
    }),
    AiBudgetExhaustedError
  )
  await assert.rejects(
    aiPipelineService.generateAnswer({ question: 'Mengapa tertarik?', questionType: 'textarea', jobDescription: 'Audit', userProfile: {}, deadlineAt: expired() }),
    AiBudgetExhaustedError
  )
  await assert.rejects(
    aiPipelineService.generateCV({ userProfile: cvProfile, jobTitle: 'Backend Engineer', company: 'GoTo Group', jobDescription: 'Microservices', deadlineAt: expired() }),
    AiBudgetExhaustedError
  )
  await assert.rejects(
    aiPipelineService.evaluateCV({ cvText: VALID_CV, jobTitle: 'Backend Engineer', company: 'GoTo Group', jobDescription: 'Microservices', deadlineAt: expired() }),
    AiBudgetExhaustedError
  )
  await assert.rejects(aiPipelineService.extractSkills('Microservices Go', undefined, expired()), AiBudgetExhaustedError)
  await assert.rejects(aiPipelineService.analyzeJobMatch('Microservices Go', ['Go'], undefined, expired()), AiBudgetExhaustedError)
  assert.equal(calls.length, 0)
})

test('entry point membatasi timeout panggilan + memasang AbortSignal sesuai deadlineAt', async () => {
  const checkCall = async (fn: (deadlineAt: number) => Promise<unknown>) => {
    calls = []
    await fn(Date.now() + 9_500)
    assert.equal(calls.length, 1)
    assert.ok(calls[0].timeout! <= 9_500 && calls[0].timeout! >= 2_000, `timeout=${calls[0].timeout}`)
    assert.ok(calls[0].signal instanceof AbortSignal)
  }

  script = { m1: { status: 200, content: ID_LETTER } }
  await checkCall((deadlineAt) => aiPipelineService.generateCoverLetter({ ...coverLetterInput, deadlineAt }))
  await checkCall((deadlineAt) =>
    aiPipelineService.regenerateCoverLetter({
      original: ID_LETTER,
      instructions: 'singkat',
      jobTitle: 'Akuntan',
      company: 'Deloitte Indonesia',
      jobDescription: 'Audit',
      deadlineAt,
    })
  )

  script = { m1: { status: 200, content: 'Tertarik pada peran audit dan pelaporan keuangan.' } }
  await checkCall((deadlineAt) =>
    aiPipelineService.generateAnswer({ question: 'Why role?', questionType: 'textarea', jobDescription: 'Audit', userProfile: {}, deadlineAt })
  )

  script = { m1: { status: 200, content: VALID_CV } }
  await checkCall((deadlineAt) =>
    aiPipelineService.generateCV({ userProfile: cvProfile, jobTitle: 'Backend Engineer', company: 'GoTo Group', jobDescription: 'Microservices', deadlineAt })
  )

  script = { m1: { status: 200, content: EVAL_OK } }
  await checkCall((deadlineAt) =>
    aiPipelineService.evaluateCV({ cvText: VALID_CV, jobTitle: 'Backend Engineer', company: 'GoTo Group', jobDescription: 'Microservices', deadlineAt })
  )

  script = { m1: { status: 200, content: 'TypeScript, Node.js' } }
  await checkCall((deadlineAt) => aiPipelineService.extractSkills('TypeScript Node', undefined, deadlineAt))

  script = { m1: { status: 200, content: 'MATCH_SCORE: 80\nSKILL_GAPS: Go\nMISSING_SKILLS: Go\nRECOMMENDATION: Ok' } }
  await checkCall((deadlineAt) => aiPipelineService.analyzeJobMatch('TypeScript Node', ['TypeScript'], undefined, deadlineAt))
})

test('entry point tanpa deadlineAt tetap memakai anggaran bawaan rantai dan timeout Groq', async () => {
  await withEnv({ GROQ_API_KEY: 'groq-test-key' }, async () => {
    costMs = 45_000
    for (const m of ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'g1', 'g2']) script[m] = new Error('slow')
    await assert.rejects(aiPipelineService.generateCoverLetter(coverLetterInput), AiBudgetExhaustedError)
    // Anggaran bawaan 90 detik habis sesudah 2 percobaan x 45 detik (tidak menunggu seluruh 8 model).
    assert.deepEqual(calls.map((c) => c.model), ['m1', 'm2'])
    assert.ok(calls.every((c) => c.signal instanceof AbortSignal))
  })
})
