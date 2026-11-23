import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import Fastify from 'fastify'
import {
  extractInboundWebhookPhones,
  KapsoWhatsAppService,
  verifyKapsoWebhookRequest,
  verifyKapsoWebhookSignature,
} from '../services/kapso-whatsapp.service.js'
import { requestWhatsappVerificationOtp } from '../services/notification-dispatcher.service.js'
import { whatsappWebhookRoutes } from '../api/routes/notifications.js'
import { makeExtensionTestDb, USER_ID } from './extension-test-db.js'

const ON = { NOTIFICATIONS_ENABLED: 'true', NOTIFY_OTP_PEPPER: 'test-otp-pepper-xyz' }
const SECRET = 'kapso-webhook-secret-2026'
const signRaw = (raw: string | Buffer) => crypto.createHmac('sha256', SECRET).update(raw).digest('hex')

test('Webhook Kapso: X-Webhook-Signature memakai raw body bytes, tolak format salah, dan semua 401 identik tanpa bocor alasan', async () => {
  const store = makeExtensionTestDb({
    user_notification_settings: [
      { user_id: USER_ID, whatsapp_phone: '+6281234567890', whatsapp_verified: true, whatsapp_enabled: true },
    ],
  })

  const app = Fastify()
  const T_HOOK = new Date('2026-11-24T01:00:00Z')
  await app.register(whatsappWebhookRoutes, {
    prefix: '/api/notifications',
    db: store.db,
    env: { KAPSO_WEBHOOK_SECRET: SECRET },
    now: () => T_HOOK,
  })

  // Raw bytes dengan spasi khusus (bila di-re-serialize JSON.stringify, hash-nya pasti berubah).
  const rawPayload = '{\n  "type": "whatsapp.message.received",\n  "batch": true,\n  "data": [\n    {\n      "message": {\n        "id": "wamid.1",\n        "kapso": { "direction": "inbound", "phone_number": "+6281234567890" }\n      },\n      "conversation": { "id": "conv_1", "phone_number": "+6281234567890" }\n    }\n  ]\n}'
  const kapsoHex = signRaw(Buffer.from(rawPayload, 'utf8'))

  // 1. Tanpa header signature -> 401 identik
  const rMissing = await app.inject({
    method: 'POST',
    url: '/api/notifications/whatsapp/webhook',
    headers: { 'content-type': 'application/json' },
    payload: rawPayload,
  })
  // 2. X-Webhook-Signature memakai prefix sha256= -> ditolak (prefix sha256= hanya untuk X-Hub-Signature-256)
  const rBadPrefix = await app.inject({
    method: 'POST',
    url: '/api/notifications/whatsapp/webhook',
    headers: { 'content-type': 'application/json', 'x-webhook-signature': `sha256=${kapsoHex}` },
    payload: rawPayload,
  })
  // 3. X-Hub-Signature-256 tanpa prefix sha256= -> ditolak
  const rMetaNoPrefix = await app.inject({
    method: 'POST',
    url: '/api/notifications/whatsapp/webhook',
    headers: { 'content-type': 'application/json', 'x-hub-signature-256': kapsoHex },
    payload: rawPayload,
  })
  // 4. Panjang beda -> ditolak tanpa melempar timingSafeEqual
  const rShort = await app.inject({
    method: 'POST',
    url: '/api/notifications/whatsapp/webhook',
    headers: { 'content-type': 'application/json', 'x-webhook-signature': 'deadbeef' },
    payload: rawPayload,
  })
  // 5. Payload berubah 1 byte (re-serialized) terhadap signature bytes asli -> ditolak
  const rTamperedBytes = await app.inject({
    method: 'POST',
    url: '/api/notifications/whatsapp/webhook',
    headers: { 'content-type': 'application/json', 'x-webhook-signature': kapsoHex },
    payload: JSON.stringify(JSON.parse(rawPayload)),
  })

  for (const r of [rMissing, rBadPrefix, rMetaNoPrefix, rShort, rTamperedBytes]) {
    assert.equal(r.statusCode, 401)
    assert.deepEqual(r.json(), { error: 'Invalid webhook signature' })
  }

  // 6. Kapso native X-Webhook-Signature + batch payload memperbarui whatsapp_last_inbound_at
  const okBatch = await app.inject({
    method: 'POST',
    url: '/api/notifications/whatsapp/webhook',
    headers: {
      'content-type': 'application/json',
      'x-webhook-event': 'whatsapp.message.received',
      'x-webhook-signature': kapsoHex,
    },
    payload: rawPayload,
  })
  assert.equal(okBatch.statusCode, 200)
  assert.deepEqual(okBatch.json(), { ok: true, updated: 1 })
  assert.equal(store.tables.user_notification_settings[0].whatsapp_last_inbound_at, T_HOOK.toISOString())

  // 7. Webhook event outbound (whatsapp.message.sent) TIDAK boleh membuka jendela 24 jam
  const outboundRaw = JSON.stringify({
    type: 'whatsapp.message.sent',
    message: { kapso: { direction: 'outbound', phone_number: '+6281234567890' } },
    conversation: { phone_number: '+6281234567890' },
  })
  const okOutbound = await app.inject({
    method: 'POST',
    url: '/api/notifications/whatsapp/webhook',
    headers: {
      'content-type': 'application/json',
      'x-webhook-event': 'whatsapp.message.sent',
      'x-webhook-signature': signRaw(outboundRaw),
    },
    payload: outboundRaw,
  })
  assert.equal(okOutbound.statusCode, 200)
  assert.deepEqual(okOutbound.json(), { ok: true, updated: 0 })

  // 8. Helper unit langsung
  assert.equal(verifyKapsoWebhookRequest(Buffer.from(rawPayload), { 'X-Webhook-Signature': kapsoHex }, SECRET), true)
  assert.equal(verifyKapsoWebhookRequest(Buffer.from(rawPayload), { 'X-Hub-Signature-256': `sha256=${kapsoHex}` }, SECRET), true)
  assert.equal(verifyKapsoWebhookSignature(rawPayload, kapsoHex, SECRET), true)
  assert.deepEqual(extractInboundWebhookPhones({ data: [{ message: { kapso: { direction: 'inbound' } }, conversation: { business_scoped_user_id: 'bsuid-1' } }] }), [])
  await app.close()
})

test('OTP WhatsApp di luar jendela 24 jam memakai template AUTHENTICATION (KAPSO_OTP_TEMPLATE_NAME) dengan komponen body + button', async () => {
  const sentPayloads: any[] = []
  const fakeFetch: typeof fetch = (async (_u: any, init: any) => {
    sentPayloads.push(JSON.parse(init.body))
    return new Response(JSON.stringify({ messages: [{ id: 'wamid.auth' }] }), { status: 200 })
  }) as typeof fetch

  const now = new Date('2026-11-24T02:00:00Z')
  const store = makeExtensionTestDb({ user_notification_settings: [], notification_verification_codes: [] })

  // 1. Tanpa KAPSO_OTP_TEMPLATE_NAME (walaupun KAPSO_TEMPLATE_NAME ada): tolak di luar 24 jam, tidak menjejali template umum
  const noOtpTpl = new KapsoWhatsAppService(fakeFetch, {
    ...ON,
    KAPSO_API_KEY: 'k',
    KAPSO_PHONE_NUMBER_ID: 'pn-1',
    KAPSO_TEMPLATE_NAME: 'applify_status_id',
  })
  await assert.rejects(
    () => requestWhatsappVerificationOtp(store.db, noOtpTpl, USER_ID, '081234567890', now, ON),
    (e: any) => e.statusCode === 502 && e.code === 'whatsapp_send_failed'
  )
  assert.equal(sentPayloads.length, 0)

  // 2. Dengan KAPSO_OTP_TEMPLATE_NAME: kirim template AUTHENTICATION (body + button sub_type url index 0) berisi hanya kode OTP
  const withOtpTpl = new KapsoWhatsAppService(fakeFetch, {
    ...ON,
    KAPSO_API_KEY: 'k',
    KAPSO_PHONE_NUMBER_ID: 'pn-1',
    KAPSO_TEMPLATE_NAME: 'applify_status_id',
    KAPSO_OTP_TEMPLATE_NAME: 'applify_auth_otp',
    KAPSO_OTP_TEMPLATE_LANG: 'id',
  })
  const store2 = makeExtensionTestDb({ user_notification_settings: [], notification_verification_codes: [] })
  const out = await requestWhatsappVerificationOtp(store2.db, withOtpTpl, USER_ID, '081234567890', now, ON)
  assert.equal(out.sent, true)
  assert.equal(out.mode, 'template')
  assert.equal(sentPayloads.length, 1)

  const req = sentPayloads[0]
  assert.equal(req.type, 'template')
  assert.equal(req.template.name, 'applify_auth_otp')
  assert.equal(req.template.language.code, 'id')
  assert.equal(req.template.components.length, 2)
  assert.equal(req.template.components[0].type, 'body')
  const otp = req.template.components[0].parameters[0].text
  assert.match(otp, /^\d{6}$/)
  assert.deepEqual(req.template.components[1], {
    type: 'button',
    sub_type: 'url',
    index: '0',
    parameters: [{ type: 'text', text: otp }],
  })

  // 3. Tanpa tombol (KAPSO_OTP_TEMPLATE_INCLUDE_BUTTON=false): hanya komponen body
  const bodyOnly = new KapsoWhatsAppService(fakeFetch, {
    ...ON,
    KAPSO_API_KEY: 'k',
    KAPSO_PHONE_NUMBER_ID: 'pn-1',
    KAPSO_OTP_TEMPLATE_NAME: 'applify_auth_otp_plain',
    KAPSO_OTP_TEMPLATE_INCLUDE_BUTTON: 'false',
  })
  const rPlain = await bodyOnly.sendOtp({ to: '081234567890', code: '654321', lastInboundAt: null, now })
  assert.equal(rPlain.ok, true)
  assert.equal(sentPayloads[1].template.components.length, 1)
  assert.deepEqual(sentPayloads[1].template.components[0], {
    type: 'body',
    parameters: [{ type: 'text', text: '654321' }],
  })
})
