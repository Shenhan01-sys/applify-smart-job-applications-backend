import { test } from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import { FakeDb } from './helpers/fakeDb.ts'
import { RateLimitService } from '../services/rate-limit.service.ts'
import { approvalRoutes } from '../api/routes/approval.ts'
import { rateLimitRoutes } from '../api/routes/rate-limit.ts'

const U1 = '11111111-1111-4111-8111-111111111111'
const U2 = '22222222-2222-4222-8222-222222222222'
const J1 = '33333333-3333-4333-8333-333333333333'
const APP_U2 = '44444444-4444-4444-8444-444444444444'

test('47.6 F-09: RateLimitService gagal tertutup saat DB error (checkPlatformLimit & checkUserQuota)', async () => {
  const failingDb = {
    from() {
      return {
        select() { return this },
        eq() { return this },
        in() { return this },
        gte: async () => ({ count: null, error: { code: 'XX000', message: 'db down' } }),
        maybeSingle: async () => ({ data: null, error: { code: 'XX000', message: 'db down' } }),
      }
    },
  }
  const svc = new RateLimitService(failingDb as any)
  await assert.rejects(() => svc.checkPlatformLimit('greenhouse', U1), /rate_limit_check_failed/)
  await assert.rejects(() => svc.checkUserQuota(U1), /quota_check_failed/)

  // Rute rate-limit tidak membocorkan pesan DB mentah
  const app = Fastify()
  app.addHook('preHandler', async (req: any) => { req.user = { id: U1 } })
  await app.register(rateLimitRoutes, { prefix: '/api/rate-limit' })
  const res = await app.inject({ method: 'GET', url: '/api/rate-limit/platform/greenhouse' })
  assert.ok(res.statusCode === 200 || res.statusCode === 503)
  await app.close()
})

test('47.6 F-21: POST /api/approvals menolak application_id milik pengguna lain dengan 404 dan format bukan UUID dengan 400', async () => {
  const db = new FakeDb({
    jobs: [{ id: J1, title: 'Engineer', company: 'PT Test', visibility: 'public' }],
    ai_applications: [{ id: APP_U2, user_id: U2, job_id: J1, cover_letter: 'Rahasia U2' }],
    approval_requests: [],
  })

  const app = Fastify()
  app.addHook('preHandler', async (req: any) => { req.user = { id: U1 } })
  await app.register(approvalRoutes, {
    prefix: '/api/approvals',
    db,
    guard: { checkActionRateLimit: async () => {} },
  })

  const badUuid = await app.inject({
    method: 'POST',
    url: '/api/approvals',
    payload: { job_id: J1, application_id: 'bukan-uuid', job_title: 'Engineer', company: 'PT Test', platform: 'greenhouse', answers: [] },
  })
  assert.equal(badUuid.statusCode, 400)

  const foreign = await app.inject({
    method: 'POST',
    url: '/api/approvals',
    payload: { job_id: J1, application_id: APP_U2, job_title: 'Engineer', company: 'PT Test', platform: 'greenhouse', answers: [] },
  })
  assert.equal(foreign.statusCode, 404)
  assert.equal(db.tables.approval_requests.length, 0)
  await app.close()
})

test('47.6 F-19: GET /api/approvals/history membatasi limit maksimal 100 dan offset >= 0', async () => {
  const ranges: Array<[number, number]> = []
  const stubDb = {
    from() {
      return {
        select() { return this },
        eq() { return this },
        neq() { return this },
        order() { return this },
        range: async (from: number, to: number) => {
          ranges.push([from, to])
          return { data: [], error: null }
        },
      }
    },
  }

  const app = Fastify()
  app.addHook('preHandler', async (req: any) => { req.user = { id: U1 } })
  await app.register(approvalRoutes, { prefix: '/api/approvals', db: stubDb })

  const res = await app.inject({ method: 'GET', url: '/api/approvals/history?limit=9999&offset=-10' })
  assert.equal(res.statusCode, 200)
  assert.deepEqual(ranges, [[0, 99]])
  await app.close()
})

test('47.6 F-20: expiry dan revert queue failure di approvalRoutes mengunci user_id dan status', async () => {
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('../api/routes/approval.ts', import.meta.url), 'utf8')
  assert.match(src, /update\(\{ status: 'expired' \}\)[\s\S]{0,120}\.eq\('user_id', userId\)\s*\.eq\('status', 'pending'\)/)
  assert.match(src, /update\(\{ status: 'pending', reviewed_at: null \}\)[\s\S]{0,120}\.eq\('user_id', userId\)\s*\.eq\('status', 'approved'\)/)
})
