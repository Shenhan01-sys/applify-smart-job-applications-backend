import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import Fastify, { type FastifyInstance } from 'fastify'
import { aiPipelineService, InvalidCvError, OutputRejectedError } from '../services/ai-pipeline.service.ts'
import { formAutofillService } from '../services/form-autofill.service.ts'
import { aiRoutes, FILL_FORM_CONCURRENCY, MAX_FILL_FORM_FIELDS } from '../api/routes/ai.ts'

/**
 * HTTP-level check of /api/ai/cv, /api/ai/cv/evaluate and /api/ai/cover-letter with the pipeline replaced:
 * no model is called. Verifies what the UI receives: warnings, language, and explicit errors.
 * Login and the quota/rate-limit guard are covered in ai-guard.test.ts; here a signed-in user and a guard
 * that lets everything through stand in for them.
 */
let app: FastifyInstance
const original = {
  generateCV: aiPipelineService.generateCV,
  generateCoverLetter: aiPipelineService.generateCoverLetter,
  evaluateCV: aiPipelineService.evaluateCV,
  extractSkills: aiPipelineService.extractSkills,
  analyzeJobMatch: aiPipelineService.analyzeJobMatch,
}
const originalFillField = formAutofillService.fillField

beforeEach(async () => {
  app = Fastify()
  app.addHook('preHandler', async (req) => {
    ;(req as any).user = { id: 'u1' }
  })
  const guard = { check: async () => ({ quota: { quota: 10, used: 0, remaining: 10, allowed: true } }), recordDraft: async () => {} }
  await app.register(aiRoutes, { prefix: '/api/ai', guard })
})
afterEach(async () => {
  Object.assign(aiPipelineService, original)
  formAutofillService.fillField = originalFillField
  await app.close()
})

const post = (url: string, payload: any) => app.inject({ method: 'POST', url, payload })
const warning = { kind: 'unsupported_percentage', values: ['30%'], count: 1, message: 'Angka persen ini tidak ada di profilmu: 30%.' }

test('POST /cv mengembalikan teks CV, bahasa, model, dan peringatan dasar fakta; language diteruskan ke pipeline', async () => {
  let seen: any
  ;(aiPipelineService as any).generateCV = async (p: any) => {
    seen = p
    return { text: 'CV bersih', warnings: [warning], language: 'id', model: 'openrouter:m2' }
  }
  const res = await post('/api/ai/cv', { jobTitle: 'Dev', company: 'PT X', jobDescription: 'd', userProfile: { firstName: 'A' }, language: 'en' })
  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.json(), { success: true, cv: 'CV bersih', model: 'openrouter:m2', language: 'id', warnings: [warning] })
  assert.equal(seen.language, 'en')
})

test('POST /cover-letter mengembalikan surat, bahasa, dan peringatan; language diteruskan', async () => {
  let seen: any
  ;(aiPipelineService as any).generateCoverLetter = async (p: any) => {
    seen = p
    return { text: 'Surat bersih', warnings: [], language: 'id', model: 'groq:openai/gpt-oss-120b' }
  }
  const res = await post('/api/ai/cover-letter', { jobTitle: 'Dev', company: 'PT X', jobDescription: 'd', userProfile: {}, language: 'auto' })
  assert.equal(res.statusCode, 200)
  const body = res.json()
  assert.equal(body.coverLetter, 'Surat bersih')
  assert.equal(body.language, 'id')
  assert.deepEqual(body.warnings, [])
  assert.equal(seen.language, 'auto')
})

test('POST /cv: semua model ditolak penjaga mutu = 502 output_rejected dengan alasan, bukan 500 dan bukan teks sampah', async () => {
  ;(aiPipelineService as any).generateCV = async () => {
    throw new OutputRejectedError(['empty', 'missing_sections'], 3)
  }
  const res = await post('/api/ai/cv', { jobTitle: 'Dev', company: 'PT X', jobDescription: 'd', userProfile: {} })
  assert.equal(res.statusCode, 502)
  const body = res.json()
  assert.equal(body.success, false)
  assert.equal(body.code, 'output_rejected')
  assert.deepEqual(body.reasons, ['empty', 'missing_sections'])
  assert.equal('cv' in body, false)
})

test('POST /cv/evaluate: CV tidak valid = 422 invalid_cv, tanpa evaluasi; CV sah = evaluasi', async () => {
  ;(aiPipelineService as any).evaluateCV = async () => {
    throw new InvalidCvError(['empty'], ['keluaran kosong setelah dibersihkan'])
  }
  const bad = await post('/api/ai/cv/evaluate', { cvText: '<think>...', jobTitle: 'Dev', company: 'PT X', jobDescription: 'd' })
  assert.equal(bad.statusCode, 422)
  assert.equal(bad.json().code, 'invalid_cv')
  assert.equal('evaluation' in bad.json(), false)

  let seen: any
  ;(aiPipelineService as any).evaluateCV = async (p: any) => {
    seen = p
    return { overallScore: 80 }
  }
  const ok = await post('/api/ai/cv/evaluate', { cvText: 'CV', jobTitle: 'Dev', company: 'PT X', jobDescription: 'd', requireEducation: false })
  assert.equal(ok.statusCode, 200)
  assert.equal(ok.json().evaluation.overallScore, 80)
  assert.equal(seen.requireEducation, false)
})

test('galat biasa tetap 500 dengan pesan', async () => {
  ;(aiPipelineService as any).generateCoverLetter = async () => {
    throw new Error('AI generation failed after 8 OpenRouter + Groq model attempts')
  }
  const res = await post('/api/ai/cover-letter', { jobTitle: 'Dev', company: 'PT X', jobDescription: 'd', userProfile: {} })
  assert.equal(res.statusCode, 500)
  assert.match(res.json().error, /AI generation failed/)
})

test('BS-02 POST /fill-form menolak fields bukan array, jumlah kolom > batas, context kosong, dan tipe/label tidak valid (400)', async () => {
  let called = 0
  formAutofillService.fillField = (async () => {
    called++
    return { field: { type: 'text', label: 'x' }, value: 'v', confidence: 0.9, source: 'rule', needsReview: false }
  }) as any

  const notArray = await post('/api/ai/fill-form', { fields: 'not-an-array', context: {} })
  assert.equal(notArray.statusCode, 400)
  assert.equal(notArray.json().code, 'invalid_fields')

  const tooMany = await post('/api/ai/fill-form', {
    fields: Array.from({ length: MAX_FILL_FORM_FIELDS + 1 }, (_, i) => ({ type: 'text', label: `Q${i}` })),
    context: { userSettings: {} },
  })
  assert.equal(tooMany.statusCode, 400)
  assert.equal(tooMany.json().code, 'too_many_fields')

  const noContext = await post('/api/ai/fill-form', { fields: [{ type: 'text', label: 'Nama' }] })
  assert.equal(noContext.statusCode, 400)
  assert.equal(noContext.json().code, 'invalid_context')

  const badType = await post('/api/ai/fill-form', {
    fields: [{ type: 'script', label: 'Nama' }],
    context: {},
  })
  assert.equal(badType.statusCode, 400)
  assert.equal(badType.json().code, 'invalid_field')

  const emptyLabel = await post('/api/ai/fill-form', {
    fields: [{ type: 'text', label: '   ' }],
    context: {},
  })
  assert.equal(emptyLabel.statusCode, 400)
  assert.equal(emptyLabel.json().code, 'invalid_field')

  assert.equal(called, 0, 'tidak satu pun panggilan autofill/LLM boleh dijalankan untuk input tak valid')
})

test('BS-02 POST /fill-form membatasi konkurensi pemrosesan dan mengembalikan urutan hasil yang konsisten', async () => {
  let active = 0
  let maxActive = 0
  formAutofillService.fillField = (async (field: any) => {
    active++
    if (active > maxActive) maxActive = active
    await new Promise((r) => setTimeout(r, 10))
    active--
    return { field, value: `ans:${field.label}`, confidence: 0.9, source: 'rule', needsReview: false }
  }) as any

  const fields = Array.from({ length: 12 }, (_, i) => ({ type: 'text', label: `Field-${i}` }))
  const res = await post('/api/ai/fill-form', { fields, context: {} })
  assert.equal(res.statusCode, 200)
  assert.equal(res.json().results.length, 12)
  assert.deepEqual(
    res.json().results.map((r: any) => r.value),
    fields.map((f) => `ans:${f.label}`),
  )
  assert.ok(maxActive <= FILL_FORM_CONCURRENCY, `konkurensi ${maxActive} melebihi batas ${FILL_FORM_CONCURRENCY}`)
})

test('BS-02 POST /extract-skills dan /analyze-match menolak jobDescription kosong (400) dan meneruskan OutputRejectedError sebagai 502', async () => {
  assert.equal((await post('/api/ai/extract-skills', { jobDescription: '  ' })).statusCode, 400)
  assert.equal((await post('/api/ai/analyze-match', { jobDescription: '' })).statusCode, 400)

  ;(aiPipelineService as any).analyzeJobMatch = async () => {
    throw new OutputRejectedError(['missing_match_score'], 2)
  }
  const rej = await post('/api/ai/analyze-match', { jobDescription: 'Backend Engineer', userSkills: ['Node.js'] })
  assert.equal(rej.statusCode, 502)
  assert.equal(rej.json().code, 'output_rejected')
})
