import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { FakeDb } from './helpers/fakeDb.ts'
import { QueueService, USER_JOB_PRIORITY } from '../services/queue.service.ts'
import { ApprovalRequiredError, clientErrorReply, InvalidPayloadError } from '../services/queue-guard.ts'

/**
 * Temuan audit 2026-11-25: POST /api/automation/queue membiarkan pengguna memilih `priority` dan job_type apa
 * saja, termasuk company_insight {all: true} (job global yang mahal). Batas pengguna ada di
 * QueueService.addUserJob; addGenericJob tetap terbuka untuk pemanggil internal.
 */

const future = '2999-01-01T00:00:00.000Z'
const approval = { id: 'a1', user_id: 'u1', job_id: 'j1', application_id: 'app1', status: 'approved', expires_at: future }

test('addUserJob: job type yang diizinkan diterima dan prioritas 999 dari klien diabaikan (server memakai 0)', async () => {
  const db = new FakeDb()
  const svc = new QueueService(db as any)
  const row = await svc.addUserJob('u1', 'search', { keywords: 'data analyst' }, 999)
  assert.ok(row)
  const rows = db.rows('automation_queue')
  assert.equal(rows.length, 1)
  assert.equal(rows[0].priority, USER_JOB_PRIORITY.search)
  assert.equal(rows[0].priority, 0)
  assert.equal(rows[0].job_type, 'search')
  assert.equal(rows[0].user_id, 'u1')
  assert.equal(rows[0].status, 'pending')
})

test('addUserJob: prioritas negatif atau bukan angka dari klien juga diabaikan', async () => {
  const db = new FakeDb()
  const svc = new QueueService(db as any)
  await svc.addUserJob('u1', 'apply', { job_id: 'j1' }, -50)
  await svc.addUserJob('u1', 'apply', { job_id: 'j2' }, 'tinggi')
  assert.deepEqual(db.rows('automation_queue').map((r) => r.priority), [0, 0])
})

test('addUserJob: setiap job type di daftar izin memakai prioritas bawaan server', async () => {
  assert.deepEqual(Object.keys(USER_JOB_PRIORITY).sort(), ['apply', 'email_apply', 'search'])
  const db = new FakeDb({ approval_requests: [approval] })
  const svc = new QueueService(db as any)
  await svc.addUserJob('u1', 'search', { keywords: 'x' }, 999)
  await svc.addUserJob('u1', 'apply', { job_id: 'j1' }, 999)
  await svc.addUserJob('u1', 'email_apply', { approval_request_id: 'a1', apply_email: 'hrd@contoh.test' }, 999)
  const rows = db.rows('automation_queue')
  assert.deepEqual(rows.map((r) => r.job_type), ['search', 'apply', 'email_apply'])
  for (const r of rows) assert.equal(r.priority, USER_JOB_PRIORITY[r.job_type as keyof typeof USER_JOB_PRIORITY])
})

test('addUserJob: job type di luar daftar izin ditolak 400 tanpa menulis baris', async () => {
  const db = new FakeDb()
  const svc = new QueueService(db as any)
  for (const jobType of ['extension_apply', 'scan_jobs', 'analyze', 'Company_Insight', ' search', 'constructor', '__proto__', '', undefined, null, 7, {}, ['search']]) {
    await assert.rejects(
      svc.addUserJob('u1', jobType, { keywords: 'x' }, 999),
      (err: unknown) => {
        assert.ok(err instanceof InvalidPayloadError, `job_type ${JSON.stringify(jobType)}`)
        assert.equal(err.statusCode, 400)
        assert.equal(err.code, 'job_type_not_allowed')
        assert.match(err.message, /Jenis pekerjaan tidak diizinkan/)
        return true
      }
    )
  }
  assert.equal(db.rows('automation_queue').length, 0)
})

test('addUserJob: company_insight dengan {all: true} ditolak, juga bila disertai prioritas tinggi', async () => {
  const db = new FakeDb()
  const svc = new QueueService(db as any)
  await assert.rejects(svc.addUserJob('u1', 'company_insight', { all: true }, 999), InvalidPayloadError)
  await assert.rejects(svc.addUserJob('u1', 'company_insight', { all: 'true' }), InvalidPayloadError)
  await assert.rejects(svc.addUserJob('u1', 'company_insight', { jobId: 'j1' }), InvalidPayloadError)
  assert.equal(db.rows('automation_queue').length, 0)
})

test('addUserJob: galat ditolak dipetakan clientErrorReply ke 400 dengan pesan Indonesia', async () => {
  const svc = new QueueService(new FakeDb() as any)
  const err = await svc.addUserJob('u1', 'company_insight', { all: true }).catch((e) => e)
  const reply = clientErrorReply(err)
  assert.ok(reply)
  assert.equal(reply.statusCode, 400)
  assert.equal(reply.body.code, 'job_type_not_allowed')
  assert.match(reply.body.error, /apply, email_apply, search/)
})

test('addUserJob: perilaku job type yang diizinkan tidak berubah (guard persetujuan dan approved tetap berlaku)', async () => {
  const db = new FakeDb({ approval_requests: [approval] })
  const svc = new QueueService(db as any)
  // email_apply tanpa persetujuan sah tetap 403.
  await assert.rejects(svc.addUserJob('u1', 'email_apply', { job_id: 'j1', approved: true }), ApprovalRequiredError)
  assert.equal(db.rows('automation_queue').length, 0)
  // apply: approved dari klien dibuang.
  await svc.addUserJob('u1', 'apply', { job_id: 'j1', approved: true })
  assert.equal(db.rows('automation_queue').length, 1)
  assert.equal('approved' in db.rows('automation_queue')[0].payload, false)
  // email_apply dengan persetujuan sah: server menulis approved dan job_id.
  await svc.addUserJob('u1', 'email_apply', { approval_request_id: 'a1', apply_email: 'hrd@contoh.test' })
  const mail = db.rows('automation_queue')[1]
  assert.equal(mail.payload.approved, true)
  assert.equal(mail.payload.job_id, 'j1')
  assert.equal(mail.payload.apply_email, 'hrd@contoh.test')
})

test('addGenericJob tetap terbuka untuk pemanggil internal (company_insight dan prioritas dari kode sistem)', async () => {
  const db = new FakeDb()
  const svc = new QueueService(db as any)
  await svc.addGenericJob('system', 'company_insight', { all: true }, 5)
  const row = db.rows('automation_queue')[0]
  assert.equal(row.job_type, 'company_insight')
  assert.equal(row.priority, 5)
  assert.deepEqual(row.payload, { all: true })
})

test('rute POST /api/automation/queue tidak membaca priority dari klien dan memakai addUserJob (tes statis pada teks kode)', () => {
  // automation.ts mengimpor klien Supabase dari api/index.ts yang menyalakan server, jadi rutenya tidak bisa
  // dimuat di tes unit; isinya diperiksa lewat teks kode, seperti di apply-email.test.ts.
  const src = readFileSync(new URL('../api/routes/automation.ts', import.meta.url), 'utf8')
  const handler = src.slice(src.indexOf("app.post('/queue'"))
  assert.match(handler, /queueService\.addUserJob\(userId, job_type, payload\)/)
  assert.doesNotMatch(handler, /priority\s*[=,}]/)
  assert.doesNotMatch(handler, /addGenericJob/)
})
