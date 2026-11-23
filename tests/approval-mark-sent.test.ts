import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FakeDb } from './helpers/fakeDb.ts'
import {
  FOLLOW_UP_DAYS,
  MANUAL_SUBMIT_NOTE,
  decideMarkSent,
  fetchMarkSentFacts,
  markApprovalSent,
  type MarkSentFacts,
} from '../services/manual-submit-guard.ts'

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

test('decideMarkSent: log manual ditambah klaim agen tetap already_sent', () => {
  const v = decideMarkSent(facts({ usedCount: 1, manualCount: 1, claimCount: 1 }))
  assert.equal((v as any).code, 'already_sent')
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

test('tandai terkirim: log success atau submit_unverified dari agen: 409 already_sent, kartu tidak berubah', async () => {
  for (const status of ['success', 'submit_unverified']) {
    const db = seed({ application_logs: [logRow({ status })] })
    const res = await run(db)
    assert.equal(res.status, 409, status)
    assert.deepEqual(res.body, { error: 'Application was already sent for this approval', code: 'already_sent' })
    assert.equal(db.rows('application_logs').length, 1)
    assert.equal(db.rows('ai_applications')[0].status, 'ready')
    assert.equal(db.writes.length, 0)
  }
})

test('tandai terkirim: klaim kirim ada: 409 already_sent', async () => {
  const db = seed({ approval_submit_claims: [claimRow()] })
  const res = await run(db)
  assert.equal(res.status, 409)
  assert.equal((res.body as any).code, 'already_sent')
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
  assert.equal(f.claimCount, 1)
  assert.equal(f.activeCount, 1)
  assert.equal(f.approval?.job_id, 'j1')
  assert.equal((await fetchMarkSentFacts(db, 'u2', 'a1')).approval, null)
})
