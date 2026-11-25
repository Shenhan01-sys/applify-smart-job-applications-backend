import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FakeDb } from './helpers/fakeDb.ts'
import { QueueService } from '../services/queue.service.ts'
import { ApprovalRequiredError, MissingCvUnconfirmedError, clientErrorReply, guardQueuePayload, requireApprovedRow } from '../services/queue-guard.ts'

const NOW = new Date('2026-11-18T10:00:00.000Z')
const FUTURE = '2026-11-18T11:00:00.000Z'
const PAST = '2026-11-18T09:00:00.000Z'

const approval = (over: Record<string, any> = {}) => ({
  id: 'a1',
  user_id: 'u1',
  job_id: 'j1',
  application_id: 'app1',
  status: 'approved',
  expires_at: FUTURE,
  resume_url: 'https://storage.test/cv.pdf',
  ...over,
})

test('requireApprovedRow: approved dan belum kedaluwarsa lolos', async () => {
  const row = await requireApprovedRow(new FakeDb({ approval_requests: [approval()] }), 'u1', 'a1', NOW)
  assert.equal(row.id, 'a1')
})

test('requireApprovedRow: tanpa id, tidak ada, milik user lain, bukan approved, kedaluwarsa: semuanya ditolak', async () => {
  const cases: Array<[string, any, unknown]> = [
    ['tanpa id', new FakeDb({ approval_requests: [approval()] }), undefined],
    ['tidak ada', new FakeDb(), 'a1'],
    ['milik user lain', new FakeDb({ approval_requests: [approval({ user_id: 'u2' })] }), 'a1'],
    ['pending', new FakeDb({ approval_requests: [approval({ status: 'pending' })] }), 'a1'],
    ['rejected', new FakeDb({ approval_requests: [approval({ status: 'rejected' })] }), 'a1'],
    ['kedaluwarsa', new FakeDb({ approval_requests: [approval({ expires_at: PAST })] }), 'a1'],
    ['expires_at kosong', new FakeDb({ approval_requests: [approval({ expires_at: null })] }), 'a1'],
  ]
  for (const [name, db, id] of cases) {
    await assert.rejects(requireApprovedRow(db, 'u1', id, NOW), ApprovalRequiredError, name)
  }
})

test('guardQueuePayload: approved dari klien selalu dibuang', async () => {
  const db = new FakeDb()
  const out = await guardQueuePayload(db, 'u1', 'apply', { job_id: 'j1', approved: true }, NOW)
  assert.equal('approved' in out, false)
  assert.equal(out.job_id, 'j1')
})

test('guardQueuePayload: apply dengan approval_request_id palsu ditolak, bukan diloloskan sebagai approved', async () => {
  const db = new FakeDb({ approval_requests: [approval({ status: 'pending' })] })
  await assert.rejects(
    guardQueuePayload(db, 'u1', 'apply', { job_id: 'j1', approval_request_id: 'a1', approved: true }, NOW),
    ApprovalRequiredError
  )
})

test('guardQueuePayload: apply dengan persetujuan sah: server yang menulis approved dan job_id', async () => {
  const db = new FakeDb({ approval_requests: [approval()] })
  const out = await guardQueuePayload(db, 'u1', 'apply', { approval_request_id: 'a1' }, NOW)
  assert.deepEqual(out, { approval_request_id: 'a1', job_id: 'j1', application_id: 'app1', approved: true })
})

test('guardQueuePayload: persetujuan untuk lowongan lain ditolak', async () => {
  const db = new FakeDb({ approval_requests: [approval()] })
  await assert.rejects(
    guardQueuePayload(db, 'u1', 'apply', { approval_request_id: 'a1', job_id: 'j9' }, NOW),
    /different job/
  )
})

test('guardQueuePayload: email_apply wajib punya persetujuan sah', async () => {
  const db = new FakeDb({ approval_requests: [approval()] })
  await assert.rejects(guardQueuePayload(db, 'u1', 'email_apply', { job_id: 'j1', approved: true }, NOW), ApprovalRequiredError)
  const ok = await guardQueuePayload(db, 'u1', 'email_apply', { approval_request_id: 'a1', apply_email: 'hr@x.test' }, NOW)
  assert.equal(ok.approved, true)
  assert.equal(ok.apply_email, 'hr@x.test')
})

test('guardQueuePayload (GAP-10): email_apply tanpa resume_url ditolak 409 missing_cv_unconfirmed kecuali allow_without_cv === true', async () => {
  const db = new FakeDb({ approval_requests: [approval({ resume_url: null })] })
  for (const badFlag of [undefined, false, 'true', 1]) {
    const err = await guardQueuePayload(
      db,
      'u1',
      'email_apply',
      { approval_request_id: 'a1', apply_email: 'hr@x.test', ...(badFlag !== undefined ? { allow_without_cv: badFlag } : {}) },
      NOW
    ).catch((e) => e)
    assert.ok(err instanceof MissingCvUnconfirmedError, String(badFlag))
    const reply = clientErrorReply(err)
    assert.equal(reply?.statusCode, 409)
    assert.equal(reply?.body.code, 'missing_cv_unconfirmed')
  }
  const ok = await guardQueuePayload(
    db,
    'u1',
    'email_apply',
    { approval_request_id: 'a1', apply_email: 'hr@x.test', allow_without_cv: true },
    NOW
  )
  assert.equal(ok.approved, true)
  assert.equal(ok.allow_without_cv, true)
})

test('guardQueuePayload: job type lain kehilangan kunci persetujuan', async () => {
  const out = await guardQueuePayload(new FakeDb(), 'u1', 'search', { keywords: 'x', approved: true, approval_request_id: 'a1' }, NOW)
  assert.deepEqual(out, { keywords: 'x' })
})

test('guardQueuePayload: payload bukan objek diperlakukan sebagai kosong', async () => {
  assert.deepEqual(await guardQueuePayload(new FakeDb(), 'u1', 'apply', null, NOW), {})
  assert.deepEqual(await guardQueuePayload(new FakeDb(), 'u1', 'apply', ['x'], NOW), {})
})

test('QueueService.addApplyJob: klien yang mengirim approved:true tanpa persetujuan tidak menghasilkan baris approved', async () => {
  const db = new FakeDb()
  const svc = new QueueService(db as any)
  await svc.addApplyJob('u1', { job_id: 'j1', approved: true })
  const row = db.rows('automation_queue')[0]
  assert.equal(row.job_type, 'apply')
  assert.equal('approved' in row.payload, false)
})

test('QueueService.addApplyJob: approval_request_id yang tidak sah melempar ApprovalRequiredError dan tidak mengantre', async () => {
  const db = new FakeDb({ approval_requests: [approval({ status: 'rejected' })] })
  const svc = new QueueService(db as any)
  await assert.rejects(svc.addApplyJob('u1', { approval_request_id: 'a1', approved: true }), ApprovalRequiredError)
  assert.equal(db.rows('automation_queue').length, 0)
})

test('QueueService.addApprovedApplyJob: payload dibangun dari baris database, bukan dari pemanggil', async () => {
  const db = new FakeDb({ approval_requests: [approval({ expires_at: '2999-01-01T00:00:00.000Z' })] })
  const svc = new QueueService(db as any)
  const { id } = await svc.addApprovedApplyJob('u1', 'a1')
  const row = db.rows('automation_queue').find((r) => r.id === id)!
  assert.deepEqual(row.payload, { job_id: 'j1', application_id: 'app1', approval_request_id: 'a1', approved: true })
})

test('QueueService.addApprovedApplyJob: persetujuan pending tidak bisa diantrekan', async () => {
  const db = new FakeDb({ approval_requests: [approval({ status: 'pending', expires_at: '2999-01-01T00:00:00.000Z' })] })
  await assert.rejects(new QueueService(db as any).addApprovedApplyJob('u1', 'a1'), ApprovalRequiredError)
  assert.equal(db.rows('automation_queue').length, 0)
})

test('QueueService.addGenericJob: jalur /api/automation/queue tidak bisa menyelundupkan email_apply atau approved', async () => {
  const db = new FakeDb()
  const svc = new QueueService(db as any)
  await assert.rejects(svc.addGenericJob('u1', 'email_apply', { job_id: 'j1', approved: true }), ApprovalRequiredError)
  await svc.addGenericJob('u1', 'apply', { job_id: 'j1', approved: true })
  assert.equal(db.rows('automation_queue').length, 1)
  assert.equal('approved' in db.rows('automation_queue')[0].payload, false)
})
