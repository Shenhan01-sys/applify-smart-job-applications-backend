import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import axios from 'axios'

/**
 * Rantai model dengan penjaga mutu, tanpa jaringan: axios.post/get diganti naskah per model. Tidak ada panggilan
 * OpenRouter atau Groq, dan tracing Langfuse dimatikan. Fixture berasal dari berkas UAT sungguhan.
 */
process.env.OPENROUTER_API_KEY = 'test-key-not-real'
process.env.OPENROUTER_MODEL = 'm1'
process.env.OPENROUTER_FALLBACK_MODELS = 'm1,m2,m3'
delete process.env.GROQ_API_KEY

const { aiPipelineService, OutputRejectedError, InvalidCvError } = await import('../services/ai-pipeline.service.ts')
const { tracingService } = await import('../services/tracing.service.ts')
const { sanitizeLetter } = await import('../services/ai-output-guard.ts')
;(tracingService as any).traceAIGeneration = async () => ({ traceId: 't', generationId: 'g' })

const HERE = path.dirname(fileURLToPath(import.meta.url))
const fx = (name: string) => fs.readFileSync(path.join(HERE, 'fixtures', 'uat', name), 'utf8')
const THINK_CV = fx('cv-think-unterminated-user004.txt')
const VALID_CV = fx('cv-valid-user001.txt')
const TRUNCATED_CV = fx('cv-truncated-user051.txt')
const NONLATIN_LETTER = fx('letter-nonlatin-user001.txt')
const ENGLISH_LETTER = fx('letter-english-user003.txt')
const ID_LETTER = fx('letter-indonesian-greeting-user018.txt')
// Pembersih menghapus spasi di ujung baris (penanda baris baru markdown) dan baris kosong berlebih.
const CLEAN_ID = sanitizeLetter(ID_LETTER).text
const CLEAN_EN = sanitizeLetter(ENGLISH_LETTER).text

const EVAL_OK = `OVERALL_SCORE: 250
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

type Call = { model: string; prompt: string }
let calls: Call[]
let script: Record<string, string | Error | ((prompt: string) => string)>

;(axios as any).get = async () => ({ status: 500, data: {} }) // daftar model tidak tersedia: rantai dipakai apa adanya
;(axios as any).post = async (_url: string, body: any) => {
  const prompt = String(body.messages?.[0]?.content ?? '')
  calls.push({ model: body.model, prompt })
  const reply = script[body.model]
  if (reply instanceof Error) throw reply
  const content = typeof reply === 'function' ? reply(prompt) : reply ?? ''
  return { status: 200, data: { choices: [{ message: { content } }] } }
}

beforeEach(() => {
  calls = []
  script = {}
  ;(aiPipelineService as any).lastModelUsed = null
})

const profile = {
  firstName: 'Siti',
  lastName: 'Yoga',
  currentTitle: 'Frontend Engineer',
  yearsOfExperience: '11',
  skills: ['React', 'TypeScript', 'Tailwind'],
  summary: '11 tahun sebagai Frontend Engineer di Bogor',
  workExperiences: [{ role_title: 'Frontend Engineer', company_name: 'Perusahaan Teknologi A', start_date: '2016-03-01' }],
  education: [{ degree: 'Ilmu Komputer', field_of_study: 'Ilmu Komputer', institution: 'Universitas Padjadjaran', start_year: 2012, end_year: 2016 }],
}
const cvParams = { userProfile: profile, jobTitle: 'Backend Engineer', company: 'GoTo Group', jobDescription: 'Microservices untuk platform Gojek-Tokopedia.' }
const letterParams = {
  jobTitle: 'Akuntan', company: 'Deloitte Indonesia', jobDescription: 'Menyusun laporan keuangan dan audit internal untuk klien.',
  userProfile: { firstName: 'Eko', lastName: 'Dimas', yearsOfExperience: '11', skills: ['Akuntansi', 'Pajak'], summary: 'Akuntan di Bandung' },
}

// ───────────────────────────────────────────── CV

test('CV: jawaban <think> tanpa penutup ditolak dan model berikutnya dipakai; hasil bersih, tidak ada rantai pikir', async () => {
  script = { m1: THINK_CV, m2: VALID_CV }
  const doc = await aiPipelineService.generateCV(cvParams)
  assert.deepEqual(calls.map((c) => c.model), ['m1', 'm2'])
  assert.equal(doc.model, 'openrouter:m2')
  assert.ok(!/<think>|Thinking Process/.test(doc.text))
  assert.ok(!doc.text.includes('**'), 'penanda tebal markdown dibuang')
  assert.match(doc.text, /PROFESSIONAL SUMMARY/)
  assert.equal(doc.language, 'id')
})

test('CV: 200 OK berisi CV terpotong juga ditolak; semua model gagal = galat eksplisit 502, tidak ada teks dikembalikan', async () => {
  script = { m1: THINK_CV, m2: TRUNCATED_CV, m3: '<think>' }
  await assert.rejects(
    aiPipelineService.generateCV(cvParams),
    (e: any) => e instanceof OutputRejectedError && e.statusCode === 502 && e.code === 'output_rejected' &&
      e.reasons.includes('empty') && e.reasons.includes('missing_sections') && /Nothing was saved/.test(e.message)
  )
  assert.equal(calls.length, 3)
})

test('CV: peringatan dasar fakta dikembalikan bersama CV (persen, proyek, sertifikasi tanpa dasar profil), tidak disimpan diam-diam', async () => {
  script = { m1: VALID_CV }
  const doc = await aiPipelineService.generateCV(cvParams)
  const kinds = doc.warnings.map((w) => w.kind)
  assert.ok(kinds.includes('unsupported_percentage'))
  assert.ok(kinds.includes('unsupported_project'))
  assert.ok(kinds.includes('unsupported_certification'))
  assert.equal(calls.length, 1)
})

test('CV: prompt memuat aturan dasar fakta, bahasa, dan tidak lagi menyuruh mengarang capaian atau kontak palsu', async () => {
  script = { m1: VALID_CV }
  await aiPipelineService.generateCV(cvParams)
  const prompt = calls[0].prompt
  assert.match(prompt, /Use ONLY facts that appear in the candidate profile/)
  assert.match(prompt, /Do NOT invent numbers, percentages/)
  assert.match(prompt, /Bahasa Indonesia/)
  assert.match(prompt, /RINGKASAN PROFESIONAL/)
  assert.match(prompt, /Phone: \(not provided\)/)
  assert.doesNotMatch(prompt, /Expand sparse work history into plausible/i)
  assert.doesNotMatch(prompt, /Include metrics, percentages/i)
  assert.doesNotMatch(prompt, /\+62-xxx|candidate@email\.com|linkedin\.com\/in\/candidate/)
})

test('CV: lowongan berbahasa Inggris memakai bahasa dan judul seksi Inggris; language="id" memaksa Indonesia', async () => {
  script = { m1: VALID_CV, m2: VALID_CV }
  const english = 'We are looking for an engineer with experience in building services. You will work with our team on the platform that our customers rely on every day.'
  const doc = await aiPipelineService.generateCV({ ...cvParams, jobDescription: english })
  assert.equal(doc.language, 'en')
  assert.match(calls[0].prompt, /Write the entire output in English/)
  assert.match(calls[0].prompt, /PROFESSIONAL SUMMARY/)
  const forced = await aiPipelineService.generateCV({ ...cvParams, jobDescription: english, language: 'id' })
  assert.equal(forced.language, 'id')
  assert.match(calls[1].prompt, /Bahasa Indonesia/)
})

test('CV: profil tanpa pendidikan tidak mewajibkan seksi Pendidikan; projects dan certifications profil tidak ditandai', async () => {
  script = { m1: TRUNCATED_CV }
  const noEdu = { ...profile, education: [] }
  const doc = await aiPipelineService.generateCV({ ...cvParams, userProfile: noEdu })
  assert.equal(calls.length, 1, 'CV tanpa Pendidikan diterima karena profil memang tanpa pendidikan')
  assert.match(doc.text, /PROFESSIONAL SUMMARY/)
  script = { m1: VALID_CV }
  const withFacts = await aiPipelineService.generateCV({
    ...cvParams,
    userProfile: { ...profile, projects: ['Marketplace Revamp', 'Real‑Time Operations Dashboard'], certifications: ['Certified JavaScript Developer', 'React Professional Certification', 'Employee of the Year'] },
  })
  const kinds = withFacts.warnings.map((w) => w.kind)
  assert.ok(!kinds.includes('unsupported_project'))
  assert.ok(!kinds.includes('unsupported_certification'))
})

// ───────────────────────────────────────────── penilai

test('penilai: CV rantai pikir tidak dinilai (422 invalid_cv) dan tidak ada panggilan model sama sekali', async () => {
  script = { m1: EVAL_OK }
  await assert.rejects(
    aiPipelineService.evaluateCV({ cvText: THINK_CV, jobTitle: 'Backend Engineer', company: 'GoTo Group', jobDescription: 'x' }),
    (e: any) => e instanceof InvalidCvError && e.statusCode === 422 && e.code === 'invalid_cv' && e.reasons.includes('empty')
  )
  assert.equal(calls.length, 0)
})

test('penilai: CV terpotong dan CV dengan placeholder juga ditolak sebelum dinilai', async () => {
  for (const cvText of [TRUNCATED_CV, VALID_CV.replace('Jakarta', '[Location]')]) {
    await assert.rejects(
      aiPipelineService.evaluateCV({ cvText, jobTitle: 'Backend Engineer', company: 'GoTo Group', jobDescription: 'x' }),
      (e: any) => e instanceof InvalidCvError
    )
  }
  assert.equal(calls.length, 0)
})

test('penilai: CV sah dinilai dalam bentuk bersih; jawaban tanpa skor ditolak, model berikutnya dipakai; skor dibatasi 0..100', async () => {
  script = { m1: 'Review needed.', m2: `<think>hitung</think>\n${EVAL_OK}` }
  const ev = await aiPipelineService.evaluateCV({
    cvText: `Berikut CV-nya:\n${VALID_CV}`, jobTitle: 'Backend Engineer', company: 'GoTo Group', jobDescription: 'Node.js, Go',
  })
  assert.deepEqual(calls.map((c) => c.model), ['m1', 'm2'])
  assert.equal(ev.overallScore, 100, '250 dibatasi ke 100')
  assert.equal(ev.atsCompatibilityScore, 85)
  assert.equal(ev.summary, 'Cukup baik untuk posisi ini.')
  assert.ok(!calls[0].prompt.includes('**'), 'CV dikirim ke penilai tanpa penanda markdown')
  assert.ok(!/Berikut CV-nya/.test(calls[0].prompt), 'kalimat pengantar tidak ikut dinilai')
})

// ───────────────────────────────────────────── Privasi kontak (audit 25 November 2026)

test('CV: email dan telepon tidak dikirim ke model; token di baris kontak diganti nilai asli', async () => {
  const withContact = { ...profile, email: 'uji.privasi@contoh.test', phone: '081234567890' }
  script = { m1: () => VALID_CV.replace('\n', '\n{{email}} | {{phone}}\n') }
  const doc = await aiPipelineService.generateCV({ ...cvParams, userProfile: withContact })
  const prompt = calls[0].prompt
  assert.doesNotMatch(prompt, /uji\.privasi@contoh\.test|081234567890/)
  assert.match(prompt, /Email: \{\{email\}\}/)
  assert.match(prompt, /Phone: \{\{phone\}\}/)
  assert.match(doc.text, /uji\.privasi@contoh\.test \| 081234567890/)
  assert.doesNotMatch(doc.text, /\{\{/)
})

test('CV: penilaian ulang menyamarkan email dan telepon di teks CV sebelum dikirim ke model', async () => {
  script = { m1: EVAL_OK }
  const cvText = VALID_CV.replace('\n', '\nuji.privasi@contoh.test | +62 812-3456-7890\n')
  await aiPipelineService.evaluateCV({ cvText, jobTitle: 'Backend Engineer', company: 'GoTo Group', jobDescription: 'x' })
  const prompt = calls[0].prompt
  assert.doesNotMatch(prompt, /uji\.privasi@contoh\.test|812-3456-7890/)
  assert.match(prompt, /\[email\] \| \[telepon\]/)
})

test('penilai: bila tidak ada model yang memberi skor terbaca, galat eksplisit (bukan skor 50 dan "Review needed.")', async () => {
  script = { m1: 'Review needed.', m2: '', m3: 'Maaf, tidak bisa.' }
  await assert.rejects(
    aiPipelineService.evaluateCV({ cvText: VALID_CV, jobTitle: 'Backend Engineer', company: 'GoTo Group', jobDescription: 'x' }),
    (e: any) => e instanceof OutputRejectedError && e.reasons.includes('evaluation_unparseable')
  )
})

// ───────────────────────────────────────────── surat lamaran

test('surat: bawaan Bahasa Indonesia; prompt memuat instruksi bahasa dan aturan dasar fakta', async () => {
  script = { m1: ID_LETTER }
  const doc = await aiPipelineService.generateCoverLetter(letterParams)
  assert.equal(doc.language, 'id')
  assert.match(calls[0].prompt, /Language: Tulis seluruh keluaran dalam Bahasa Indonesia/)
  assert.match(calls[0].prompt, /Do NOT invent numbers, percentages/)
  assert.match(calls[0].prompt, /Use ONLY facts/)
  assert.deepEqual(doc.warnings.filter((w) => w.kind === 'language_mismatch'), [])
})

test('surat: lowongan berbahasa Inggris menghasilkan permintaan bahasa Inggris; language="en" eksplisit juga', async () => {
  script = { m1: ENGLISH_LETTER }
  const english = 'We are looking for an accountant with experience in financial reporting. You will work with our team and our clients on the audit work that we do.'
  const doc = await aiPipelineService.generateCoverLetter({ ...letterParams, jobDescription: english })
  assert.equal(doc.language, 'en')
  assert.match(calls[0].prompt, /Write the entire output in English/)
  const explicit = await aiPipelineService.generateCoverLetter({ ...letterParams, language: 'en' })
  assert.equal(explicit.language, 'en')
  assert.match(calls[1].prompt, /Write the entire output in English/)
})

test('surat: huruf non-Latin menyusup (11 surat UAT) ditolak; model berikutnya dipakai', async () => {
  script = { m1: NONLATIN_LETTER, m2: ID_LETTER }
  const doc = await aiPipelineService.generateCoverLetter(letterParams)
  assert.deepEqual(calls.map((c) => c.model), ['m1', 'm2'])
  assert.equal(doc.text, CLEAN_ID)
  assert.equal(doc.model, 'openrouter:m2')
})

test('surat: model mengabaikan bahasa (Inggris padahal diminta Indonesia): model berikutnya dicoba, yang benar menang', async () => {
  script = { m1: ENGLISH_LETTER, m2: ID_LETTER }
  const doc = await aiPipelineService.generateCoverLetter(letterParams)
  assert.deepEqual(calls.map((c) => c.model), ['m1', 'm2'])
  assert.equal(doc.text, CLEAN_ID)
  assert.deepEqual(doc.warnings.filter((w) => w.kind === 'language_mismatch'), [])
})

test('surat: semua model menjawab Inggris untuk permintaan Indonesia: surat pertama dipakai dengan peringatan language_mismatch', async () => {
  script = { m1: ENGLISH_LETTER, m2: ENGLISH_LETTER, m3: ENGLISH_LETTER }
  const doc = await aiPipelineService.generateCoverLetter(letterParams)
  assert.equal(calls.length, 3)
  assert.equal(doc.text, CLEAN_EN)
  assert.equal(doc.model, 'openrouter:m1')
  assert.ok(doc.warnings.some((w) => w.kind === 'language_mismatch'))
})

test('surat: semua model rantai pikir, huruf asing, atau kosong: galat eksplisit, tidak ada surat', async () => {
  script = { m1: '<think>\nThinking Process: ...', m2: NONLATIN_LETTER, m3: '' }
  await assert.rejects(
    aiPipelineService.generateCoverLetter(letterParams),
    (e: any) => e instanceof OutputRejectedError && e.reasons.includes('stray_script') && e.reasons.includes('empty')
  )
})

test('surat: angka persen yang tidak ada di profil dikembalikan sebagai peringatan', async () => {
  const letter = ID_LETTER.replace('Dengan hormat,', 'Dengan hormat, saya menurunkan biaya audit sebesar 35 % di tempat kerja saya.')
  script = { m1: letter }
  const doc = await aiPipelineService.generateCoverLetter(letterParams)
  const pct = doc.warnings.find((w) => w.kind === 'unsupported_percentage')
  assert.ok(pct)
  assert.deepEqual(pct!.values, ['35%'])
})

test('tulis ulang surat: bahasa surat asli dipertahankan; jawaban berpenalaran ditolak; blok <think> dibuang', async () => {
  script = { m1: NONLATIN_LETTER, m2: `<think>mikir</think>\n${ID_LETTER}` }
  const out = await aiPipelineService.regenerateCoverLetter({
    original: ID_LETTER, instructions: 'lebih singkat', jobTitle: 'Akuntan', company: 'Deloitte Indonesia', jobDescription: 'x',
  })
  assert.equal(out, CLEAN_ID)
  assert.match(calls[0].prompt, /same language as the original letter \(Bahasa Indonesia\)/)
  assert.match(calls[0].prompt, /Do not output your reasoning/)
})

// ───────────────────────────────────────────── jalur lain ikut dibersihkan

test('jawaban pertanyaan formulir: blok <think> dibuang; <think> tanpa penutup dianggap kosong dan model berikutnya dicoba', async () => {
  script = { m1: '<think>\nThinking Process: ...', m2: '<think>x</think>Ya, saya bersedia relokasi.' }
  const answer = await aiPipelineService.generateAnswer({
    question: 'Bersedia relokasi?', questionType: 'text', jobDescription: 'x', userProfile: {},
  })
  assert.equal(answer, 'Ya, saya bersedia relokasi.')
  assert.deepEqual(calls.map((c) => c.model), ['m1', 'm2'])
})
