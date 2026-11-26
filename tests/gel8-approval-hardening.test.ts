import { test } from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import { FakeDb } from './helpers/fakeDb.js'
import { approvalRoutes } from '../api/routes/approval.js'
import { AiAccessError } from '../services/ai-guard.service.js'

const U1 = '11111111-1111-4111-8111-111111111111'
const J1 = '22222222-2222-4222-8222-222222222222'
const A1 = '33333333-3333-4333-8333-333333333333'
const APR1 = '44444444-4444-4444-8444-444444444444'

test('E2E-05: POST /api/approvals wajib job_id dan idempoten untuk pending per (user_id, job_id)', async () => {
  const db = new FakeDb({
    jobs: [{ id: J1, title: 'Backend Engineer', company: 'PT Test', visibility: 'public' }],
    ai_applications: [{ id: A1, user_id: U1, job_id: J1, cover_letter: 'Draf awal.' }],
    approval_requests: [],
  })

  const app = Fastify()
  app.addHook('preHandler', async (req: any) => { req.user = { id: U1 } })
  await app.register(approvalRoutes, {
    prefix: '/api/approvals',
    db,
    guard: { checkActionRateLimit: async () => {} },
  })

  const missingJob = await app.inject({
    method: 'POST',
    url: '/api/approvals',
    payload: { job_id: '   ', job_title: 'Backend Engineer', company: 'PT Test', platform: 'greenhouse' },
  })
  assert.equal(missingJob.statusCode, 400)
  assert.equal(missingJob.json().code, 'job_id_required')

  const first = await app.inject({
    method: 'POST',
    url: '/api/approvals',
    payload: {
      job_id: J1,
      application_id: A1,
      job_title: 'Backend Engineer',
      company: 'PT Test',
      platform: 'greenhouse',
      cover_letter: 'Surat pertama.',
    },
  })
  assert.equal(first.statusCode, 200)
  const firstBody = first.json()
  assert.equal(db.tables.approval_requests.length, 1)

  // Permintaan kedua untuk lowongan yang sama saat pending aktif harus mengembalikan baris yang sama.
  const second = await app.inject({
    method: 'POST',
    url: '/api/approvals',
    payload: {
      job_id: J1,
      application_id: A1,
      job_title: 'Backend Engineer',
      company: 'PT Test',
      platform: 'greenhouse',
      cover_letter: 'Surat kedua.',
    },
  })
  assert.equal(second.statusCode, 200)
  assert.equal(second.json().id, firstBody.id)
  assert.equal(db.tables.approval_requests.length, 1)
  await app.close()
})

test('E2E-05: client answers tidak boleh melewati rate limit atau menyuntikkan confidence=1 dan needs_review=false', async () => {
  const db = new FakeDb({
    jobs: [{ id: J1, title: 'Backend Engineer', company: 'PT Test', visibility: 'public' }],
    approval_requests: [],
  })

  let rateCalls = 0
  const app = Fastify()
  app.addHook('preHandler', async (req: any) => { req.user = { id: U1 } })
  await app.register(approvalRoutes, {
    prefix: '/api/approvals',
    db,
    guard: {
      checkActionRateLimit: async () => {
        rateCalls += 1
      },
    },
  })

  const res = await app.inject({
    method: 'POST',
    url: '/api/approvals',
    payload: {
      job_id: J1,
      job_title: 'Backend Engineer',
      company: 'PT Test',
      platform: 'greenhouse',
      answers: [{ question: 'Nama', answer: 'Budi', confidence: 1, needs_review: false, source: 'rule' }],
    },
  })
  assert.equal(res.statusCode, 200)
  assert.equal(rateCalls, 1)
  const savedAnswer = res.json().answers[0]
  assert.equal(savedAnswer.needs_review, true)
  assert.ok(savedAnswer.confidence <= 0.5)
  assert.equal(savedAnswer.source, 'default')
  await app.close()

  // Simulasi rate limit terlampaui bahkan ketika answers dikirim klien
  const limitedApp = Fastify()
  limitedApp.addHook('preHandler', async (req: any) => { req.user = { id: U1 } })
  await limitedApp.register(approvalRoutes, {
    prefix: '/api/approvals',
    db: new FakeDb({
      jobs: [{ id: J1, title: 'Backend Engineer', company: 'PT Test', visibility: 'public' }],
      approval_requests: [],
    }),
    guard: {
      checkActionRateLimit: async () => {
        throw new AiAccessError(429, 'rate_limited', 'Terlalu sering mencoba', { retryAfterSec: 30 })
      },
    },
  })
  const blocked = await limitedApp.inject({
    method: 'POST',
    url: '/api/approvals',
    payload: {
      job_id: J1,
      job_title: 'Backend Engineer',
      company: 'PT Test',
      platform: 'greenhouse',
      answers: [{ question: 'Nama', answer: 'Budi', confidence: 1, needs_review: false }],
    },
  })
  assert.equal(blocked.statusCode, 429)
  await limitedApp.close()
})

test('E2E-04: PATCH /api/approvals/:id/cover-letter menyinkronkan surat di pending approval & menolak non-pending', async () => {
  const future = new Date(Date.now() + 3_600_000).toISOString()
  const db = new FakeDb({
    ai_applications: [{ id: A1, user_id: U1, job_id: J1, cover_letter: 'Surat lama' }],
    approval_requests: [
      { id: APR1, user_id: U1, application_id: A1, job_id: J1, status: 'pending', expires_at: future, cover_letter: 'Surat lama' },
    ],
  })

  const app = Fastify()
  app.addHook('preHandler', async (req: any) => { req.user = { id: U1 } })
  await app.register(approvalRoutes, {
    prefix: '/api/approvals',
    db,
    guard: { checkActionRateLimit: async () => {} },
  })

  const empty = await app.inject({
    method: 'PATCH',
    url: `/api/approvals/${APR1}/cover-letter`,
    payload: { cover_letter: '   ' },
  })
  assert.equal(empty.statusCode, 400)

  const ok = await app.inject({
    method: 'PATCH',
    url: `/api/approvals/${APR1}/cover-letter`,
    payload: { cover_letter: 'Surat lamaran hasil tulis ulang.' },
  })
  assert.equal(ok.statusCode, 200)
  assert.equal(db.tables.approval_requests[0].cover_letter, 'Surat lamaran hasil tulis ulang.')
  assert.equal(db.tables.ai_applications[0].cover_letter, 'Surat lamaran hasil tulis ulang.')

  // Bila status sudah berubah menjadi approved, tidak boleh diedit lagi lewat endpoint ini
  db.tables.approval_requests[0].status = 'approved'
  const conflict = await app.inject({
    method: 'PATCH',
    url: `/api/approvals/${APR1}/cover-letter`,
    payload: { cover_letter: 'Terlambat ubah' },
  })
  assert.equal(conflict.statusCode, 409)
  await app.close()
})

test('Gelombang 10 (1a/1b): error 23505 saat race insert POST /api/approvals membaca ulang baris pending dengan 200 & DRAFT SQL siap', async () => {
  const { readFileSync } = await import('node:fs')
  const { resolve } = await import('node:path')
  const winningRow = {
    id: APR1,
    user_id: U1,
    job_id: J1,
    application_id: A1,
    job_title: 'Backend Engineer',
    company: 'PT Test',
    platform: 'greenhouse',
    cover_letter: 'Surat pemenang dari tab pertama.',
    answers: [],
    status: 'pending',
    expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    created_at: new Date().toISOString(),
  }

  let selectPhase = 0
  const raceDb: any = {
    from(table: string) {
      if (table === 'jobs') {
        const b: any = {
          select() { return b },
          eq() { return b },
          maybeSingle: async () => ({ data: { id: J1, visibility: 'public', created_by: null }, error: null }),
        }
        return b
      }
      if (table === 'ai_applications') {
        const b: any = {
          select() { return b },
          eq() { return b },
          maybeSingle: async () => ({ data: { id: A1, cover_letter: 'Draf awal.' }, error: null }),
        }
        return b
      }
      if (table === 'approval_requests') {
        let mode: 'select' | 'insert' = 'select'
        const b: any = {
          select() { return b },
          eq() { return b },
          gt() { return b },
          order() { return b },
          limit() { return b },
          insert() {
            mode = 'insert'
            return {
              select: async () => ({
                data: null,
                error: {
                  code: '23505',
                  message: 'duplicate key value violates unique constraint "approval_requests_one_pending_per_job"',
                },
              }),
            }
          },
          maybeSingle: async () => {
            if (mode === 'select') {
              selectPhase += 1
              // Panggilan pertama (pre-check) kosong seolah tab paralel belum commit; panggilan kedua (recovery 23505) mengembalikan baris pemenang.
              return { data: selectPhase === 1 ? null : winningRow, error: null }
            }
            return { data: null, error: null }
          },
        }
        return b
      }
      // Tabel pendukung jawaban formulir & resume
      const empty: any = {
        select() { return empty },
        eq() { return empty },
        order() { return empty },
        limit: async () => ({ data: [], error: null }),
        maybeSingle: async () => ({ data: null, error: null }),
        then(resolveFn: any, rejectFn: any) { return Promise.resolve({ data: [], error: null }).then(resolveFn, rejectFn) },
      }
      return empty
    },
  }

  const app = Fastify()
  app.addHook('preHandler', async (req: any) => { req.user = { id: U1 } })
  await app.register(approvalRoutes, {
    prefix: '/api/approvals',
    db: raceDb,
    guard: { checkActionRateLimit: async () => {} },
  })

  const res = await app.inject({
    method: 'POST',
    url: '/api/approvals',
    payload: {
      job_id: J1,
      application_id: A1,
      job_title: 'Backend Engineer',
      company: 'PT Test',
      platform: 'greenhouse',
      cover_letter: 'Surat dari tab kedua.',
    },
  })
  assert.equal(res.statusCode, 200, 'race 23505 wajib membalas 200, bukan 500')
  assert.equal(res.json().id, APR1)
  assert.equal(selectPhase, 2)
  await app.close()

  const draftSql = readFileSync(
    resolve(import.meta.dirname, '../../database/migrations/DRAFT_2026-11-26_approval_pending_unique.sql'),
    'utf8'
  )
  assert.match(draftSql, /SELECT user_id, job_id, count\(\*\)/i)
  assert.match(draftSql, /WHERE status = 'pending'/i)
  assert.match(draftSql, /GROUP BY 1, 2/i)
  assert.match(draftSql, /HAVING count\(\*\) > 1/i)
  assert.match(draftSql, /CREATE UNIQUE INDEX IF NOT EXISTS approval_requests_one_pending_per_job/i)
  assert.match(draftSql, /ON public\.approval_requests \(user_id, job_id\)/i)
  assert.match(draftSql, /deploy terlebih dahulu/i)
})
