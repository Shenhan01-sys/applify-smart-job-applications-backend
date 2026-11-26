import test from 'node:test'
import assert from 'node:assert/strict'
import { MAX_NEXT_STEPS, sanitizeNextSteps } from '../services/extension-runner.js'
import { buildApp, issueToken, makeExtensionTestDb, USER_ID } from './extension-test-db.js'

// Uji live 26 November 2026 (JobStreet, QA Tester Intern): ekstensi berhenti di editor Riwayat karier tanpa tombol
// kirim akhir. Laporannya membawa `nextSteps` supaya kartu Persetujuan bisa menunjukkan langkah berikutnya.

const NOW = new Date('2026-11-26T05:00:00Z')
const FUTURE = '2026-11-27T12:00:00Z'
const APPROVAL = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1'
const PAGE_URL = 'https://id.jobstreet.com/id/job/1/apply/profile'

async function setup() {
  const store = makeExtensionTestDb({
    approval_requests: [{ id: APPROVAL, user_id: USER_ID, job_id: 'job-1', application_id: 'app-1', status: 'approved', expires_at: FUTURE, job_title: 'QA Tester Intern', company: 'Acme' }],
    jobs: [{ id: 'job-1', platform_source: 'jobstreet', title: 'QA Tester Intern', company: 'Acme', external_url: 'https://id.jobstreet.com/id/job/1' }],
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
  return { store, report }
}

test('sanitizeNextSteps: jenis dikenal saja, label dibersihkan, duplikat dan kunci asing dibuang', () => {
  const out = sanitizeNextSteps([
    { kind: 'subform_save', label: '  Simpan jabatan  ', value: 'rahasia' },
    { kind: 'next_page', label: 'Review dan kirim' },
    { kind: 'next_page', label: 'Review dan kirim' },
    { kind: 'upload_file', label: 'Unggah CV\nsecara manual' },
    { kind: 'answer_required', label: 'Jawab 2 pertanyaan wajib' },
    { kind: 'login', label: 'Masuk ke akunmu' },
    { kind: 'hack', label: 'Tidak dikenal' },
    { kind: 'next_page', label: '' },
    { kind: 'next_page' },
    'bukan objek',
    null,
  ])
  assert.deepEqual(out, [
    { kind: 'subform_save', label: 'Simpan jabatan' },
    { kind: 'next_page', label: 'Review dan kirim' },
    { kind: 'upload_file', label: 'Unggah CV secara manual' },
    { kind: 'answer_required', label: 'Jawab 2 pertanyaan wajib' },
    { kind: 'login', label: 'Masuk ke akunmu' },
  ])
  assert.ok(!JSON.stringify(out).includes('rahasia'))
})

test('sanitizeNextSteps: bukan larik menjadi kosong, jumlah dan panjang label dibatasi', () => {
  for (const bad of [undefined, null, 'x', 7, {}]) assert.deepEqual(sanitizeNextSteps(bad), [], String(bad))
  const many = Array.from({ length: 20 }, (_, i) => ({ kind: 'next_page', label: `Langkah ${i}` }))
  assert.equal(sanitizeNextSteps(many).length, MAX_NEXT_STEPS)
  assert.equal(sanitizeNextSteps([{ kind: 'next_page', label: 'x'.repeat(400) }])[0].label.length, 120)
})

test('report-run: nextSteps disaring dan disimpan ke details.next_steps tanpa perubahan skema', async () => {
  const { store, report } = await setup()
  const res = await report({
    outcome: 'incomplete',
    filledCount: 12,
    nextSteps: [
      { kind: 'subform_save', label: 'Simpan jabatan' },
      { kind: 'next_page', label: 'Review dan kirim' },
      { kind: 'bukan_jenis', label: 'dibuang' },
    ],
  })
  assert.equal(res.statusCode, 200)
  assert.deepEqual(store.tables.application_logs[0].details.next_steps, [
    { kind: 'subform_save', label: 'Simpan jabatan' },
    { kind: 'next_page', label: 'Review dan kirim' },
  ])
})

test('report-run: tanpa nextSteps (klien lama) atau kosong, kunci next_steps tidak ditulis', async () => {
  const { store, report } = await setup()
  assert.equal((await report({ outcome: 'incomplete', filledCount: 1 })).statusCode, 200)
  assert.equal('next_steps' in store.tables.application_logs[0].details, false)
  assert.equal((await report({ outcome: 'incomplete', filledCount: 1, nextSteps: [] })).statusCode, 200)
  assert.equal('next_steps' in store.tables.application_logs[1].details, false)
  assert.equal((await report({ outcome: 'incomplete', filledCount: 1, nextSteps: 'bukan larik' })).statusCode, 200)
  assert.equal('next_steps' in store.tables.application_logs[2].details, false)
})
