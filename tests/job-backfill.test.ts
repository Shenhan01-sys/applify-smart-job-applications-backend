import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { FakeDb } from './helpers/fakeDb.ts'
import {
  backfillState, isBackfillAdmin, resetBackfillState, runBackfill, selectBackfillTargets,
} from '../services/job-backfill.service.ts'

const long = 'x'.repeat(700)

test('isBackfillAdmin: hanya id di BACKFILL_ADMIN_IDS; env kosong berarti tidak ada', () => {
  assert.equal(isBackfillAdmin('u1', 'u1, u2'), true)
  assert.equal(isBackfillAdmin('u2', 'u1, u2'), true)
  assert.equal(isBackfillAdmin('u3', 'u1, u2'), false)
  assert.equal(isBackfillAdmin('u1', ''), false)
  assert.equal(isBackfillAdmin('u1', undefined), false)
  assert.equal(isBackfillAdmin('', 'u1'), false)
  assert.equal(isBackfillAdmin(null, 'u1'), false)
})

test('selectBackfillTargets: aktif, JobStreet/Dealls, URL https, terbaru dulu, hanya yang masih ringkas atau tanpa gaji', async () => {
  const base = { status: 'active', requirements: ['a'], salary_min: 5, description: long }
  const db = new FakeDb({
    jobs: [
      { ...base, id: 'thin-old', platform_source: 'jobstreet', external_url: 'https://id.jobstreet.com/id/job/1', description: 'pendek', created_at: '2026-11-01' },
      { ...base, id: 'thin-new', platform_source: 'dealls', external_url: 'https://dealls.com/loker/a', description: 'pendek', created_at: '2026-11-20' },
      { ...base, id: 'nosalary', platform_source: 'jobstreet', external_url: 'https://id.jobstreet.com/id/job/2', salary_min: null, created_at: '2026-11-10' },
      { ...base, id: 'complete', platform_source: 'jobstreet', external_url: 'https://id.jobstreet.com/id/job/3', created_at: '2026-11-19' },
      { ...base, id: 'glints', platform_source: 'glints', external_url: 'https://glints.com/x', description: 'pendek', created_at: '2026-11-20' },
      { ...base, id: 'seed', platform_source: 'jobstreet', external_url: null, description: 'pendek', created_at: '2026-11-20' },
      { ...base, id: 'closed', platform_source: 'jobstreet', external_url: 'https://id.jobstreet.com/id/job/4', status: 'closed', description: 'pendek', created_at: '2026-11-20' },
    ],
  })
  assert.deepEqual(await selectBackfillTargets(db as any, 10), ['thin-new', 'nosalary', 'thin-old'])
  assert.deepEqual(await selectBackfillTargets(db as any, 1), ['thin-new'])
})

test('runBackfill: berurutan dengan jeda, menghitung hasil, galat satu lowongan tidak menghentikan sisanya', async () => {
  resetBackfillState()
  const db = new FakeDb({ jobs: [{ id: 'a', salary_min: null }, { id: 'b', salary_min: null }, { id: 'c', salary_min: 1 }, { id: 'd' }] })
  const sleeps: number[] = []
  const seen: string[] = []
  const ok = await runBackfill(db as any, ['a', 'b', 'c', 'd'], {
    startedBy: 'u1',
    delayMs: 5,
    sleep: async (ms) => { sleeps.push(ms) },
    enrich: async (_db, id) => {
      seen.push(id)
      if (id === 'a') return { job: { salary_min: 7 }, enriched: true, reason: 'detail lowongan diperbarui', status: 'ok' } as any
      if (id === 'b') return { job: null, enriched: false, reason: 'gagal mengambil detail', status: 'ok' } as any
      if (id === 'c') return { job: { salary_min: 1 }, enriched: true, reason: 'detail lowongan diperbarui', status: 'ok' } as any
      throw new Error('boom')
    },
  })
  assert.equal(ok, true)
  assert.deepEqual(seen, ['a', 'b', 'c', 'd'])
  assert.deepEqual(sleeps, [5, 5, 5])
  const s = backfillState()
  assert.equal(s.running, false)
  assert.equal(s.total, 4)
  assert.equal(s.done, 4)
  assert.equal(s.enriched, 2)
  assert.equal(s.salaryAdded, 1)
  assert.equal(s.failed, 2)
  assert.equal(s.reasons['detail lowongan diperbarui'], 2)
  assert.ok(s.finishedAt)
})

test('runBackfill: hanya satu berjalan sekaligus', async () => {
  resetBackfillState()
  let release!: () => void
  const gate = new Promise<void>((r) => { release = r })
  const db = new FakeDb({ jobs: [{ id: 'a' }] })
  const first = runBackfill(db as any, ['a'], { startedBy: 'u1', enrich: async () => { await gate; return { job: null, enriched: false, reason: 'x', status: 'ok' } as any } })
  assert.equal(await runBackfill(db as any, ['a'], { startedBy: 'u1', enrich: async () => ({}) as any }), false)
  release()
  assert.equal(await first, true)
})

test('rute backfill: login wajib, hanya admin, 409 saat berjalan, berjalan di latar', () => {
  const src = readFileSync(new URL('../api/routes/jobs.ts', import.meta.url), 'utf8')
  const post = src.slice(src.indexOf("app.post('/backfill'"), src.indexOf("app.get('/backfill/status'"))
  assert.match(post, /if \(!userId\) return reply\.status\(401\)/)
  assert.match(post, /if \(!isBackfillAdmin\(userId\)\) return reply\.status\(403\)/)
  assert.match(post, /reply\.status\(409\)/)
  assert.match(post, /void runBackfill\(/)
  assert.match(post, /reply\.status\(202\)/)
  const status = src.slice(src.indexOf("app.get('/backfill/status'"))
  assert.match(status, /isBackfillAdmin\(userId\)/)
})
