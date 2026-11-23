import test from 'node:test'
import assert from 'node:assert/strict'
import { sanitizeFilesAttached, sanitizeFilledFields } from '../services/extension-runner.js'
import { buildApp, issueToken, makeExtensionTestDb, USER_ID } from './extension-test-db.js'

const NOW = new Date('2026-11-24T05:00:00Z')
const FUTURE = '2026-11-24T12:00:00Z'
const APPROVAL = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1'
const PAGE_URL = 'https://www.kalibrr.com/c/acme/jobs/1/apply'

async function setup() {
  const store = makeExtensionTestDb({
    approval_requests: [{ id: APPROVAL, user_id: USER_ID, job_id: 'job-1', application_id: 'app-1', status: 'approved', expires_at: FUTURE, job_title: 'Backend', company: 'Acme' }],
    jobs: [{ id: 'job-1', platform_source: 'kalibrr', title: 'Backend Engineer', company: 'Acme', external_url: 'https://www.kalibrr.com/c/acme/jobs/1' }],
    ai_applications: [{ id: 'app-1', user_id: USER_ID, job_id: 'job-1', status: 'draft' }],
    subscriptions: [{ user_id: USER_ID, ai_model_tier: 'free' }],
  })
  const app = buildApp({ db: store.db, primaryUserId: USER_ID, now: () => NOW.getTime() })
  const token = await issueToken(app)
  const report = (payload: Record<string, unknown>) =>
    app.inject({
      method: 'POST',
      url: '/api/extension/report-run',
      headers: { authorization: `Bearer ${token}` },
      payload: { approvalId: APPROVAL, jobId: 'job-1', pageUrl: PAGE_URL, ...payload },
    })
  const authorize = () =>
    app.inject({
      method: 'POST',
      url: '/api/extension/authorize-submit',
      headers: { authorization: `Bearer ${token}` },
      payload: { approvalId: APPROVAL, jobId: 'job-1', pageUrl: PAGE_URL, missingRequiredCount: 0 },
    })
  return { store, report, authorize }
}

test('sanitizeFilesAttached: empat jenis dikenal, nilai boolean; nama berkas, kunci asing, dan bentuk salah tidak disimpan', () => {
  assert.deepEqual(sanitizeFilesAttached({ resume: true, cover_letter: 'surat-budi.pdf', transcript: false, portfolio: 0, evil: true, __proto__: { resume: true } }), {
    resume: true,
    cover_letter: true,
    transcript: false,
    portfolio: false,
  })
  assert.deepEqual(sanitizeFilesAttached(['resume', 'transcript', 'bogus', 7]), { resume: true, cover_letter: false, transcript: true, portfolio: false })
  assert.deepEqual(sanitizeFilesAttached({ resume: '  ' }), { resume: false, cover_letter: false, transcript: false, portfolio: false })
  for (const bad of [undefined, null, 'resume', 42, true]) assert.equal(sanitizeFilesAttached(bad), null, String(bad))
})

test('sanitizeFilledFields: nilai untuk label rahasia tidak pernah disimpan (Password, PIN, CVV, nomor kartu, OTP, KTP), label dan jenis tetap', () => {
  const out = sanitizeFilledFields([
    { label: 'Password', kind: 'text', value: 'hunter2' },
    { label: 'Enter your PIN', kind: 'text', value: '1234' },
    { label: 'CVV', kind: 'text', value: '987' },
    { label: 'Card number', kind: 'text', value: '4111111111111111' },
    { label: 'One-time passcode', kind: 'text', value: '55555' },
    { label: 'Security code', kind: 'text', value: '424242' },
    { label: 'KTP', kind: 'text', value: '3174000000000001' },
    { label: 'Shipping address', kind: 'text', value: 'Jl. Merdeka 1' },
    { label: 'Pinterest profile', kind: 'text', value: 'pinterest.com/budi' },
    { label: 'Notice period', kind: 'select', value: '1 month' },
    { label: 'Resume', kind: 'upload', value: '/tmp/applify/cv-budi.pdf' },
    { label: 'I agree', kind: 'check', value: 'true' },
  ])
  const json = JSON.stringify(out)
  for (const secret of ['hunter2', '1234', '987', '4111111111111111', '55555', '424242', '3174000000000001']) assert.ok(!json.includes(secret), secret)
  assert.deepEqual(out.slice(0, 7).map((f) => [f.label, f.kind, 'value' in f]), [
    ['Password', 'text', false],
    ['Enter your PIN', 'text', false],
    ['CVV', 'text', false],
    ['Card number', 'text', false],
    ['One-time passcode', 'text', false],
    ['Security code', 'text', false],
    ['KTP', 'text', false],
  ])
  // Kata yang hanya mirip tidak lagi menghapus nilai.
  assert.equal(out[7].value, 'Jl. Merdeka 1')
  assert.equal(out[8].value, 'pinterest.com/budi')
  assert.equal(out[9].value, '1 month')
  assert.equal(out[10].value, 'cv-budi.pdf', 'unggahan hanya nama berkas')
  assert.equal('value' in out[11], false)
})

test('report-run: filesAttached -> details.documents_attached, filledFields -> details.filled_fields (label dan jenis), tanpa nilai rahasia', async () => {
  const { store, report } = await setup()
  const res = await report({
    outcome: 'ready',
    filledCount: 4,
    filesAttached: { resume: true, cover_letter: true, transcript: false },
    filledFields: [
      { label: 'Full Name', kind: 'text' },
      { label: 'Password', kind: 'text', value: 'hunter2-SECRET' },
      { label: 'Card number', kind: 'text', value: '4111111111111111' },
      { label: 'Resume', kind: 'upload', value: 'C:\\Users\\budi\\cv.pdf' },
    ],
  })
  assert.equal(res.statusCode, 200)
  const log = store.tables.application_logs[0]
  assert.deepEqual(log.details.documents_attached, { resume: true, cover_letter: true, transcript: false, portfolio: false })
  assert.deepEqual(
    log.details.filled_fields.map((f: any) => [f.label, f.kind]),
    [['Full Name', 'text'], ['Password', 'text'], ['Card number', 'text'], ['Resume', 'upload']]
  )
  assert.deepEqual(log.details.fields_by_kind, { text: 3, select: 0, check: 0, upload: 1 })
  const everything = JSON.stringify(store.tables)
  assert.ok(!everything.includes('hunter2-SECRET'))
  assert.ok(!everything.includes('4111111111111111'))
})

test('report-run: tanpa filesAttached kunci documents_attached tidak ditulis (klien lama tidak dianggap "tidak ada berkas")', async () => {
  const { store, report } = await setup()
  assert.equal((await report({ outcome: 'ready', filledCount: 1 })).statusCode, 200)
  assert.equal('documents_attached' in store.tables.application_logs[0].details, false)
  assert.equal((await report({ outcome: 'ready', filledCount: 1, filesAttached: 'resume' })).statusCode, 200)
  assert.equal('documents_attached' in store.tables.application_logs[1].details, false)
})

test('report-run: filesAttached ikut tersimpan pada laporan kirim (submitted)', async () => {
  const { store, report, authorize } = await setup()
  const auth = await authorize()
  assert.equal(auth.statusCode, 200)
  const res = await report({ outcome: 'submitted', runId: auth.json().runId, filledCount: 3, filesAttached: { resume: true } })
  assert.equal(res.statusCode, 200)
  assert.equal(store.tables.application_logs[0].status, 'success')
  assert.deepEqual(store.tables.application_logs[0].details.documents_attached, { resume: true, cover_letter: false, transcript: false, portfolio: false })
})

test('report-run: pertanyaan opsional dan kontrol rahasia dari plan-form dipisah; tidak ada yang rahasia di details.questions', async () => {
  const { store, report } = await setup()
  const res = await report({
    outcome: 'incomplete',
    filledCount: 2,
    // Angka lama = jumlah seluruh pertanyaan (termasuk opsional); yang jadi remaining_required hanya yang wajib.
    remainingRequired: 4,
    questions: [
      { key: 'why us', label: 'Why us?', kind: 'textarea', required: true },
      { key: 'nickname', label: 'Nickname', kind: 'text', required: false },
      { key: 'account password', label: 'Account password', kind: 'secret_skip', required: true },
      { key: 'security pin', label: 'Security PIN', kind: 'secret_skip', required: false },
    ],
  })
  assert.equal(res.statusCode, 200)
  const d = store.tables.application_logs[0].details
  // Bentuk yang dibaca parser frontend: key, label, kind, options?; required adalah tambahan.
  assert.deepEqual(d.questions, [
    { key: 'why us', label: 'Why us?', kind: 'textarea', required: true },
    { key: 'nickname', label: 'Nickname', kind: 'text', required: false },
  ])
  assert.equal(d.questions_pending, 2)
  assert.deepEqual(d.secret_skipped, [
    { key: 'account password', label: 'Account password', required: true },
    { key: 'security pin', label: 'Security PIN', required: false },
  ])
  assert.deepEqual(d.remaining_required, ['Why us?', 'Account password'])
})
