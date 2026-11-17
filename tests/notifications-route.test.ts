import { test, beforeEach, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import Fastify, { type FastifyInstance } from 'fastify'
import { notificationsService } from '../services/notifications.service.ts'
import { notificationRoutes, TELEGRAM_TEST_MESSAGE, TELEGRAM_TEST_COOLDOWN_MS } from '../api/routes/notifications.ts'

/**
 * HTTP-level check of the Telegram routes. Telegram is a fake: sendTelegram is replaced, so nothing is sent.
 * The chat is shared by the whole deployment, so a logged-in user must not be able to post text to it.
 */

let app: FastifyInstance
let sent: string[]
let currentUser: { id: string } | undefined
const realSend = notificationsService.sendTelegram.bind(notificationsService)

async function build() {
  const a = Fastify()
  a.addHook('preHandler', async (req) => {
    if (currentUser) (req as any).user = currentUser
  })
  await a.register(notificationRoutes, { prefix: '/api/notifications' })
  return a
}

beforeEach(async () => {
  sent = []
  currentUser = { id: 'u1' }
  ;(notificationsService as any).sendTelegram = async (m: string) => {
    sent.push(m)
    return { ok: true }
  }
  app = await build()
})

afterEach(async () => {
  ;(notificationsService as any).sendTelegram = realSend
  mock.timers.reset()
  await app.close()
})

test('POST /telegram (teks bebas) sudah dihapus: 404 dan tidak ada pesan ke Telegram', async () => {
  const res = await app.inject({ method: 'POST', url: '/api/notifications/telegram', payload: { message: 'pesan bebas dari pengguna' } })
  assert.equal(res.statusCode, 404)
  assert.equal(sent.length, 0)
})

test('POST /telegram/test: isi pesan tetap, teks dari pengguna diabaikan', async () => {
  const res = await app.inject({ method: 'POST', url: '/api/notifications/telegram/test', payload: { message: 'SPAM <b>x</b>', text: 'lain' } })
  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.json(), { success: true })
  assert.deepEqual(sent, [TELEGRAM_TEST_MESSAGE])
  assert.doesNotMatch(sent[0], /u1|SPAM/)
})

test('POST /telegram/test tanpa login: 401 dan tidak ada pesan', async () => {
  currentUser = undefined
  const res = await app.inject({ method: 'POST', url: '/api/notifications/telegram/test' })
  assert.equal(res.statusCode, 401)
  assert.equal(sent.length, 0)
})

test('POST /telegram/test: satu kali per menit per pengguna (429 + Retry-After), pengguna lain tidak terpengaruh', async () => {
  mock.timers.enable({ apis: ['Date'], now: 1_000_000 })
  const hit = () => app.inject({ method: 'POST', url: '/api/notifications/telegram/test' })

  assert.equal((await hit()).statusCode, 200)
  mock.timers.setTime(1_000_000 + 10_000)
  const blocked = await hit()
  assert.equal(blocked.statusCode, 429)
  assert.equal(blocked.headers['retry-after'], '50')
  assert.equal(sent.length, 1)

  currentUser = { id: 'u2' }
  assert.equal((await hit()).statusCode, 200)
  assert.equal(sent.length, 2)

  currentUser = { id: 'u1' }
  mock.timers.setTime(1_000_000 + TELEGRAM_TEST_COOLDOWN_MS)
  assert.equal((await hit()).statusCode, 200)
  assert.equal(sent.length, 3)
})

test('POST /telegram/test: Telegram tidak terkonfigurasi atau gagal membalas 503', async () => {
  ;(notificationsService as any).sendTelegram = async () => ({ ok: false, error: 'telegram not configured' })
  const res = await app.inject({ method: 'POST', url: '/api/notifications/telegram/test' })
  assert.equal(res.statusCode, 503)
  assert.equal(res.json().success, false)
})

test('POST /application-status tanpa login: 401', async () => {
  currentUser = undefined
  const res = await app.inject({ method: 'POST', url: '/api/notifications/application-status', payload: { application_id: 'a1' } })
  assert.equal(res.statusCode, 401)
  assert.equal(sent.length, 0)
})

test('POST /application-status tanpa application_id: 400', async () => {
  const res = await app.inject({ method: 'POST', url: '/api/notifications/application-status', payload: {} })
  assert.equal(res.statusCode, 400)
  assert.equal(sent.length, 0)
})
