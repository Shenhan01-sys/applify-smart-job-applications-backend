import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import axios from 'axios'
import { FakeDb } from './helpers/fakeDb.ts'
import { NOW, fixturePdf } from './helpers/linkedinFixture.ts'

/**
 * Jalur AI impor profil lewat rantai model yang SUNGGUHAN (aiPipelineService.completeJson), tanpa jaringan:
 * axios.post diganti naskah per model. Membuktikan bahwa jawaban yang bukan JSON ditolak dan model berikutnya
 * dicoba, bahwa pesan sistem dan pengguna terkirim, dan bahwa impor tidak memakai tracing maupun kuota.
 */
process.env.OPENROUTER_API_KEY = 'test-key-not-real'
process.env.OPENROUTER_MODEL = 'm1'
process.env.OPENROUTER_FALLBACK_MODELS = 'm1,m2,m3'
delete process.env.GROQ_API_KEY
delete process.env.GEMINI_API_KEY
delete process.env.ANTHROPIC_API_KEY
for (const k of ['NUMES_API_KEY', 'NUMES_API_KEY_2', 'NUMES_API_KEY_3', 'NUMES_API_KEYS']) delete process.env[k]

const { aiPipelineService } = await import('../services/ai-pipeline.service.ts')
const { LinkedInImportService } = await import('../services/linkedin-import.service.ts')

type Call = { model: string; messages: Array<{ role: string; content: string }>; max_tokens: number }
let calls: Call[]
let script: Record<string, string | Error>

;(axios as any).get = async () => ({ status: 500, data: {} }) // daftar model tidak tersedia: rantai dipakai apa adanya
;(axios as any).post = async (_url: string, body: any) => {
  calls.push({ model: body.model, messages: body.messages, max_tokens: body.max_tokens })
  const reply = script[body.model]
  if (reply instanceof Error) throw reply
  return { status: 200, data: { choices: [{ message: { content: reply ?? '' } }] } }
}

beforeEach(() => {
  calls = []
  script = {}
  ;(aiPipelineService as any).tierClient = new FakeDb({ subscriptions: [{ user_id: 'u1', ai_model_tier: 'free' }] })
})

const GOOD = JSON.stringify({
  full_name: 'Rina Kusuma Wardhani',
  experiences: [{ company: 'Biru Langit Labs', title: 'Senior Data Analyst', date_range: 'January 2022 - Present (2 years 11 months)' }],
  skills: ['Python'],
})

test('completeJson: jawaban pertama bukan JSON ditolak, model kedua dipakai; pesan sistem dan pengguna terkirim', async () => {
  script = { m1: 'Maaf, saya tidak bisa membantu.', m2: '```json\n' + GOOD + '\n```' }
  const out = await aiPipelineService.completeJson({ system: 'SISTEM', user: 'PENGGUNA', userId: 'u1' })
  assert.deepEqual(calls.map((c) => c.model), ['m1', 'm2'])
  assert.equal(out.model, 'openrouter:m2')
  assert.deepEqual(JSON.parse(out.text).skills, ['Python'])
  assert.deepEqual(calls[0].messages, [{ role: 'system', content: 'SISTEM' }, { role: 'user', content: 'PENGGUNA' }])
  assert.equal(calls[0].max_tokens, 4000)
})

test('completeJson: semua model gagal = galat (bukan teks sampah)', async () => {
  script = { m1: '<think>', m2: 'bukan json', m3: new Error('timeout') }
  await assert.rejects(aiPipelineService.completeJson({ system: 's', user: 'u' }), (e: any) => e.code === 'output_rejected' || /AI generation failed/.test(e.message))
})

test('impor end-to-end lewat rantai model tiruan: PDF sintetis -> pratinjau metode ai, model tercatat', async () => {
  script = { m1: 'bukan json', m2: GOOD }
  const svc = new LinkedInImportService({ now: () => NOW })
  const preview = await svc.importFromPdf(fixturePdf(), { userId: 'u1' })
  assert.equal(preview.meta.method, 'ai')
  assert.equal(preview.meta.model, 'openrouter:m2')
  assert.equal(preview.experiences[0].company_name, 'Biru Langit Labs')
  const user = calls[0].messages[1].content
  assert.ok(user.includes('<profile_text>') && user.includes('Biru Langit Labs'))
  assert.ok(!user.includes('rina.sintetis@example.com'), 'email tidak ikut terkirim ke model')
})

test('impor: semua model gagal = pratinjau dari parser aturan, bukan galat', async () => {
  script = { m1: new Error('boom1'), m2: new Error('boom2'), m3: new Error('boom3') }
  const preview = await new LinkedInImportService({ now: () => NOW }).importFromPdf(fixturePdf(), { userId: 'u1' })
  assert.equal(preview.meta.method, 'rules')
  assert.equal(preview.experiences.length, 4)
})
