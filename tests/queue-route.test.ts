import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import Fastify, { type FastifyInstance } from 'fastify'
import { FakeDb } from './helpers/fakeDb.ts'
import { queueService } from '../services/queue.service.ts'
import { queueRoutes } from '../api/routes/queue.ts'

/**
 * HTTP-level check of POST /api/queue/apply with a fake database behind the real route and service:
 * a client cannot turn a queue row into an approved one by typing approved:true.
 */

let app: FastifyInstance
let db: FakeDb
const future = '2999-01-01T00:00:00.000Z'

beforeEach(async () => {
  db = new FakeDb({
    approval_requests: [
      { id: 'ok', user_id: 'u1', job_id: 'j1', application_id: 'app1', status: 'approved', expires_at: future },
      { id: 'pend', user_id: 'u1', job_id: 'j1', application_id: 'app1', status: 'pending', expires_at: future },
      { id: 'other', user_id: 'u2', job_id: 'j1', application_id: 'app9', status: 'approved', expires_at: future },
    ],
  })
  ;(queueService as any).client = db
  app = Fastify()
  app.addHook('preHandler', async (req) => {
    ;(req as any).user = { id: 'u1' }
  })
  await app.register(queueRoutes, { prefix: '/api/queue' })
})

afterEach(async () => {
  ;(queueService as any).client = undefined
  await app.close()
})

const post = (payload: any) => app.inject({ method: 'POST', url: '/api/queue/apply', payload })

test('POST /apply dengan approved:true tanpa persetujuan: diterima sebagai isi-formulir-saja, approved dibuang', async () => {
  const res = await post({ job_id: 'j1', approved: true })
  assert.equal(res.statusCode, 200)
  assert.equal(db.rows('automation_queue').length, 1)
  assert.equal('approved' in db.rows('automation_queue')[0].payload, false)
})

test('POST /apply dengan approval_request_id pending, milik user lain, atau tidak ada: 403 dan tidak ada baris antrean', async () => {
  for (const id of ['pend', 'other', 'tidak-ada']) {
    const res = await post({ job_id: 'j1', approval_request_id: id, approved: true })
    assert.equal(res.statusCode, 403, id)
    assert.equal(res.json().code, 'approval_required')
  }
  assert.equal(db.rows('automation_queue').length, 0)
})

test('POST /apply dengan persetujuan sah: server yang menulis approved:true', async () => {
  const res = await post({ approval_request_id: 'ok' })
  assert.equal(res.statusCode, 200)
  assert.deepEqual(db.rows('automation_queue')[0].payload, {
    approval_request_id: 'ok', job_id: 'j1', application_id: 'app1', approved: true,
  })
})

test('POST /apply: persetujuan untuk lowongan lain ditolak', async () => {
  const res = await post({ approval_request_id: 'ok', job_id: 'j-lain' })
  assert.equal(res.statusCode, 403)
  assert.equal(db.rows('automation_queue').length, 0)
})
