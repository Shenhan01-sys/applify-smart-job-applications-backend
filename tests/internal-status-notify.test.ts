import test from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import { internalNotificationRoutes, verifyInternalBearer } from '../api/routes/notifications.ts'
import { KapsoWhatsAppService } from '../services/kapso-whatsapp.service.ts'
import { NotificationDispatcherService, sendTransactionalEmailNotification } from '../services/notification-dispatcher.service.ts'
import { notificationsService } from '../services/notifications.service.ts'
import { makeExtensionTestDb, USER_ID } from './extension-test-db.ts'

const APP_ID = 'app-notify-1'
const JOB_ID = 'job-notify-1'
const SECRET = 'svc-role-secret-for-worker-test-123'

function seedNotifyDb(status: 'ready' | 'submitted' | 'draft' = 'submitted', emailEnabled = true) {
  return makeExtensionTestDb(
    {
      jobs: [{ id: JOB_ID, title: 'Backend Engineer', company: 'PT Nusantara' }],
      ai_applications: [{ id: APP_ID, user_id: USER_ID, job_id: JOB_ID, status, follow_up_scheduled: '2026-11-28T00:00:00Z' }],
      user_notification_settings: [
        { user_id: USER_ID, whatsapp_phone: null, whatsapp_verified: false, whatsapp_enabled: false, email_enabled: emailEnabled },
      ],
    },
    { authUsers: { [USER_ID]: { email: 'kandidat@contoh.test', email_confirmed_at: '2026-01-01T00:00:00Z' } } }
  )
}

test('verifyInternalBearer & endpoint internal: tolak 401 tanpa/salah token dan 503 tanpa secret terkonfigurasi', async () => {
  assert.equal(verifyInternalBearer(undefined, SECRET), false)
  assert.equal(verifyInternalBearer('Bearer short', SECRET), false)
  assert.equal(verifyInternalBearer(`Bearer ${SECRET}`, 'tiny'), false)
  assert.equal(verifyInternalBearer(`Bearer ${SECRET}`, SECRET), true)

  const store = seedNotifyDb()
  const appNoSecret = Fastify()
  await appNoSecret.register(internalNotificationRoutes, {
    prefix: '/api/internal/notifications',
    db: store.db,
    env: {},
  })
  const res503 = await appNoSecret.inject({
    method: 'POST',
    url: '/api/internal/notifications/application-status',
    headers: { authorization: `Bearer ${SECRET}` },
    payload: { user_id: USER_ID, application_id: APP_ID },
  })
  assert.equal(res503.statusCode, 503)
  await appNoSecret.close()

  const appWithSecret = Fastify()
  await appWithSecret.register(internalNotificationRoutes, {
    prefix: '/api/internal/notifications',
    db: store.db,
    env: { INTERNAL_NOTIFY_SECRET: SECRET },
  })
  const res401 = await appWithSecret.inject({
    method: 'POST',
    url: '/api/internal/notifications/application-status',
    headers: { authorization: 'Bearer wrong-token-value' },
    payload: { user_id: USER_ID, application_id: APP_ID },
  })
  assert.equal(res401.statusCode, 401)
  await appWithSecret.close()
})

test('POST /api/internal/notifications/application-status: dispatch Resend saat NOTIFICATIONS_ENABLED=true, diam saat false, tanpa Telegram ganda', async () => {
  const realTelegram = notificationsService.sendTelegram.bind(notificationsService)
  let telegramCalls = 0
  ;(notificationsService as any).sendTelegram = async () => {
    telegramCalls++
    return { ok: true }
  }

  try {
    // 1. NOTIFICATIONS_ENABLED tidak disetel / false -> 0 fetch ke Resend
    let resendCalls = 0
    const spyFetch = (async (url: string | URL | Request, _init?: RequestInit) => {
      resendCalls++
      return new Response(JSON.stringify({ id: `em-${resendCalls}` }), { status: 200 })
    }) as typeof fetch

    const envOff = { RESEND_API_KEY: 're_test_key', NOTIFY_FROM_EMAIL: 'Applify <no-reply@applify.test>' }
    const dispatcherOff = new NotificationDispatcherService(
      new KapsoWhatsAppService(spyFetch, envOff),
      (a, _f, e) => sendTransactionalEmailNotification(a, spyFetch, e),
      envOff
    )
    const storeOff = seedNotifyDb('ready', true)
    const appOff = Fastify()
    await appOff.register(internalNotificationRoutes, {
      prefix: '/api/internal/notifications',
      db: storeOff.db,
      dispatcher: dispatcherOff,
      env: { INTERNAL_NOTIFY_SECRET: SECRET },
    })
    const offRes = await appOff.inject({
      method: 'POST',
      url: '/api/internal/notifications/application-status',
      headers: { authorization: `Bearer ${SECRET}` },
      payload: { user_id: USER_ID, application_id: APP_ID, skip_telegram: true },
    })
    assert.equal(offRes.statusCode, 200)
    assert.deepEqual(offRes.json(), { sent: false, reason: 'no_user_channels' })
    assert.equal(resendCalls, 0)
    assert.equal(telegramCalls, 0)
    await appOff.close()

    // 2. NOTIFICATIONS_ENABLED=true -> email terkirim lewat dispatcher tiruan, tetap bebas duplikasi & skip Telegram
    const payloads: any[] = []
    const spyFetchOn = (async (url: string | URL | Request, init?: RequestInit) => {
      resendCalls++
      payloads.push({ url: String(url), body: JSON.parse(String(init?.body ?? '{}')) })
      return new Response(JSON.stringify({ id: `em-${resendCalls}` }), { status: 200 })
    }) as typeof fetch

    const envOn = {
      NOTIFICATIONS_ENABLED: 'true',
      RESEND_API_KEY: 're_test_key',
      NOTIFY_FROM_EMAIL: 'Applify <no-reply@applify.test>',
    }
    const dispatcherOn = new NotificationDispatcherService(
      new KapsoWhatsAppService(spyFetchOn, envOn),
      (a, _f, e) => sendTransactionalEmailNotification(a, spyFetchOn, e),
      envOn
    )
    const storeOn = seedNotifyDb('submitted', true)
    const appOn = Fastify()
    await appOn.register(internalNotificationRoutes, {
      prefix: '/api/internal/notifications',
      db: storeOn.db,
      dispatcher: dispatcherOn,
      env: { INTERNAL_NOTIFY_SECRET: SECRET },
    })

    const onRes = await appOn.inject({
      method: 'POST',
      url: '/api/internal/notifications/application-status',
      headers: { authorization: `Bearer ${SECRET}` },
      payload: { user_id: USER_ID, application_id: APP_ID, skip_telegram: true },
    })
    assert.equal(onRes.statusCode, 200)
    assert.deepEqual(onRes.json(), { sent: true, status: 'submitted' })
    assert.equal(resendCalls, 1)
    assert.equal(telegramCalls, 0)
    assert.equal(payloads[0].url, 'https://api.resend.com/emails')
    assert.deepEqual(payloads[0].body.to, ['kandidat@contoh.test'])
    assert.match(payloads[0].body.text, /Backend Engineer.*PT Nusantara/)

    // Panggilan ulang pada status yang sama tidak mengirim email ganda
    const dupRes = await appOn.inject({
      method: 'POST',
      url: '/api/internal/notifications/application-status',
      headers: { authorization: `Bearer ${SECRET}` },
      payload: { user_id: USER_ID, application_id: APP_ID, skip_telegram: true },
    })
    assert.equal(dupRes.statusCode, 200)
    assert.deepEqual(dupRes.json(), { sent: false, reason: 'duplicate' })
    assert.equal(resendCalls, 1)
    await appOn.close()
  } finally {
    ;(notificationsService as any).sendTelegram = realTelegram
  }
})

test('rute internal: kunci service role tidak diterima sebagai pengganti INTERNAL_NOTIFY_SECRET', async () => {
  const app = Fastify()
  await app.register(internalNotificationRoutes, { prefix: '/api/internal/notifications', env: { SUPABASE_SERVICE_ROLE_KEY: 'svc-key-1234567890' } })
  const res = await app.inject({
    method: 'POST',
    url: '/api/internal/notifications/application-status',
    headers: { authorization: 'Bearer svc-key-1234567890' },
    payload: { user_id: 'u', application_id: 'a' },
  })
  assert.equal(res.statusCode, 503)
  await app.close()
})

