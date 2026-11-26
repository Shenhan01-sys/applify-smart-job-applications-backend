import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FakeDb } from './helpers/fakeDb.ts'
import { JobNotAccessibleError, clientErrorReply, guardQueuePayload } from '../services/queue-guard.ts'

// Jalur apply tanpa persetujuan (isi-saja): worker membaca `jobs` lewat service role, jadi `job_id` dari klien
// tidak boleh menunjuk lowongan privat milik pengguna lain (prasyarat DRAFT_2026-11-26_private_offportal_jobs.sql).

test('guardQueuePayload: apply tanpa persetujuan untuk lowongan privat milik orang lain ditolak 404', async () => {
  const db = new FakeDb({ jobs: [{ id: 'jp', visibility: 'private', created_by: 'owner' }] })
  await assert.rejects(guardQueuePayload(db, 'intruder', 'apply', { job_id: 'jp' }), JobNotAccessibleError)
  const reply = clientErrorReply(new JobNotAccessibleError())
  assert.equal(reply?.statusCode, 404)
  assert.equal(reply?.body.code, 'job_not_found')
})

test('guardQueuePayload: apply tanpa persetujuan untuk lowongan privat milik sendiri dan lowongan publik lolos', async () => {
  const db = new FakeDb({
    jobs: [
      { id: 'jp', visibility: 'private', created_by: 'owner' },
      { id: 'jpub', visibility: 'public', created_by: null },
      { id: 'jold' },
    ],
  })
  assert.equal((await guardQueuePayload(db, 'owner', 'apply', { job_id: 'jp' })).job_id, 'jp')
  assert.equal((await guardQueuePayload(db, 'intruder', 'apply', { job_id: 'jpub' })).job_id, 'jpub')
  // Baris tanpa kolom visibility (basis data pra-migrasi) dianggap publik.
  assert.equal((await guardQueuePayload(db, 'intruder', 'apply', { job_id: 'jold' })).job_id, 'jold')
})

test('guardQueuePayload: apply tanpa job_id atau dengan job_id yang tidak ada tetap lolos (tidak ada yang bocor)', async () => {
  const db = new FakeDb()
  assert.deepEqual(await guardQueuePayload(db, 'u1', 'apply', { url: 'https://example.test/job' }), { url: 'https://example.test/job' })
  assert.equal((await guardQueuePayload(db, 'u1', 'apply', { job_id: 'tidak-ada' })).job_id, 'tidak-ada')
})
