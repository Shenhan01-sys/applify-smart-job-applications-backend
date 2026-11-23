import test from 'node:test'
import assert from 'node:assert/strict'
import {
  EXT_MAX_PENDING_QUESTIONS,
  ExtensionPlanner,
  isSecretLabel,
  sanitizeExtensionControls,
  sanitizePendingQuestions,
  sanitizeSecretSkips,
  SECRET_LABEL_RE,
} from '../services/extension-planner.js'
import { planFileTargets } from '../services/extension-file-targets.js'
import { makeExtensionTestDb, USER_ID } from './extension-test-db.js'

const NOW = new Date('2026-11-24T05:00:00Z')

// -------------------------------------------------------------------------------------------------------------
// 1. SECRET_LABEL_RE dengan batas kata
// -------------------------------------------------------------------------------------------------------------

test('regex rahasia: tidak lagi membuang "Shipping address", "opinion", "Pinterest", tetapi tetap menangkap "Password" dan "CVV"', () => {
  for (const ok of [
    'Shipping address',
    'Your opinion of our product',
    'Pinterest profile URL',
    'Spinner experience',
    'Mapping tools you have used',
    'Notification preferences',
    'Do you accept the privacy policy?',
    'Technik',
    'Sandia National Laboratories',
    'Company pinned repositories',
    'Current City',
    'Full Name',
    'LinkedIn Profile',
    'Cover letter',
  ]) {
    assert.equal(isSecretLabel(ok), false, ok)
    assert.equal(SECRET_LABEL_RE.test(ok), false, ok)
  }
  for (const secret of [
    'Password',
    'Create a password',
    'Confirm Password *',
    'Enter your PIN',
    'CVV',
    'cvv2',
    'Card number',
    'Credit card',
    'One-time passcode',
    'OTP code',
    'Security code',
    'SSN',
    'Social Security Number',
    'IBAN',
    'Kata sandi',
    'KTP',
    'NIK (Nomor Induk Kependudukan)',
    'NPWP',
    'Passport number',
    'Bank account',
    'Nomor rekening',
  ]) {
    assert.equal(isSecretLabel(secret), true, secret)
  }
})

test('regex rahasia: nama atribut dengan garis bawah, tanda hubung, angka, dan camelCase tetap tertangkap', () => {
  for (const name of ['user_pin', 'card_number', 'cc-number card number', 'password1', 'password_confirmation', 'confirmPassword', 'userPin', 'OTPCode', 'new-password', 'newpassword', 'userpasscode', 'confirmcvv']) {
    assert.equal(isSecretLabel(name), true, name)
  }
  for (const name of ['shipping_address', 'job_application[opinion]', 'pinterest_url', 'mapping_experience', 'classname', 'footprint', 'compass_code']) {
    assert.equal(isSecretLabel(name), false, name)
  }
})

test('planner: kontrol "Shipping address" dan "Pinterest" kembali diproses (tidak dibuang), kontrol rahasia dilaporkan secret_skip', async () => {
  const store = makeExtensionTestDb({
    jobs: [{ id: 'job-1', title: 'Backend', company: 'Acme', description: '', location: 'Jakarta' }],
    profiles: [{ id: USER_ID, full_name: 'Budi Santoso' }],
    user_form_answers: [
      { user_id: USER_ID, question_key: 'shipping address', question_label: 'Shipping address', answer: 'Jl. Merdeka 1' },
      { user_id: USER_ID, question_key: 'pinterest profile', question_label: 'Pinterest profile', answer: 'pinterest.com/budi' },
    ],
  })
  let aiPrompt = ''
  const planner = new ExtensionPlanner(async (req) => {
    aiPrompt = req.user
    return { model: 'm', text: '{"actions":[]}' }
  }, () => NOW.getTime())

  const res = await planner.planForm({
    db: store.db,
    userId: USER_ID,
    jobId: 'job-1',
    pageUrl: 'https://jobs.lever.co/acme/1/apply',
    rawControls: [
      { controlId: 'c1', kind: 'text', label: 'Shipping address', required: false },
      { controlId: 'c2', kind: 'text', label: 'Pinterest profile', required: false },
      { controlId: 'c3', kind: 'text', label: 'Your opinion', required: false },
      { controlId: 'c4', kind: 'text', label: 'CVV', required: true },
      { controlId: 'c5', kind: 'text', label: 'Password', required: false },
    ],
  })

  // Dua kontrol pertama terisi dari jawaban tersimpan: tanda bahwa tidak dibuang sebagai rahasia.
  assert.deepEqual(res.actions.map((a) => [a.controlId, a.source, a.value]), [
    ['c1', 'saved', 'Jl. Merdeka 1'],
    ['c2', 'saved', 'pinterest.com/budi'],
  ])
  // Kontrol rahasia: tidak diisi, tidak dikirim ke AI.
  assert.ok(!res.actions.some((a) => a.controlId === 'c4' || a.controlId === 'c5'))
  assert.ok(!aiPrompt.includes('c4') && !aiPrompt.includes('c5') && !aiPrompt.includes('CVV') && !aiPrompt.includes('Password'))
  assert.ok(aiPrompt.includes('c3'), 'kolom "Your opinion" ikut ke AI')
  // Dilaporkan sebagai pertanyaan: wajib dulu, lalu opsional.
  assert.deepEqual(res.pendingQuestions, [
    { key: 'cvv', label: 'CVV', kind: 'secret_skip', required: true },
    { key: 'your opinion', label: 'Your opinion', kind: 'text', required: false },
    { key: 'password', label: 'Password', kind: 'secret_skip', required: false },
  ])
})

test('planner di portal login (JobStreet, Glints, Kalibrr, Dealls): kata sandi dan OTP tidak pernah diisi atau dikirim ke AI', async () => {
  for (const pageUrl of [
    'https://id.jobstreet.com/id/job/1/apply',
    'https://glints.com/id/opportunities/jobs/abc/apply',
    'https://www.kalibrr.com/c/acme/jobs/1/apply',
    'https://dealls.com/loker/backend~acme',
  ]) {
    const store = makeExtensionTestDb({
      jobs: [{ id: 'job-1', title: 'Backend', company: 'Acme', description: '', location: 'Jakarta', external_url: pageUrl }],
      profiles: [{ id: USER_ID, full_name: 'Budi Santoso' }],
    })
    let aiPrompt = ''
    const planner = new ExtensionPlanner(async (req) => {
      aiPrompt = req.user
      return { model: 'm', text: '{"actions":[]}' }
    }, () => NOW.getTime())

    const res = await planner.planForm({
      db: store.db,
      userId: USER_ID,
      jobId: 'job-1',
      pageUrl,
      rawControls: [
        { controlId: 'c1', kind: 'text', label: 'Your opinion', required: false },
        { controlId: 'c2', kind: 'text', label: 'Kata sandi', required: true },
        { controlId: 'c3', kind: 'text', label: 'Kode OTP', required: true },
        { controlId: 'c4', kind: 'text', label: 'Confirm Password', required: false },
      ],
    })

    assert.ok(!res.actions.some((a) => ['c2', 'c3', 'c4'].includes(a.controlId)), pageUrl)
    assert.ok(!aiPrompt.includes('c2') && !aiPrompt.includes('c3') && !aiPrompt.includes('c4'), `${pageUrl}: kontrol rahasia ikut ke AI`)
    assert.ok(!/kata sandi|otp|password/i.test(aiPrompt), `${pageUrl}: label rahasia ikut ke AI`)
    assert.deepEqual(
      res.pendingQuestions.filter((q) => q.kind === 'secret_skip').map((q) => q.label).sort(),
      ['Confirm Password', 'Kata sandi', 'Kode OTP'],
      pageUrl
    )
  }
})

// -------------------------------------------------------------------------------------------------------------
// 2. pendingQuestions untuk kontrol opsional
// -------------------------------------------------------------------------------------------------------------

async function plan(rawControls: unknown[], opts: { ai?: (user: string) => Promise<string> } = {}) {
  const store = makeExtensionTestDb({
    jobs: [{ id: 'job-1', title: 'Backend', company: 'Acme', description: '', location: 'Jakarta' }],
    profiles: [{ id: USER_ID, full_name: 'Budi Santoso' }],
  })
  const planner = new ExtensionPlanner(
    async (req) => ({ model: 'm', text: opts.ai ? await opts.ai(req.user) : '{"actions":[]}' }),
    () => NOW.getTime()
  )
  return planner.planForm({ db: store.db, userId: USER_ID, jobId: 'job-1', pageUrl: 'https://jobs.lever.co/acme/1/apply', rawControls })
}

test('pendingQuestions: kolom opsional yang tidak terisi ikut dengan required:false; wajib lebih dulu', async () => {
  const res = await plan([
    { controlId: 'o1', kind: 'text', label: 'Referral name', required: false },
    { controlId: 'r1', kind: 'textarea', label: 'Why us?', required: true },
    { controlId: 'o2', kind: 'select', label: 'How did you hear about us?', options: ['LinkedIn', 'Friend'], required: false },
    { controlId: 'r2', kind: 'radio', groupLabel: 'Willing to relocate?', label: 'Yes', options: ['Yes', 'No'], required: true },
  ])
  assert.deepEqual(
    res.pendingQuestions.map((q) => [q.label, q.required, q.kind]),
    [
      ['Why us?', true, 'textarea'],
      ['Willing to relocate?', true, 'radio'],
      ['Referral name', false, 'text'],
      ['How did you hear about us?', false, 'select'],
    ]
  )
  assert.deepEqual(res.pendingQuestions[3].options, ['LinkedIn', 'Friend'])
  for (const q of res.pendingQuestions) assert.equal(typeof q.required, 'boolean')
})

test('pendingQuestions: opsional yang sudah berisi, kotak centang opsional, tanpa label, dan yang sudah direncanakan tidak ikut', async () => {
  const res = await plan([
    { controlId: 'a', kind: 'text', label: 'First Name', required: false }, // terisi fakta
    { controlId: 'b', kind: 'text', label: 'Nickname', required: false, currentValue: 'Bud' }, // sudah berisi
    { controlId: 'c', kind: 'checkbox', label: 'Send me job alerts', required: false }, // kotak centang opsional
    { controlId: 'd', kind: 'text', label: '', required: false }, // tanpa label, nama, atau placeholder
    { controlId: 'e', kind: 'checkbox', label: 'I agree to the terms', required: true }, // wajib tetap ikut
    { controlId: 'f', kind: 'text', label: 'Middle name', required: false },
  ])
  assert.deepEqual(res.pendingQuestions.map((q) => q.label), ['I agree to the terms', 'Middle name'])
  assert.equal(res.pendingQuestions[0].kind, 'check')
})

test('pendingQuestions: paling banyak 20 sesudah disaring, wajib tidak tergeser oleh opsional', async () => {
  const optional = Array.from({ length: 25 }, (_, i) => ({ controlId: `o${i}`, kind: 'text', label: `Optional question ${i}`, required: false }))
  const required = Array.from({ length: 3 }, (_, i) => ({ controlId: `r${i}`, kind: 'text', label: `Required question ${i}`, required: true }))
  const res = await plan([...optional, ...required])
  assert.equal(res.pendingQuestions.length, EXT_MAX_PENDING_QUESTIONS)
  assert.equal(EXT_MAX_PENDING_QUESTIONS, 20)
  assert.deepEqual(res.pendingQuestions.slice(0, 3).map((q) => q.label), ['Required question 0', 'Required question 1', 'Required question 2'])
  assert.equal(res.pendingQuestions.filter((q) => q.required).length, 3)
})

test('pendingQuestions: kontrol rahasia yang sudah terisi pengguna tidak dilaporkan, dan nilainya tidak pernah masuk respons', async () => {
  const res = await plan([
    { controlId: 'p', kind: 'text', label: 'OTP code', required: true, currentValue: '123456' },
    { controlId: 'q', kind: 'text', label: 'Security PIN', required: true },
  ])
  assert.deepEqual(res.pendingQuestions, [{ key: 'security pin', label: 'Security PIN', kind: 'secret_skip', required: true }])
  assert.ok(!JSON.stringify(res).includes('123456'))
})

test('sanitizePendingQuestions: required boolean (bawaan true), kontrol rahasia dipisah ke sanitizeSecretSkips', () => {
  const raw = [
    { label: 'Why us?', kind: 'textarea', required: true },
    { label: 'Nickname', kind: 'text', required: false },
    { label: 'Old client question', kind: 'text' },
    { label: 'Weird', kind: 'text', required: 'yes' },
    { label: 'Account password', kind: 'secret_skip', required: true },
    { label: 'Enter your PIN', kind: 'text', required: false },
    { label: 'Custom secret', kind: 'secret_skip', required: false },
  ]
  assert.deepEqual(sanitizePendingQuestions(raw), [
    { key: 'why us', label: 'Why us?', kind: 'textarea', required: true },
    { key: 'nickname', label: 'Nickname', kind: 'text', required: false },
    { key: 'old client question', label: 'Old client question', kind: 'text', required: true },
    { key: 'weird', label: 'Weird', kind: 'text', required: true },
  ])
  assert.deepEqual(sanitizeSecretSkips(raw), [
    { key: 'account password', label: 'Account password', kind: 'secret_skip', required: true },
    { key: 'enter your pin', label: 'Enter your PIN', kind: 'secret_skip', required: false },
    { key: 'custom secret', label: 'Custom secret', kind: 'secret_skip', required: false },
  ])
  assert.deepEqual(sanitizeSecretSkips('bukan array'), [])
})

test('aiError: galat AI dan keluaran tanpa JSON ditandai generik; isian faktual tetap ada; tanpa galat bernilai null', async () => {
  const controls = [
    { controlId: 'n', kind: 'text', label: 'Full Name', required: true },
    { controlId: 'x', kind: 'textarea', label: 'Tell us about a hard problem', required: true },
  ]
  const store = makeExtensionTestDb({ jobs: [{ id: 'job-1', title: 'B', company: 'A', description: '', location: '' }], profiles: [{ id: USER_ID, full_name: 'Budi Santoso' }] })
  const run = (fn: () => Promise<{ text: string; model: string }>) =>
    new ExtensionPlanner(fn, () => NOW.getTime()).planForm({
      db: store.db,
      userId: USER_ID,
      jobId: 'job-1',
      pageUrl: 'https://jobs.lever.co/acme/1/apply',
      rawControls: controls,
    })

  const thrown = await run(async () => {
    throw new Error('401 invalid api key sk-SECRET-123 from provider')
  })
  assert.equal(thrown.aiError, 'ai_failed')
  assert.equal(thrown.actions.length, 1)
  assert.ok(!JSON.stringify(thrown).includes('sk-SECRET'))

  const garbage = await run(async () => ({ model: 'm', text: 'maaf, tidak bisa' }))
  assert.equal(garbage.aiError, 'ai_failed')
  const brokenJson = await run(async () => ({ model: 'm', text: '{"actions": [oops]}' }))
  assert.equal(brokenJson.aiError, 'ai_failed')
  const fine = await run(async () => ({ model: 'm', text: '{"actions":[]}' }))
  assert.equal(fine.aiError, null)
})

// -------------------------------------------------------------------------------------------------------------
// 3. fileTargets
// -------------------------------------------------------------------------------------------------------------

const fileCtl = (controlId: string, label: string, extra: Record<string, unknown> = {}) => ({ controlId, kind: 'file', label, ...extra })

test('fileTargets: CV, surat lamaran, transkrip, portofolio dipetakan dari label; satu kontrol hanya satu jenis', () => {
  const controls = sanitizeExtensionControls([
    fileCtl('f1', 'Resume/CV'),
    fileCtl('f2', 'Cover Letter'),
    fileCtl('f3', 'Academic Transcript'),
    fileCtl('f4', 'Portfolio'),
    { controlId: 's', kind: 'submit', label: 'Submit' },
  ])
  assert.deepEqual(planFileTargets(controls), [
    { controlId: 'f1', kind: 'resume' },
    { controlId: 'f2', kind: 'cover_letter' },
    { controlId: 'f3', kind: 'transcript' },
    { controlId: 'f4', kind: 'portfolio' },
  ])
})

test('fileTargets: petunjuk dari name dan id (Greenhouse id:resume, cover_letter) didahulukan, termasuk camelCase', () => {
  const controls = sanitizeExtensionControls([
    fileCtl('a', 'Attach', { name: 'job_application[cover_letter]', elementId: 'cover_letter' }),
    fileCtl('b', 'Attach', { name: 'job_application[resume]', elementId: 'resume' }),
    fileCtl('c', 'Choose file', { elementId: 'academicTranscriptFile' }),
    fileCtl('d', 'Choose file', { name: 'portfolio_upload' }),
  ])
  assert.deepEqual(planFileTargets(controls), [
    { controlId: 'b', kind: 'resume' },
    { controlId: 'a', kind: 'cover_letter' },
    { controlId: 'c', kind: 'transcript' },
    { controlId: 'd', kind: 'portfolio' },
  ])
})

test('fileTargets: label Indonesia, satu kontrol tidak dipakai dua kali, kontrol tanpa kecocokan tidak dilaporkan', () => {
  const controls = sanitizeExtensionControls([
    fileCtl('a', 'Unggah Surat Lamaran'),
    fileCtl('b', 'Transkrip Nilai'),
    fileCtl('c', 'Work samples'),
    fileCtl('d', 'Curriculum Vitae'),
    fileCtl('e', 'Lainnya'),
  ])
  const targets = planFileTargets(controls)
  assert.deepEqual(targets, [
    { controlId: 'd', kind: 'resume' },
    { controlId: 'a', kind: 'cover_letter' },
    { controlId: 'b', kind: 'transcript' },
    { controlId: 'c', kind: 'portfolio' },
  ])
  assert.equal(new Set(targets.map((t) => t.controlId)).size, targets.length)
})

test('fileTargets: tidak ada yang menyebut CV -> kontrol berkas pertama yang bebas dipakai untuk CV, bukan kolom foto', () => {
  assert.deepEqual(planFileTargets(sanitizeExtensionControls([fileCtl('a', 'Upload')])), [{ controlId: 'a', kind: 'resume' }])
  assert.deepEqual(planFileTargets(sanitizeExtensionControls([fileCtl('p', 'Profile photo'), fileCtl('a', 'Attach file')])), [{ controlId: 'a', kind: 'resume' }])
  assert.deepEqual(planFileTargets(sanitizeExtensionControls([fileCtl('p', 'Profile photo')])), [])
  // Kontrol yang sudah dipakai jenis lain tidak ikut menjadi CV.
  assert.deepEqual(planFileTargets(sanitizeExtensionControls([fileCtl('a', 'Cover letter')])), [{ controlId: 'a', kind: 'cover_letter' }])
  assert.deepEqual(planFileTargets([]), [])
})

test('plan-form: fileTargets dan fileControlId/resumeUrl lama ada pada respons; tanpa kontrol berkas daftarnya kosong', async () => {
  const store = makeExtensionTestDb({
    jobs: [{ id: 'job-1', title: 'B', company: 'A', description: '', location: '' }],
    profiles: [{ id: USER_ID, full_name: 'Budi Santoso', resume_url: `${USER_ID}/cv-budi.pdf` }],
  })
  const planner = new ExtensionPlanner(async () => ({ model: 'm', text: '{"actions":[]}' }), () => NOW.getTime())
  const base = { db: store.db, userId: USER_ID, jobId: 'job-1', pageUrl: 'https://jobs.lever.co/acme/1/apply' }

  const withFiles = await planner.planForm({
    ...base,
    rawControls: [fileCtl('f1', 'Resume', { elementId: 'resume' }), fileCtl('f2', 'Cover letter'), { controlId: 's', kind: 'submit', label: 'Submit' }],
  })
  assert.deepEqual(withFiles.fileTargets, [
    { controlId: 'f1', kind: 'resume' },
    { controlId: 'f2', kind: 'cover_letter' },
  ])
  assert.equal(withFiles.fileControlId, 'f1')
  assert.match(String(withFiles.resumeUrl), /^https:\/\/storage\.test\/resumes\//)

  const none = await planner.planForm({ ...base, rawControls: [{ controlId: 'n', kind: 'text', label: 'Full Name', required: true }] })
  assert.deepEqual(none.fileTargets, [])
  assert.equal(none.fileControlId, null)

  const blocked = await planner.planForm({ ...base, pageUrl: 'https://jobs.lever.co/login', hasPasswordInput: true, rawControls: [] })
  assert.equal(blocked.blocked, 'auth_required')
  assert.deepEqual(blocked.fileTargets, [])
  assert.equal(blocked.aiError, null)
})
