import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import Fastify, { type FastifyInstance } from 'fastify'
import { FakeDb } from './helpers/fakeDb.ts'
import { APPLY_EMAIL_MAX_LENGTH, isValidApplyEmail } from '../services/email-address.ts'
import { QueueService, queueService } from '../services/queue.service.ts'
import {
  ApprovalRequiredError,
  InvalidPayloadError,
  clientErrorReply,
  guardQueuePayload,
} from '../services/queue-guard.ts'
import { queueRoutes } from '../api/routes/queue.ts'
import {
  ACCEPTED, ADDR_254, BREAK_VECTORS, LENGTH_VECTORS, LIST_AND_SYNTAX_VECTORS, REJECTED, TYPE_VECTORS,
} from './helpers/emailVectors.ts'

/**
 * apply_email of an email_apply job goes into the To: header of the message the worker sends from the
 * user's Gmail. The queue guard must refuse anything that is not exactly one plain address (header
 * injection by direct API calls). The vectors (helpers/emailVectors.ts) are the same file as
 * worker/tests/helpers/emailVectors.ts, which checks the worker-side copy of the rule.
 */

const NOW = new Date('2026-11-18T10:00:00.000Z')
const approval = () => ({
  id: 'a1', user_id: 'u1', job_id: 'j1', application_id: 'app1', status: 'approved', expires_at: '2026-11-18T11:00:00.000Z',
})

test('isValidApplyEmail: alamat tunggal yang wajar lolos, termasuk batas 254 karakter dan local part 64', () => {
  assert.equal(ADDR_254.length, APPLY_EMAIL_MAX_LENGTH)
  for (const a of ACCEPTED) assert.equal(isValidApplyEmail(a), true, a.slice(0, 40))
})

test('isValidApplyEmail: CR/LF, pemisah baris Unicode, dan karakter kontrol ditolak di posisi mana pun', () => {
  for (const [name, value] of BREAK_VECTORS) assert.equal(isValidApplyEmail(value), false, `${name}: ${JSON.stringify(value)}`)
})

test('isValidApplyEmail: daftar penerima, nama tampilan, kurung sudut, kutip, dan bentuk RFC lain ditolak', () => {
  for (const [name, value] of LIST_AND_SYNTAX_VECTORS) assert.equal(isValidApplyEmail(value), false, `${name}: ${JSON.stringify(value)}`)
})

test('isValidApplyEmail: lebih dari 254 karakter, local part atau label terlalu panjang ditolak', () => {
  assert.equal(`${ADDR_254}e`.length, APPLY_EMAIL_MAX_LENGTH + 1)
  for (const [name, value] of LENGTH_VECTORS) assert.equal(isValidApplyEmail(value), false, name)
})

test('isValidApplyEmail: bukan string (angka, objek, larik berisi alamat) ditolak', () => {
  for (const [name, value] of TYPE_VECTORS) assert.equal(isValidApplyEmail(value), false, name)
})

test('isValidApplyEmail: tidak ada vektor tolak yang lolos, dan daftarnya cukup lengkap', () => {
  const leaked = REJECTED.filter(([, v]) => isValidApplyEmail(v)).map(([n]) => n)
  assert.deepEqual(leaked, [])
  assert.ok(REJECTED.length > 100)
})

test('guardQueuePayload: email_apply dengan persetujuan sah tetapi apply_email berbahaya: InvalidPayloadError 400 invalid_apply_email', async () => {
  const db = new FakeDb({ approval_requests: [approval()] })
  for (const [name, value] of REJECTED) {
    await assert.rejects(
      guardQueuePayload(db, 'u1', 'email_apply', { approval_request_id: 'a1', apply_email: value }, NOW),
      (e: any) => e instanceof InvalidPayloadError && e.statusCode === 400 && e.code === 'invalid_apply_email',
      name
    )
  }
})

test('guardQueuePayload: apply_email tidak dikirim sama sekali ditolak dengan 400', async () => {
  const db = new FakeDb({ approval_requests: [approval()] })
  await assert.rejects(
    guardQueuePayload(db, 'u1', 'email_apply', { approval_request_id: 'a1' }, NOW),
    (e: any) => e instanceof InvalidPayloadError && e.statusCode === 400
  )
})

test('guardQueuePayload: pesan galat 400 tidak memuat nilai yang dikirim klien', async () => {
  const db = new FakeDb({ approval_requests: [approval()] })
  const evil = 'hr@x.test\r\nBcc: attacker@evil.test'
  await assert.rejects(
    guardQueuePayload(db, 'u1', 'email_apply', { approval_request_id: 'a1', apply_email: evil }, NOW),
    (e: any) => !e.message.includes('attacker') && !/[\r\n]/.test(e.message)
  )
})

test('guardQueuePayload: alamat sah disimpan apa adanya (tidak dipangkas atau diubah huruf), approved ditulis server', async () => {
  const db = new FakeDb({ approval_requests: [approval()] })
  for (const a of ACCEPTED) {
    const out = await guardQueuePayload(db, 'u1', 'email_apply', { approval_request_id: 'a1', apply_email: a, approved: false }, NOW)
    assert.equal(out.apply_email, a)
    assert.equal(out.approved, true)
    assert.equal(out.job_id, 'j1')
  }
})

test('guardQueuePayload: persetujuan diperiksa lebih dulu, jadi alamat jelek tanpa persetujuan sah tetap 403', async () => {
  const db = new FakeDb()
  await assert.rejects(
    guardQueuePayload(db, 'u1', 'email_apply', { approval_request_id: 'a1', apply_email: 'a@x.test,b@y.test' }, NOW),
    ApprovalRequiredError
  )
})

test('QueueService.addGenericJob: email_apply dengan alamat berbahaya tidak masuk antrean (satu baris pun)', async () => {
  const db = new FakeDb({ approval_requests: [{ ...approval(), expires_at: '2999-01-01T00:00:00.000Z' }] })
  const svc = new QueueService(db as any)
  for (const [name, value] of REJECTED) {
    await assert.rejects(
      svc.addGenericJob('u1', 'email_apply', { approval_request_id: 'a1', apply_email: value }),
      InvalidPayloadError,
      name
    )
  }
  assert.equal(db.rows('automation_queue').length, 0)
  await svc.addGenericJob('u1', 'email_apply', { approval_request_id: 'a1', apply_email: 'hrd@contoh.test' })
  assert.equal(db.rows('automation_queue').length, 1)
  assert.equal(db.rows('automation_queue')[0].payload.apply_email, 'hrd@contoh.test')
})

test('clientErrorReply: ApprovalRequiredError 403, InvalidPayloadError 400, galat lain null (jawaban 500)', () => {
  assert.deepEqual(clientErrorReply(new ApprovalRequiredError('x')), { statusCode: 403, body: { error: 'x', code: 'approval_required' } })
  assert.deepEqual(clientErrorReply(new InvalidPayloadError('y', 'invalid_apply_email')), {
    statusCode: 400, body: { error: 'y', code: 'invalid_apply_email' },
  })
  assert.equal(clientErrorReply(new InvalidPayloadError('z'))?.body.code, 'invalid_payload')
  assert.equal(clientErrorReply(new Error('db down')), null)
  assert.equal(clientErrorReply('teks'), null)
  assert.equal(clientErrorReply(undefined), null)
})

let app: FastifyInstance
const originalAddApplyJob = queueService.addApplyJob
beforeEach(async () => {
  app = Fastify()
  app.addHook('preHandler', async (req) => {
    ;(req as any).user = { id: 'u1' }
  })
  await app.register(queueRoutes, { prefix: '/api/queue' })
})
afterEach(async () => {
  queueService.addApplyJob = originalAddApplyJob
  await app.close()
})

test('POST /api/queue/apply: InvalidPayloadError dijawab 400 beserta code, bukan 500', async () => {
  queueService.addApplyJob = async () => {
    throw new InvalidPayloadError('apply_email tidak sah', 'invalid_apply_email')
  }
  const res = await app.inject({ method: 'POST', url: '/api/queue/apply', payload: { job_id: 'j1' } })
  assert.equal(res.statusCode, 400)
  assert.deepEqual(res.json(), { error: 'apply_email tidak sah', code: 'invalid_apply_email' })
})

test('rute POST /api/automation/queue memakai clientErrorReply, jadi galat 400 dan 403 sampai ke klien (tes statis pada teks kode)', () => {
  // automation.ts imports the Supabase client from api/index.ts, which starts the whole server, so the route
  // cannot be loaded in a unit test; its error mapping is checked in the source text instead.
  const src = readFileSync(new URL('../api/routes/automation.ts', import.meta.url), 'utf8')
  const handler = src.slice(src.indexOf("app.post('/queue'"))
  // Rute memakai batas pengguna addUserJob (daftar izin job_type, prioritas dari server), bukan addGenericJob.
  assert.match(handler, /addUserJob\(userId, job_type, payload\)/)
  assert.match(handler, /clientErrorReply\(error\)/)
  assert.match(handler, /reply\.status\(clientError\.statusCode\)\.send\(clientError\.body\)/)
})
