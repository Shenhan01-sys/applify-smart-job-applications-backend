import test from 'node:test'
import assert from 'node:assert/strict'
import { MAX_ACTION_LOG, sanitizeActionLog } from '../services/extension-runner.js'
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
  return { store, report }
}

test('sanitizeActionLog: daftar tertutup, kunci asing (nilai, label) tidak disalin, ref dan alasan dibersihkan', () => {
  const out = sanitizeActionLog([
    { step: 1, ref: 'c1', kind: 'text', action: 'set', result: 'verified', value: 'Budi Santoso', label: 'Nama lengkap', text: 'isi halaman' },
    { step: 2, ref: 'c2 <x>', kind: 'weird', action: 'select', result: 'unverified', reason: 'option_ambiguous' },
    { step: 3, ref: 'c3', kind: 'file', action: 'attach', result: 'missing', reason: 'Jl. Merdeka 5' },
    { ref: 'c4', kind: 'text', action: 'hack', result: 'verified' },
    { ref: 'c5', kind: 'text', action: 'set', result: 'ok' },
    'bukan objek',
    null,
    ['larik'],
  ])
  assert.deepEqual(out, [
    { step: 1, ref: 'c1', kind: 'text', action: 'set', result: 'verified' },
    { step: 2, ref: 'c2x', kind: 'other', action: 'select', result: 'unverified', reason: 'option_ambiguous' },
    { step: 3, ref: 'c3', kind: 'file', action: 'attach', result: 'missing' },
  ])
  const json = JSON.stringify(out)
  for (const leak of ['Budi', 'Nama lengkap', 'isi halaman', 'Merdeka']) assert.ok(!json.includes(leak), leak)
})

test('sanitizeActionLog: bukan larik menjadi kosong, jumlah dan nomor langkah dibatasi', () => {
  for (const bad of [undefined, null, 'x', 7, {}, { 0: { action: 'set', result: 'verified' } }]) assert.deepEqual(sanitizeActionLog(bad), [], String(bad))
  const many = Array.from({ length: MAX_ACTION_LOG + 100 }, (_, i) => ({ step: i % 50, ref: `c${i}`, kind: 'text', action: 'set', result: 'verified' }))
  const out = sanitizeActionLog(many)
  assert.equal(out.length, MAX_ACTION_LOG)
  assert.ok(out.every((e) => e.step >= 1 && e.step <= 20))
  assert.equal(sanitizeActionLog([{ ref: 'x'.repeat(300), action: 'skip', result: 'skipped' }])[0].ref.length, 64)
})

test('report-run: actionLog disaring dan disimpan ke details.action_log; nilai isian tidak pernah masuk database', async () => {
  const { store, report } = await setup()
  const res = await report({
    outcome: 'incomplete',
    filledCount: 1,
    // Kunci tak dikenal di tingkat atas tetap diterima (tidak ada validator yang menolak), hanya diabaikan.
    unknownTopLevel: { anything: true },
    actionLog: [
      { step: 1, ref: 'c1', kind: 'text', action: 'set', result: 'verified', value: 'NILAI-RAHASIA-123' },
      { step: 1, ref: 'c2', kind: 'radio', action: 'check', result: 'unverified', reason: 'option_ambiguous' },
      { step: 2, ref: 'next_step', kind: 'button', action: 'click', result: 'unverified', reason: 'page_unchanged' },
    ],
  })
  assert.equal(res.statusCode, 200)
  assert.deepEqual(store.tables.application_logs[0].details.action_log, [
    { step: 1, ref: 'c1', kind: 'text', action: 'set', result: 'verified' },
    { step: 1, ref: 'c2', kind: 'radio', action: 'check', result: 'unverified', reason: 'option_ambiguous' },
    { step: 2, ref: 'next_step', kind: 'button', action: 'click', result: 'unverified', reason: 'page_unchanged' },
  ])
  assert.ok(!JSON.stringify(store.tables).includes('NILAI-RAHASIA-123'))
})

test('report-run: tanpa actionLog (klien lama) atau actionLog kosong, kunci action_log tidak ditulis; 300 entri dipotong jadi 200', async () => {
  const { store, report } = await setup()
  assert.equal((await report({ outcome: 'ready', filledCount: 1 })).statusCode, 200)
  assert.equal('action_log' in store.tables.application_logs[0].details, false)
  assert.equal((await report({ outcome: 'ready', filledCount: 1, actionLog: [] })).statusCode, 200)
  assert.equal('action_log' in store.tables.application_logs[1].details, false)
  assert.equal((await report({ outcome: 'ready', filledCount: 1, actionLog: 'bukan larik' })).statusCode, 200)
  assert.equal('action_log' in store.tables.application_logs[2].details, false)

  const many = Array.from({ length: 300 }, (_, i) => ({ step: 1, ref: `c${i}`, kind: 'text', action: 'set', result: 'verified' }))
  assert.equal((await report({ outcome: 'incomplete', filledCount: 1, actionLog: many })).statusCode, 200)
  assert.equal(store.tables.application_logs[3].details.action_log.length, MAX_ACTION_LOG)
})
