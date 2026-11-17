import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FakeDb } from './helpers/fakeDb.ts'
import { RateLimitService, DAILY_APPLY_LIMIT, startOfUtcDay } from '../services/rate-limit.service.ts'

// ---- rate limit: one definition of "a submission" ---------------------------------------------------

const NOW = new Date('2026-11-18T10:00:00.000Z')
const logRow = (over: Record<string, any> = {}) => ({
  user_id: 'u1', action: 'apply', status: 'success', platform: 'greenhouse',
  created_at: '2026-11-18T08:00:00.000Z', ...over,
})
const rows = (n: number, over: Record<string, any> = {}) => Array.from({ length: n }, () => logRow(over))

test('checkUserQuota menghitung apply dan email_apply berstatus success, bukan action "submit"', async () => {
  const db = new FakeDb({
    application_logs: [
      ...rows(3),
      ...rows(2, { action: 'email_apply' }),
      ...rows(5, { action: 'submit' }),
      ...rows(5, { status: 'ready' }),
      ...rows(5, { created_at: '2026-11-17T23:59:00.000Z' }),
      ...rows(5, { user_id: 'u2' }),
    ],
  })
  const q = await new RateLimitService(db as any).checkUserQuota('u1', NOW)
  assert.equal(q.used, 5)
  assert.equal(q.limit, 10)
  assert.equal(q.remaining, 5)
  assert.equal(q.allowed, true)
  assert.equal(q.tier, 'free')
  assert.equal(q.resetsAt.toISOString(), '2026-11-19T00:00:00.000Z')
})

test('checkUserQuota membaca paket dari subscriptions.ai_model_tier (pro = 20)', async () => {
  const db = new FakeDb({
    subscriptions: [{ user_id: 'u1', ai_model_tier: 'pro' }],
    application_logs: rows(15),
  })
  const q = await new RateLimitService(db as any).checkUserQuota('u1', NOW)
  assert.equal(q.tier, 'pro')
  assert.equal(q.limit, DAILY_APPLY_LIMIT.pro)
  assert.equal(q.used, 15)
  assert.equal(q.allowed, true)
})

test('checkUserQuota: tepat di batas harian = tidak diizinkan', async () => {
  const db = new FakeDb({ application_logs: rows(10) })
  const q = await new RateLimitService(db as any).checkUserQuota('u1', NOW)
  assert.equal(q.allowed, false)
  assert.equal(q.remaining, 0)
})

test('startOfUtcDay', () => {
  assert.equal(startOfUtcDay(new Date('2026-11-18T23:59:59.000Z')).toISOString(), '2026-11-18T00:00:00.000Z')
})

