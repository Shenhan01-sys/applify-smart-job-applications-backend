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
  // Sesudah create_fresh_approval klaim lama dihitung selesai ('abandoned'), bukan lagi 'locked_stuck'.
  assert.equal(httpClaims.json().claims[A2].state, 'abandoned')
})

function seedApproval(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    user_id: USER_ID,
    job_id: `job-${id.slice(-1)}`,
    application_id: `app-${id.slice(-1)}`,
    job_title: 'BE',
    company: 'Acme',
    platform: 'greenhouse',
    cover_letter: 'Surat',
    answers: [],
    status: 'approved',
    expires_at: '2026-11-24T12:00:00Z',
    ...extra,
  }
}

const NOW = new Date('2026-11-23T12:10:00Z')

test('resolveLockedClaim: klaim in_progress ditolak 409 untuk kedua jalan pulih dan tidak menulis apa pun', async () => {
  const store = makeExtensionTestDb({
    approval_requests: [seedApproval(A1), seedApproval(A2)],
    approval_submit_claims: [
      // worker masih memproses antrean
      { approval_request_id: A1, user_id: USER_ID, channel: 'worker', queue_job_id: 'q1', created_at: '2026-11-23T12:00:00Z' },
      // ekstensi baru 20 detik lalu
      { approval_request_id: A2, user_id: USER_ID, channel: 'extension', run_id: 'r2', created_at: '2026-11-23T12:09:40Z' },
    ],
    automation_queue: [{ id: 'q1', user_id: USER_ID, job_type: 'apply', status: 'processing', payload: { approval_request_id: A1 } }],
    ai_applications: [{ id: 'app-1', user_id: USER_ID, status: 'ready' }, { id: 'app-2', user_id: USER_ID, status: 'ready' }],
  })

  for (const id of [A1, A2]) {
    for (const resolution of ['mark_sent', 'create_fresh_approval'] as const) {
      await assert.rejects(
        () => resolveLockedClaim(store.db, USER_ID, id, resolution, NOW),
        (err: any) => err.statusCode === 409 && err.code === 'claim_in_progress'
      )
    }
  }
  assert.equal(store.tables.approval_requests.length, 2) // tidak ada persetujuan baru
  assert.equal(store.tables.application_logs.length, 0) // tidak ada log
  assert.equal(store.tables.ai_applications[0].status, 'ready')
  assert.equal(store.tables.approval_submit_claims.length, 2)
})

test('resolveLockedClaim: sesudah create_fresh_approval klaim selesai; ulangan dijawab 409 dan tidak membuat persetujuan baru', async () => {
  const store = makeExtensionTestDb(
    {
      approval_requests: [seedApproval(A1)],
      approval_submit_claims: [{ approval_request_id: A1, user_id: USER_ID, channel: 'worker', queue_job_id: 'q1', created_at: '2026-11-23T12:00:00Z' }],
    },
    { uniqueKeys: { approval_submit_claims: 'approval_request_id', approval_requests: 'id' } }
  )

  const first = await resolveLockedClaim(store.db, USER_ID, A1, 'create_fresh_approval', NOW)
  assert.ok(first.newApprovalId)
  assert.equal(store.tables.approval_requests.length, 2)

  const states = await getClaimStatuses(store.db, USER_ID, [A1], NOW)
  assert.equal(states[A1].state, 'abandoned') // banner hilang

  for (const resolution of ['create_fresh_approval', 'create_fresh_approval', 'mark_sent'] as const) {
    await assert.rejects(
      () => resolveLockedClaim(store.db, USER_ID, A1, resolution, NOW),
      (err: any) => err.statusCode === 409 && err.code === 'already_resolved'
    )
  }
  assert.equal(store.tables.approval_requests.length, 2) // tetap satu persetujuan baru
  assert.equal(store.tables.application_logs.filter((l) => l.details?.reason === 'abandoned_locked_claim').length, 1)
  assert.equal(store.tables.approval_submit_claims.length, 1) // klaim lama tidak pernah dihapus
})

test('resolveLockedClaim: dua permintaan create_fresh_approval paralel hanya menghasilkan satu persetujuan baru', async () => {
  const store = makeExtensionTestDb(
    {
      approval_requests: [seedApproval(A1)],
      approval_submit_claims: [{ approval_request_id: A1, user_id: USER_ID, channel: 'worker', created_at: '2026-11-23T12:00:00Z' }],
    },
    { uniqueKeys: { approval_submit_claims: 'approval_request_id', approval_requests: 'id' } }
  )
  const results = await Promise.allSettled([
    resolveLockedClaim(store.db, USER_ID, A1, 'create_fresh_approval', NOW),
    resolveLockedClaim(store.db, USER_ID, A1, 'create_fresh_approval', NOW),
  ])
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1)
  const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult
  assert.equal((rejected.reason as any).statusCode, 409)
  assert.equal(store.tables.approval_requests.length, 2)
})

test('resolveLockedClaim: sudah ada log kirim -> 409; klaim milik pengguna lain tidak ditemukan', async () => {
  const store = makeExtensionTestDb({
    approval_requests: [seedApproval(A1), seedApproval(A2, { user_id: 'other-user' })],
    approval_submit_claims: [
      { approval_request_id: A1, user_id: USER_ID, channel: 'worker', created_at: '2026-11-23T12:00:00Z' },
      { approval_request_id: A2, user_id: 'other-user', channel: 'worker', created_at: '2026-11-23T12:00:00Z' },
    ],
    application_logs: [{ user_id: USER_ID, status: 'success', details: { approval_request_id: A1 } }],
  })
  await assert.rejects(() => resolveLockedClaim(store.db, USER_ID, A1, 'create_fresh_approval', NOW), (e: any) => e.statusCode === 409 && e.code === 'already_logged')
  await assert.rejects(() => resolveLockedClaim(store.db, USER_ID, A2, 'mark_sent', NOW), (e: any) => e.statusCode === 404)
})

test('getClaimStatuses: bukti tidak terbaca (log atau antrean gagal) tidak pernah dinyatakan locked_stuck', async () => {
  const claims = [{ approval_request_id: A1, user_id: USER_ID, channel: 'worker', created_at: '2026-11-23T12:00:00Z' }]
  for (const failing of ['application_logs', 'automation_queue']) {
    const store = makeExtensionTestDb({ approval_submit_claims: claims }, { failTables: { [failing]: { code: 'XX000', message: 'boom' } } })
    const map = await getClaimStatuses(store.db, USER_ID, [A1], NOW)
    assert.equal(map[A1].state, 'in_progress', failing)
  }
})

test('resolve-claim (HTTP): klaim in_progress 409, klaim macet pulih sekali, ulangan 409', async () => {
  const store = makeExtensionTestDb(
    {
      approval_requests: [seedApproval(A1), seedApproval(A2)],
      approval_submit_claims: [
        { approval_request_id: A1, user_id: USER_ID, channel: 'worker', queue_job_id: 'q1', created_at: '2026-11-23T12:00:00Z' },
        { approval_request_id: A2, user_id: USER_ID, channel: 'worker', queue_job_id: 'q2', created_at: '2026-11-23T12:00:00Z' },
      ],
      automation_queue: [{ id: 'q1', user_id: USER_ID, job_type: 'apply', status: 'processing', payload: { approval_request_id: A1 } }],
    },
    { uniqueKeys: { approval_submit_claims: 'approval_request_id', approval_requests: 'id' } }
  )
  const app = Fastify()
  app.addHook('preHandler', async (req: any) => {
    req.user = { id: USER_ID }
  })
  await app.register(approvalRoutes, { prefix: '/api/approvals', db: store.db, guard: { checkActionRateLimit: async () => {} } })
  const post = (id: string, resolution: string) =>
    app.inject({ method: 'POST', url: `/api/approvals/${id}/resolve-claim`, payload: { resolution } })

  const busy = await post(A1, 'create_fresh_approval')
  assert.equal(busy.statusCode, 409)
  assert.equal(busy.json().code, 'claim_in_progress')

  const ok = await post(A2, 'create_fresh_approval')
  assert.equal(ok.statusCode, 200)
  assert.ok(ok.json().newApprovalId)

  const again = await post(A2, 'create_fresh_approval')
  assert.equal(again.statusCode, 409)
  assert.equal(again.json().code, 'already_resolved')
  assert.equal(store.tables.approval_requests.length, 3)
})

test('getClaimStatuses: persetujuan yang diganti atau ditutup pengguna jadi abandoned atau closed, juga tanpa baris klaim', async () => {
  const store = makeExtensionTestDb({
    approval_submit_claims: [{ approval_request_id: A4, user_id: USER_ID, channel: 'worker', queue_job_id: 'q4', created_at: '2026-11-23T12:00:00Z' }],
    automation_queue: [],
    application_logs: [
      // A1: kirim belum terkonfirmasi lalu pengguna menyatakan belum terkirim (tanpa klaim): diganti.
      { user_id: USER_ID, status: 'submit_unverified', details: { approval_request_id: A1 } },
      { user_id: USER_ID, status: 'incomplete', details: { approval_request_id: A1, reason: 'user_not_sent' } },
      // A2: ditutup pengguna, tanpa klaim.
      { user_id: USER_ID, status: 'incomplete', details: { approval_request_id: A2, reason: 'user_closed' } },
      // A3: log success mengalahkan penutupan yang datang belakangan.
      { user_id: USER_ID, status: 'success', details: { approval_request_id: A3 } },
      { user_id: USER_ID, status: 'incomplete', details: { approval_request_id: A3, reason: 'user_closed' } },
      // A4: klaim macet lalu ditutup: closed, bukan locked_stuck.
      { user_id: USER_ID, status: 'incomplete', details: { approval_request_id: A4, reason: 'user_closed' } },
    ],
  })
  const map = await getClaimStatuses(store.db, USER_ID, [A1, A2, A3, A4], new Date('2026-11-23T12:10:00Z'))
  assert.equal(map[A1].state, 'abandoned')
  assert.equal(map[A2].state, 'closed')
  assert.equal(map[A3].state, 'none') // success dibaca layar lewat daftar terkirim, bukan status klaim
  assert.equal(map[A4].state, 'closed')
})

test('getClaimStatuses: kirim belum terkonfirmasi tanpa pernyataan pengguna tetap submitted', async () => {
  const store = makeExtensionTestDb({
    approval_submit_claims: [{ approval_request_id: A1, user_id: USER_ID, channel: 'worker', queue_job_id: 'q1', created_at: '2026-11-23T12:00:00Z' }],
    automation_queue: [],
    application_logs: [{ user_id: USER_ID, status: 'submit_unverified', details: { approval_request_id: A1 } }],
  })
  const map = await getClaimStatuses(store.db, USER_ID, [A1], new Date('2026-11-23T12:10:00Z'))
  assert.equal(map[A1].state, 'submitted')
})

test('resolveLockedClaim mark_sent: log success ditandai manual dan confirmed_by user, bukan konfirmasi sistem', async () => {
  const store = makeExtensionTestDb({
    approval_requests: [seedApproval(A1)],
    approval_submit_claims: [{ approval_request_id: A1, user_id: USER_ID, channel: 'worker', queue_job_id: 'q1', created_at: '2026-11-23T12:00:00Z' }],
    automation_queue: [{ id: 'q1', user_id: USER_ID, job_type: 'apply', status: 'failed', payload: { approval_request_id: A1 } }],
    ai_applications: [{ id: 'app-1', user_id: USER_ID, status: 'ready' }],
  })
  await resolveLockedClaim(store.db, USER_ID, A1, 'mark_sent', NOW)
  const written = store.tables.application_logs[0]
  assert.equal(written.status, 'success')
  assert.equal(written.details.manual, true)
  assert.equal(written.details.confirmed_by, 'user')
  assert.equal(written.details.confirmed_from, 'locked_claim')
})
