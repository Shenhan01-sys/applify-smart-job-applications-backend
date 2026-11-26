import { test } from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import { APPROVAL_TTL_MS, approvalRoutes } from '../api/routes/approval.js'
import { FakeDb } from './helpers/fakeDb.js'

const U1 = '11111111-1111-4111-8111-111111111111'
const J1 = '22222222-2222-4222-8222-222222222222'
const APR_VALID = '33333333-3333-4333-8333-333333333333'
const APR_EXPIRED = '44444444-4444-4444-8444-444444444444'
const APR_EXPIRED_EXT = '55555555-5555-4555-8555-555555555555'

async function buildApp(db: FakeDb, queuedJobs: string[] = []) {
  const app = Fastify({ logger: false })
  app.addHook('preHandler', async (req: any) => {
    req.user = { id: U1, email: 'uji@example.id' }
  })
  const fakeQueue: any = {
    addApprovedApplyJob: async (_uid: string, approvalId: string) => {
      queuedJobs.push(approvalId)
      return { id: `q-${approvalId}` }
    },
    addApprovedExtensionApplyJob: async (_uid: string, approvalId: string) => {
      queuedJobs.push(approvalId)
      return { id: `q-ext-${approvalId}` }
    },
  }
  await app.register(approvalRoutes, {
    prefix: '/api/approvals',
    db,
    queue: fakeQueue,
    guard: { checkActionRateLimit: async () => {} },
  })
  return app
}

test('APPROVAL_TTL_MS: POST /api/approvals menetapkan expires_at 24 jam ke depan', async () => {
  assert.equal(APPROVAL_TTL_MS, 24 * 60 * 60 * 1000)
  const db = new FakeDb({
    jobs: [{ id: J1, title: 'Backend Engineer', company: 'PT Uji', external_url: 'https://boards.greenhouse.io/acme/jobs/1', visibility: 'public' }],
    approval_requests: [],
  })
  const app = await buildApp(db)

  const before = Date.now()
  const res = await app.inject({
    method: 'POST',
    url: '/api/approvals',
    payload: { job_id: J1, job_title: 'Backend Engineer', company: 'PT Uji', platform: 'greenhouse', cover_letter: 'Surat lengkap.' },
  })
  const after = Date.now()

  assert.equal(res.statusCode, 200)
  const expiresMs = Date.parse(res.json().expires_at)
  assert.ok(expiresMs >= before + APPROVAL_TTL_MS - 1000 && expiresMs <= after + APPROVAL_TTL_MS + 1000, 'expires_at harus 24 jam, bukan 1 jam')
  await app.close()
})

test('APPROVAL_TTL_MS: approve lolos saat belum kedaluwarsa, tetapi ditolak 410 dan ditandai expired setelah lewat batas 24 jam', async () => {
  const now = Date.now()
  const queued: string[] = []
  const db = new FakeDb({
    jobs: [{ id: J1, title: 'Backend Engineer', company: 'PT Uji', external_url: 'https://boards.greenhouse.io/acme/jobs/1', visibility: 'public' }],
    approval_requests: [
      { id: APR_VALID, user_id: U1, job_id: J1, job_title: 'Backend Engineer', company: 'PT Uji', platform: 'greenhouse', status: 'pending', expires_at: new Date(now + 60_000).toISOString() },
      { id: APR_EXPIRED, user_id: U1, job_id: J1, job_title: 'Backend Engineer', company: 'PT Uji', platform: 'greenhouse', status: 'pending', expires_at: new Date(now - 10_000).toISOString() },
      { id: APR_EXPIRED_EXT, user_id: U1, job_id: J1, job_title: 'Backend Engineer', company: 'PT Uji', platform: 'greenhouse', status: 'approved', expires_at: new Date(now - 10_000).toISOString() },
    ],
  })
  const app = await buildApp(db, queued)

  const okRes = await app.inject({ method: 'POST', url: `/api/approvals/${APR_VALID}/approve`, payload: {} })
  assert.equal(okRes.statusCode, 200)
  assert.deepEqual(queued, [APR_VALID])
  assert.equal(db.tables.approval_requests.find((r) => r.id === APR_VALID)?.status, 'approved')

  const expRes = await app.inject({ method: 'POST', url: `/api/approvals/${APR_EXPIRED}/approve`, payload: {} })
  assert.equal(expRes.statusCode, 410)
  assert.deepEqual(queued, [APR_VALID], 'persetujuan kedaluwarsa tidak boleh diantrekan')
  assert.equal(db.tables.approval_requests.find((r) => r.id === APR_EXPIRED)?.status, 'expired')

  const expConsent = await app.inject({ method: 'POST', url: `/api/approvals/${APR_EXPIRED_EXT}/extension-consent`, payload: {} })
  assert.equal(expConsent.statusCode, 410)
  assert.equal(expConsent.json().code, 'approval_expired')
  assert.deepEqual(queued, [APR_VALID])

  await app.close()
})
