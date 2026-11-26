import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FakeDb } from './helpers/fakeDb.ts'
import {
  FOLLOW_UP_DAYS,
  MANUAL_SUBMIT_NOTE,
  USER_CONFIRMED_NOTE,
  closeApproval,
  decideMarkSent,
  decideResolve,
  fetchMarkSentFacts,
  markApprovalSent,
  reportNotSent,
  type MarkSentFacts,
} from '../services/manual-submit-guard.ts'
import { APPROVAL_TTL_MS, freshApprovalId } from '../services/approval-shared.ts'

/**
 * POST /api/approvals/:id/mark-sent: the decision is a pure function (decideMarkSent), the flow around it
 * (markApprovalSent) runs here against a fake database. Nothing is sent and no network is used.
 */

const NOW = new Date('2026-11-23T10:00:00.000Z')
const FOUR_DAYS_LATER = '2026-11-27T10:00:00.000Z'
const PAST = '2026-11-20T00:00:00.000Z'

const facts = (over: Partial<MarkSentFacts> = {}, approval: Record<string, any> | null = {}): MarkSentFacts => ({
  approval: approval === null ? null : { status: 'approved', job_id: 'j1', ...approval },
  usedCount: 0,
  manualCount: 0,
  claimCount: 0,
  activeCount: 0,
  ...over,
})

// ---- decideMarkSent: every branch -------------------------------------------------------------------

test('decideMarkSent: disetujui, belum dipakai, tanpa klaim, tanpa job aktif: ok', () => {
  assert.deepEqual(decideMarkSent(facts()), { ok: true })
})

test('decideMarkSent: persetujuan tidak ada: 404', () => {
  assert.deepEqual(decideMarkSent(facts({}, null)), {
    ok: false, status: 404, code: 'not_found', error: 'Approval request not found',
  })
})

test('decideMarkSent: status selain approved: 409 not_approved', () => {
  for (const status of ['pending', 'rejected', 'expired', undefined, null]) {
    assert.deepEqual(decideMarkSent(facts({}, { status })), {
      ok: false, status: 409, code: 'not_approved', error: 'Approval is not approved',
    })
  }
})

test('decideMarkSent: tanpa job_id: 422 no_job', () => {
  for (const job_id of [null, undefined, '']) {
    const v = decideMarkSent(facts({}, { job_id }))
    assert.equal(v.ok, false)
    assert.equal((v as any).status, 422)
    assert.equal((v as any).code, 'no_job')
  }
})

test('decideMarkSent: kedaluwarsa tidak dicek, karena pengguna mengirim sendiri', () => {
  assert.deepEqual(decideMarkSent(facts({}, { expires_at: PAST })), { ok: true })
})

test('decideMarkSent: log success atau submit_unverified dari agen: 409 already_sent', () => {
  assert.deepEqual(decideMarkSent(facts({ usedCount: 1 })), {
    ok: false, status: 409, code: 'already_sent', error: 'Application was already sent for this approval',
  })
})

test('decideMarkSent: klaim kirim ada (agen mungkin sudah mengirim): 409 already_sent', () => {
  const v = decideMarkSent(facts({ claimCount: 1 }))
  assert.equal(v.ok, false)
  assert.equal((v as any).status, 409)
  assert.equal((v as any).code, 'already_sent')
})

test('decideMarkSent: konfirmasi pengguna sebelumnya ditambah klaim agen: aman diulang (alreadyMarked)', () => {
  // Sejak 26 November 2026 pengguna boleh mengonfirmasi kirim yang tidak pasti, jadi klaim dan log manual bisa berdampingan.
  assert.deepEqual(decideMarkSent(facts({ usedCount: 1, manualCount: 1, claimCount: 1 })), { ok: true, alreadyMarked: true })
})

test('decideMarkSent: kirim belum terkonfirmasi (submit_unverified) boleh dikonfirmasi pengguna', () => {
  assert.deepEqual(decideMarkSent(facts({ usedCount: 1, unverifiedCount: 1 })), { ok: true })
  assert.deepEqual(decideMarkSent(facts({ usedCount: 1, unverifiedCount: 1, claimCount: 1, claimInProgress: false })), { ok: true })
})

test('decideMarkSent: unverified dicampur success agen tetap already_sent', () => {
  const v = decideMarkSent(facts({ usedCount: 2, unverifiedCount: 1 }))
  assert.equal((v as any).code, 'already_sent')
})

test('decideMarkSent: klaim macet tanpa log (worker berhenti atau ekstensi basi) boleh dikonfirmasi', () => {
  assert.deepEqual(decideMarkSent(facts({ claimCount: 1, claimInProgress: false })), { ok: true })
})

test('decideMarkSent: klaim ekstensi yang masih baru berarti ekstensi mungkin sedang mengirim: 409 agent_working', () => {
  const v = decideMarkSent(facts({ claimCount: 1, claimInProgress: true }))
  assert.equal((v as any).status, 409)
  assert.equal((v as any).code, 'agent_working')
})

test('decideMarkSent: persetujuan sudah diganti persetujuan baru: 409 already_resolved; ditutup tetap boleh dikonfirmasi', () => {
  assert.equal((decideMarkSent(facts({ replacedCount: 1 })) as any).code, 'already_resolved')
  assert.deepEqual(decideMarkSent(facts({ closedCount: 1 })), { ok: true })
})

// ---- decideResolve: Belum terkirim, ulangi dan Tutup ---------------------------------------------------

test('decideResolve: disetujui dan tidak ada yang berjalan: ok untuk not_sent dan close', () => {
  assert.deepEqual(decideResolve(facts(), 'not_sent'), { ok: true })
  assert.deepEqual(decideResolve(facts(), 'close'), { ok: true })
  assert.deepEqual(decideResolve(facts({ usedCount: 1, unverifiedCount: 1 }), 'not_sent'), { ok: true })
  assert.deepEqual(decideResolve(facts({ claimCount: 1, claimInProgress: false }), 'close'), { ok: true })
})

test('decideResolve: tidak ada, bukan disetujui, atau tanpa job (hanya not_sent): 404, 409, 422', () => {
  assert.equal((decideResolve(facts({}, null), 'close') as any).status, 404)
  assert.equal((decideResolve(facts({}, { status: 'pending' }), 'close') as any).code, 'not_approved')
  assert.equal((decideResolve(facts({}, { job_id: null }), 'not_sent') as any).code, 'no_job')
  assert.deepEqual(decideResolve(facts({}, { job_id: null }), 'close'), { ok: true }, 'Tutup tidak butuh lowongan')
})

test('decideResolve: sudah terkirim (agen atau konfirmasi pengguna): 409 already_sent', () => {
  for (const kind of ['not_sent', 'close'] as const) {
    assert.equal((decideResolve(facts({ usedCount: 1 }), kind) as any).code, 'already_sent')
    assert.equal((decideResolve(facts({ usedCount: 1, manualCount: 1 }), kind) as any).code, 'already_sent')
  }
})

test('decideResolve: agen atau ekstensi masih bekerja: 409 agent_working', () => {
  for (const kind of ['not_sent', 'close'] as const) {
    assert.equal((decideResolve(facts({ activeCount: 1 }), kind) as any).code, 'agent_working')
    assert.equal((decideResolve(facts({ claimCount: 1, claimInProgress: true }), kind) as any).code, 'agent_working')
  }
})

test('decideResolve: sudah diganti atau ditutup: 409 already_resolved', () => {
  for (const kind of ['not_sent', 'close'] as const) {
    assert.equal((decideResolve(facts({ replacedCount: 1 }), kind) as any).code, 'already_resolved')
    assert.equal((decideResolve(facts({ closedCount: 1 }), kind) as any).code, 'already_resolved')
  }
})

test('decideMarkSent: log manual dicampur log agen: already_sent', () => {
  const v = decideMarkSent(facts({ usedCount: 2, manualCount: 1 }))
  assert.equal((v as any).code, 'already_sent')
})

test('decideMarkSent: hanya penandaan manual sebelumnya: ok dan alreadyMarked (aman diulang)', () => {
  assert.deepEqual(decideMarkSent(facts({ usedCount: 1, manualCount: 1 })), { ok: true, alreadyMarked: true })
  assert.deepEqual(decideMarkSent(facts({ usedCount: 2, manualCount: 2 })), { ok: true, alreadyMarked: true })
})

test('decideMarkSent: agen sedang bekerja pada persetujuan ini: 409 agent_working', () => {
  assert.deepEqual(decideMarkSent(facts({ activeCount: 1 })), {
    ok: false, status: 409, code: 'agent_working', error: 'Agent is already working on this application',
  })
})

test('decideMarkSent: urutan aturan. Terkirim mengalahkan aktif; status dan job_id mengalahkan semuanya', () => {
  const all = { usedCount: 1, claimCount: 1, activeCount: 1 }
  assert.equal((decideMarkSent(facts(all)) as any).code, 'already_sent')
  assert.equal((decideMarkSent(facts({ activeCount: 1 })) as any).code, 'agent_working')
  assert.equal((decideMarkSent(facts(all, { status: 'pending' })) as any).code, 'not_approved')
  assert.equal((decideMarkSent(facts(all, { job_id: null })) as any).code, 'no_job')
})

// ---- fetchMarkSentFacts + markApprovalSent against a fake database ----------------------------------------

const approvalRow = (over: Record<string, any> = {}) => ({
  id: 'a1', user_id: 'u1', job_id: 'j1', application_id: 'app1', job_title: 'Judul Persetujuan', company: 'PT Persetujuan',
  platform: 'web', status: 'approved', expires_at: PAST, ...over,
})
const jobRow = (over: Record<string, any> = {}) => ({
  id: 'j1', title: 'Backend Engineer', company: 'PT Contoh', platform_source: 'jobstreet', ...over,
})
const appRow = (over: Record<string, any> = {}) => ({
  id: 'app1', user_id: 'u1', job_id: 'j1', status: 'ready', submitted_at: null, follow_up_scheduled: null,
  follow_up_sent: false, ...over,
})
const queueRow = (over: Record<string, any> = {}) => ({
  id: `q-${Math.random()}`, user_id: 'u1', job_type: 'apply', status: 'completed',
  payload: { approval_request_id: 'a1', job_id: 'j1', approved: true }, ...over,
})
const logRow = (over: Record<string, any> = {}) => ({
  id: `l-${Math.random()}`, user_id: 'u1', action: 'apply', status: 'ready', details: { approval_request_id: 'a1' }, ...over,
})
const claimRow = (over: Record<string, any> = {}) => ({
  approval_request_id: 'a1', user_id: 'u1', channel: 'worker', queue_job_id: null, run_id: 'r1', ...over,
})

const seed = (extra: Record<string, any[]> = {}) =>
  new FakeDb({
    approval_requests: [approvalRow()],
    jobs: [jobRow()],
    ai_applications: [appRow()],
    ...extra,
  })

const run = (db: FakeDb, userId = 'u1', id = 'a1', announce?: (id: string) => Promise<unknown>) =>
  markApprovalSent(db, userId, id, NOW, announce)

test('tandai terkirim sah: log success manual dan kartu pindah ke submitted, 200 { success: true }', async () => {
  const db = seed({
    automation_queue: [queueRow()],
    application_logs: [
      logRow({ status: 'ready', details: { approval_request_id: 'a1', submit_blocked: 'not_allowed', filled_fields: [] } }),
    ],
  })
  const res = await run(db)
  assert.equal(res.status, 200)
  assert.deepEqual(res.body, { success: true })

  const logs = db.rows('application_logs')
  assert.equal(logs.length, 2)
  const written = logs[1]
  assert.equal(written.user_id, 'u1')
  assert.equal(written.action, 'apply')
  assert.equal(written.status, 'success')
  assert.equal(written.job_id, 'j1')
  assert.equal(written.job_title, 'Backend Engineer')
  assert.equal(written.company, 'PT Contoh')
  assert.equal(written.platform, 'jobstreet')
  assert.deepEqual(written.details, {
    approval_request_id: 'a1',
    manual: true,
    reason: 'manual_submit',
    note: MANUAL_SUBMIT_NOTE,
    confirmed_by: 'user',
    confirmed_from: 'no_agent_confirmation',
  })

  const app = db.rows('ai_applications')[0]
  assert.equal(app.status, 'submitted')
  assert.equal(app.submitted_at, NOW.toISOString())
  assert.equal(app.follow_up_scheduled, FOUR_DAYS_LATER)
  assert.equal(app.follow_up_sent, false)
  assert.equal(app.updated_at, NOW.toISOString())
  assert.equal(FOLLOW_UP_DAYS, 4)

  assert.equal(db.rows('approval_submit_claims').length, 0, 'tidak ada klaim: kolom channel hanya worker atau extension')
  assert.equal(db.rows('automation_queue').length, 1, 'tidak ada tugas antrean baru')
  assert.equal(db.rows('approval_requests')[0].status, 'approved', 'baris persetujuan tidak diubah')
})

test('tandai terkirim: kedaluwarsa tidak menghalangi', async () => {
  const db = seed({ approval_requests: [approvalRow({ expires_at: PAST })] })
  assert.equal((await run(db)).status, 200)
  assert.equal(db.rows('application_logs').length, 1)
})

test('tandai terkirim: log memakai ringkasan persetujuan bila lowongan tidak terbaca, platform bawaan web', async () => {
  const db = new FakeDb({
    approval_requests: [approvalRow({ platform: null })],
    ai_applications: [appRow()],
  })
  assert.equal((await run(db)).status, 200)
  const written = db.rows('application_logs')[0]
  assert.equal(written.job_title, 'Judul Persetujuan')
  assert.equal(written.company, 'PT Persetujuan')
  assert.equal(written.platform, 'web')
})

test('tandai terkirim: follow_up_scheduled yang sudah ada dipertahankan', async () => {
  const existing = '2026-12-01T00:00:00.000Z'
  const db = seed({ ai_applications: [appRow({ follow_up_scheduled: existing })] })
  assert.equal((await run(db)).status, 200)
  assert.equal(db.rows('ai_applications')[0].follow_up_scheduled, existing)
})

test('tandai terkirim: kartu hanya maju. submitted, follow_up, responded, closed tidak diubah', async () => {
  for (const status of ['submitted', 'follow_up', 'responded', 'closed']) {
    const db = seed({ ai_applications: [appRow({ status, submitted_at: '2026-11-22T00:00:00.000Z' })] })
    const res = await run(db)
    assert.equal(res.status, 200, status)
    const app = db.rows('ai_applications')[0]
    assert.equal(app.status, status)
    assert.equal(app.submitted_at, '2026-11-22T00:00:00.000Z')
    assert.equal(db.rows('application_logs').length, 1, 'log tetap ditulis supaya persetujuan terpakai')
  }
})

test('tandai terkirim: draf juga pindah ke submitted', async () => {
  const db = seed({ ai_applications: [appRow({ status: 'draft' })] })
  assert.equal((await run(db)).status, 200)
  assert.equal(db.rows('ai_applications')[0].status, 'submitted')
})

test('tandai terkirim: kartu milik pengguna lain tidak disentuh', async () => {
  const db = seed({ ai_applications: [appRow({ user_id: 'u2' })] })
  const res = await run(db)
  assert.equal(res.status, 200)
  assert.equal(db.rows('ai_applications')[0].status, 'ready')
  assert.equal(db.rows('application_logs').length, 1)
})

test('tandai terkirim: tanpa application_id, kartu terbaru untuk lowongan itu yang dipindah', async () => {
  const db = seed({
    approval_requests: [approvalRow({ application_id: null })],
    ai_applications: [
      appRow({ id: 'lama', created_at: '2026-11-20T00:00:00.000Z' }),
      appRow({ id: 'baru', created_at: '2026-11-22T00:00:00.000Z' }),
      appRow({ id: 'lain', job_id: 'j9', created_at: '2026-11-23T00:00:00.000Z' }),
    ],
  })
  assert.equal((await run(db)).status, 200)
  const byId = Object.fromEntries(db.rows('ai_applications').map((r) => [r.id, r.status]))
  assert.deepEqual(byId, { lama: 'ready', baru: 'submitted', lain: 'ready' })
})

test('tandai terkirim: tanpa kartu lamaran sama sekali tetap 200 dan log ditulis', async () => {
  const db = seed({ ai_applications: [] })
  assert.equal((await run(db)).status, 200)
  assert.equal(db.rows('application_logs').length, 1)
})

test('tandai terkirim: persetujuan tidak ada atau milik pengguna lain: 404, tidak ada tulisan', async () => {
  const db = seed({ approval_requests: [approvalRow({ user_id: 'u2' })] })
  assert.equal((await run(db)).status, 404)
  assert.equal((await run(db, 'u1', 'tidak-ada')).status, 404)
  assert.equal(db.writes.length, 0)
})

test('tandai terkirim: status pending, rejected, atau expired: 409 not_approved', async () => {
  for (const status of ['pending', 'rejected', 'expired']) {
    const db = seed({ approval_requests: [approvalRow({ status })] })
    const res = await run(db)
    assert.equal(res.status, 409, status)
    assert.equal((res.body as any).code, 'not_approved')
    assert.equal(db.writes.length, 0)
  }
})

test('tandai terkirim: tanpa job_id: 422 dan tidak ada tulisan', async () => {
  const db = seed({ approval_requests: [approvalRow({ job_id: null })] })
  const res = await run(db)
  assert.equal(res.status, 422)
  assert.equal((res.body as any).code, 'no_job')
  assert.equal(db.writes.length, 0)
})

test('tandai terkirim: log success dari agen: 409 already_sent, kartu tidak berubah', async () => {
  const db = seed({ application_logs: [logRow({ status: 'success' })] })
  const res = await run(db)
  assert.equal(res.status, 409)
  assert.deepEqual(res.body, { error: 'Application was already sent for this approval', code: 'already_sent' })
  assert.equal(db.rows('application_logs').length, 1)
  assert.equal(db.rows('ai_applications')[0].status, 'ready')
  assert.equal(db.writes.length, 0)
})

test('tandai terkirim: kirim belum terkonfirmasi (submit_unverified) dikonfirmasi pengguna, ditandai bukan konfirmasi sistem', async () => {
  // Kasus nyata Hans 23 November 2026: log ready + submit_unverified, tanpa baris klaim.
  const db = seed({
    approval_requests: [approvalRow({ expires_at: PAST })],
    application_logs: [logRow({ status: 'ready' }), logRow({ status: 'submit_unverified', details: { approval_request_id: 'a1', submit_check: { verdict: 'uncertain' } } })],
  })
  const res = await run(db)
  assert.equal(res.status, 200)
  const written = db.rows('application_logs')[2]
  assert.equal(written.status, 'success')
  assert.equal(written.details.manual, true)
  assert.equal(written.details.confirmed_by, 'user')
  assert.equal(written.details.confirmed_from, 'submit_unverified')
  assert.equal(written.details.note, USER_CONFIRMED_NOTE)
  assert.equal(db.rows('ai_applications')[0].status, 'submitted')
  // Ulang: idempoten, tidak ada log ketiga.
  const again = await run(db)
  assert.deepEqual(again.body, { success: true, already_marked: true })
  assert.equal(db.rows('application_logs').length, 3)
})

test('tandai terkirim: klaim worker macet (tidak ada tugas aktif, tidak ada log) boleh dikonfirmasi', async () => {
  const db = seed({ approval_submit_claims: [claimRow()] })
  const res = await run(db)
  assert.equal(res.status, 200)
  assert.equal(db.rows('application_logs')[0].details.confirmed_from, 'claim_unconfirmed')
  assert.equal(db.rows('approval_submit_claims').length, 1, 'klaim lama tidak dihapus')
})

test('tandai terkirim: klaim ekstensi yang masih baru ditolak 409 agent_working, klaim basi boleh', async () => {
  const fresh = seed({ approval_submit_claims: [claimRow({ channel: 'extension', created_at: new Date(NOW.getTime() - 30_000).toISOString() })] })
  const refused = await run(fresh)
  assert.equal(refused.status, 409)
  assert.equal((refused.body as any).code, 'agent_working')
  assert.equal(fresh.writes.length, 0)

  const stale = seed({ approval_submit_claims: [claimRow({ channel: 'extension', created_at: new Date(NOW.getTime() - 3 * 60_000).toISOString() })] })
  assert.equal((await run(stale)).status, 200)
})

test('tandai terkirim: persetujuan yang sudah diganti persetujuan baru ditolak 409 already_resolved', async () => {
  const db = seed({ application_logs: [logRow({ status: 'incomplete', details: { approval_request_id: 'a1', reason: 'user_not_sent' } })] })
  const res = await run(db)
  assert.equal(res.status, 409)
  assert.equal((res.body as any).code, 'already_resolved')
  assert.equal(db.writes.length, 0)
})

test('tandai terkirim: klaim persetujuan lain atau pengguna lain tidak menghalangi', async () => {
  const db = seed({
    approval_submit_claims: [claimRow({ approval_request_id: 'a-lain' }), claimRow({ approval_request_id: 'a1', user_id: 'u2' })],
  })
  assert.equal((await run(db)).status, 200)
})

test('tandai terkirim: log lain tidak menghalangi (ready, incomplete, failed, persetujuan lain, pengguna lain)', async () => {
  const db = seed({
    application_logs: [
      logRow({ status: 'ready' }),
      logRow({ status: 'incomplete' }),
      logRow({ status: 'failed' }),
      logRow({ status: 'success', details: { approval_request_id: 'a-lain' } }),
      logRow({ status: 'success', user_id: 'u2' }),
    ],
  })
  assert.equal((await run(db)).status, 200)
})

test('tandai terkirim: job apply pending atau processing: 409 agent_working', async () => {
  for (const status of ['pending', 'processing']) {
    const db = seed({ automation_queue: [queueRow({ status })] })
    const res = await run(db)
    assert.equal(res.status, 409, status)
    assert.deepEqual(res.body, { error: 'Agent is already working on this application', code: 'agent_working' })
    assert.equal(db.writes.length, 0)
  }
})

test('tandai terkirim: job aktif milik persetujuan lain, pengguna lain, atau jenis lain tidak menghalangi', async () => {
  const db = seed({
    automation_queue: [
      queueRow({ status: 'pending', payload: { approval_request_id: 'a-lain' } }),
      queueRow({ status: 'processing', user_id: 'u2' }),
      queueRow({ status: 'pending', job_type: 'email_apply' }),
      queueRow({ status: 'pending', payload: { job_id: 'j9' } }),
      queueRow({ status: 'failed' }),
    ],
  })
  assert.equal((await run(db)).status, 200)
})

test('tandai terkirim dua kali: yang kedua 200 already_marked tanpa log kedua', async () => {
  const db = seed()
  assert.deepEqual((await run(db)).body, { success: true })
  const second = await run(db)
  assert.equal(second.status, 200)
  assert.deepEqual(second.body, { success: true, already_marked: true })
  assert.equal(db.rows('application_logs').length, 1)
})

test('ulangi setelah kartu gagal diubah: log sudah ada, kartu dipindah pada percobaan kedua', async () => {
  const db = seed()
  db.failOn('ai_applications', 'update', 'db mati')
  const first = await run(db)
  assert.equal(first.status, 500)
  assert.equal(db.rows('application_logs').length, 1, 'log tertulis lebih dulu')
  assert.equal(db.rows('ai_applications')[0].status, 'ready')

  const healthy = new FakeDb({ ...db.tables })
  const second = await run(healthy)
  assert.equal(second.status, 200)
  assert.deepEqual(second.body, { success: true, already_marked: true })
  assert.equal(healthy.rows('application_logs').length, 1)
  assert.equal(healthy.rows('ai_applications')[0].status, 'submitted')
})

test('tandai terkirim: pengumuman status dipanggil sekali dengan id kartu yang berubah', async () => {
  const seen: string[] = []
  const db = seed()
  assert.equal((await run(db, 'u1', 'a1', async (id) => void seen.push(id))).status, 200)
  assert.deepEqual(seen, ['app1'])
})

test('tandai terkirim: pengumuman tidak dipanggil bila kartu tidak berubah', async () => {
  const seen: string[] = []
  const db = seed({ ai_applications: [appRow({ status: 'submitted' })] })
  assert.equal((await run(db, 'u1', 'a1', async (id) => void seen.push(id))).status, 200)
  assert.deepEqual(seen, [])
})

test('tandai terkirim: pengumuman yang gagal tidak mengubah jawaban', async () => {
  const db = seed()
  const res = await run(db, 'u1', 'a1', async () => {
    throw new Error('telegram mati')
  })
  assert.equal(res.status, 200)
  assert.deepEqual(res.body, { success: true })
})

test('tandai terkirim: kesalahan database dijawab 500 generik tanpa teks galat, tidak ada log bila pembacaan gagal', async () => {
  for (const [table, op] of [
    ['approval_requests', 'select'],
    ['application_logs', 'select'],
    ['approval_submit_claims', 'select'],
    ['automation_queue', 'select'],
  ] as const) {
    const db = seed()
    db.failOn(table, op, 'db mati')
    const res = await run(db)
    assert.equal(res.status, 500, `${table}.${op}`)
    assert.doesNotMatch(JSON.stringify(res.body), /db mati/) // teks galat database tidak sampai ke klien
    assert.equal((res.body as any).code, 'mark_failed')
    assert.equal(db.writes.length, 0, `${table}.${op}`)
  }
})

test('tandai terkirim: log gagal ditulis: 500 dan kartu tidak berubah', async () => {
  const db = seed()
  db.failOn('application_logs', 'insert', 'log mati')
  const res = await run(db)
  assert.equal(res.status, 500)
  assert.doesNotMatch(JSON.stringify(res.body), /log mati/)
  assert.equal((res.body as any).code, 'mark_failed')
  assert.equal(db.rows('ai_applications')[0].status, 'ready')
})

test('tandai terkirim: pembacaan lowongan gagal: 500, tidak ada log', async () => {
  const db = seed()
  db.failOn('jobs', 'select', 'jobs mati')
  const res = await run(db)
  assert.equal(res.status, 500)
  assert.equal(db.rows('application_logs').length, 0)
})

test('fetchMarkSentFacts: menghitung log, klaim, dan job aktif hanya milik persetujuan dan pengguna ini', async () => {
  const db = seed({
    application_logs: [
      logRow({ status: 'success', details: { approval_request_id: 'a1', manual: true } }),
      logRow({ status: 'success', details: { approval_request_id: 'a1' } }),
      logRow({ status: 'success', details: { approval_request_id: 'a-lain' } }),
      logRow({ status: 'ready', details: { approval_request_id: 'a1' } }),
    ],
    approval_submit_claims: [claimRow(), claimRow({ approval_request_id: 'a-lain' })],
    automation_queue: [queueRow({ status: 'pending' }), queueRow({ status: 'completed' }), queueRow({ status: 'pending', user_id: 'u2' })],
  })
  const f = await fetchMarkSentFacts(db, 'u1', 'a1')
  assert.equal(f.usedCount, 2)
  assert.equal(f.manualCount, 1)
  assert.equal(f.unverifiedCount, 0)
  assert.equal(f.claimCount, 1)
  assert.equal(f.claimInProgress, false)
  assert.equal(f.replacedCount, 0)
  assert.equal(f.closedCount, 0)
  assert.equal(f.activeCount, 1)
  assert.equal(f.approval?.job_id, 'j1')
  assert.equal((await fetchMarkSentFacts(db, 'u2', 'a1')).approval, null)
})

// ---- reportNotSent ("Belum terkirim, ulangi") ----------------------------------------------------------

const runNotSent = (db: FakeDb, userId = 'u1', id = 'a1') => reportNotSent(db, userId, id, NOW)
const runClose = (db: FakeDb, userId = 'u1', id = 'a1') => closeApproval(db, userId, id, NOW)

const unverifiedSeed = (extra: Record<string, any[]> = {}) =>
  seed({
    approval_requests: [approvalRow({ cover_letter: 'Surat lama', resume_url: 'u1/cv.pdf', answers: [{ question: 'Q', answer: 'A' }] })],
    application_logs: [logRow({ status: 'submit_unverified' })],
    ...extra,
  })

test('belum terkirim: membuat persetujuan baru pending 24 jam, salinan surat, dan log user_not_sent', async () => {
  const db = unverifiedSeed()
  const res = await runNotSent(db)
  assert.equal(res.status, 200)
  const newId = freshApprovalId('a1')
  assert.deepEqual(res.body, { success: true, new_approval_id: newId })

  const fresh = db.rows('approval_requests').find((r) => r.id === newId)
  assert.ok(fresh)
  assert.equal(fresh.user_id, 'u1')
  assert.equal(fresh.status, 'pending')
  assert.equal(fresh.job_id, 'j1')
  assert.equal(fresh.application_id, 'app1')
  assert.equal(fresh.cover_letter, 'Surat lama')
  assert.equal(fresh.resume_url, 'u1/cv.pdf')
  assert.deepEqual(fresh.answers, [{ question: 'Q', answer: 'A' }])
  assert.equal(fresh.expires_at, new Date(NOW.getTime() + APPROVAL_TTL_MS).toISOString())
  assert.equal(APPROVAL_TTL_MS, 24 * 60 * 60 * 1000)

  const log = db.rows('application_logs')[1]
  assert.equal(log.status, 'incomplete')
  assert.equal(log.user_id, 'u1')
  assert.deepEqual(log.details, {
    approval_request_id: 'a1',
    reason: 'user_not_sent',
    resolved_by: 'user',
    fresh_approval_id: newId,
    previous_outcome: 'submit_unverified',
  })
  assert.equal(db.rows('approval_requests').find((r) => r.id === 'a1')?.status, 'approved', 'persetujuan lama tidak diubah')
  assert.equal(db.rows('ai_applications')[0].status, 'ready', 'kartu lamaran tidak diubah')
  assert.equal(db.rows('automation_queue').length, 0, 'tidak ada tugas antrean: agen baru jalan setelah persetujuan baru disetujui')
})

test('belum terkirim: dua kali dijawab 409 already_resolved, hanya satu persetujuan baru', async () => {
  const db = unverifiedSeed()
  assert.equal((await runNotSent(db)).status, 200)
  const second = await runNotSent(db)
  assert.equal(second.status, 409)
  assert.equal((second.body as any).code, 'already_resolved')
  assert.equal(db.rows('approval_requests').length, 2)
})

test('belum terkirim: ditolak bila sudah terkirim, agen bekerja, bukan milik pengguna, atau bukan approved', async () => {
  const sent = seed({ application_logs: [logRow({ status: 'success' })] })
  assert.equal((await runNotSent(sent)).status, 409)
  assert.equal(sent.writes.length, 0)

  const working = seed({ automation_queue: [queueRow({ status: 'processing' })] })
  assert.equal((await runNotSent(working)).status, 409)
  assert.equal(working.writes.length, 0)

  const others = seed({ approval_requests: [approvalRow({ user_id: 'u2' })] })
  assert.equal((await runNotSent(others)).status, 404)
  assert.equal(others.writes.length, 0)

  const pending = seed({ approval_requests: [approvalRow({ status: 'pending' })] })
  assert.equal((await runNotSent(pending)).status, 409)
  assert.equal(pending.writes.length, 0)
})

test('belum terkirim: persetujuan lain yang masih pending untuk lowongan itu (23505, id turunan belum ada): 409 pending_exists', async () => {
  const db = unverifiedSeed()
  const realFrom = db.from.bind(db)
  ;(db as any).from = (table: string) => {
    const q = realFrom(table)
    if (table !== 'approval_requests') return q
    const realInsert = q.insert.bind(q)
    q.insert = (payload: any) => {
      const chain = realInsert(payload)
      chain.select = () => Promise.resolve({ data: null, error: { code: '23505', message: 'duplicate key' } })
      return chain
    }
    return q
  }
  const res = await runNotSent(db)
  assert.equal(res.status, 409)
  assert.equal((res.body as any).code, 'pending_exists')
  assert.equal(db.rows('application_logs').length, 1, 'log tidak ditulis')
})

test('belum terkirim: log gagal ditulis, ulangi: persetujuan baru yang sudah ada dipakai dan log ditulis', async () => {
  const db = unverifiedSeed()
  db.failOn('application_logs', 'insert', 'log mati')
  const first = await runNotSent(db)
  assert.equal(first.status, 500)
  assert.equal((first.body as any).code, 'not_sent_failed')
  assert.doesNotMatch(JSON.stringify(first.body), /log mati/)
  assert.equal(db.rows('approval_requests').length, 2)

  const healthy = new FakeDb({ ...db.tables })
  // Meniru kunci utama: penyisipan kedua dengan id yang sama bentrok.
  const realFrom = healthy.from.bind(healthy)
  ;(healthy as any).from = (table: string) => {
    const q = realFrom(table)
    if (table !== 'approval_requests') return q
    const realInsert = q.insert.bind(q)
    q.insert = (payload: any) => {
      const chain = realInsert(payload)
      chain.select = () => Promise.resolve({ data: null, error: { code: '23505', message: 'duplicate key' } })
      return chain
    }
    return q
  }
  const second = await runNotSent(healthy)
  assert.equal(second.status, 200)
  assert.equal(healthy.rows('application_logs').filter((l) => l.details?.reason === 'user_not_sent').length, 1)
})

test('belum terkirim: kesalahan database dijawab 500 generik', async () => {
  for (const [table, op] of [
    ['approval_requests', 'select'],
    ['application_logs', 'select'],
    ['approval_requests', 'insert'],
  ] as const) {
    const db = unverifiedSeed()
    db.failOn(table, op, 'db mati')
    const res = await runNotSent(db)
    assert.equal(res.status, 500, `${table}.${op}`)
    assert.doesNotMatch(JSON.stringify(res.body), /db mati/)
    assert.equal((res.body as any).code, 'not_sent_failed')
  }
})

// ---- closeApproval ("Tutup") ----------------------------------------------------------------------------

test('tutup: satu log user_closed, kartu lamaran dan persetujuan tidak diubah', async () => {
  const db = unverifiedSeed()
  const res = await runClose(db)
  assert.equal(res.status, 200)
  assert.deepEqual(res.body, { success: true })
  const log = db.rows('application_logs')[1]
  assert.equal(log.status, 'incomplete')
  assert.deepEqual(log.details, { approval_request_id: 'a1', reason: 'user_closed', resolved_by: 'user', previous_outcome: 'submit_unverified' })
  assert.equal(db.rows('approval_requests').length, 1)
  assert.equal(db.rows('approval_requests')[0].status, 'approved')
  assert.equal(db.rows('ai_applications')[0].status, 'ready')
})

test('tutup: dua kali 409 already_resolved; terkirim, agen bekerja, bukan milik pengguna ditolak tanpa tulisan', async () => {
  const db = unverifiedSeed()
  assert.equal((await runClose(db)).status, 200)
  assert.equal((await runClose(db)).status, 409)
  assert.equal(db.rows('application_logs').length, 2)

  const sent = seed({ application_logs: [logRow({ status: 'success' })] })
  assert.equal((await runClose(sent)).status, 409)
  const working = seed({ automation_queue: [queueRow({ status: 'pending' })] })
  assert.equal((await runClose(working)).status, 409)
  const others = seed({ approval_requests: [approvalRow({ user_id: 'u2' })] })
  assert.equal((await runClose(others)).status, 404)
  assert.equal(sent.writes.length + working.writes.length + others.writes.length, 0)
})

test('tutup: kedaluwarsa tidak menghalangi, log gagal ditulis dijawab 500 generik', async () => {
  const ok = seed({ approval_requests: [approvalRow({ expires_at: PAST })] })
  assert.equal((await runClose(ok)).status, 200)

  const broken = seed()
  broken.failOn('application_logs', 'insert', 'log mati')
  const res = await runClose(broken)
  assert.equal(res.status, 500)
  assert.equal((res.body as any).code, 'close_failed')
  assert.doesNotMatch(JSON.stringify(res.body), /log mati/)
})
