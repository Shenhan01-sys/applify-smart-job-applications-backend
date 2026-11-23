import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'crypto'
import Fastify from 'fastify'
import {
  KapsoWhatsAppService,
  normalizeWhatsAppPhone,
  verifyKapsoWebhookSignature,
} from '../services/kapso-whatsapp.service.js'
import {
  NotificationDispatcherService,
  requestWhatsappVerificationOtp,
  verifyWhatsappVerificationOtp,
} from '../services/notification-dispatcher.service.js'
import { notifyApplicationStatus } from '../services/application-status.service.js'
import { notificationRoutes, whatsappWebhookRoutes } from '../api/routes/notifications.js'
import { makeExtensionTestDb } from './extension-test-db.js'

const USER_ID = '11111111-2222-3333-4444-555555555555'

test('normalizeWhatsAppPhone & KapsoWhatsAppService: normalisasi E.164, 24h window teks vs template luar window', async () => {
  assert.deepEqual(normalizeWhatsAppPhone('0812-3456-7890'), { e164: '+6281234567890', waDigits: '6281234567890' })
  assert.deepEqual(normalizeWhatsAppPhone('+62 812 9999 0000'), { e164: '+6281299990000', waDigits: '6281299990000' })
  assert.equal(normalizeWhatsAppPhone('abc'), null)

  const sentPayloads: any[] = []
  const fakeFetch: typeof fetch = (async (_url: any, init: any) => {
    assert.equal(init.headers['X-API-Key'], 'kapso-test-key')
    sentPayloads.push(JSON.parse(init.body))
    return new Response(JSON.stringify({ messages: [{ id: 'wamid.1' }] }), { status: 200 })
  }) as typeof fetch

  const kapso = new KapsoWhatsAppService(fakeFetch, {
    KAPSO_API_KEY: 'kapso-test-key',
    KAPSO_PHONE_NUMBER_ID: 'pn-123',
    KAPSO_TEMPLATE_NAME: 'applify_status_id',
  })

  const now = new Date('2026-11-23T12:00:00Z')
  // Dalam 24 jam -> kirim type: 'text'
  const r1 = await kapso.sendMessage({
    to: '08123456789',
    body: 'Status lamaran ready',
    lastInboundAt: '2026-11-23T10:00:00Z',
    now,
  })
  assert.equal(r1.ok, true)
  assert.equal(r1.mode, 'text')
  assert.equal(sentPayloads[0].type, 'text')

  // Di luar 24 jam -> kirim template
  const r2 = await kapso.sendMessage({
    to: '08123456789',
    body: 'Lamaran terkirim',
    lastInboundAt: '2026-11-20T10:00:00Z',
    now,
  })
  assert.equal(r2.ok, true)
  assert.equal(r2.mode, 'template')
  assert.equal(sentPayloads[1].type, 'template')
  assert.equal(sentPayloads[1].template.name, 'applify_status_id')

  // Di luar 24 jam TANPA template dan TANPA sandbox -> tolak jujur
  const noTpl = new KapsoWhatsAppService(fakeFetch, { KAPSO_API_KEY: 'k', KAPSO_PHONE_NUMBER_ID: 'p' })
  const r3 = await noTpl.sendMessage({ to: '08123456789', body: 'hi', lastInboundAt: null, now })
  assert.equal(r3.ok, false)
  assert.equal(r3.error, 'outside_24h_window_no_template')
})

test('Alur OTP WhatsApp & Webhook Kapso x-hub-signature-256 + Dispatcher status', async () => {
  let capturedOtp = ''
  const fakeFetch: typeof fetch = (async (_url: any, init: any) => {
    const body = JSON.parse(init.body)
    const text = body.text?.body ?? ''
    const m = text.match(/\b(\d{6})\b/)
    if (m) capturedOtp = m[1]
    return new Response(JSON.stringify({ messages: [{ id: 'wamid.otp' }] }), { status: 200 })
  }) as typeof fetch

  const kapso = new KapsoWhatsAppService(fakeFetch, {
    KAPSO_API_KEY: 'kapso-test-key',
    KAPSO_PHONE_NUMBER_ID: 'pn-123',
    KAPSO_SANDBOX_MODE: 'true',
  })

  const store = makeExtensionTestDb({
    user_notification_settings: [],
    notification_verification_codes: [],
    ai_applications: [{ id: 'app-1', user_id: USER_ID, job_id: 'job-1', status: 'submitted', follow_up_scheduled: '2026-11-27T12:00:00Z' }],
    jobs: [{ id: 'job-1', title: 'Backend Engineer', company: 'Acme' }],
  })

  const t0 = new Date('2026-11-23T12:00:00Z')
  const reqRes = await requestWhatsappVerificationOtp(store.db, kapso, USER_ID, '081234567890', t0)
  assert.equal(reqRes.sent, true)
  assert.match(capturedOtp, /^\d{6}$/)

  // OTP salah ditolak
  await assert.rejects(() => verifyWhatsappVerificationOtp(store.db, USER_ID, '081234567890', '000000', t0), /Kode OTP salah/)

  // OTP benar memverifikasi dan mengaktifkan whatsapp
  const verified = await verifyWhatsappVerificationOtp(store.db, USER_ID, '+6281234567890', capturedOtp, t0)
  assert.equal(verified.whatsappVerified, true)
  assert.equal(verified.whatsappEnabled, true)

  // Webhook Kapso dengan signature sah memperbarui whatsapp_last_inbound_at
  const app = Fastify()
  const webhookSecret = 'kapso-webhook-secret-xyz'
  app.addHook('preHandler', async (req: any) => {
    req.user = { id: USER_ID }
  })
  await app.register(notificationRoutes, { prefix: '/api/notifications', db: store.db, whatsapp: kapso })
  await app.register(whatsappWebhookRoutes, { prefix: '/api/notifications', db: store.db, env: { KAPSO_WEBHOOK_SECRET: webhookSecret }, now: () => new Date('2026-11-23T14:00:00Z') })

  const payload = JSON.stringify({ messages: [{ from: '6281234567890', text: { body: 'Halo' } }] })
  const sig = 'sha256=' + crypto.createHmac('sha256', webhookSecret).update(payload).digest('hex')

  const badHook = await app.inject({
    method: 'POST',
    url: '/api/notifications/whatsapp/webhook',
    headers: { 'content-type': 'application/json', 'x-hub-signature-256': 'sha256=deadbeef' },
    payload,
  })
  assert.equal(badHook.statusCode, 401)
  assert.equal(verifyKapsoWebhookSignature(payload, sig, webhookSecret), true)

  const okHook = await app.inject({
    method: 'POST',
    url: '/api/notifications/whatsapp/webhook',
    headers: { 'content-type': 'application/json', 'x-hub-signature-256': sig },
    payload,
  })
  assert.equal(okHook.statusCode, 200)
  assert.equal(okHook.json().updated, 1)
  assert.equal(store.tables.user_notification_settings[0].whatsapp_last_inbound_at, '2026-11-23T14:00:00.000Z')

  // notifyApplicationStatus mengirim ke WA user walaupun Telegram operator mati
  const dispatcher = new NotificationDispatcherService(kapso, async () => ({ ok: false }))
  const notifyRes = await notifyApplicationStatus(
    store.db,
    { sendTelegram: async () => ({ ok: false, error: 'telegram not configured' }) },
    { userId: USER_ID, applicationId: 'app-1' },
    { dispatcher }
  )
  assert.deepEqual(notifyRes, { sent: true, status: 'submitted' })
  assert.equal(store.tables.application_logs[0].platform, 'whatsapp')
})
