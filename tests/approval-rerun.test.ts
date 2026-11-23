import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FakeDb } from './helpers/fakeDb.ts'
import { QueueService } from '../services/queue.service.ts'
import { ApprovalRequiredError } from '../services/queue-guard.ts'
import {
  MAX_RUNS_PER_APPROVAL,
  decideRerun,
  fetchRerunFacts,
  rerunApproval,
  type RerunFacts,
} from '../services/rerun-guard.ts'

/**
 * POST /api/approvals/:id/rerun: the decision is a pure function (decideRerun), the flow around it
 * (rerunApproval) runs here against a fake database. Nothing is sent and no network is used.
 */

const NOW = new Date('2026-11-23T10:00:00.000Z')
const FUTURE = '2026-11-23T11:00:00.000Z'
const PAST = '2026-11-23T09:00:00.000Z'

const facts = (over: Partial<RerunFacts> = {}, approval: Record<string, any> | null = {}): RerunFacts => ({
  approval: approval === null ? null : { status: 'approved', expires_at: FUTURE, job_id: 'j1', ...approval },
  now: NOW,
  usedCount: 0,
  activeCount: 0,
  totalCount: 1,
  ...over,
})

// ---- decideRerun: every branch ----------------------------------------------------------------------

test('decideRerun: persetujuan sah, belum terkirim, tidak ada job aktif, di bawah batas: ok', () => {
  assert.deepEqual(decideRerun(facts()), { ok: true })
})

test('decideRerun: persetujuan tidak ada: 404', () => {
  assert.deepEqual(decideRerun(facts({}, null)), { ok: false, status: 404, error: 'Approval request not found' })
})

test('decideRerun: status selain approved: 409 "Approval is not approved"', () => {
  for (const status of ['pending', 'rejected', 'expired', undefined, null]) {
    assert.deepEqual(decideRerun(facts({}, { status })), {
      ok: false, status: 409, error: 'Approval is not approved',
    })
  }
})

test('decideRerun: kedaluwarsa, kosong, atau tidak terbaca: 410', () => {
  for (const expires_at of [PAST, NOW.toISOString(), null, undefined, '', 'bukan tanggal']) {
    const v = decideRerun(facts({}, { expires_at }))
    assert.equal(v.ok, false, String(expires_at))
    assert.equal((v as any).status, 410, String(expires_at))
  }
})

test('decideRerun: satu milidetik sebelum kedaluwarsa masih lolos', () => {
  const expires_at = new Date(NOW.getTime() + 1).toISOString()
  assert.deepEqual(decideRerun(facts({}, { expires_at })), { ok: true })
})

test('decideRerun: tanpa job_id: 422', () => {
  for (const job_id of [null, undefined, '']) {
    const v = decideRerun(facts({}, { job_id }))
    assert.equal(v.ok, false)
    assert.equal((v as any).status, 422)
  }
})

test('decideRerun: lamaran sudah terkirim (success atau submit_unverified): 409', () => {
  assert.deepEqual(decideRerun(facts({ usedCount: 1 })), {
    ok: false, status: 409, error: 'Application was already sent for this approval',
  })
})

test('decideRerun: agen sedang bekerja pada persetujuan ini: 409', () => {
  assert.deepEqual(decideRerun(facts({ activeCount: 1 })), {
    ok: false, status: 409, error: 'Agent is already working on this application',
  })
})

test('decideRerun: batas 6 job per persetujuan (1 asli + 5 ulang): 5 lolos, 6 ditolak 429', () => {
  assert.equal(MAX_RUNS_PER_APPROVAL, 6)
  assert.deepEqual(decideRerun(facts({ totalCount: 5 })), { ok: true })
  assert.deepEqual(decideRerun(facts({ totalCount: 6 })), {
    ok: false, status: 429, error: 'Too many reruns for this approval',
  })
  assert.equal((decideRerun(facts({ totalCount: 40 })) as any).status, 429)
})

test('decideRerun: urutan aturan. Terkirim mengalahkan aktif, aktif mengalahkan batas; status mengalahkan semuanya', () => {
  const all = { usedCount: 1, activeCount: 1, totalCount: 9 }
  assert.equal((decideRerun(facts(all)) as any).error, 'Application was already sent for this approval')
  assert.equal((decideRerun(facts({ ...all, usedCount: 0 })) as any).error, 'Agent is already working on this application')
  assert.equal((decideRerun(facts({ ...all, usedCount: 0, activeCount: 0 })) as any).status, 429)
  assert.equal((decideRerun(facts(all, { status: 'pending' })) as any).error, 'Approval is not approved')
  assert.equal((decideRerun(facts(all, { expires_at: PAST })) as any).status, 410)
  assert.equal((decideRerun(facts(all, { job_id: null })) as any).status, 422)
})

// ---- fetchRerunFacts + rerunApproval against a fake database ------------------------------------------

// QueueService.addApprovedApplyJob checks expiry against the real clock, so the rows expire in year 2999.
const FAR_FUTURE = '2999-01-01T00:00:00.000Z'
const approvalRow = (over: Record<string, any> = {}) => ({
  id: 'a1', user_id: 'u1', job_id: 'j1', application_id: 'app1', status: 'approved', expires_at: FAR_FUTURE, ...over,
})
const queueRow = (over: Record<string, any> = {}) => ({
  id: `q-${Math.random()}`, user_id: 'u1', job_type: 'apply', status: 'completed',
  payload: { approval_request_id: 'a1', job_id: 'j1', approved: true }, ...over,
})
const logRow = (over: Record<string, any> = {}) => ({
  id: `l-${Math.random()}`, user_id: 'u1', action: 'apply', status: 'ready', details: { approval_request_id: 'a1' }, ...over,
})

const run = (db: FakeDb, userId = 'u1', id = 'a1') => rerunApproval(db, new QueueService(db), userId, id, NOW)

test('rerun sah: baris antrean apply baru dengan payload dari database, 200 dan queue_job_id', async () => {
  const db = new FakeDb({
    approval_requests: [approvalRow()],
    automation_queue: [queueRow()],
    application_logs: [logRow({ status: 'incomplete', details: { approval_request_id: 'a1', questions: ['q'] } })],
  })
  const res = await run(db)
  assert.equal(res.status, 200)
  assert.equal(res.body.success, true)
  const queued = db.rows('automation_queue')
  assert.equal(queued.length, 2)
  assert.equal(res.body.queue_job_id, queued[1].id)
  assert.equal(queued[1].job_type, 'apply')
  assert.equal(queued[1].status, 'pending')
  assert.deepEqual(queued[1].payload, {
    job_id: 'j1', application_id: 'app1', approval_request_id: 'a1', approved: true,
  })
  assert.equal(db.rows('approval_requests')[0].status, 'approved', 'status persetujuan tidak berubah')
})

test('rerun: persetujuan tidak ada atau milik user lain: 404, tidak ada baris antrean', async () => {
  const db = new FakeDb({ approval_requests: [approvalRow({ user_id: 'u2' })] })
  assert.equal((await run(db)).status, 404)
  assert.equal((await run(db, 'u1', 'tidak-ada')).status, 404)
  assert.equal(db.rows('automation_queue').length, 0)
})

test('rerun: status pending, rejected, atau expired: 409 "Approval is not approved"', async () => {
  for (const status of ['pending', 'rejected', 'expired']) {
    const db = new FakeDb({ approval_requests: [approvalRow({ status })] })
    const res = await run(db)
    assert.equal(res.status, 409, status)
    assert.deepEqual(res.body, { error: 'Approval is not approved' })
    assert.equal(db.rows('automation_queue').length, 0)
  }
})

test('rerun: kedaluwarsa atau expires_at kosong: 410 dan baris persetujuan tidak diubah', async () => {
  for (const expires_at of [PAST, null]) {
    const db = new FakeDb({ approval_requests: [approvalRow({ expires_at })] })
    const res = await run(db)
    assert.equal(res.status, 410)
    assert.equal(db.rows('approval_requests')[0].status, 'approved')
    assert.equal(db.writes.length, 0)
  }
})

test('rerun: tanpa job_id: 422', async () => {
  const db = new FakeDb({ approval_requests: [approvalRow({ job_id: null })] })
  assert.equal((await run(db)).status, 422)
  assert.equal(db.rows('automation_queue').length, 0)
})

test('rerun: log success atau submit_unverified untuk persetujuan ini: 409 sudah terkirim', async () => {
  for (const status of ['success', 'submit_unverified']) {
    const db = new FakeDb({ approval_requests: [approvalRow()], application_logs: [logRow({ status })] })
    const res = await run(db)
    assert.equal(res.status, 409, status)
    assert.deepEqual(res.body, { error: 'Application was already sent for this approval' })
    assert.equal(db.rows('automation_queue').length, 0)
  }
})

test('rerun: log lain tidak menghalangi (status ready/incomplete/failed, persetujuan lain, user lain)', async () => {
  const db = new FakeDb({
    approval_requests: [approvalRow()],
    application_logs: [
      logRow({ status: 'ready' }),
      logRow({ status: 'incomplete' }),
      logRow({ status: 'failed' }),
      logRow({ status: 'success', details: { approval_request_id: 'a-lain' } }),
      logRow({ status: 'success', user_id: 'u2' }),
    ],
  })
  assert.equal((await run(db)).status, 200)
})

test('rerun: job apply pending atau processing untuk persetujuan ini: 409 agen sedang bekerja', async () => {
  for (const status of ['pending', 'processing']) {
    const db = new FakeDb({ approval_requests: [approvalRow()], automation_queue: [queueRow({ status })] })
    const res = await run(db)
    assert.equal(res.status, 409, status)
    assert.deepEqual(res.body, { error: 'Agent is already working on this application' })
    assert.equal(db.rows('automation_queue').length, 1)
  }
})

test('rerun: job aktif milik persetujuan lain, user lain, atau jenis lain tidak menghalangi', async () => {
  const db = new FakeDb({
    approval_requests: [approvalRow()],
    automation_queue: [
      queueRow({ status: 'pending', payload: { approval_request_id: 'a-lain' } }),
      queueRow({ status: 'processing', user_id: 'u2' }),
      queueRow({ status: 'pending', job_type: 'email_apply' }),
      queueRow({ status: 'pending', payload: { job_id: 'j9' } }),
    ],
  })
  assert.equal((await run(db)).status, 200)
})

test('rerun: 6 job apply selesai atau gagal untuk persetujuan ini: 429; 5 masih boleh', async () => {
  const runs = (n: number) =>
    Array.from({ length: n }, (_, i) => queueRow({ status: i % 2 ? 'failed' : 'completed' }))
  const five = new FakeDb({ approval_requests: [approvalRow()], automation_queue: runs(5) })
  assert.equal((await run(five)).status, 200)
  assert.equal(five.rows('automation_queue').length, 6)

  const six = new FakeDb({ approval_requests: [approvalRow()], automation_queue: runs(6) })
  const res = await run(six)
  assert.equal(res.status, 429)
  assert.deepEqual(res.body, { error: 'Too many reruns for this approval' })
  assert.equal(six.rows('automation_queue').length, 6)
})

test('rerun: baris antrean persetujuan lain dan user lain tidak dihitung ke batas', async () => {
  const db = new FakeDb({
    approval_requests: [approvalRow()],
    automation_queue: [
      ...Array.from({ length: 8 }, () => queueRow({ payload: { approval_request_id: 'a-lain' } })),
      ...Array.from({ length: 8 }, () => queueRow({ user_id: 'u2' })),
    ],
  })
  const facts = await fetchRerunFacts(db, 'u1', 'a1', NOW)
  assert.equal(facts.totalCount, 0)
  assert.equal((await run(db)).status, 200)
})

test('rerun: kesalahan database dijawab 500 generik tanpa teks galat, tidak ada baris antrean', async () => {
  for (const [table, op] of [
    ['approval_requests', 'select'],
    ['application_logs', 'select'],
    ['automation_queue', 'select'],
    ['automation_queue', 'insert'],
  ] as const) {
    const db = new FakeDb({ approval_requests: [approvalRow()] })
    db.failOn(table, op, 'db mati')
    const res = await run(db)
    assert.equal(res.status, 500, `${table}.${op}`)
    assert.doesNotMatch(JSON.stringify(res.body), /db mati/) // teks galat database tidak sampai ke klien
    assert.equal((res.body as any).code, 'rerun_failed')
    assert.equal(db.rows('automation_queue').length, 0)
  }
})

test('rerun: persetujuan yang lapuk di antara pengecekan dan antrean dijawab 403, bukan 500', async () => {
  const db = new FakeDb({ approval_requests: [approvalRow()] })
  const queue = {
    addApprovedApplyJob: async () => {
      throw new ApprovalRequiredError('approval request has expired')
    },
  }
  const res = await rerunApproval(db, queue, 'u1', 'a1', NOW)
  assert.equal(res.status, 403)
  assert.equal((res.body as any).code, 'approval_required')
})

test('rerun: kegagalan antrean lain dijawab 500 generik tanpa teks galat', async () => {
  const db = new FakeDb({ approval_requests: [approvalRow()] })
  const queue = {
    addApprovedApplyJob: async () => {
      throw new Error('antrean penuh')
    },
  }
  const res = await rerunApproval(db, queue, 'u1', 'a1', NOW)
  assert.equal(res.status, 500)
  assert.doesNotMatch(JSON.stringify(res.body), /antrean penuh/)
  assert.equal((res.body as any).code, 'rerun_failed')
})

test('rerun dua kali berturut-turut: yang kedua ditolak karena job pertama masih pending', async () => {
  const db = new FakeDb({ approval_requests: [approvalRow()] })
  assert.equal((await run(db)).status, 200)
  assert.equal((await run(db)).status, 409)
  assert.equal(db.rows('automation_queue').length, 1)
})
