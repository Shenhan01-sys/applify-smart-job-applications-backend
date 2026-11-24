import test from 'node:test'
import assert from 'node:assert/strict'
import { EXTENSION_LEASE_STALE_MS } from '../services/extension-queue.js'
import { parseLeaseId } from '../services/extension-lease.js'
import { buildApp, makeExtensionTestDb, OTHER_USER_ID, USER_ID } from './extension-test-db.js'

/**
 * Kepemilikan lease antrean extension_apply: claim -> lease_id (claimed_by), heartbeat/release/report-run
 * menolak pemilik lama sesudah reklamasi. Sebelum migrasi (kolom claimed_by belum ada) pemeriksaan dilewati.
 */

const NOW = new Date('2026-11-24T12:00:00Z')
const FUTURE = '2026-11-25T12:00:00Z'
const JOB_ID = '22222222-2222-4222-8222-222222222201'
const APPROVAL_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'
const APPROVAL_2 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2'
const Q1 = 'aaaaaaaa-1111-4111-8111-111111111111'
const Q2 = 'bbbbbbbb-2222-4222-8222-222222222222'
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

const pendingRow = (id = Q1, approval = APPROVAL_ID) => ({
  id,
  user_id: USER_ID,
  job_type: 'extension_apply',
  status: 'pending',
  priority: 0,
  retry_count: 0,
  max_retries: 3,
  scheduled_at: '2026-11-24T11:59:00Z',
  payload: { job_id: JOB_ID, approval_request_id: approval, approved: true },
})

function seed(rows: any[], options: Parameters<typeof makeExtensionTestDb>[1] = {}) {
  return makeExtensionTestDb(
    {
      jobs: [{ id: JOB_ID, title: 'Backend Engineer', company: 'Acme ID', platform_source: 'jobstreet', external_url: 'https://id.jobstreet.com/id/job/96011760', description: '' }],
      approval_requests: [
        { id: APPROVAL_ID, user_id: USER_ID, job_id: JOB_ID, application_id: 'app-1', status: 'approved', apply_channel: 'extension', expires_at: FUTURE },
        { id: APPROVAL_2, user_id: USER_ID, job_id: JOB_ID, application_id: 'app-2', status: 'approved', apply_channel: 'extension', expires_at: FUTURE },
      ],
      automation_queue: rows,
    },
    options
  )
}

async function setup(rows: any[], options: Parameters<typeof makeExtensionTestDb>[1] = {}) {
  const store = seed(rows, options)
  const clock = { ms: NOW.getTime() }
  const app = buildApp({ db: store.db, primaryUserId: USER_ID, now: () => clock.ms })
  const { token } = (await app.inject({ method: 'POST', url: '/api/extension/token' })).json()
  const auth = { authorization: `Bearer ${token}` }
  const post = (url: string, payload?: unknown) => app.inject({ method: 'POST', url: `/api/extension${url}`, headers: auth, payload: payload as any })
  return { store, clock, post }
}

const report = (post: any, extra: Record<string, unknown>) =>
  post('/report-run', {
    approvalId: APPROVAL_ID,
    jobId: JOB_ID,
    queueJobId: Q1,
    pageUrl: 'https://id.jobstreet.com/id/job/96011760/apply',
    outcome: 'ready',
    filledCount: 3,
    ...extra,
  })

test('parseLeaseId: tidak ada, rusak, sah', () => {
  assert.deepEqual(parseLeaseId(undefined), { kind: 'absent' })
  assert.deepEqual(parseLeaseId(null), { kind: 'absent' })
  assert.deepEqual(parseLeaseId(''), { kind: 'absent' })
  assert.deepEqual(parseLeaseId(42), { kind: 'invalid' })
  assert.deepEqual(parseLeaseId('bukan-uuid'), { kind: 'invalid' })
  assert.deepEqual(parseLeaseId('AAAAAAAA-1111-4111-8111-111111111111'), { kind: 'present', leaseId: 'aaaaaaaa-1111-4111-8111-111111111111' })
})

test('claim: job memuat lease_id (UUID acak) yang tersimpan di claimed_by; tiap klaim lease baru', async () => {
  const { store, clock, post } = await setup([pendingRow()])
  const c1 = await post('/jobs/claim', { claimer: 'ext-a' })
  assert.equal(c1.statusCode, 200)
  const lease1 = c1.json().job.lease_id
  assert.match(lease1, UUID_RE)
  assert.equal(store.tables.automation_queue[0].claimed_by, lease1)

  // Reklamasi sesudah heartbeat putus > 5 menit: lease baru, lease lama tak berlaku.
  clock.ms += EXTENSION_LEASE_STALE_MS + 1000
  const c2 = await post('/jobs/claim')
  assert.equal(c2.statusCode, 200)
  const lease2 = c2.json().job.lease_id
  assert.match(lease2, UUID_RE)
  assert.notEqual(lease2, lease1)
  assert.equal(store.tables.automation_queue[0].claimed_by, lease2)
})

test('heartbeat: lease benar 200, lease pemilik lama 409 lease_lost, tanpa lease_id (ekstensi lama) 200, lease rusak 400', async () => {
  const { clock, post } = await setup([pendingRow()])
  const leaseA = (await post('/jobs/claim')).json().job.lease_id

  assert.equal((await post(`/jobs/${Q1}/heartbeat`, { lease_id: leaseA })).statusCode, 200)
  assert.equal((await post(`/jobs/${Q1}/heartbeat`)).statusCode, 200, 'tanpa lease_id tetap diterima')
  assert.equal((await post(`/jobs/${Q1}/heartbeat`, { lease_id: 'bukan-uuid' })).statusCode, 400)

  clock.ms += EXTENSION_LEASE_STALE_MS + 1000
  const leaseB = (await post('/jobs/claim')).json().job.lease_id
  assert.notEqual(leaseA, leaseB)

  const stale = await post(`/jobs/${Q1}/heartbeat`, { lease_id: leaseA })
  assert.equal(stale.statusCode, 409)
  assert.equal(stale.json().error, 'Tugas ini sudah direklaim ekstensi lain')
  assert.equal(stale.json().code, 'lease_lost')
  assert.equal((await post(`/jobs/${Q1}/heartbeat`, { lease_id: leaseB })).statusCode, 200)
})

test('release: pemilik lama ditolak 409 lease_lost dan baris tidak berubah; pemilik sah melepas dan claimed_by dikosongkan', async () => {
  const { store, clock, post } = await setup([pendingRow()])
  const leaseA = (await post('/jobs/claim')).json().job.lease_id
  clock.ms += EXTENSION_LEASE_STALE_MS + 1000
  const leaseB = (await post('/jobs/claim')).json().job.lease_id
  const before = { ...store.tables.automation_queue[0] }

  const lost = await post(`/jobs/${Q1}/release`, { lease_id: leaseA, error: 'tab ditutup', delaySeconds: 0 })
  assert.equal(lost.statusCode, 409)
  assert.equal(lost.json().code, 'lease_lost')
  assert.equal(store.tables.automation_queue[0].status, 'processing')
  assert.equal(store.tables.automation_queue[0].retry_count, before.retry_count)
  assert.equal(store.tables.automation_queue[0].claimed_by, leaseB)

  const ok = await post(`/jobs/${Q1}/release`, { lease_id: leaseB, delaySeconds: 0 })
  assert.equal(ok.statusCode, 200)
  assert.equal(ok.json().status, 'pending')
  assert.equal(store.tables.automation_queue[0].claimed_by, null)

  // Lease lama setelah baris dilepas (claimed_by kosong) tidak bisa melepas lagi.
  const again = await post(`/jobs/${Q1}/release`, { lease_id: leaseB, delaySeconds: 0 })
  assert.equal(again.statusCode, 409)
  assert.equal(again.json().code, 'lease_lost')
})

test('release tanpa lease_id (ekstensi lama): diterima', async () => {
  const { store, post } = await setup([pendingRow()])
  await post('/jobs/claim')
  const res = await post(`/jobs/${Q1}/release`, { delaySeconds: 0 })
  assert.equal(res.statusCode, 200)
  assert.equal(store.tables.automation_queue[0].status, 'pending')
})

test('report-run: lease pemilik lama tidak menyentuh baris, lease sah menuntaskan', async () => {
  const { store, clock, post } = await setup([pendingRow()])
  const leaseA = (await post('/jobs/claim')).json().job.lease_id
  clock.ms += EXTENSION_LEASE_STALE_MS + 1000
  const leaseB = (await post('/jobs/claim')).json().job.lease_id

  const stale = await report(post, { lease_id: leaseA })
  assert.equal(stale.statusCode, 200, 'log hasil tetap tersimpan')
  assert.equal(store.tables.application_logs.length, 1)
  assert.equal(store.tables.automation_queue[0].status, 'processing', 'baris milik pemilik baru tidak disentuh')
  assert.equal(store.tables.automation_queue[0].claimed_by, leaseB)

  const ok = await report(post, { lease_id: leaseB })
  assert.equal(ok.statusCode, 200)
  assert.equal(store.tables.automation_queue[0].status, 'completed')
  assert.equal(store.tables.automation_queue[0].claimed_by, null)
})

test('report-run tanpa lease_id (ekstensi lama): tetap menuntaskan baris', async () => {
  const { store, post } = await setup([pendingRow()])
  await post('/jobs/claim')
  const res = await report(post, {})
  assert.equal(res.statusCode, 200)
  assert.equal(store.tables.automation_queue[0].status, 'completed')
})

test('report-run: queueJobId milik persetujuan lain atau baris yang sudah selesai tidak disentuh', async () => {
  const { store, post } = await setup([
    pendingRow(Q1, APPROVAL_ID),
    { ...pendingRow(Q2, APPROVAL_2), status: 'failed', error_message: 'sudah gagal' },
  ])
  // Laporan untuk APPROVAL_ID tetapi menunjuk queueJobId milik APPROVAL_2: tidak boleh menyentuh baris Q2.
  const mismatch = await report(post, { queueJobId: Q2 })
  assert.equal(mismatch.statusCode, 200)
  const q2 = store.tables.automation_queue.find((r: any) => r.id === Q2)
  assert.equal(q2.status, 'failed')
  assert.equal(q2.error_message, 'sudah gagal')

  // Baris aktif tetapi milik persetujuan lain: tetap tidak disentuh.
  q2.status = 'processing'
  const mismatchActive = await report(post, { queueJobId: Q2 })
  assert.equal(mismatchActive.statusCode, 200)
  assert.equal(store.tables.automation_queue.find((r: any) => r.id === Q2).status, 'processing')

  // Baris sudah completed: laporan susulan tidak membukanya kembali atau mengubah completed_at.
  store.tables.automation_queue[0].status = 'completed'
  store.tables.automation_queue[0].completed_at = '2026-11-24T11:00:00Z'
  const late = await report(post, { outcome: 'awaiting_login', queueJobId: Q1 })
  assert.equal(late.statusCode, 200)
  assert.equal(store.tables.automation_queue[0].status, 'completed')
  assert.equal(store.tables.automation_queue[0].completed_at, '2026-11-24T11:00:00Z')
})

test('report-run: baris milik pengguna lain tidak pernah disentuh', async () => {
  const foreign = { ...pendingRow(Q2), user_id: OTHER_USER_ID, status: 'processing', claimed_by: 'lease-lain' }
  const { store, post } = await setup([pendingRow(), foreign])
  const res = await report(post, { queueJobId: Q2 })
  assert.equal(res.statusCode, 200)
  const row = store.tables.automation_queue.find((r: any) => r.id === Q2)
  assert.equal(row.status, 'processing')
  assert.equal(row.claimed_by, 'lease-lain')
})

test('sebelum migrasi (kolom claimed_by dan heartbeat_at belum ada): lease_id tetap dikirim, pemeriksaan dilewati', async () => {
  const { store, clock, post } = await setup([pendingRow()], { missingColumns: { automation_queue: ['claimed_by', 'heartbeat_at'] } })
  const claim = await post('/jobs/claim')
  assert.equal(claim.statusCode, 200)
  const lease = claim.json().job.lease_id
  assert.match(lease, UUID_RE)
  assert.equal('claimed_by' in store.tables.automation_queue[0], false)

  // Lease apa pun lolos karena tak ada yang disimpan.
  assert.equal((await post(`/jobs/${Q1}/heartbeat`, { lease_id: lease })).statusCode, 200)
  assert.equal((await post(`/jobs/${Q1}/heartbeat`, { lease_id: 'bbbbbbbb-1111-4111-8111-111111111111' })).statusCode, 200)
  clock.ms += 1000
  const rep = await report(post, { lease_id: 'bbbbbbbb-1111-4111-8111-111111111111' })
  assert.equal(rep.statusCode, 200)
  assert.equal(store.tables.automation_queue[0].status, 'completed')
})

test('sebelum migrasi: release memakai lease apa pun dan berhasil', async () => {
  const { store, post } = await setup([pendingRow()], { missingColumns: { automation_queue: ['claimed_by', 'heartbeat_at'] } })
  const lease = (await post('/jobs/claim')).json().job.lease_id
  const res = await post(`/jobs/${Q1}/release`, { lease_id: lease, delaySeconds: 0 })
  assert.equal(res.statusCode, 200)
  assert.equal(store.tables.automation_queue[0].status, 'pending')
})
