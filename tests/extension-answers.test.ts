import test from 'node:test'
import assert from 'node:assert/strict'
import { EXT_MAX_ANSWER_CHARS, EXT_MAX_ANSWERS } from '../services/extension-answers.js'
import { ExtensionPlanner, questionKey } from '../services/extension-planner.js'
import { buildApp, issueToken, makeExtensionTestDb, OTHER_USER_ID, USER_ID, type FakeDbOptions } from './extension-test-db.js'

const NOW = new Date('2026-11-24T05:00:00Z')
const FUTURE = '2026-11-24T12:00:00Z'
const APPROVAL = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1'
const OTHER_APPROVAL = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb2'
const PENDING_APPROVAL = 'cccccccc-cccc-cccc-cccc-ccccccccccc3'

function seed(extra: Partial<Record<string, any[]>> = {}) {
  return {
    approval_requests: [
      { id: APPROVAL, user_id: USER_ID, job_id: 'job-1', application_id: 'app-1', status: 'approved', expires_at: FUTURE },
      { id: OTHER_APPROVAL, user_id: OTHER_USER_ID, job_id: 'job-1', application_id: 'app-2', status: 'approved', expires_at: FUTURE },
      { id: PENDING_APPROVAL, user_id: USER_ID, job_id: 'job-1', application_id: 'app-3', status: 'pending', expires_at: FUTURE },
    ],
    jobs: [{ id: 'job-1', platform_source: 'kalibrr', title: 'Backend Engineer', company: 'Acme', external_url: 'https://www.kalibrr.com/c/acme/jobs/1', description: '', location: 'Jakarta' }],
    profiles: [{ id: USER_ID, full_name: 'Budi Santoso' }],
    ...extra,
  }
}

async function setup(extra: Partial<Record<string, any[]>> = {}, options: FakeDbOptions = {}) {
  const store = makeExtensionTestDb(seed(extra), options)
  const app = buildApp({ db: store.db, primaryUserId: USER_ID, now: () => NOW.getTime() })
  const token = await issueToken(app)
  const post = (payload: unknown, headers: Record<string, string> = { authorization: `Bearer ${token}` }) =>
    app.inject({ method: 'POST', url: '/api/extension/answers', headers, payload: payload as any })
  return { store, app, token, post }
}

test('answers: menyimpan ke user_form_answers dengan questionKey yang sama, user_id dari token, respons {saved}', async () => {
  const { post, store } = await setup()
  const res = await post({
    approvalId: APPROVAL,
    answers: [
      { key: 'FORGED', label: 'Are you open to relocation? *', value: 'Yes' },
      { key: 'x', label: 'Expected salary (wajib)', value: '  15000000  ' },
    ],
  })
  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.json(), { saved: 2 })
  const rows = store.tables.user_form_answers
  assert.equal(rows.length, 2)
  assert.deepEqual(
    rows.map((r) => ({ user_id: r.user_id, question_key: r.question_key, question_label: r.question_label, answer: r.answer, updated_at: r.updated_at })),
    [
      { user_id: USER_ID, question_key: 'are you open to relocation', question_label: 'Are you open to relocation? *', answer: 'Yes', updated_at: NOW.toISOString() },
      { user_id: USER_ID, question_key: 'expected salary', question_label: 'Expected salary (wajib)', answer: '15000000', updated_at: NOW.toISOString() },
    ]
  )
  // Kunci dari modul yang sama dengan perencana dan jawaban web.
  assert.equal(rows[0].question_key, questionKey('Are you open to relocation? *'))
})

test('answers: kunci unik per pengguna, jawaban baru memperbarui baris lama (bukan baris ganda) dan baris pengguna lain tidak tersentuh', async () => {
  const { post, store } = await setup({
    user_form_answers: [
      { user_id: USER_ID, question_key: 'expected salary', question_label: 'Expected salary', answer: '10000000' },
      { user_id: OTHER_USER_ID, question_key: 'expected salary', question_label: 'Expected salary', answer: 'PUNYA ORANG LAIN' },
    ],
  })
  const res = await post({ approvalId: APPROVAL, answers: [{ key: 'k', label: 'Expected salary', value: '20000000' }, { key: 'k2', label: 'expected SALARY *', value: '25000000' }] })
  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.json(), { saved: 1 }, 'dua label dengan kunci sama dihitung satu, yang terakhir menang')
  const mine = store.tables.user_form_answers.filter((r) => r.user_id === USER_ID)
  assert.equal(mine.length, 1)
  assert.equal(mine[0].answer, '25000000')
  assert.equal(store.tables.user_form_answers.find((r) => r.user_id === OTHER_USER_ID)?.answer, 'PUNYA ORANG LAIN')
})

test('answers: jawaban yang disimpan dipakai perencana pada isi ulang (kunci cocok dengan pendingQuestions)', async () => {
  const { post, store } = await setup()
  const planner = new ExtensionPlanner(async () => ({ model: 'm', text: '{"actions":[]}' }), () => NOW.getTime())
  const controls = [{ controlId: 'c1', kind: 'select', label: 'Notice period', options: ['Immediately', '1 month', '3 months'], required: true }]
  const before = await planner.planForm({ db: store.db, userId: USER_ID, jobId: 'job-1', pageUrl: 'https://www.kalibrr.com/c/acme/jobs/1/apply', rawControls: controls })
  assert.equal(before.actions.length, 0)
  const q = before.pendingQuestions[0]

  const res = await post({ approvalId: APPROVAL, answers: [{ key: q.key, label: q.label, value: '1 month' }] })
  assert.deepEqual(res.json(), { saved: 1 })

  const after = await planner.planForm({ db: store.db, userId: USER_ID, jobId: 'job-1', pageUrl: 'https://www.kalibrr.com/c/acme/jobs/1/apply', rawControls: controls })
  assert.deepEqual(after.actions, [{ controlId: 'c1', kind: 'select', value: '1 month', source: 'saved' }])
  assert.deepEqual(after.pendingQuestions, [])
})

test('answers: terlalu banyak (>30) atau terlalu panjang (>2000) -> 400, tidak ada yang ditulis', async () => {
  const { post, store } = await setup()
  const many = Array.from({ length: EXT_MAX_ANSWERS + 1 }, (_, i) => ({ key: `k${i}`, label: `Question ${i}`, value: 'a' }))
  const tooMany = await post({ approvalId: APPROVAL, answers: many })
  assert.equal(tooMany.statusCode, 400)
  assert.equal(tooMany.json().code, 'too_many_answers')

  const exactly30 = await post({ approvalId: APPROVAL, answers: many.slice(0, EXT_MAX_ANSWERS) })
  assert.equal(exactly30.statusCode, 200)
  assert.deepEqual(exactly30.json(), { saved: 30 })
  store.tables.user_form_answers.length = 0

  const tooLong = await post({
    approvalId: APPROVAL,
    answers: [{ key: 'a', label: 'Fine question', value: 'ok' }, { key: 'b', label: 'Long question', value: 'x'.repeat(EXT_MAX_ANSWER_CHARS + 1) }],
  })
  assert.equal(tooLong.statusCode, 400)
  assert.equal(tooLong.json().code, 'answer_too_long')
  assert.equal(store.tables.user_form_answers.length, 0, 'validasi lebih dulu: jawaban yang sah ikut tidak tersimpan')

  const justRight = await post({ approvalId: APPROVAL, answers: [{ key: 'b', label: 'Long question', value: 'x'.repeat(EXT_MAX_ANSWER_CHARS) }] })
  assert.equal(justRight.statusCode, 200)
  assert.equal(store.tables.user_form_answers[0].answer.length, EXT_MAX_ANSWER_CHARS)
})

test('answers: bentuk salah -> 400 (bukan daftar, kosong, bukan objek, value bukan teks, tanpa label)', async () => {
  const { post, store } = await setup()
  for (const answers of [undefined, null, 'x', {}, [], [null], ['teks'], [{ key: 'a', label: 'Q', value: 42 }], [{ key: 'a', label: '', value: 'x' }], [{ key: 'a', value: 'x' }], [{ label: '***', value: 'x' }]]) {
    const res = await post({ approvalId: APPROVAL, answers })
    assert.equal(res.statusCode, 400, JSON.stringify(answers))
    assert.equal(res.json().code, 'invalid_answers', JSON.stringify(answers))
  }
  assert.equal(store.tables.user_form_answers.length, 0)
})

test('answers: jawaban kosong dilewati tanpa galat; semuanya kosong -> {saved: 0}', async () => {
  const { post, store } = await setup()
  const mixed = await post({ approvalId: APPROVAL, answers: [{ key: 'a', label: 'Skipped question', value: '   ' }, { key: 'b', label: 'Answered question', value: 'Ya' }] })
  assert.deepEqual(mixed.json(), { saved: 1 })
  const none = await post({ approvalId: APPROVAL, answers: [{ key: 'a', label: 'Skipped question', value: '' }] })
  assert.equal(none.statusCode, 200)
  assert.deepEqual(none.json(), { saved: 0 })
  assert.equal(store.tables.user_form_answers.length, 1)
})

test('answers: butir bertanda kind file (unggah manual) dilewati tanpa galat dan tidak pernah disimpan', async () => {
  const { post, store } = await setup()
  const only = await post({ approvalId: APPROVAL, answers: [{ key: 'f1', label: 'Unggah CV secara manual', kind: 'file' }] })
  assert.equal(only.statusCode, 200)
  assert.deepEqual(only.json(), { saved: 0 })
  const mixed = await post({
    approvalId: APPROVAL,
    answers: [
      { key: 'f1', label: 'Unggah CV secara manual', kind: 'file', value: 'cv.pdf' },
      { key: 'b', label: 'Answered question', value: 'Ya' },
    ],
  })
  assert.deepEqual(mixed.json(), { saved: 1 })
  assert.deepEqual(store.tables.user_form_answers.map((r) => r.question_key), ['answered question'])
})

test('answers: jawaban untuk pertanyaan rahasia ditolak (400 secret_question) dan tidak pernah disimpan', async () => {
  const { post, store } = await setup()
  for (const label of ['Password', 'Enter your PIN', 'One-time passcode', 'CVV', 'Kata sandi']) {
    const res = await post({ approvalId: APPROVAL, answers: [{ key: 'ok', label: 'Harmless question', value: 'a' }, { key: 'p', label: label, value: 'hunter2' }] })
    assert.equal(res.statusCode, 400, label)
    assert.equal(res.json().code, 'secret_question', label)
  }
  assert.equal(store.tables.user_form_answers.length, 0)
  // Kata yang hanya mirip tidak ditolak.
  const ok = await post({ approvalId: APPROVAL, answers: [{ key: 'a', label: 'Shipping address', value: 'Jl. Merdeka 1' }] })
  assert.deepEqual(ok.json(), { saved: 1 })
})

test('answers: persetujuan pengguna lain 404, belum disetujui 409, bukan UUID 400 invalid_id, tanpa token 401', async () => {
  const { post, store } = await setup()
  const payload = (approvalId: unknown) => ({ approvalId, answers: [{ key: 'a', label: 'Some question', value: 'x' }] })

  const foreign = await post(payload(OTHER_APPROVAL))
  assert.equal(foreign.statusCode, 404)
  assert.equal(foreign.json().code, 'approval_not_found')

  const pending = await post(payload(PENDING_APPROVAL))
  assert.equal(pending.statusCode, 409)
  assert.equal(pending.json().code, 'approval_not_approved')

  for (const bad of ['123', '', null, undefined, 7, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaZ']) {
    const res = await post(payload(bad))
    assert.equal(res.statusCode, 400, String(bad))
    assert.equal(res.json().code, 'invalid_id', String(bad))
  }
  assert.equal((await post(payload(APPROVAL), {})).statusCode, 401)
  assert.equal(store.tables.user_form_answers.length, 0)
})

test('answers: token dicabut ditolak (401 token_revoked) dan tidak ada yang tersimpan', async () => {
  const { post, app, store } = await setup()
  const body = { approvalId: APPROVAL, answers: [{ key: 'a', label: 'Some question', value: 'x' }] }
  assert.equal((await post(body)).statusCode, 200)
  store.tables.user_form_answers.length = 0

  assert.equal((await app.inject({ method: 'POST', url: '/api/extension/revoke-all' })).statusCode, 200)
  const res = await post(body)
  assert.equal(res.statusCode, 401)
  assert.equal(res.json().code, 'token_revoked')
  assert.equal(store.tables.user_form_answers.length, 0)
})

test('answers: tabel belum dimigrasi 503 answers_unavailable; galat lain 500 generik tanpa teks galat database', async () => {
  const missing = await setup({}, { failTables: { user_form_answers: { code: '42P01', message: 'relation "user_form_answers" does not exist' } } })
  const res = await missing.post({ approvalId: APPROVAL, answers: [{ key: 'a', label: 'Some question', value: 'x' }] })
  assert.equal(res.statusCode, 503)
  assert.equal(res.json().code, 'answers_unavailable')

  const broken = await setup({}, { failTables: { user_form_answers: { code: 'XX000', message: 'deadlock detected on host db.internal password=hunter2' } } })
  const bad = await broken.post({ approvalId: APPROVAL, answers: [{ key: 'a', label: 'Some question', value: 'x' }] })
  assert.equal(bad.statusCode, 500)
  assert.equal(bad.json().code, 'answers_save_failed')
  assert.ok(!bad.body.includes('deadlock') && !bad.body.includes('hunter2') && !bad.body.includes('db.internal'))
})
