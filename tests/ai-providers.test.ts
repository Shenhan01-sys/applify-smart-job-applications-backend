import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import axios from 'axios'

/**
 * Rantai Gemini/Anthropic di depan OpenRouter dan Groq, tanpa jaringan: axios.post diganti naskah per URL dan model.
 * Nilai kunci di sini palsu.
 */
process.env.OPENROUTER_API_KEY = 'or-test-not-real'
process.env.OPENROUTER_MODEL = 'm1'
process.env.OPENROUTER_FALLBACK_MODELS = 'm1,m2'
process.env.GEMINI_API_KEY = 'gem-test-not-real'
process.env.ANTHROPIC_API_KEY = 'ant-test-not-real'
delete process.env.GROQ_API_KEY
delete process.env.FREE_MODELS
delete process.env.PRO_MODELS

const { DEFAULT_FREE_MODELS, DEFAULT_PRO_MODELS, parseModelList, premiumChain, resolvePremiumModel } = await import('../services/ai-providers.ts')
const { aiPipelineService } = await import('../services/ai-pipeline.service.ts')
const { tracingService } = await import('../services/tracing.service.ts')
;(tracingService as any).traceAIGeneration = async () => ({ traceId: 't', generationId: 'g' })

const LETTER = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'uat', 'letter-indonesian-greeting-user018.txt'), 'utf8')

type Call = { url: string; model: string; headers: any; timeout: any }
let calls: Call[]
let script: Record<string, string | number | Error>

;(axios as any).get = async () => ({ status: 500, data: {} })
;(axios as any).post = async (url: string, body: any, cfg: any) => {
  calls.push({ url, model: body.model, headers: cfg?.headers, timeout: cfg?.timeout })
  const reply = script[body.model]
  if (reply instanceof Error) throw reply
  if (typeof reply === 'number') return { status: reply, data: { error: 'x' } }
  return { status: 200, data: { choices: [{ message: { content: reply ?? '' } }] } }
}

beforeEach(() => {
  calls = []
  script = {}
  delete process.env.FREE_MODELS
  delete process.env.PRO_MODELS
  ;(aiPipelineService as any).tierClient = undefined
})

const params = (userId?: string) => ({
  jobTitle: 'Frontend Developer',
  company: 'PT Contoh',
  jobDescription: 'Bangun antarmuka dengan React dan TypeScript. Kami butuh orang yang teliti dan mau belajar.',
  userProfile: { firstName: 'Budi', lastName: 'Uji', yearsOfExperience: '2', skills: ['React', 'TypeScript'], summary: 'Frontend developer.' },
  language: 'id',
  userId,
})

test('resolvePremiumModel: gemini dan anthropic ke endpoint kompatibel OpenAI; tanpa kunci atau entri OpenRouter: null', () => {
  const keys = { gemini: 'g', anthropic: 'a' }
  const g = resolvePremiumModel('gemini:gemini-3.5-flash-lite', keys)!
  assert.equal(g.url, 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions')
  assert.equal(g.model, 'gemini-3.5-flash-lite')
  assert.equal(g.headers.Authorization, 'Bearer g')
  const a = resolvePremiumModel('anthropic:claude-haiku-5-5', keys)!
  assert.equal(a.url, 'https://api.anthropic.com/v1/chat/completions')
  assert.equal(a.model, 'claude-haiku-5-5')
  assert.equal(resolvePremiumModel('gemini:x', { anthropic: 'a' }), null)
  assert.equal(resolvePremiumModel('openrouter/free', keys), null)
  assert.equal(resolvePremiumModel('google/gemma-4-31b-it:free', keys), null)
})

test('premiumChain: Free = Gemini 3.5 flash-lite lalu Claude Haiku; Pro = Gemini 4, lalu Claude, tanpa DeepSeek', () => {
  const keys = { gemini: 'g', anthropic: 'a' }
  assert.deepEqual(premiumChain('free', keys, {}).map((r) => r.entry), ['gemini:gemini-3.5-flash-lite', 'anthropic:claude-haiku-5-5'])
  const pro = premiumChain('pro', keys, {}).map((r) => r.entry)
  assert.deepEqual(pro, ['gemini:gemini-4-hydrogen', 'gemini:gemini-4-argon', 'anthropic:claude-sonnet-5-5', 'anthropic:claude-haiku-5-5'])
  assert.ok(!DEFAULT_PRO_MODELS.includes('deepseek'))
  assert.ok(DEFAULT_FREE_MODELS.startsWith('gemini:'))
  // Kunci Gemini tidak ada: hanya Claude. Tidak ada kunci: kosong.
  assert.deepEqual(premiumChain('pro', { anthropic: 'a' }, {}).map((r) => r.entry), ['anthropic:claude-sonnet-5-5', 'anthropic:claude-haiku-5-5'])
  assert.deepEqual(premiumChain('free', {}, {}), [])
  // Variabel lingkungan menimpa bawaan.
  assert.deepEqual(premiumChain('pro', keys, { PRO_MODELS: 'anthropic:claude-haiku-5-5' }).map((r) => r.entry), ['anthropic:claude-haiku-5-5'])
  assert.deepEqual(parseModelList(' ', 'a,b'), ['a', 'b'])
})

test('paket Free: Gemini menjawab, OpenRouter tidak dipanggil', async () => {
  script['gemini-3.5-flash-lite'] = LETTER
  const doc = await aiPipelineService.generateCoverLetter(params())
  assert.equal(doc.model, 'gemini:gemini-3.5-flash-lite')
  assert.deepEqual(calls.map((c) => c.model), ['gemini-3.5-flash-lite'])
  assert.match(calls[0].url, /generativelanguage\.googleapis\.com/)
  assert.equal(calls[0].timeout, 25_000, 'batas waktu per panggilan')
})

test('Free: Gemini gagal (429) lalu Claude Haiku menjawab; OpenRouter tetap tidak dipanggil', async () => {
  script['gemini-3.5-flash-lite'] = 429
  script['claude-haiku-5-5'] = LETTER
  const doc = await aiPipelineService.generateCoverLetter(params())
  assert.equal(doc.model, 'anthropic:claude-haiku-5-5')
  assert.deepEqual(calls.map((c) => c.model), ['gemini-3.5-flash-lite', 'claude-haiku-5-5'])
})

test('Free: Gemini dan Claude gagal (timeout, jawaban kosong) lalu jatuh ke rantai OpenRouter lama', async () => {
  script['gemini-3.5-flash-lite'] = Object.assign(new Error('timeout of 25000ms exceeded'), { code: 'ECONNABORTED' })
  script['claude-haiku-5-5'] = ''
  script['m1'] = LETTER
  const doc = await aiPipelineService.generateCoverLetter(params())
  assert.equal(doc.model, 'openrouter:m1')
  assert.deepEqual(calls.map((c) => c.model), ['gemini-3.5-flash-lite', 'claude-haiku-5-5', 'm1'])
})

test('paket Pro (subscriptions.ai_model_tier = pro): rantai Gemini 4 lalu Claude Sonnet', async () => {
  ;(aiPipelineService as any).tierClient = {
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { ai_model_tier: 'pro' } }) }) }) }),
  }
  script['gemini-4-hydrogen'] = 503
  script['gemini-4-argon'] = 429
  script['claude-sonnet-5-5'] = LETTER
  const doc = await aiPipelineService.generateCoverLetter(params('u-pro'))
  assert.equal(doc.model, 'anthropic:claude-sonnet-5-5')
  assert.deepEqual(calls.map((c) => c.model), ['gemini-4-hydrogen', 'gemini-4-argon', 'claude-sonnet-5-5'])
  assert.ok(calls.every((c) => !/deepseek/i.test(c.model)))
})

test('tierFor: tanpa userId, tanpa data, atau galat database: free', async () => {
  assert.equal(await aiPipelineService.tierFor(undefined), 'free')
  ;(aiPipelineService as any).tierClient = { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }) }) }
  assert.equal(await aiPipelineService.tierFor('u'), 'free')
  ;(aiPipelineService as any).tierClient = { from: () => { throw new Error('db down') } }
  assert.equal(await aiPipelineService.tierFor('u'), 'free')
})
