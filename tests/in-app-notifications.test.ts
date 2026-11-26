import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import Fastify from 'fastify'
import { FakeDb } from './helpers/fakeDb.ts'
import { notificationRoutes } from '../api/routes/notifications.ts'
import {
  createInAppNotification,
  listInAppNotifications,
  markInAppNotificationsRead,
  sanitizeInternalHref,
} from '../services/in-app-notifications.service.ts'
import { notifyApplicationStatus } from '../services/application-status.service.ts'

const U1 = '11111111-1111-4111-8111-111111111111'
const U2 = '22222222-2222-4222-8222-222222222222'
const N1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const N2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

test('DRAFT_2026-11-26_user_notifications.sql idempoten, non-destruktif, dan SELECT-only untuk pemilik', () => {
  const sql = readFileSync(
    path.resolve(import.meta.dirname, '../../database/migrations/DRAFT_2026-11-26_user_notifications.sql'),
    'utf8'
  )
  const run = sql
    .split('\n')
    .filter((l) => !l.trim().startsWith('--'))
    .join('\n')
  assert.match(run, /CREATE TABLE IF NOT EXISTS public\.user_notifications/i)
  assert.match(run, /FOR SELECT\s+TO authenticated\s+USING \(auth\.uid\(\) = user_id\)/i)
  assert.doesNotMatch(run, /\b(DROP TABLE|TRUNCATE|DELETE FROM)\b/i)
})

test('sanitizeInternalHref menolak URL eksternal dan skrip, menerima path internal saja', () => {
  assert.equal(sanitizeInternalHref('/approvals'), '/approvals')
  assert.equal(sanitizeInternalHref('https://evil.example/x'), null)
  assert.equal(sanitizeInternalHref('//evil.example/x'), null)
  assert.equal(sanitizeInternalHref('javascript:alert(1)'), null)
})

test('in-app notifications: degradasi bersih saat tabel user_notifications belum ada (pra-migrasi)', async () => {
  const missingErr = { code: '42P01', message: 'relation "public.user_notifications" does not exist' }
  const dbMissing = {
    from() {
      let mode: 'select' | 'update' = 'select'
      return {
        select() {
          if (mode === 'update') return Promise.resolve({ data: null, error: missingErr })
          return this
        },
        insert: async () => ({ error: missingErr }),
        update() {
          mode = 'update'
          return this
        },
        eq() { return this },
        is() { return this },
        in() { return this },
        order() { return this },
        limit: async () => ({ data: null, error: missingErr }),
      }
    },
  }

  const ins = await createInAppNotification(dbMissing as any, {
    userId: U1,
    event: 'submitted',
    title: 'Applify: Terkirim',
    body: 'Lamaran Anda sudah dikirim.',
  })
  assert.deepEqual(ins, { ok: false, migrationPending: true })

  const list = await listInAppNotifications(dbMissing as any, U1)
  assert.deepEqual(list, { items: [], unreadCount: 0, migrationPending: true })

  const readRes = await markInAppNotificationsRead(dbMissing as any, U1, { all: true })
  assert.deepEqual(readRes, { updated: 0, migrationPending: true })
})

test('GET /in-app & POST /in-app/read mengisolasi per user, menghitung unread, dan menandai terbaca', async () => {
  const db = new FakeDb({
    user_notifications: [
      { id: N1, user_id: U1, event: 'ready', title: 'Siap', body: 'Periksa persetujuan', href: '/approvals', metadata: {}, read_at: null, created_at: '2026-11-26T09:00:00Z' },
      { id: N2, user_id: U1, event: 'submitted', title: 'Terkirim', body: 'Lamaran terkirim', href: '/applications', metadata: {}, read_at: '2026-11-26T08:00:00Z', created_at: '2026-11-26T08:00:00Z' },
      { id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', user_id: U2, event: 'submitted', title: 'Milik U2', body: 'Rahasia U2', href: '/applications', metadata: {}, read_at: null, created_at: '2026-11-26T09:05:00Z' },
    ],
  })

  const app = Fastify()
  let activeUser: string | null = U1
  app.addHook('preHandler', async (req) => {
    if (activeUser) (req as any).user = { id: activeUser }
  })
  await app.register(notificationRoutes, { db: db as any })

  const unauth = await (async () => {
    activeUser = null
    return app.inject({ method: 'GET', url: '/in-app' })
  })()
  assert.equal(unauth.statusCode, 401)
  activeUser = U1

  const res1 = await app.inject({ method: 'GET', url: '/in-app' })
  assert.equal(res1.statusCode, 200)
  const body1 = res1.json()
  assert.equal(body1.migrationPending, false)
  assert.equal(body1.items.length, 2)
  assert.equal(body1.unreadCount, 1)

  const readOne = await app.inject({
    method: 'POST',
    url: '/in-app/read',
    payload: { ids: [N1, 'bukan-uuid'] },
  })
  assert.equal(readOne.statusCode, 200)
  assert.equal(readOne.json().updated, 1)

  const res2 = await app.inject({ method: 'GET', url: '/in-app' })
  assert.equal(res2.json().unreadCount, 0)
  // Baris milik U2 tetap tidak tersentuh
  assert.equal(db.tables.user_notifications.find((r) => r.user_id === U2)?.read_at, null)
})

test('notifyApplicationStatus mencatat notifikasi in-app untuk pemilik lamaran', async () => {
  const db = new FakeDb({
    ai_applications: [{ id: 'app-1', user_id: U1, job_id: 'job-1', status: 'ready', follow_up_scheduled: null }],
    jobs: [{ id: 'job-1', title: 'Backend Engineer', company: 'PT Contoh' }],
    application_logs: [],
    user_notifications: [],
  })

  const out = await notifyApplicationStatus(
    db as any,
    { sendTelegram: async () => ({ ok: true }) },
    { userId: U1, applicationId: 'app-1' }
  )
  assert.equal(out.sent, true)
  assert.equal(db.tables.user_notifications.length, 1)
  assert.equal(db.tables.user_notifications[0].user_id, U1)
  assert.equal(db.tables.user_notifications[0].href, '/approvals')
})
