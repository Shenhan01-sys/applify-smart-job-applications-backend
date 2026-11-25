import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FakeDb } from './helpers/fakeDb.ts'
import { QueueService, type PlatformLimiter } from '../services/queue.service.ts'
import { PlatformLimitReachedError, clientErrorReply } from '../services/queue-guard.ts'

const FUTURE = '2999-01-01T00:00:00.000Z'
const approval = (platform: string | null) => ({
  id: 'a1', user_id: 'u1', job_id: 'j1', application_id: null, status: 'approved', expires_at: FUTURE, platform,
})
const limiter = (allowed: boolean, calls: Array<[string, string]> = []): PlatformLimiter => ({
  async checkPlatformLimit(platform, userId) {
    calls.push([platform, userId])
    return { allowed, remaining: allowed ? 5 : 0, resetAt: new Date(Date.now() + 3600_000) }
  },
})

test('addApprovedApplyJob: batas platform tercapai -> PlatformLimitReachedError dan tidak ada baris antrean', async () => {
  const db = new FakeDb({ approval_requests: [approval('JobStreet')] })
  const calls: Array<[string, string]> = []
  const svc = new QueueService(db as any, limiter(false, calls))
  await assert.rejects(svc.addApprovedApplyJob('u1', 'a1'), (e: any) => e instanceof PlatformLimitReachedError && e.code === 'platform_limit_reached' && e.statusCode === 429)
  assert.deepEqual(calls, [['jobstreet', 'u1']])
  assert.equal(((db as any).tables?.automation_queue ?? []).length, 0)
})

test('addApprovedExtensionApplyJob juga dibatasi', async () => {
  const db = new FakeDb({ approval_requests: [approval('glints')] })
  const svc = new QueueService(db as any, limiter(false))
  await assert.rejects(svc.addApprovedExtensionApplyJob('u1', 'a1'), PlatformLimitReachedError)
})

test('batas belum tercapai -> job masuk antrean', async () => {
  const db = new FakeDb({ approval_requests: [approval('kalibrr')] })
  const svc = new QueueService(db as any, limiter(true))
  const { id } = await svc.addApprovedApplyJob('u1', 'a1')
  assert.ok(id)
})

test('platform kosong tidak memanggil pembatas', async () => {
  const db = new FakeDb({ approval_requests: [approval(null)] })
  const calls: Array<[string, string]> = []
  const svc = new QueueService(db as any, limiter(false, calls))
  await svc.addApprovedApplyJob('u1', 'a1')
  assert.equal(calls.length, 0)
})

test('addApplyJob (isi formulir tanpa kirim) dan addScanJob tidak melewati batas platform', async () => {
  const db = new FakeDb()
  const calls: Array<[string, string]> = []
  const svc = new QueueService(db as any, limiter(false, calls))
  await svc.addScanJob('u1', { keywords: 'x' })
  await svc.addApplyJob('u1', { job_id: 'j1' })
  assert.equal(calls.length, 0)
})

test('clientErrorReply: 429 platform_limit_reached berbahasa Indonesia', () => {
  const r = clientErrorReply(new PlatformLimitReachedError('jobstreet'))
  assert.equal(r?.statusCode, 429)
  assert.equal(r?.body.code, 'platform_limit_reached')
  assert.match(r!.body.error, /Batas lamaran ke jobstreet/)
})
