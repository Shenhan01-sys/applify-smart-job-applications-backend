import { test, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { MAX_RUNS_PER_APPROVAL } from '../../services/rerun-guard.js'

/**
 * Integrasi: rute persetujuan (/api/approvals) pada server backend sungguhan dan klien supabase-js sungguhan,
 * terhadap Supabase tiruan strik yang menolak tabel/kolom/tipe yang tidak ada di skema SQL. Mencakup alur yang
 * sering patah di uji klik: setujui, antrean worker, jalankan ulang, tandai terkirim, pesan galat dan isolasi pengguna.
 */
const h = await import('../helpers/backendHarness.ts')
const { api, fake, USER_A, USER_B, seedApproval, uuid, future, past } = h

beforeEach(() => {
  fake.reset()
})
after(async () => {
  await fake.close()
  setTimeout(() => process.exit(process.exitCode ?? 0), 50).unref()
})

const queueRows = () => fake.rows('automation_queue')
const logRows = () => fake.rows('application_logs')

// ───────────────────────────────────────────────────────────────── auth

test('tanpa token atau token tak dikenal: 401 di semua rute persetujuan', async () => {
  const { approvalId } = seedApproval()
  for (const [method, path] of [
    ['GET', '/api/approvals/pending'],
    ['POST', `/api/approvals/${approvalId}/approve`],
    ['POST', `/api/approvals/${approvalId}/rerun`],
    ['POST', `/api/approvals/${approvalId}/mark-sent`],
    ['POST', `/api/approvals/${approvalId}/not-sent`],
    ['POST', `/api/approvals/${approvalId}/close`],
  ] as const) {
    assert.equal((await api(method, path, { user: null })).status, 401, `${method} ${path} tanpa token`)
    assert.equal((await api(method, path, { user: { token: 'token-palsu' } })).status, 401, `${method} ${path} token palsu`)
  }
  assert.equal(queueRows().length, 0)
  assert.equal(logRows().length, 0)
})

// ───────────────────────────────────────────────────────────────── membuat dan menyetujui

test('buat persetujuan lalu setujui: baris antrean apply memuat id persetujuan dan approved ditulis server', async () => {
  const { jobId, appId } = seedApproval({ approval: { status: 'pending' } })
  fake.rows('approval_requests').length = 0 // pakai jalur POST / untuk membuat

  const created = await api('POST', '/api/approvals', {
    body: { job_id: jobId, application_id: appId, job_title: 'Backend Engineer', company: 'Fixture Co', platform: 'greenhouse', cover_letter: 'Surat dari pengguna', answers: [] },
  })
  assert.equal(created.status, 200, created.text)
  assert.equal(created.body.status, 'pending')
  const id = created.body.id as string
  const ttl = new Date(created.body.expires_at).getTime() - Date.now()
  assert.ok(ttl > 23 * 3_600_000 && ttl <= 24 * 3_600_000, 'masa berlaku 24 jam')

  const pending = await api('GET', '/api/approvals/pending')
  assert.equal(pending.status, 200)
  assert.deepEqual(pending.body.map((r: any) => r.id), [id])

  const approved = await api('POST', `/api/approvals/${id}/approve`, { body: { cover_letter: 'Surat hasil edit' } })
  assert.equal(approved.status, 200, approved.text)
  assert.ok(approved.body.queue_job_id)

  const row = fake.rows('approval_requests').find((r) => r.id === id)!
  assert.equal(row.status, 'approved')
  assert.equal(row.cover_letter, 'Surat hasil edit', 'surat hasil edit = versi yang disetujui')
  assert.equal(fake.rows('ai_applications').find((r) => r.id === appId)!.cover_letter, 'Surat hasil edit')

  assert.equal(queueRows().length, 1)
  const job = queueRows()[0]
  assert.equal(job.id, approved.body.queue_job_id)
  assert.equal(job.job_type, 'apply')
  assert.equal(job.status, 'pending')
  assert.equal(job.user_id, USER_A.id)
  assert.deepEqual(job.payload, { job_id: jobId, application_id: appId, approval_request_id: id, approved: true })
})

test('setujui dua kali: kedua hanya ditolak, satu pekerjaan antrean', async () => {
  const { approvalId } = seedApproval({ approval: { status: 'pending' } })
  assert.equal((await api('POST', `/api/approvals/${approvalId}/approve`)).status, 200)
  const second = await api('POST', `/api/approvals/${approvalId}/approve`)
  assert.equal(second.status, 404)
  assert.equal(queueRows().length, 1)
})

test('setujui persetujuan kedaluwarsa: 410, status menjadi expired, tidak ada antrean', async () => {
  const { approvalId } = seedApproval({ approval: { status: 'pending', expires_at: past() } })
  const res = await api('POST', `/api/approvals/${approvalId}/approve`)
  assert.equal(res.status, 410)
  assert.equal(fake.rows('approval_requests')[0].status, 'expired')
  assert.equal(queueRows().length, 0)
})

test('setujui persetujuan milik pengguna lain: 404 dan tidak berubah', async () => {
  const { approvalId } = seedApproval({ approval: { status: 'pending' } })
  const res = await api('POST', `/api/approvals/${approvalId}/approve`, { user: USER_B })
  assert.equal(res.status, 404)
  assert.equal(fake.rows('approval_requests')[0].status, 'pending')
  assert.equal(queueRows().length, 0)
})

test('tolak persetujuan: status rejected, alasan tercatat, log reject, tidak ada antrean', async () => {
  const { approvalId } = seedApproval({ approval: { status: 'pending' } })
  const res = await api('POST', `/api/approvals/${approvalId}/reject`, { body: { reason: 'Gaji kurang' } })
  assert.equal(res.status, 200, res.text)
  const row = fake.rows('approval_requests')[0]
  assert.equal(row.status, 'rejected')
  assert.equal(row.rejection_reason, 'Gaji kurang')
  assert.equal(logRows().filter((l) => l.action === 'reject').length, 1)
  assert.equal(queueRows().length, 0)
})

// ───────────────────────────────────────────────────────────────── rerun

test('rerun: ditolak selama ada pekerjaan aktif, diterima sesudah selesai, memuat payload yang sama', async () => {
  const { approvalId, jobId, appId } = seedApproval()
  const first = await api('POST', `/api/approvals/${approvalId}/rerun`)
  assert.equal(first.status, 200, first.text)
  assert.equal(queueRows().length, 1)
  assert.deepEqual(queueRows()[0].payload, { job_id: jobId, application_id: appId, approval_request_id: approvalId, approved: true })

  const busy = await api('POST', `/api/approvals/${approvalId}/rerun`)
  assert.equal(busy.status, 409)
  assert.match(busy.body.error, /already working/)
  assert.equal(queueRows().length, 1)

  queueRows()[0].status = 'completed'
  const again = await api('POST', `/api/approvals/${approvalId}/rerun`)
  assert.equal(again.status, 200, again.text)
  assert.equal(queueRows().length, 2)
})

test('rerun: batas MAX_RUNS_PER_APPROVAL jalan per persetujuan (429)', async () => {
  const { approvalId } = seedApproval()
  for (let i = 0; i < MAX_RUNS_PER_APPROVAL; i++) {
    const r = await api('POST', `/api/approvals/${approvalId}/rerun`)
    assert.equal(r.status, 200, `jalan ke-${i + 1}: ${r.text}`)
    queueRows()[queueRows().length - 1].status = 'completed'
  }
  const over = await api('POST', `/api/approvals/${approvalId}/rerun`)
  assert.equal(over.status, 429)
  assert.equal(queueRows().length, MAX_RUNS_PER_APPROVAL)
})

test('rerun: sudah terkirim (log success atau submit_unverified) 409, kedaluwarsa 410, belum disetujui 409, bukan milik sendiri 404', async () => {
  const sent = seedApproval()
  fake.seed('application_logs', { user_id: USER_A.id, action: 'apply', status: 'success', details: { approval_request_id: sent.approvalId } })
  assert.equal((await api('POST', `/api/approvals/${sent.approvalId}/rerun`)).status, 409)

  const unverified = seedApproval()
  fake.seed('application_logs', { user_id: USER_A.id, action: 'apply', status: 'submit_unverified', details: { approval_request_id: unverified.approvalId } })
  assert.equal((await api('POST', `/api/approvals/${unverified.approvalId}/rerun`)).status, 409)

  const expired = seedApproval({ approval: { expires_at: past() } })
  assert.equal((await api('POST', `/api/approvals/${expired.approvalId}/rerun`)).status, 410)

  const pending = seedApproval({ approval: { status: 'pending' } })
  assert.equal((await api('POST', `/api/approvals/${pending.approvalId}/rerun`)).status, 409)

  const others = seedApproval({ user: USER_B })
  assert.equal((await api('POST', `/api/approvals/${others.approvalId}/rerun`)).status, 404)

  assert.equal((await api('POST', `/api/approvals/${uuid('dead')}/rerun`)).status, 404)
  assert.equal(queueRows().length, 0, 'tidak satu pun dari kasus ini menaruh pekerjaan di antrean')
})

// TEMUAN (23 November 2026): id yang bukan uuid sampai ke Postgres dan kembali sebagai 500 "Failed to queue rerun:
// approval lookup failed: invalid input syntax for type uuid". Seharusnya 404/400. Dampaknya kecil (hanya pesan galat
// yang bocor dan status yang salah). `todo` menjaga verify tetap hijau; hapus `todo` bersama perbaikannya.
test('rerun dengan id yang bukan uuid: tidak jatuh menjadi 500 dari galat tipe database', { todo: 'id bukan uuid menghasilkan 500' }, async () => {
  const res = await api('POST', '/api/approvals/bukan-uuid/rerun')
  assert.ok(res.status >= 400 && res.status < 500, `status ${res.status}: ${res.text}`)
})

// ───────────────────────────────────────────────────────────────── mark-sent

test('mark-sent: log success manual memakai persetujuan, kartu menjadi submitted, tindak lanjut empat hari', async () => {
  const { approvalId, appId } = seedApproval()
  const res = await api('POST', `/api/approvals/${approvalId}/mark-sent`)
  assert.equal(res.status, 200, res.text)

  const logs = logRows().filter((l) => l.action === 'apply')
  assert.equal(logs.length, 1)
  assert.equal(logs[0].status, 'success')
  assert.equal(logs[0].details.approval_request_id, approvalId)
  assert.equal(logs[0].details.manual, true)

  const app = fake.rows('ai_applications').find((r) => r.id === appId)!
  assert.equal(app.status, 'submitted')
  const days = (new Date(app.follow_up_scheduled).getTime() - Date.now()) / 86_400_000
  assert.ok(days > 3.9 && days < 4.1, `tindak lanjut ${days} hari`)
})

test('mark-sent dua kali: idempoten (200), tetap satu log, kartu tidak mundur', async () => {
  const { approvalId, appId } = seedApproval()
  assert.equal((await api('POST', `/api/approvals/${approvalId}/mark-sent`)).status, 200)
  const second = await api('POST', `/api/approvals/${approvalId}/mark-sent`)
  assert.equal(second.status, 200, second.text)
  assert.equal(logRows().length, 1, 'tidak ada log kedua')
  assert.equal(fake.rows('ai_applications').find((r) => r.id === appId)!.status, 'submitted')
})

test('mark-sent sesudah agen terkirim (log success bukan manual): 409 already_sent', async () => {
  const { approvalId } = seedApproval()
  fake.seed('application_logs', { user_id: USER_A.id, action: 'apply', status: 'success', details: { approval_request_id: approvalId } })
  const res = await api('POST', `/api/approvals/${approvalId}/mark-sent`)
  assert.equal(res.status, 409)
  assert.equal(res.body.code, 'already_sent')
  assert.equal(logRows().length, 1)
})

test('mark-sent: klaim ekstensi yang masih baru, pekerjaan aktif, belum disetujui, milik orang lain: ditolak', async () => {
  const claimed = seedApproval()
  fake.seed('approval_submit_claims', { approval_request_id: claimed.approvalId, user_id: USER_A.id, channel: 'extension', created_at: new Date().toISOString() })
  const c = await api('POST', `/api/approvals/${claimed.approvalId}/mark-sent`)
  assert.equal(c.status, 409)
  assert.equal(c.body.code, 'agent_working')

  const active = seedApproval()
  fake.seed('automation_queue', { user_id: USER_A.id, job_type: 'apply', status: 'processing', payload: { approval_request_id: active.approvalId } })
  const a = await api('POST', `/api/approvals/${active.approvalId}/mark-sent`)
  assert.equal(a.status, 409)
  assert.equal(a.body.code, 'agent_working')

  const pending = seedApproval({ approval: { status: 'pending' } })
  assert.equal((await api('POST', `/api/approvals/${pending.approvalId}/mark-sent`)).body.code, 'not_approved')

  const others = seedApproval({ user: USER_B })
  assert.equal((await api('POST', `/api/approvals/${others.approvalId}/mark-sent`)).status, 404)

  assert.equal(logRows().length, 0, 'tidak ada log yang ditulis oleh kasus yang ditolak')
})

test('mark-sent: kirim belum terkonfirmasi (submit_unverified) dari 23 November: 200, ditandai konfirmasi pengguna', async () => {
  const { approvalId, appId } = seedApproval({ approval: { expires_at: past(3 * 86_400_000) } })
  fake.seed('application_logs', { user_id: USER_A.id, action: 'apply', status: 'submit_unverified', details: { approval_request_id: approvalId } })
  const res = await api('POST', `/api/approvals/${approvalId}/mark-sent`)
  assert.equal(res.status, 200, res.text)
  const written = logRows().filter((l) => l.status === 'success')
  assert.equal(written.length, 1)
  assert.equal(written[0].details.confirmed_by, 'user')
  assert.equal(written[0].details.confirmed_from, 'submit_unverified')
  assert.equal(fake.rows('ai_applications').find((r) => r.id === appId)!.status, 'submitted')
})

// ───────────────────────────────────────────────────────────────── not-sent dan close

test('not-sent: persetujuan baru pending 24 jam untuk pemilik, persetujuan lama diganti, status klaim abandoned', async () => {
  const { approvalId, jobId, appId } = seedApproval({ approval: { expires_at: past(3 * 86_400_000) } })
  fake.seed('application_logs', { user_id: USER_A.id, action: 'apply', status: 'submit_unverified', details: { approval_request_id: approvalId } })
  const res = await api('POST', `/api/approvals/${approvalId}/not-sent`)
  assert.equal(res.status, 200, res.text)
  const newId = res.body.new_approval_id as string
  const fresh = fake.rows('approval_requests').find((r) => r.id === newId)!
  assert.equal(fresh.user_id, USER_A.id)
  assert.equal(fresh.status, 'pending')
  assert.equal(fresh.job_id, jobId)
  assert.equal(fresh.application_id, appId)
  const ttl = new Date(fresh.expires_at).getTime() - Date.now()
  assert.ok(ttl > 23 * 3_600_000 && ttl <= 24 * 3_600_000)
  assert.equal(queueRows().length, 0, 'tidak ada tugas agen sebelum persetujuan baru disetujui')

  const claims = await api('POST', '/api/approvals/claim-statuses', { body: { approval_ids: [approvalId] } })
  assert.equal(claims.status, 200, claims.text)
  assert.equal(claims.body.claims[approvalId].state, 'abandoned')

  assert.equal((await api('POST', `/api/approvals/${approvalId}/not-sent`)).status, 409, 'dua kali: already_resolved')
})

test('close: log user_closed, status klaim closed, kartu lamaran tidak berubah', async () => {
  const { approvalId, appId } = seedApproval({ approval: { expires_at: past(3 * 86_400_000) } })
  const res = await api('POST', `/api/approvals/${approvalId}/close`)
  assert.equal(res.status, 200, res.text)
  assert.equal(logRows().filter((l) => l.details?.reason === 'user_closed').length, 1)
  assert.equal(fake.rows('ai_applications').find((r) => r.id === appId)!.status, 'ready')
  const claims = await api('POST', '/api/approvals/claim-statuses', { body: { approval_ids: [approvalId] } })
  assert.equal(claims.body.claims[approvalId].state, 'closed')
})

test('not-sent dan close: hanya pemilik. Persetujuan pengguna lain dijawab 404 tanpa tulisan', async () => {
  const others = seedApproval({ user: USER_B })
  const before = fake.rows('approval_requests').length
  assert.equal((await api('POST', `/api/approvals/${others.approvalId}/not-sent`)).status, 404)
  assert.equal((await api('POST', `/api/approvals/${others.approvalId}/close`)).status, 404)
  assert.equal(logRows().length, 0)
  assert.equal(fake.rows('approval_requests').length, before)
})

test('mark-sent tidak memeriksa kedaluwarsa (pengguna mengirim sendiri)', async () => {
  const { approvalId } = seedApproval({ approval: { expires_at: past(3 * 86_400_000) } })
  assert.equal((await api('POST', `/api/approvals/${approvalId}/mark-sent`)).status, 200)
})

test('mark-sent memakai persetujuan: rerun sesudahnya ditolak 409 (satu persetujuan satu kirim)', async () => {
  const { approvalId } = seedApproval({ approval: { expires_at: future() } })
  assert.equal((await api('POST', `/api/approvals/${approvalId}/mark-sent`)).status, 200)
  const rerun = await api('POST', `/api/approvals/${approvalId}/rerun`)
  assert.equal(rerun.status, 409)
  assert.match(rerun.body.error, /already sent/)
  assert.equal(queueRows().length, 0)
})
