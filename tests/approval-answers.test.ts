import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { FakeDb } from './helpers/fakeDb.ts'
import { aiPipelineService } from '../services/ai-pipeline.service.ts'
import { formAutofillService } from '../services/form-autofill.service.ts'
import {
  buildApprovalAnswers,
  confidenceLevel,
  coverLetterFromApplication,
  prepareApprovalAnswers,
  sanitizeClientAnswers,
} from '../services/approval-answers.service.ts'

// AI is always replaced: no OpenRouter or Groq request leaves the machine in these tests. Outside a test
// that installs its own mock, a call to the real AI throws instead of going to the network.
const blockRealAI = async () => {
  throw new Error('real AI call blocked in tests')
}
;(aiPipelineService as any).generateAnswer = blockRealAI
let aiCalls = 0
const mockAI = (impl: () => Promise<string>) => {
  aiCalls = 0
  ;(aiPipelineService as any).generateAnswer = async () => {
    aiCalls++
    return impl()
  }
}
afterEach(() => {
  ;(aiPipelineService as any).generateAnswer = blockRealAI
})

const fullSettings = {
  first_name: 'Budi',
  last_name: 'Uji',
  phone_number: '+628111111111',
  current_city: 'Yogyakarta',
  years_of_experience: '3',
  desired_salary: 9000000,
  notice_period: 30,
  // huruf kecil = pilihan pengguna di Pengaturan Agen; "No" persis adalah nilai bawaan database (applicant-fallbacks.ts)
  require_visa: 'no',
  linkedin_url: 'https://linkedin.example/in/budi',
}
const job = { title: 'Backend Engineer', company: 'Contoh PT', description: 'Bangun API.' }
const profile = { email: 'budi@contoh.test', skills: ['TypeScript'] }

const byQuestion = (rows: Awaited<ReturnType<typeof buildApprovalAnswers>>, part: string) => {
  const r = rows.find((x) => x.question.includes(part))
  assert.ok(r, `pertanyaan "${part}" tidak ditemukan`)
  return r!
}

test('confidenceLevel: >0,8 tinggi; 0,5 sampai 0,8 sedang; <0,5 rendah', () => {
  assert.equal(confidenceLevel(0.99), 'high')
  assert.equal(confidenceLevel(0.81), 'high')
  assert.equal(confidenceLevel(0.8), 'medium')
  assert.equal(confidenceLevel(0.75), 'medium')
  assert.equal(confidenceLevel(0.5), 'medium')
  assert.equal(confidenceLevel(0.49), 'low')
  assert.equal(confidenceLevel(0), 'low')
  assert.equal(confidenceLevel(Number.NaN), 'low')
})

test('data lengkap: jawaban aturan tetap berkeyakinan tinggi dan tidak ditandai; jawaban AI ditandai', async () => {
  mockAI(async () => 'Saya tertarik karena stack-nya cocok.')
  const rows = await buildApprovalAnswers({ settings: fullSettings, profile, job })
  assert.equal(rows.length, 11)

  const name = byQuestion(rows, 'Nama lengkap')
  assert.equal(name.answer, 'Budi Uji')
  assert.equal(name.source, 'rule')
  assert.ok(name.confidence > 0.8)
  assert.equal(name.needs_review, false)

  assert.equal(byQuestion(rows, 'Email').answer, 'budi@contoh.test')
  assert.equal(byQuestion(rows, 'Kota domisili').answer, 'Yogyakarta')
  assert.equal(byQuestion(rows, 'Butuh sponsor visa').answer, 'No')

  const why = byQuestion(rows, 'Mengapa tertarik')
  assert.equal(why.source, 'ai')
  assert.equal(why.confidence, 0.75)
  assert.equal(why.needs_review, true, 'jawaban AI selalu ditandai untuk dicek')
  assert.equal(aiCalls, 1, 'hanya satu pertanyaan yang memanggil AI')
})

test('AI selalu ditandai walau pengguna mematikan pause_at_failed_question', async () => {
  mockAI(async () => 'Jawaban AI.')
  const rows = await buildApprovalAnswers({
    settings: { ...fullSettings, pause_at_failed_question: false },
    profile,
    job,
  })
  assert.equal(byQuestion(rows, 'Mengapa tertarik').needs_review, true)
})

test('data sumber kosong: jawaban dikosongkan, keyakinan 0, wajib dicek (tidak ada nilai bawaan palsu)', async () => {
  mockAI(async () => 'x')
  const rows = await buildApprovalAnswers({ settings: {}, profile: { email: null }, job })
  for (const part of ['Nama lengkap', 'Email', 'Nomor telepon', 'Kota domisili', 'Negara', 'Total pengalaman', 'Ekspektasi gaji', 'notice', 'sponsor visa', 'LinkedIn']) {
    const r = byQuestion(rows, part)
    assert.equal(r.answer, '', part)
    assert.equal(r.confidence, 0, part)
    assert.equal(r.needs_review, true, part)
  }
})

test('kota kosong tidak lagi diisi dari kata terakhir judul lowongan', async () => {
  const res = await formAutofillService.fillField(
    { type: 'text', label: 'Current city' },
    { jobTitle: 'Senior Backend Engineer', company: 'X', jobDescription: '', userSettings: {}, userProfile: {} }
  )
  assert.equal(res.value, '')
  assert.equal(res.confidence, 0)
})

test('AI gagal: pertanyaan itu jatuh ke jawaban bawaan berkeyakinan rendah, bukan error', async () => {
  mockAI(async () => {
    throw new Error('semua model gagal')
  })
  const rows = await buildApprovalAnswers({ settings: fullSettings, profile, job })
  const why = byQuestion(rows, 'Mengapa tertarik')
  assert.equal(why.source, 'default')
  assert.equal(why.confidence, 0.3)
  assert.equal(why.needs_review, true)
  assert.equal(confidenceLevel(why.confidence), 'low')
})

test('use_ai=false: AI tidak dipanggil', async () => {
  mockAI(async () => 'x')
  await buildApprovalAnswers({ settings: { ...fullSettings, use_ai: false }, profile, job })
  assert.equal(aiCalls, 0)
})

test('nama perusahaan di label tidak memicu aturan kata kunci (GoPay, Real Estate)', async () => {
  mockAI(async () => 'AI')
  for (const company of ['GoPay', 'Real Estate Group']) {
    const rows = await buildApprovalAnswers({ settings: fullSettings, profile, job: { ...job, company } })
    assert.equal(byQuestion(rows, 'Mengapa tertarik').source, 'ai', company)
  }
})

test('filler yang melempar: jawaban kosong dan ditandai, daftar tetap lengkap', async () => {
  const rows = await buildApprovalAnswers({ settings: fullSettings, profile, job }, async () => {
    throw new Error('boom')
  })
  assert.equal(rows.length, 11)
  assert.ok(rows.every((r) => r.needs_review && r.answer === ''))
})

test('prepareApprovalAnswers: baca pengaturan dari database dan tidak pernah melempar', async () => {
  mockAI(async () => 'AI')
  const db = new FakeDb({
    user_automation_settings: [{ user_id: 'u1', ...fullSettings }],
    user_skills: [{ user_id: 'u1', name: 'TypeScript' }],
    jobs: [{ id: 'j1', description: 'Bangun API.' }],
  })
  const rows = await prepareApprovalAnswers(db, { userId: 'u1', email: 'budi@contoh.test', jobId: 'j1', jobTitle: 'BE', company: 'C' })
  assert.equal(rows.length, 11)
  assert.equal(byQuestion(rows, 'Nama lengkap').answer, 'Budi Uji')

  const broken = { from: () => { throw new Error('db down') } }
  assert.deepEqual(await prepareApprovalAnswers(broken as any, { userId: 'u1', jobTitle: 'BE', company: 'C' }), [])
})

test('Profil mengisi kolom Pengaturan Otomasi yang kosong; sumber "profile"; Pengaturan Otomasi tetap menang', async () => {
  mockAI(async () => 'AI')
  const profileRow = {
    full_name: 'Hans Gunawan',
    location: 'Yogyakarta, Indonesia',
    experience_years: 2,
    phone: '+6281234567890',
    linkedin_url: 'https://linkedin.example/in/hans',
    portfolio_url: 'https://hans.example',
  }
  // Pengaturan Otomasi kosong: semuanya dari Profil, email dari akun.
  const rows = await buildApprovalAnswers({ settings: {}, profileRow, profile: { email: 'hans@contoh.test' }, job })
  const name = byQuestion(rows, 'Nama lengkap')
  assert.equal(name.answer, 'Hans Gunawan')
  assert.equal(name.source, 'profile')
  assert.equal(name.needs_review, false)
  assert.equal(byQuestion(rows, 'Email').source, 'rule')
  assert.equal(byQuestion(rows, 'Email').answer, 'hans@contoh.test')
  assert.equal(byQuestion(rows, 'Nomor telepon').answer, '+6281234567890')
  const city = byQuestion(rows, 'Kota domisili')
  assert.equal(city.answer, 'Yogyakarta')
  assert.equal(city.source, 'profile')
  assert.equal(city.confidence, 0.75)
  assert.equal(city.needs_review, true, 'kota diturunkan dari teks bebas: dicek pengguna')
  const years = byQuestion(rows, 'Total pengalaman')
  assert.equal(years.answer, '2')
  assert.equal(years.source, 'profile')
  assert.equal(byQuestion(rows, 'LinkedIn').answer, 'https://linkedin.example/in/hans')
  // Data yang memang tidak ada tetap kosong dan wajib dicek.
  assert.equal(byQuestion(rows, 'Ekspektasi gaji').answer, '')

  // Pengaturan Otomasi yang terisi menang atas Profil.
  const mixed = await buildApprovalAnswers({
    settings: { first_name: 'Budi', last_name: 'Uji', current_city: 'Bandung', years_of_experience: '5' },
    profileRow,
    profile: { email: 'x@contoh.test' },
    job,
  })
  assert.equal(byQuestion(mixed, 'Nama lengkap').answer, 'Budi Uji')
  assert.equal(byQuestion(mixed, 'Nama lengkap').source, 'rule')
  assert.equal(byQuestion(mixed, 'Kota domisili').answer, 'Bandung')
  assert.equal(byQuestion(mixed, 'Total pengalaman').answer, '5')
  assert.equal(byQuestion(mixed, 'Nomor telepon').source, 'profile') // hanya kolom kosong yang diisi Profil

  // experience_years 0 (nilai bawaan kolom) tidak dianggap jawaban.
  const zero = await buildApprovalAnswers({ settings: {}, profileRow: { ...profileRow, experience_years: 0 }, profile: {}, job })
  assert.equal(byQuestion(zero, 'Total pengalaman').answer, '')
})

test('prepareApprovalAnswers membaca profiles dari database', async () => {
  mockAI(async () => 'AI')
  const db = new FakeDb({
    profiles: [{ id: 'u2', full_name: 'Hans Gunawan', location: 'Yogyakarta, Indonesia', experience_years: 2 }],
  })
  const rows = await prepareApprovalAnswers(db, { userId: 'u2', email: 'hans@contoh.test', jobTitle: 'FE', company: 'C' })
  assert.equal(byQuestion(rows, 'Nama lengkap').answer, 'Hans Gunawan')
  assert.equal(byQuestion(rows, 'Kota domisili').answer, 'Yogyakarta')
})

test('coverLetterFromApplication: surat dari ai_applications milik pengguna itu saja', async () => {
  const db = new FakeDb({
    ai_applications: [
      { id: 'a1', user_id: 'u1', cover_letter: '  Surat saya.  ' },
      { id: 'a2', user_id: 'u2', cover_letter: 'Surat orang lain' },
      { id: 'a3', user_id: 'u1', cover_letter: '   ' },
    ],
  })
  assert.equal(await coverLetterFromApplication(db, 'u1', 'a1'), 'Surat saya.')
  assert.equal(await coverLetterFromApplication(db, 'u1', 'a2'), null, 'milik pengguna lain')
  assert.equal(await coverLetterFromApplication(db, 'u1', 'a3'), null, 'kosong')
  assert.equal(await coverLetterFromApplication(db, 'u1', 'tidak-ada'), null)
  assert.equal(await coverLetterFromApplication({ from: () => { throw new Error('db down') } }, 'u1', 'a1'), null)
})

test('sanitizeClientAnswers: bentuk salah dibuang, nilai dibatasi, needs_review default true', () => {
  assert.deepEqual(sanitizeClientAnswers('x'), [])
  const out = sanitizeClientAnswers([
    { question: 'Q1', answer: 'A', confidence: 7, needs_review: false, source: 'rule' },
    { question: 'Q2', answer: 'B', confidence: 'abc' },
    { nope: 1 },
    null,
  ])
  assert.equal(out.length, 2)
  assert.equal(out[0].confidence, 1)
  assert.equal(out[0].needs_review, false)
  assert.equal(out[1].confidence, 0)
  assert.equal(out[1].needs_review, true)
  assert.equal(out[1].source, 'default')
})

test('AI yang menggantung tidak menahan pengajuan: lewat batas waktu, jawaban dikosongkan dan ditandai', async () => {
  const slow = async (field: any, ctx: any) => {
    if (field.type === 'textarea') {
      await new Promise((r) => setTimeout(r, 300))
      return { field, value: 'terlambat', confidence: 0.75, source: 'ai' as const, needsReview: true }
    }
    return formAutofillService.fillField(field, ctx)
  }
  mockAI(async () => 'terlambat')
  const started = Date.now()
  const rows = await buildApprovalAnswers({ settings: fullSettings, profile, job }, slow, 30)
  assert.ok(Date.now() - started < 250, 'tidak menunggu filler yang lambat')
  const why = byQuestion(rows, 'Mengapa tertarik')
  assert.equal(why.answer, '')
  assert.equal(why.needs_review, true)
  assert.equal(why.confidence, 0)
  assert.equal(byQuestion(rows, 'Nama lengkap').answer, 'Budi Uji', 'pertanyaan lain tetap terjawab')
})
