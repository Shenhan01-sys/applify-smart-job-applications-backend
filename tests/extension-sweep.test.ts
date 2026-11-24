import test from 'node:test'
import assert from 'node:assert/strict'
import { EXHAUSTED_MESSAGE, EXPIRED_MESSAGE, sweepExtensionJobs, sweepExtensionJobsNode } from '../services/extension-sweep.js'
import { claimNextExtensionJob } from '../services/extension-queue.js'
import { makeExtensionTestDb, OTHER_USER_ID, USER_ID } from './extension-test-db.js'

/** Sapuan tugas extension_apply: jatah percobaan habis + heartbeat basi, dan persetujuan tidak berlaku. */

const NOW = new Date('2026-11-24T12:00:00Z')
const FUTURE = '2026-11-25T12:00:00Z'
const PAST = '2026-11-24T11:00:00Z'
const JOB_ID = '22222222-2222-4222-8222-222222222201'
const A_OK = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'
const A_EXPIRED = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2'
const A_MISSING = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3'
const A_OTHER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4'

const row = (id: string, approval: string, over: Record<string, any> = {}) => ({
  id,
  user_id: USER_ID,
  job_type: 'extension_apply',
  status: 'pending',
  priority: 0,
  retry_count: 0,
  max_retries: 3,
  scheduled_at: '2026-11-24T11:59:00Z',
  payload: { job_id: JOB_ID, approval_request_id: approval, approved: true },
  ...over,
})

const approvals = [
  { id: A_OK, user_id: USER_ID, job_id: JOB_ID, status: 'approved', expires_at: FUTURE },
  { id: A_EXPIRED, user_id: USER_ID, job_id: JOB_ID, status: 'approved', expires_at: PAST },
  { id: A_OTHER, user_id: OTHER_USER_ID, job_id: JOB_ID, status: 'approved', expires_at: PAST },
]

function seed(rows: any[]) {
  return makeExtensionTestDb({
    jobs: [{ id: JOB_ID, title: 'Backend', company: 'Acme', platform_source: 'jobstreet', external_url: 'https://id.jobstreet.com/id/job/1', description: '' }],
    approval_requests: approvals.map((a) => ({ ...a })),
    automation_queue: rows,
  })
}

const byId = (store: any, id: string) => store.tables.automation_queue.find((r: any) => r.id === id)

test('sapuan: processing basi dengan jatah percobaan habis menjadi failed berpesan jelas', async () => {
  const store = seed([
    row('q-exhausted', A_OK, { status: 'processing', retry_count: 3, heartbeat_at: '2026-11-24T11:50:00Z', processed_at: '2026-11-24T11:50:00Z' }),
    row('q-fresh', A_OK, { status: 'processing', retry_count: 3, heartbeat_at: '2026-11-24T11:58:00Z' }),
    row('q-retry-left', A_OK, { status: 'processing', retry_count: 1, heartbeat_at: '2026-11-24T11:50:00Z' }),
  ])
  const res = await sweepExtensionJobs(store.db as any, { userId: USER_ID, now: NOW })
  assert.equal(res.via, 'node')
  assert.equal(res.failed, 1)
  assert.equal(byId(store, 'q-exhausted').status, 'failed')
  assert.equal(byId(store, 'q-exhausted').error_message, EXHAUSTED_MESSAGE)
  assert.equal(byId(store, 'q-exhausted').completed_at, NOW.toISOString())
  assert.equal(byId(store, 'q-fresh').status, 'processing', 'heartbeat segar tidak disapu')
  assert.equal(byId(store, 'q-retry-left').status, 'processing', 'masih punya jatah percobaan: dibiarkan agar direklaim')
})

test('sapuan: persetujuan kedaluwarsa atau hilang membuat baris pending/processing menjadi failed', async () => {
  const store = seed([
    row('q-expired-pending', A_EXPIRED),
    row('q-expired-processing', A_EXPIRED, { status: 'processing', heartbeat_at: '2026-11-24T11:59:30Z' }),
    row('q-missing', A_MISSING),
    row('q-ok', A_OK),
  ])
  const res = await sweepExtensionJobs(store.db as any, { userId: USER_ID, now: NOW })
  assert.equal(res.failed, 3)
  for (const id of ['q-expired-pending', 'q-expired-processing', 'q-missing']) {
    assert.equal(byId(store, id).status, 'failed', id)
    assert.equal(byId(store, id).error_message, EXPIRED_MESSAGE, id)
  }
  assert.equal(byId(store, 'q-ok').status, 'pending')
})

test('sapuan: persetujuan yang tidak lagi approved (mis. rejected atau expired) ikut gagal', async () => {
  const store = seed([row('q1', A_OK)])
  store.tables.approval_requests.find((a: any) => a.id === A_OK).status = 'expired'
  assert.equal((await sweepExtensionJobs(store.db as any, { userId: USER_ID, now: NOW })).failed, 1)
  assert.equal(byId(store, 'q1').status, 'failed')
})

test('sapuan per pengguna tidak menyentuh baris pengguna lain; tanpa userId menyapu semua', async () => {
  const mine = row('q-mine', A_EXPIRED)
  const theirs = row('q-theirs', A_OTHER, { user_id: OTHER_USER_ID })
  const store = seed([mine, theirs])
  const scoped = await sweepExtensionJobs(store.db as any, { userId: USER_ID, now: NOW })
  assert.equal(scoped.failed, 1)
  assert.equal(byId(store, 'q-theirs').status, 'pending')

  const all = await sweepExtensionJobs(store.db as any, { now: NOW })
  assert.equal(all.failed, 1)
  assert.equal(byId(store, 'q-theirs').status, 'failed')
})

test('sapuan: baris completed/failed tidak disentuh dan sapuan kedua tidak menghitung ulang', async () => {
  const store = seed([
    row('q-done', A_EXPIRED, { status: 'completed', completed_at: '2026-11-24T10:00:00Z' }),
    row('q-pending', A_EXPIRED),
  ])
  assert.equal((await sweepExtensionJobsNode(store.db as any, { userId: USER_ID, now: NOW })), 1)
  assert.equal(byId(store, 'q-done').status, 'completed')
  assert.equal((await sweepExtensionJobsNode(store.db as any, { userId: USER_ID, now: NOW })), 0)
})

test('sapuan memakai RPC bila sudah dimigrasi dan tidak mengulang lewat Node', async () => {
  const store = seed([row('q1', A_EXPIRED)])
  const calls: Array<{ name: string; args: any }> = []
  const db: any = {
    from: (t: string) => store.db.from(t),
    rpc: async (name: string, args: any) => {
      calls.push({ name, args })
      return { data: 4, error: null }
    },
  }
  const res = await sweepExtensionJobs(db, { userId: USER_ID, now: NOW, staleAfterMs: 300_000 })
  assert.deepEqual(res, { failed: 4, via: 'rpc' })
  assert.deepEqual(calls, [{ name: 'sweep_extension_apply_jobs', args: { p_user_id: USER_ID, p_stale_after_seconds: 300 } }])
  assert.equal(byId(store, 'q1').status, 'pending', 'RPC yang menyapu; Node tidak dijalankan')
})

test('sapuan: galat RPC selain "fungsi belum ada" dilempar, bukan ditelan', async () => {
  const db: any = { from: () => { throw new Error('tidak boleh dipakai') }, rpc: async () => ({ data: null, error: { code: '42501', message: 'permission denied' } }) }
  await assert.rejects(sweepExtensionJobs(db, { userId: USER_ID, now: NOW }), /sweep rpc failed/)
})

test('klaim menyapu tugas pengguna lebih dulu: baris persetujuan kedaluwarsa gagal, baris sehat diklaim', async () => {
  const store = seed([
    row('q-expired', A_EXPIRED, { scheduled_at: '2026-11-24T11:00:00Z' }),
    row('q-ok', A_OK),
  ])
  const job = await claimNextExtensionJob(store.db as any, USER_ID, { now: NOW })
  assert.equal(job?.queueJobId, 'q-ok')
  assert.equal(byId(store, 'q-expired').status, 'failed')
  assert.equal(byId(store, 'q-expired').error_message, EXPIRED_MESSAGE)
})

test('klaim: baris processing basi dengan jatah habis menjadi failed (tidak diklaim ulang tanpa akhir)', async () => {
  const store = seed([row('q-stuck', A_OK, { status: 'processing', retry_count: 3, heartbeat_at: '2026-11-24T11:40:00Z' })])
  const job = await claimNextExtensionJob(store.db as any, USER_ID, { now: NOW })
  assert.equal(job, null)
  assert.equal(byId(store, 'q-stuck').status, 'failed')
  assert.equal(byId(store, 'q-stuck').error_message, EXHAUSTED_MESSAGE)
})
