import test from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import { approvalRoutes } from '../api/routes/approval.js'
import { getClaimStatuses, resolveLockedClaim } from '../services/approval-claim-recovery.js'
import { makeExtensionTestDb } from './extension-test-db.js'

const USER_ID = '11111111-2222-3333-4444-555555555555'
const A1 = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1'
const A2 = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2'
const A3 = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa3'
const A4 = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa4'

test('getClaimStatuses: membedakan locked_stuck vs in_progress vs submitted secara tepat', async () => {
  const now = new Date('2026-11-23T12:10:00Z')
  const store = makeExtensionTestDb({
    approval_submit_claims: [
      { approval_request_id: A1, user_id: USER_ID, channel: 'worker', queue_job_id: 'q1', created_at: '2026-11-23T12:00:00Z' },
      { approval_request_id: A2, user_id: USER_ID, channel: 'worker', queue_job_id: 'q2', created_at: '2026-11-23T12:09:30Z' },
      { approval_request_id: A3, user_id: USER_ID, channel: 'extension', run_id: 'ext-1', created_at: '2026-11-23T12:05:00Z' },
      { approval_request_id: A4, user_id: USER_ID, channel: 'extension', run_id: 'ext-2', created_at: '2026-11-23T12:09:40Z' },
    ],
    automation_queue: [
      { id: 'q1', user_id: USER_ID, job_type: 'apply', status: 'failed', payload: { approval_request_id: A1 } },
      { id: 'q2', user_id: USER_ID, job_type: 'apply', status: 'processing', payload: { approval_request_id: A2 } },
    ],
    application_logs: [],
  })

  const map = await getClaimStatuses(store.db, USER_ID, [A1, A2, A3, A4], now)
  assert.equal(map[A1].state, 'locked_stuck') // worker berhenti tanpa log kirim
  assert.equal(map[A2].state, 'in_progress')  // worker masih processing
  assert.equal(map[A3].state, 'locked_stuck') // ekstensi lewat 2 menit tanpa laporan
  assert.equal(map[A4].state, 'in_progress')  // ekstensi baru 20 detik
})

test('resolveLockedClaim: mark_sent & create_fresh_approval memulihkan tanpa pernah menghapus klaim lama', async () => {
  const now = new Date('2026-11-23T12:10:00Z')
  const store = makeExtensionTestDb({
    approval_requests: [
      {
        id: A1,
        user_id: USER_ID,
        job_id: 'j1',
        application_id: 'app-1',
        job_title: 'BE',
        company: 'Acme',
        platform: 'greenhouse',
        cover_letter: 'Surat A1',
        answers: [],
        status: 'approved',
        expires_at: '2026-11-24T12:00:00Z',
      },
      {
        id: A2,
        user_id: USER_ID,
        job_id: 'j2',
        application_id: 'app-2',
        job_title: 'FE',
        company: 'Beta',
        platform: 'lever',
        cover_letter: 'Surat A2',
        answers: [{ question: 'Why?', answer: 'Yes' }],
        status: 'approved',
        expires_at: '2026-11-24T12:00:00Z',
      },
    ],
    approval_submit_claims: [
      { approval_request_id: A1, user_id: USER_ID, channel: 'extension', run_id: 'r1', created_at: '2026-11-23T12:00:00Z' },
      { approval_request_id: A2, user_id: USER_ID, channel: 'worker', queue_job_id: 'q2', created_at: '2026-11-23T12:00:00Z' },
    ],
    ai_applications: [
      { id: 'app-1', user_id: USER_ID, job_id: 'j1', status: 'ready' },
      { id: 'app-2', user_id: USER_ID, job_id: 'j2', status: 'draft' },
    ],
  })

  // 1. mark_sent
  const res1 = await resolveLockedClaim(store.db, USER_ID, A1, 'mark_sent', now)
  assert.equal(res1.ok, true)
  assert.equal(res1.newApprovalId, null)
  assert.equal(store.tables.ai_applications[0].status, 'submitted')
  assert.equal(store.tables.application_logs[0].status, 'success')
  assert.equal(store.tables.approval_submit_claims.length, 2) // klaim lama TETAP dipertahankan

  // 2. create_fresh_approval
  const res2 = await resolveLockedClaim(store.db, USER_ID, A2, 'create_fresh_approval', now)
  assert.equal(res2.ok, true)
  assert.ok(res2.newApprovalId)
  assert.equal(store.tables.approval_submit_claims.length, 2) // klaim A2 TETAP dikunci selamanya
  assert.equal(store.tables.approval_requests.length, 3)
  const fresh = store.tables.approval_requests[2]
  assert.equal(fresh.status, 'pending')
  assert.equal(fresh.cover_letter, 'Surat A2')
  assert.equal(store.tables.application_logs[1].details.reason, 'abandoned_locked_claim')

  // HTTP route wiring check
  const app = Fastify()
  app.addHook('preHandler', async (req: any) => {
    req.user = { id: USER_ID }
  })
  await app.register(approvalRoutes, {
    prefix: '/api/approvals',
    db: store.db,
    guard: { checkActionRateLimit: async () => {} },
  })
  const httpClaims = await app.inject({
    method: 'POST',
    url: '/api/approvals/claim-statuses',
    payload: { approval_ids: [A1, A2] },
  })
  assert.equal(httpClaims.statusCode, 200)
  assert.equal(httpClaims.json().claims[A1].state, 'submitted')
  assert.equal(httpClaims.json().claims[A2].state, 'locked_stuck')
})
