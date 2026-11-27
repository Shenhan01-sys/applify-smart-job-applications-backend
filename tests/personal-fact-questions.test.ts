import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import Fastify from 'fastify'
import {
  NEEDS_CHECK_LABEL,
  personalFactCategory,
  splitPersonalFactQuestions,
} from '../services/personal-fact-questions.ts'
import { classifyPersonalFact } from '../services/personal-fact-extras.ts'
import { aiPipelineService, PersonalFactQuestionError } from '../services/ai-pipeline.service.ts'
import { formAutofillService, type FormContext, type FormField } from '../services/form-autofill.service.ts'
import { buildApprovalAnswers } from '../services/approval-answers.service.ts'
import { aiRoutes } from '../api/routes/ai.ts'
import { ExtensionPlanner, personalFactAnswerAllowed, questionKey } from '../services/extension-planner.ts'
import { makeExtensionTestDb, USER_ID } from './extension-test-db.ts'

/**
 * Pertanyaan formulir yang menanyakan fakta pribadi tidak dijawab AI (temuan E2E production 27 November 2026): kartunya
 * "Perlu dicek" dan pengguna yang menjawab. Hanya data yang pengguna simpan sendiri untuk pertanyaan yang sama yang dipakai.
 * Klasifikatornya salinan dari frontend (personal-fact-questions.ts) plus pelengkap lokal (personal-fact-extras.ts).
 */

const HERE = path.dirname(fileURLToPath(import.meta.url))
const MARKER = '// ---- salinan dimulai di bawah baris ini ----\n'

test('personal-fact-questions.ts: isi di bawah penanda sama persis dengan berkas frontend', (t) => {
  const original = path.resolve(
    HERE,
    '..',
    '..',
    'applify-smart-job-applications',
    'supabase',
    'functions',
    '_shared',
    'personal-fact-questions.ts',
  )
  if (!existsSync(original)) return t.skip('repositori frontend tidak ada di samping backend')
  const copy = readFileSync(path.resolve(HERE, '../services/personal-fact-questions.ts'), 'utf8')
  const at = copy.indexOf(MARKER)
  assert.ok(at > 0, 'penanda salinan hilang')
  assert.equal(copy.slice(at + MARKER.length), readFileSync(original, 'utf8'))
  assert.match(copy.slice(0, at), /SALINAN\. Asal: applify-smart-job-applications\/supabase\/functions\/_shared\/personal-fact-questions\.ts/)
})

// ---- salinan frontend: perilaku yang sama --------------------------------------------------------------------------

test('klasifikator frontend: pertanyaan fakta pribadi dikenali (Inggris dan Indonesia)', () => {
  const personal: Array<[string, string]> = [
    ['Are you a citizen of the United States?', 'citizenship'],
    ['Apakah Anda warga negara Indonesia?', 'citizenship'],
    ['Nationality', 'citizenship'],
    ['Are you legally authorized to work in the country where this job is located?', 'work_authorization'],
    ['Apakah Anda memiliki izin kerja?', 'work_authorization'],
    ['Do you hold a valid work visa?', 'work_authorization'],
    ['Will you now or in the future require sponsorship for employment visa status?', 'sponsorship'],
    ['Do you have any relatives who are government officials or employees?', 'government_relative'],
    ['Apakah Anda memiliki kerabat yang menjabat sebagai pejabat pemerintah?', 'government_relative'],
    ['Have you previously worked at Coinbase?', 'prior_employment'],
    ['Apakah Anda pernah bekerja di perusahaan ini?', 'prior_employment'],
    ['How did you hear about this job?', 'job_source'],
    ['Dari mana Anda mengetahui lowongan ini?', 'job_source'],
    ['Are you available for a 12-week internship from June to August?', 'internship_availability'],
    ['Apakah Anda bersedia mengikuti durasi magang selama 6 bulan?', 'internship_availability'],
    ['What is your earliest start date?', 'internship_availability'],
    ['Have you ever been convicted of a felony?', 'criminal_record'],
    ['Gender', 'demographics'],
    ['Veteran status', 'demographics'],
  ]
  for (const [label, category] of personal) assert.equal(personalFactCategory(label), category, label)
})

test('klasifikator frontend: pertanyaan yang boleh dijawab dari profil tidak ikut ditandai', () => {
  const fine = [
    'Why do you want to work at Coinbase?',
    'Link to your GitHub profile',
    'Years of experience with TypeScript',
    'Describe a project you are proud of',
    'Apa alasan Anda tertarik pada posisi ini?',
    'LinkedIn URL',
    'Nama lengkap',
    'Which programming languages do you know?',
    '',
  ]
  for (const label of fine) assert.equal(personalFactCategory(label), null, label)
  assert.equal(personalFactCategory(undefined), null)
  assert.equal(personalFactCategory(null, ['Yes', 'No']), null)
})

test('splitPersonalFactQuestions memisahkan yang harus dijawab pengguna dan memberi alasan, pilihan ikut dibaca', () => {
  const questions = [
    { key: 'why', label: 'Why do you want to join?' },
    { key: 'citizen', label: 'Citizenship status', options: ['Citizen', 'Permanent resident'] },
    { key: 'src', label: 'Source', options: ['LinkedIn', 'How did you hear about us - referral'] },
    { key: 'visa', label: 'Apakah Anda membutuhkan sponsor visa?' },
  ]
  const { answerable, needsUser } = splitPersonalFactQuestions(questions)
  assert.deepEqual(answerable.map((q) => q.key), ['why'])
  assert.deepEqual(needsUser.map((n) => [n.question.key, n.category]), [
    ['citizen', 'citizenship'],
    ['src', 'job_source'],
    ['visa', 'sponsorship'],
  ])
  assert.ok(needsUser.every((n) => n.reason.length > 10))
  assert.equal(NEEDS_CHECK_LABEL, 'Perlu dicek')
})

// ---- pelengkap lokal ---------------------------------------------------------------------------------------------

test('classifyPersonalFact: usia, pemakaian produk, NIK atau KTP, hadir di kantor, rujukan, dan bekerja di perusahaan itu', () => {
  const cases: Array<[string, string]> = [
    ['Are you at least 18 years of age?', 'age_requirement'],
    ['Are you over 18?', 'age_requirement'],
    ['Are you 18 or older?', 'age_requirement'],
    ['Apakah usia Anda minimal 18 tahun?', 'age_requirement'],
    ['Do you currently use any Coinbase products?', 'product_usage'],
    ['Are you an existing customer of ours?', 'product_usage'],
    ['Please enter your NIK (national ID number)', 'national_id'],
    ['Nomor KTP', 'national_id'],
    ['Are you willing to work from the office 5 days a week?', 'office_attendance'],
    ['Are you open to hybrid work?', 'office_attendance'],
    ['Bersedia bekerja dari kantor?', 'office_attendance'],
    ['Were you referred by a senior leader at the company?', 'job_source'],
    ['Do you know anyone who works at Coinbase?', 'employee_referral'],
    ['Do you have any friends or family members that work at Coinbase?', 'employee_referral'],
    ['Are you currently or have you previously been employed by Coinbase?', 'prior_employment'],
    ['Are you Hispanic/Latino?', 'demographics'],
    ['What is your gender identity?', 'demographics'],
    ['Do you have a conflict of interest with Coinbase?', 'government_relative'],
  ]
  for (const [label, category] of cases) assert.equal(classifyPersonalFact(label)?.category, category, label)
  // Aturan frontend tetap menang dan reasonnya dari tabel frontend.
  assert.equal(classifyPersonalFact('How did you hear about this job?')?.reason, 'Dari mana kamu menemukan lowongan ini hanya kamu yang tahu.')
  assert.equal(classifyPersonalFact('Are you at least 18 years of age?')?.reason, 'Usiamu hanya kamu yang tahu.')
})

test('classifyPersonalFact: temuan audit Lever (Palantir SG New Grad): PR, tawaran lain, persetujuan, magang terakhir', () => {
  const cases: Array<[string, string]> = [
    ['Are you a Singapore permanent resident?', 'permanent_residency'],
    ['Do you hold a green card?', 'permanent_residency'],
    ['Are you a Singapore PR?', 'permanent_residency'],
    ['Do you have PR status in Singapore?', 'permanent_residency'],
    ['Apakah Anda penduduk tetap Singapura?', 'permanent_residency'],
    ['Do you have any upcoming offer deadlines?', 'competing_offers'],
    ['Do you currently hold any other offers?', 'competing_offers'],
    ['Have you received offers from other companies?', 'competing_offers'],
    ['Do you have a job offer from another company?', 'competing_offers'],
    ['Apakah Anda memiliki penawaran kerja lain?', 'competing_offers'],
    ['Do you consent to the use of an AI Notetaker during interviews?', 'consent'],
    ['Are you comfortable with the interview being recorded?', 'consent'],
    ['Do you agree to your call being recorded?', 'consent'],
    ['Do you consent to us retaining your data for future roles?', 'consent'],
    ['Apakah Anda bersedia wawancara direkam?', 'consent'],
    ['Is this your final internship before graduating?', 'final_internship'],
    ['Will this be your last internship before you graduate?', 'final_internship'],
    ['Apakah ini magang terakhir Anda sebelum lulus?', 'final_internship'],
  ]
  for (const [label, category] of cases) {
    const verdict = classifyPersonalFact(label)
    assert.equal(verdict?.category, category, label)
    assert.ok(verdict?.reason && verdict.reason.length > 0, `alasan kosong: ${label}`)
  }
  assert.equal(classifyPersonalFact('Are you a Singapore permanent resident?')?.reason, 'Status penduduk tetap (permanent resident atau green card) hanya kamu yang tahu.')
})

test('classifyPersonalFact: pertanyaan teknis, kata "PR", "offer", "record", dan kotak persetujuan wajib tidak ikut ditandai', () => {
  const fine = [
    'Describe a project where you used AI',
    'Which programming languages do you know?',
    'Describe your experience with pull requests and PR reviews',
    'Do you have experience in Singapore PR and communications?',
    'Are you a PR professional?',
    'What does the company offer?',
    'Tell us about a tight deadline you handled',
    'Do you have experience with offer management systems?',
    'Describe your last internship',
    'Tell us about your final year project before graduating',
    'When do you expect to graduate?',
    'Do you have experience with call recording software?',
    'Tell us about your track record',
    'Do you have experience taking meeting notes?',
    // Kebijakan privasi, syarat, dan pemrosesan data wajib tetap lewat jalur kotak persetujuan yang sudah ada.
    'I agree to the Privacy Policy',
    'I consent to the processing of my personal data',
    'I consent to the Terms of Service',
  ]
  for (const label of fine) assert.equal(classifyPersonalFact(label), null, label)
})

test('classifyPersonalFact: pertanyaan biasa dan teknis tidak ikut ditandai', () => {
  const fine = [
    'Why are you interested in this role?',
    'Why do you want to work at Coinbase?',
    'LinkedIn Profile URL',
    'First Name',
    'Full name',
    'Nama lengkap (sesuai KTP)',
    'Full name as on passport',
    'Email',
    'Phone',
    'Current company',
    'Location (City)',
    'Describe your experience with TypeScript and Python',
    'Do you have at least 18 months of experience with React?',
    'Have you built more than 21 projects?',
    'Do you have experience using our platform APIs?',
    'Describe your experience working with hybrid cloud architectures',
    'Do you have experience working with on-site support teams?',
    'Are you comfortable working in a fast-paced environment?',
    'Tell us about a time you worked at a startup',
    'What is your expected salary?',
    'GitHub URL',
    'Website',
    '',
  ]
  for (const label of fine) assert.equal(classifyPersonalFact(label), null, label)
  assert.equal(classifyPersonalFact(undefined), null)
  assert.equal(classifyPersonalFact(null, ['Yes', 'No']), null)
})

// ---- 21 pertanyaan Greenhouse Coinbase Software Engineer Intern ---------------------------------------------------

/**
 * Daftar disusun dari pola pertanyaan formulir Greenhouse Coinbase Software Engineer Intern (6 biasa, 15 fakta pribadi);
 * bukan salinan resmi formulirnya. Dipakai untuk memastikan model tidak dipanggil untuk satu pun fakta pribadi.
 */
const COINBASE: Array<{ label: string; type: FormField['type']; personal: boolean }> = [
  { label: 'First Name', type: 'text', personal: false },
  { label: 'Last Name', type: 'text', personal: false },
  { label: 'Email', type: 'text', personal: false },
  { label: 'Phone', type: 'text', personal: false },
  { label: 'LinkedIn Profile URL', type: 'text', personal: false },
  { label: 'Why are you interested in this role?', type: 'textarea', personal: false },
  { label: 'What is your citizenship status in Singapore?', type: 'text', personal: true },
  { label: 'Will you require sponsorship to work in Singapore now or in the future?', type: 'radio', personal: true },
  { label: 'Are you a close relative of a government official or politically exposed person?', type: 'radio', personal: true },
  { label: 'How did you hear about this job?', type: 'text', personal: true },
  { label: 'Will you be able to make the internship duration of 12 weeks (June to August)?', type: 'radio', personal: true },
  { label: 'Are you currently or have you previously been employed by Coinbase?', type: 'radio', personal: true },
  { label: 'Do you currently use any Coinbase products?', type: 'radio', personal: true },
  { label: 'Are you at least 18 years of age?', type: 'radio', personal: true },
  { label: 'Were you referred by a Coinbase employee or a senior leader?', type: 'radio', personal: true },
  { label: 'Do you have a conflict of interest with Coinbase?', type: 'radio', personal: true },
  { label: 'Are you willing to work from the office 5 days a week?', type: 'radio', personal: true },
  { label: 'Gender', type: 'select', personal: true },
  { label: 'Race/Ethnicity', type: 'select', personal: true },
  { label: 'Veteran Status', type: 'select', personal: true },
  { label: 'Disability Status', type: 'select', personal: true },
]

const YES_NO = ['Yes', 'No']
const optionsFor = (type: FormField['type']): string[] | undefined => (type === 'radio' ? YES_NO : type === 'select' ? ['Decline to self-identify', 'Yes', 'No'] : undefined)

let aiCalls: string[] = []
const mockAi = (answer = 'Saya tertarik karena produknya.') => {
  aiCalls = []
  ;(aiPipelineService as any).generateAnswer = async (p: { question: string }) => {
    aiCalls.push(p.question)
    return answer
  }
}
afterEach(() => {
  ;(aiPipelineService as any).generateAnswer = async () => {
    throw new Error('real AI call blocked in tests')
  }
})

const ctx = (settings: Record<string, unknown> = {}): FormContext => ({
  jobTitle: 'Software Engineer Intern',
  company: 'Coinbase',
  jobDescription: 'Intern for 12 weeks.',
  userSettings: { first_name: 'Budi', last_name: 'Uji', phone_number: '+628111111111', linkedin_url: 'https://linkedin.example/in/budi', use_ai: true, ...settings },
  userProfile: { email: 'budi@example.test', skills: ['TypeScript'] },
  jobLocation: 'Singapore',
})
const toField = (q: (typeof COINBASE)[number]): FormField => {
  const options = optionsFor(q.type)
  return { type: q.type, label: q.label, ...(options ? { options } : {}) }
}

test('21 pertanyaan Coinbase: 15 fakta pribadi kosong dan "Perlu dicek" tanpa memanggil model; 6 pertanyaan biasa dijawab seperti biasa', async () => {
  assert.equal(COINBASE.length, 21)
  mockAi()
  for (const q of COINBASE) {
    const r = await formAutofillService.fillField(toField(q), ctx())
    if (q.personal) {
      assert.ok(r.value === '' || (Array.isArray(r.value) && r.value.length === 0), q.label)
      assert.equal(r.confidence, 0, q.label)
      assert.equal(r.needsReview, true, q.label)
      assert.equal(r.source, 'default', q.label)
      assert.ok(r.personalFact && r.personalFact.reason.length > 10, q.label)
    } else {
      assert.equal(r.personalFact, undefined, q.label)
      assert.notEqual(r.value, '', q.label)
    }
  }
  // Model hanya dipanggil untuk satu pertanyaan: "Why are you interested in this role?".
  assert.deepEqual(aiCalls, ['Why are you interested in this role?'])
})

test('"How did you hear about this job?" tidak lagi dijawab "LinkedIn Job Posting"', async () => {
  mockAi()
  const r = await formAutofillService.fillField({ type: 'text', label: 'How did you hear about this job?' }, ctx())
  assert.equal(r.value, '')
  assert.equal(r.confidence, 0)
  assert.equal(r.needsReview, true)
  assert.equal(r.personalFact?.category, 'job_source')
  assert.equal(aiCalls.length, 0)
})

test('data yang pengguna simpan sendiri untuk pertanyaan yang sama tetap dipakai; sisanya tetap kosong', async () => {
  mockAi()
  const saved = ctx({ require_visa: 'yes', gender: 'Female', veteran_status: 'Not a veteran', notice_period: 30 })

  const sponsor = await formAutofillService.fillField({ type: 'radio', label: 'Will you require sponsorship to work in Singapore?', options: YES_NO }, saved)
  assert.equal(sponsor.value, 'Yes')
  assert.equal(sponsor.source, 'rule')
  assert.equal(sponsor.needsReview, false)

  const gender = await formAutofillService.fillField({ type: 'select', label: 'Gender', options: ['Male', 'Female', 'Decline to self-identify'] }, saved)
  assert.equal(gender.value, 'Female')
  const veteran = await formAutofillService.fillField({ type: 'select', label: 'Veteran Status', options: ['Veteran', 'Not a veteran'] }, saved)
  assert.equal(veteran.value, 'Not a veteran')
  const notice = await formAutofillService.fillField({ type: 'text', label: 'Notice period (days)' }, saved)
  assert.equal(notice.value, '30')

  // Kolom yang tidak disimpan pengguna: tetap kosong. Sponsor visa tidak menjawab "Do you hold a valid visa?".
  const race = await formAutofillService.fillField({ type: 'select', label: 'Race/Ethnicity', options: ['Asian', 'Decline to self-identify'] }, saved)
  assert.equal(race.value, '')
  assert.equal(race.needsReview, true)
  const holdsVisa = await formAutofillService.fillField({ type: 'radio', label: 'Do you hold a valid work visa?', options: YES_NO }, saved)
  assert.equal(holdsVisa.value, '')
  assert.equal(holdsVisa.needsReview, true)
  const earliest = await formAutofillService.fillField({ type: 'text', label: 'What is your earliest start date?' }, saved)
  assert.equal(earliest.value, '')
  assert.equal(aiCalls.length, 0)
})

test('aturan lokasi tidak menjawab pertanyaan fakta pribadi yang labelnya memuat "state" atau "country"', async () => {
  mockAi()
  const base = { ...ctx({ state: 'Jawa Tengah', country: 'Indonesia' }), jobLocation: 'Remote' }
  for (const label of [
    'Are you a close relative of a state-owned enterprise employee or government official?',
    'Are you legally authorized to work in this country?',
    'What is your nationality?',
  ]) {
    const r = await formAutofillService.fillField({ type: 'text', label }, base)
    assert.equal(r.value, '', label)
    assert.equal(r.needsReview, true, label)
  }
})

test('buildApprovalAnswers: pertanyaan standar tetap, sponsor visa dari data tersimpan, tidak ada jawaban karangan', async () => {
  mockAi()
  const rows = await buildApprovalAnswers({
    settings: { first_name: 'Budi', last_name: 'Uji', phone_number: '+62811', current_city: 'Jogja', country: 'Indonesia', years_of_experience: '2', desired_salary: 5000000, notice_period: 30, require_visa: 'no', linkedin_url: 'https://linkedin.example/in/budi' },
    profile: { email: 'budi@example.test' },
    job: { title: 'Intern', company: 'Coinbase', description: '' },
  })
  const visa = rows.find((r) => r.question.startsWith('Butuh sponsor visa'))!
  assert.equal(visa.answer, 'No')
  assert.equal(visa.source, 'rule')
  const notice = rows.find((r) => r.question.startsWith('Masa pemberitahuan'))!
  assert.equal(notice.answer, '30')

  const empty = await buildApprovalAnswers({
    settings: { first_name: 'Budi', last_name: 'Uji', use_ai: false },
    profile: { email: 'budi@example.test' },
    job: { title: 'Intern', company: 'Coinbase', description: '' },
  })
  const emptyVisa = empty.find((r) => r.question.startsWith('Butuh sponsor visa'))!
  assert.equal(emptyVisa.answer, '')
  assert.equal(emptyVisa.needs_review, true)
})

test('generateAnswer menolak pertanyaan fakta pribadi sebelum memanggil model', async () => {
  const real = new (aiPipelineService.constructor as any)()
  for (const question of ['What is your citizenship status in Singapore?', 'How did you hear about this job?', 'Are you at least 18 years of age?']) {
    await assert.rejects(
      () => real.generateAnswer({ question, questionType: 'text', jobDescription: '', userProfile: {} }),
      (e: unknown) => e instanceof PersonalFactQuestionError && e.reason.length > 10,
      question,
    )
  }
})

test('POST /api/ai/answer: fakta pribadi dijawab kosong dan "Perlu dicek" tanpa model; pertanyaan biasa dijawab model', async () => {
  const app = Fastify()
  app.addHook('preHandler', async (req) => {
    ;(req as any).user = { id: 'u1' }
  })
  const guard = { check: async () => ({ quota: { quota: 10, used: 0, remaining: 10, allowed: true } }), recordDraft: async () => {} }
  await app.register(aiRoutes, { prefix: '/api/ai', guard })
  mockAi('Karena produknya relevan.')

  const personal = await app.inject({ method: 'POST', url: '/api/ai/answer', payload: { question: 'How did you hear about this job?', questionType: 'text', jobDescription: '', userProfile: {} } })
  assert.equal(personal.statusCode, 200)
  assert.equal(personal.json().answer, '')
  assert.equal(personal.json().needsReview, true)
  assert.equal(personal.json().personalFact.category, 'job_source')
  assert.equal(aiCalls.length, 0)

  const ordinary = await app.inject({ method: 'POST', url: '/api/ai/answer', payload: { question: 'Why are you interested in this role?', questionType: 'textarea', jobDescription: '', userProfile: {} } })
  assert.equal(ordinary.json().answer, 'Karena produknya relevan.')
  assert.deepEqual(aiCalls, ['Why are you interested in this role?'])

  const fill = await app.inject({
    method: 'POST',
    url: '/api/ai/fill-form',
    payload: { fields: [{ type: 'text', label: 'What is your citizenship status in Singapore?' }], context: { jobTitle: 'T', company: 'C', jobDescription: '', userSettings: { first_name: 'A', last_name: 'B' }, userProfile: {} } },
  })
  assert.equal(fill.statusCode, 200)
  assert.equal(fill.json().results[0].value, '')
  assert.equal(fill.json().results[0].needsReview, true)
  assert.equal(fill.json().results[0].personalFact.category, 'citizenship')
  await app.close()
})

// ---- planner ekstensi --------------------------------------------------------------------------------------------

async function planWithAi(opts: { controls: any[]; settings?: Record<string, unknown>; saved?: Array<{ label: string; answer: string }>; aiActions: Array<{ controlId: string; value: string | boolean }> }) {
  const planner = new ExtensionPlanner(async () => ({ model: 'm', text: JSON.stringify({ actions: opts.aiActions }) }))
  const store = makeExtensionTestDb({
    jobs: [{ id: 'job-1', title: 'Engineer', company: 'Coinbase', description: '', location: 'Singapore' }],
    user_automation_settings: [{ user_id: USER_ID, email: 'budi@example.id', use_ai: true, ...(opts.settings ?? {}) }],
    user_form_answers: (opts.saved ?? []).map((x) => ({ user_id: USER_ID, question_key: questionKey(x.label), question_label: x.label, answer: x.answer })),
  })
  return planner.planForm({ db: store.db, userId: USER_ID, jobId: 'job-1', pageUrl: 'https://boards.greenhouse.io/coinbase/jobs/1', rawControls: opts.controls })
}

test('planner ekstensi: jawaban AI untuk fakta pribadi dibuang dan menjadi pertanyaan; pertanyaan biasa tetap diisi', async () => {
  const res = await planWithAi({
    controls: [
      { controlId: 'c1', kind: 'select', label: 'What is your citizenship status in Singapore?', options: ['Citizen', 'Permanent resident', 'Other'], required: true },
      { controlId: 'c2', kind: 'select', label: 'How did you hear about this job?', options: ['LinkedIn', 'Referral', 'Other'], required: true },
      { controlId: 'c3', kind: 'radio', label: 'Are you at least 18 years of age?', groupLabel: 'Are you at least 18 years of age?', options: ['Yes', 'No'], required: true },
      { controlId: 'c4', kind: 'select', label: 'Gender', options: ['Male', 'Female', 'Decline to self-identify'], required: true },
      { controlId: 'c5', kind: 'select', label: 'Preferred editor', options: ['Vim', 'Emacs'], required: true },
    ],
    aiActions: [
      { controlId: 'c1', value: 'Citizen' },
      { controlId: 'c2', value: 'LinkedIn' },
      { controlId: 'c3', value: 'Yes' },
      { controlId: 'c4', value: 'Decline to self-identify' },
      { controlId: 'c5', value: 'Vim' },
    ],
  })
  assert.deepEqual(res.actions.map((a) => [a.controlId, a.value]), [['c5', 'Vim']])
  const pending = res.pendingQuestions.map((q) => q.key)
  for (const label of ['What is your citizenship status in Singapore?', 'How did you hear about this job?', 'Are you at least 18 years of age?', 'Gender']) {
    assert.ok(pending.includes(questionKey(label)), label)
  }
})

test('planner ekstensi: token profil untuk pertanyaan yang sama persis dan jawaban tersimpan tetap dipakai', async () => {
  const res = await planWithAi({
    settings: { require_visa: 'no' },
    controls: [
      { controlId: 'c1', kind: 'select', label: 'Will you require sponsorship to work in Singapore?', options: ['Yes', 'No'], required: true },
      { controlId: 'c2', kind: 'select', label: 'How did you hear about this job?', options: ['LinkedIn', 'Referral', 'Other'], required: true },
      { controlId: 'c3', kind: 'select', label: 'Gender', options: ['Male', 'Female'], required: true },
    ],
    saved: [{ label: 'How did you hear about this job?', answer: 'Referral' }],
    aiActions: [
      { controlId: 'c1', value: '{{require_visa}}' },
      { controlId: 'c3', value: '{{require_visa}}' },
    ],
  })
  const byId = new Map(res.actions.map((a) => [a.controlId, a.value]))
  assert.equal(byId.get('c1'), 'No')
  assert.equal(byId.get('c2'), 'Referral') // jawaban tersimpan pengguna untuk pertanyaan yang sama persis
  assert.equal(byId.has('c3'), false) // token sponsor visa bukan jawaban untuk gender
  assert.equal(personalFactAnswerAllowed('sponsorship', '{{require_visa}}'), true)
  assert.equal(personalFactAnswerAllowed('sponsorship', 'No'), false)
  assert.equal(personalFactAnswerAllowed('job_source', '{{require_visa}}'), false)
})
