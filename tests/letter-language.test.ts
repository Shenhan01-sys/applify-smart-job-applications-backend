import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import axios from 'axios'

/**
 * Uji klik produksi 21 November 2026, temuan 28: surat lamaran satu paragraf tanpa nama posisi, dan jawaban formulir
 * "Mengapa tertarik pada posisi ini" berbahasa Inggris untuk lowongan berbahasa Indonesia. Tanpa jaringan:
 * axios.post diganti naskah, kunci palsu.
 */
process.env.GEMINI_API_KEY = 'gem-test-not-real'
delete process.env.ANTHROPIC_API_KEY
for (const k of ['NUMES_API_KEY', 'NUMES_API_KEY_2', 'NUMES_API_KEY_3', 'NUMES_API_KEYS']) delete process.env[k]
delete process.env.OPENROUTER_API_KEY
delete process.env.GROQ_API_KEY
delete process.env.FREE_MODELS
delete process.env.PRO_MODELS

const HERE = path.dirname(fileURLToPath(import.meta.url))
const LETTER = fs.readFileSync(path.resolve(HERE, 'fixtures', 'uat', 'letter-indonesian-greeting-user018.txt'), 'utf8')
const { aiPipelineService } = await import('../services/ai-pipeline.service.ts')
const { tracingService } = await import('../services/tracing.service.ts')
const { LETTER_MIN_PARAGRAPHS, letterStructureRules } = await import('../services/letter-rules.ts')
;(tracingService as any).traceAIGeneration = async () => ({ traceId: 't', generationId: 'g' })

type Call = { model: string; prompt: string }
let calls: Call[]
;(axios as any).get = async () => ({ status: 500, data: {} })
;(axios as any).post = async (_url: string, body: any) => {
  calls.push({ model: body.model, prompt: String(body.messages?.[0]?.content ?? '') })
  const prompt = String(body.messages?.[0]?.content ?? '')
  return { status: 200, data: { choices: [{ message: { content: prompt.startsWith('Write a compelling cover letter') ? LETTER : 'Jawaban uji.' } }] } }
}
beforeEach(() => {
  calls = []
  ;(aiPipelineService as any).tierClient = undefined
})

const ID_JOB =
  'Kami mencari staf merchandiser yang teliti untuk mengelola stok toko dan bekerja sama dengan tim penjualan. Pengalaman di bidang ritel menjadi nilai tambah.'
const EN_JOB =
  'We are looking for a detail oriented merchandiser to manage store inventory and work with the sales team. Experience in retail is a plus and you will report to the store manager.'

const answer = (questionType: string, jobDescription: string, extra: Record<string, unknown> = {}) =>
  aiPipelineService.generateAnswer({
    question: 'Why are you interested in this role?',
    questionType: questionType as any,
    options: questionType === 'radio' ? ['Yes', 'No'] : undefined,
    jobDescription,
    userProfile: { name: 'Budi Uji', skills: ['Excel'] },
    ...extra,
  })

test('temuan 28: jawaban teks untuk lowongan berbahasa Indonesia diminta dalam Bahasa Indonesia, walau label pertanyaannya Inggris', async () => {
  for (const type of ['textarea', 'text']) {
    calls = []
    await answer(type, ID_JOB)
    assert.match(calls[0].prompt, /Language: Tulis seluruh keluaran dalam Bahasa Indonesia/, `tipe ${type}`)
    assert.doesNotMatch(calls[0].prompt, /Write the entire output in English/)
  }
})

test('temuan 28: lowongan kosong atau pendek tetap Bahasa Indonesia (bawaan)', async () => {
  await answer('textarea', '')
  assert.match(calls[0].prompt, /Bahasa Indonesia/)
  calls = []
  await answer('textarea', 'Bangun API.')
  assert.match(calls[0].prompt, /Bahasa Indonesia/)
})

test('temuan 28: lowongan yang jelas berbahasa Inggris, atau permintaan eksplisit, memakai English', async () => {
  await answer('textarea', EN_JOB)
  assert.match(calls[0].prompt, /Language: Write the entire output in English/)
  calls = []
  await answer('textarea', ID_JOB, { language: 'en' })
  assert.match(calls[0].prompt, /Language: Write the entire output in English/)
  calls = []
  await answer('textarea', EN_JOB, { language: 'id' })
  assert.match(calls[0].prompt, /Language: Tulis seluruh keluaran dalam Bahasa Indonesia/)
})

test('temuan 28: pilihan, radio, dan kotak centang tidak diberi instruksi bahasa (jawabannya salah satu opsi apa adanya)', async () => {
  for (const type of ['radio', 'select', 'checkbox']) {
    calls = []
    await answer(type, ID_JOB)
    assert.doesNotMatch(calls[0].prompt, /Language:/, `tipe ${type}`)
  }
})

test('temuan 28: prompt surat lamaran mewajibkan nama posisi, nama perusahaan, dan paling sedikit tiga paragraf pendek', async () => {
  await aiPipelineService.generateCoverLetter({
    jobTitle: 'Staf Merchandiser - Fullstack Developer',
    company: 'FIN HOMEMART',
    jobDescription: ID_JOB,
    userProfile: { firstName: 'Budi', lastName: 'Uji', yearsOfExperience: '2', skills: ['Excel'], summary: 'Staf toko.' },
    language: 'id',
  } as any)
  const prompt = calls[0].prompt
  assert.equal(LETTER_MIN_PARAGRAPHS, 3)
  assert.match(prompt, /Name the exact position "Staf Merchandiser - Fullstack Developer" and the company "FIN HOMEMART" in the first paragraph/)
  assert.match(prompt, /melamar posisi Staf Merchandiser - Fullstack Developer di FIN HOMEMART/)
  assert.match(prompt, /at least 3 short paragraphs separated by one blank line/)
  assert.match(prompt, /Never output the letter as one block of text/)
  // aturan itu ada di daftar Instructions, sebelum aturan grounding
  assert.ok(prompt.indexOf('Instructions:') < prompt.indexOf('Name the exact position'))
  assert.ok(prompt.indexOf('Name the exact position') < prompt.indexOf('Grounding rules (strict)'))
  assert.match(prompt, /Language: Tulis seluruh keluaran dalam Bahasa Indonesia/)
})

test('temuan 28: letterStructureRules memuat judul dan perusahaan sebagai satu baris, tanpa kutip ganda, dengan cadangan bila kosong', () => {
  const [naming] = letterStructureRules('Staf\n"Senior"\tAnalis', '  PT   Contoh  ')
  assert.ok(naming.includes('"Staf \'Senior\' Analis"'))
  assert.ok(naming.includes('"PT Contoh"'))
  assert.ok(!/\n/.test(naming))
  const fallback = letterStructureRules(undefined, 42)
  assert.ok(fallback[0].includes('"the position"') && fallback[0].includes('"the company"'))
  assert.equal(letterStructureRules('x'.repeat(500), 'y')[0].includes('x'.repeat(121)), false)
})

test('temuan 28: salinan aturan surat di Edge Function identik dengan backend, dan Edge Function memasangnya di prompt', (t) => {
  const edge = path.resolve(HERE, '..', '..', 'applify-smart-job-applications', 'supabase', 'functions', '_shared', 'letter-rules.ts')
  const fn = path.resolve(HERE, '..', '..', 'applify-smart-job-applications', 'supabase', 'functions', 'generate-application', 'index.ts')
  if (!fs.existsSync(edge) || !fs.existsSync(fn)) return t.skip('repositori frontend tidak ada di samping backend')
  assert.equal(fs.readFileSync(edge, 'utf8'), fs.readFileSync(path.resolve(HERE, '..', 'services', 'letter-rules.ts'), 'utf8'), 'salinan Edge Function berbeda')
  const src = fs.readFileSync(fn, 'utf8')
  assert.match(src, /import \{ letterStructureRules \} from "\.\.\/_shared\/letter-rules\.ts";/)
  assert.match(src, /LETTER STRUCTURE \(strict\):\n\$\{letterStructureRules\(job\.title, job\.company\)/)
  assert.match(src, /in at least 3 short paragraphs separated by \\\\n\\\\n, naming the position title and the company/)
})
