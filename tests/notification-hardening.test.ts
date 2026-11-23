import test from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import { KapsoWhatsAppService } from '../services/kapso-whatsapp.service.js'
import { isTestRuntime, networkErrorCode, notificationsEnabled } from '../services/notifications-switch.js'
import {
  getAccountEmail,
  hashVerificationOtp,
  MAX_OTP_ATTEMPTS,
  NotificationDispatcherService,
  OTP_DAILY_LIMIT_PER_PHONE,
  OTP_DAILY_LIMIT_PER_USER,
  OTP_DAILY_WINDOW_MS,
  requestWhatsappVerificationOtp,
  sendTransactionalEmailNotification,
  updateUserNotificationSettings,
  verifyWhatsappVerificationOtp,
} from '../services/notification-dispatcher.service.js'
import { notificationsService } from '../services/notifications.service.js'
import { afterReplyFor, runAfterReplyTasks } from '../services/after-reply.js'
import { notificationRoutes } from '../api/routes/notifications.js'
import { buildApp, issueToken, makeExtensionTestDb, OTHER_USER_ID, USER_ID } from './extension-test-db.js'

/** Semua uji di sini memakai fetch tiruan dan env suntikan: tidak ada jaringan, tidak ada pesan sungguhan. */

const ON = { NOTIFICATIONS_ENABLED: 'true', NOTIFY_OTP_PEPPER: 'test-pepper-not-a-secret' }
const KAPSO_ENV = { ...ON, KAPSO_API_KEY: 'kapso-test-key', KAPSO_PHONE_NUMBER_ID: 'pn-1', KAPSO_SANDBOX_MODE: 'true' }
const T0 = new Date('2026-11-23T12:00:00Z')
const MIN = 60 * 1000
const OK_JSON = () => new Response(JSON.stringify({ messages: [{ id: 'wamid.1' }] }), { status: 200 })

const waitFor = async (cond: () => boolean, ms = 1500) => {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error('waitFor timeout')
    await new Promise((r) => setTimeout(r, 5))
  }
}

// -------------------------------------------------------------------------------------------------------------
// Sakelar, NODE_ENV=test, dan batas waktu (temuan 4)
// -------------------------------------------------------------------------------------------------------------

test('sakelar: NOTIFICATIONS_ENABLED hanya aktif untuk string "true"; bawaan mati; NODE_ENV=test selalu mematikan', () => {
  assert.equal(notificationsEnabled({}), false)
  for (const v of ['', '1', 'TRUE', 'True', 'yes', 'on', 'false', 'truee', 'enabled']) {
    assert.equal(notificationsEnabled({ NOTIFICATIONS_ENABLED: v }), false, v)
  }
  assert.equal(notificationsEnabled({ NOTIFICATIONS_ENABLED: 'true' }), true)
  assert.equal(notificationsEnabled({ NOTIFICATIONS_ENABLED: 'true', NODE_ENV: 'test' }), false)
  assert.equal(notificationsEnabled({ NOTIFICATIONS_ENABLED: 'true', NODE_ENV: ' TEST ' }), false)
  // Proses uji ini sendiri (node --test) memakai process.env sungguhan: dianggap runtime uji, jadi tidak ada pengiriman.
  assert.equal(isTestRuntime(process.env), true)
  assert.equal(notificationsEnabled(process.env), false)
})

test('tanpa sakelar atau saat NODE_ENV=test: tidak ada fetch dari Kapso, Resend, dispatcher, OTP, maupun Telegram', async () => {
  let calls = 0
  const spy = (async () => {
    calls++
    return OK_JSON()
  }) as typeof fetch
  const realFetch = globalThis.fetch
  globalThis.fetch = spy

  try {
    const base = { KAPSO_API_KEY: 'k', KAPSO_PHONE_NUMBER_ID: 'p', KAPSO_SANDBOX_MODE: 'true', RESEND_API_KEY: 'r', NOTIFY_FROM_EMAIL: 'a@example.com', NOTIFY_OTP_PEPPER: 'x' }
    const envs = [
      base,
      { ...base, NOTIFICATIONS_ENABLED: '1' },
      { ...base, NOTIFICATIONS_ENABLED: 'TRUE' },
      { ...base, NOTIFICATIONS_ENABLED: 'true', NODE_ENV: 'test' },
    ]
    for (const env of envs) {
      const store = makeExtensionTestDb(
        {
          user_notification_settings: [{ user_id: USER_ID, whatsapp_phone: '+6281234567890', whatsapp_verified: true, whatsapp_enabled: true, email_enabled: true }],
          notification_verification_codes: [],
        },
        { authUsers: { [USER_ID]: { email: 'me@example.com', email_confirmed_at: '2026-01-01T00:00:00Z' } } }
      )
      const kapso = new KapsoWhatsAppService(spy, env)
      assert.deepEqual(await kapso.sendMessage({ to: '08123456789', body: 'x' }), { ok: false, error: 'notifications_disabled' })
      assert.deepEqual(await sendTransactionalEmailNotification({ to: 'u@example.com', subject: 's', text: 't' }, spy, env), {
        ok: false,
        error: 'notifications_disabled',
      })
      const dispatcher = new NotificationDispatcherService(kapso, (a, f, e) => sendTransactionalEmailNotification(a, spy, e), env)
      assert.deepEqual(await dispatcher.dispatchUserNotification(store.db, { userId: USER_ID, event: 'submitted', title: 't', plainMessage: 'm' }), { deliveredChannels: [] })
      await assert.rejects(
        () => requestWhatsappVerificationOtp(store.db, kapso, USER_ID, '081234567890', T0, env),
        (e: any) => e.statusCode === 503 && e.code === 'notifications_disabled'
      )
      assert.equal(store.tables.notification_verification_codes.length, 0)
    }
    // Telegram operator juga tidak mengirim apa pun di runtime uji.
    assert.deepEqual(await notificationsService.sendTelegram('halo'), { ok: false, error: 'telegram_disabled_in_test' })
    assert.equal(calls, 0)
  } finally {
    globalThis.fetch = realFetch
  }
})

test('semua fetch Kapso dan Resend membawa AbortSignal.timeout; galat waktu habis menjadi kode generik', async () => {
  const signals: Array<AbortSignal | undefined> = []
  const capture = (async (_url: any, init: any) => {
    signals.push(init?.signal)
    return OK_JSON()
  }) as typeof fetch

  const kapso = new KapsoWhatsAppService(capture, KAPSO_ENV)
  assert.equal((await kapso.sendMessage({ to: '08123456789', body: 'x', now: T0 })).ok, true)
  const resendEnv = { ...ON, RESEND_API_KEY: 'r', NOTIFY_FROM_EMAIL: 'a@example.com' }
  assert.equal((await sendTransactionalEmailNotification({ to: 'u@example.com', subject: 's', text: 't' }, capture, resendEnv)).ok, true)
  assert.equal(signals.length, 2)
  for (const sig of signals) {
    assert.ok(sig instanceof AbortSignal)
    assert.equal(sig.aborted, false)
  }

  const timeoutErr = Object.assign(new Error('The operation was aborted due to timeout with secret-detail'), { name: 'TimeoutError' })
  const hang = (async () => {
    throw timeoutErr
  }) as typeof fetch
  assert.deepEqual(await new KapsoWhatsAppService(hang, KAPSO_ENV).sendMessage({ to: '08123456789', body: 'x', now: T0 }), { ok: false, error: 'kapso_timeout' })
  assert.deepEqual(await sendTransactionalEmailNotification({ to: 'u@example.com', subject: 's', text: 't' }, hang, resendEnv), { ok: false, error: 'resend_timeout' })
  assert.equal(networkErrorCode('kapso', new Error('ECONNRESET 10.0.0.1')), 'kapso_network_error')
})

test('galat Kapso tidak membocorkan isi penyedia: kode generik di layanan dan pesan tetap di rute OTP', async () => {
  const leaky = (async () =>
    new Response(JSON.stringify({ error: { message: 'Recipient +6281234567890 invalid, token abc123', code: 131030 } }), { status: 400 })) as typeof fetch
  const kapso = new KapsoWhatsAppService(leaky, KAPSO_ENV)
  const res = await kapso.sendMessage({ to: '08123456789', body: 'x', now: T0 })
  assert.deepEqual(res, { ok: false, error: 'kapso_http_400' })

  const store = makeExtensionTestDb({ user_notification_settings: [], notification_verification_codes: [] })
  const app = Fastify()
  app.addHook('preHandler', async (req: any) => {
    req.user = { id: USER_ID }
  })
  await app.register(notificationRoutes, { prefix: '/api/notifications', db: store.db, whatsapp: kapso, env: ON, now: () => T0 })
  const out = await app.inject({ method: 'POST', url: '/api/notifications/whatsapp/request-otp', payload: { phone: '081234567890' } })
  assert.equal(out.statusCode, 502)
  assert.equal(out.json().code, 'whatsapp_send_failed')
  assert.doesNotMatch(out.body, /abc123|131030|kapso_http|\+6281234567890/i)
})

// -------------------------------------------------------------------------------------------------------------
// Email penerima hanya dari akun Auth (temuan 2) dan tanpa Telegram per pengguna (nit)
// -------------------------------------------------------------------------------------------------------------

const ACCOUNT = { email: 'owner@example.com', email_confirmed_at: '2026-01-01T00:00:00Z' }

test('dispatcher: email hanya ke email akun Auth terkonfirmasi, kolom email_address lama diabaikan', async () => {
  const sent: string[] = []
  const emailSpy = (async (a: { to: string }) => {
    sent.push(a.to)
    return { ok: true }
  }) as typeof sendTransactionalEmailNotification
  const row = { user_id: USER_ID, email_enabled: true, email_address: 'attacker@evil.test', whatsapp_enabled: false }
  const dispatch = (store: ReturnType<typeof makeExtensionTestDb>) =>
    new NotificationDispatcherService(new KapsoWhatsAppService(fetch, KAPSO_ENV), emailSpy, ON).dispatchUserNotification(store.db, {
      userId: USER_ID,
      event: 'submitted',
      title: 't',
      plainMessage: 'm',
    })

  const ok = await dispatch(makeExtensionTestDb({ user_notification_settings: [row] }, { authUsers: { [USER_ID]: ACCOUNT } }))
  assert.deepEqual(ok.deliveredChannels, ['email'])
  assert.deepEqual(sent, ['owner@example.com'])

  // Email akun belum dikonfirmasi, tidak ada di Auth, atau pengguna mematikan email: tidak ada pengiriman.
  const unconfirmed = await dispatch(makeExtensionTestDb({ user_notification_settings: [row] }, { authUsers: { [USER_ID]: { email: 'owner@example.com', email_confirmed_at: null } } }))
  const noAuth = await dispatch(makeExtensionTestDb({ user_notification_settings: [row] }))
  const off = await dispatch(makeExtensionTestDb({ user_notification_settings: [{ ...row, email_enabled: false }] }, { authUsers: { [USER_ID]: ACCOUNT } }))
  for (const r of [unconfirmed, noAuth, off]) assert.deepEqual(r.deliveredChannels, [])
  assert.deepEqual(sent, ['owner@example.com'])
  assert.equal(await getAccountEmail(makeExtensionTestDb({}, { authUsers: { [OTHER_USER_ID]: ACCOUNT } }).db, USER_ID), null)
})

test('updateUserNotificationSettings dan PUT /preferences: emailAddress dan Telegram dari klien diabaikan; email = email akun', async () => {
  const store = makeExtensionTestDb(
    { user_notification_settings: [{ user_id: USER_ID, whatsapp_verified: false, email_enabled: false }], notification_verification_codes: [] },
    { authUsers: { [USER_ID]: ACCOUNT } }
  )
  const app = Fastify()
  app.addHook('preHandler', async (req: any) => {
    req.user = { id: USER_ID }
  })
  await app.register(notificationRoutes, { prefix: '/api/notifications', db: store.db, env: ON, now: () => T0 })

  const put = await app.inject({
    method: 'PUT',
    url: '/api/notifications/preferences',
    payload: { emailEnabled: true, emailAddress: 'attacker@evil.test', telegramChatId: '12345', telegramEnabled: true },
  })
  assert.equal(put.statusCode, 200)
  const body = put.json()
  assert.equal(body.emailAddress, 'owner@example.com')
  assert.equal(body.emailEnabled, true)
  assert.equal('telegramChatId' in body, false)
  assert.equal('telegramEnabled' in body, false)
  const row = store.tables.user_notification_settings[0]
  assert.equal(row.email_address, undefined)
  assert.equal(row.telegram_chat_id, undefined)
  assert.equal(row.telegram_enabled, undefined)

  const get = await app.inject({ method: 'GET', url: '/api/notifications/preferences' })
  assert.equal(get.json().emailAddress, 'owner@example.com')

  // Tanpa email akun terkonfirmasi, email tidak bisa diaktifkan.
  const bare = makeExtensionTestDb({ user_notification_settings: [{ user_id: USER_ID }] })
  await assert.rejects(
    () => updateUserNotificationSettings(bare.db, USER_ID, { emailEnabled: true }, T0),
    (e: any) => e.statusCode === 400 && e.code === 'account_email_unavailable'
  )
})

// -------------------------------------------------------------------------------------------------------------
// OTP (temuan 3 dan nit pepper)
// -------------------------------------------------------------------------------------------------------------

function otpHarness(opts: { env?: Record<string, string | undefined> } = {}) {
  let lastCode = ''
  let sends = 0
  const fakeFetch = (async (_u: any, init: any) => {
    sends++
    lastCode = String(JSON.parse(init.body).text?.body ?? '').match(/\b(\d{6})\b/)?.[1] ?? ''
    return OK_JSON()
  }) as typeof fetch
  const env = opts.env ?? ON
  const kapso = new KapsoWhatsAppService(fakeFetch, { ...KAPSO_ENV, ...env })
  const store = makeExtensionTestDb({ user_notification_settings: [], notification_verification_codes: [] }, { authUsers: { [USER_ID]: ACCOUNT } })
  return { kapso, store, env, code: () => lastCode, sends: () => sends }
}

test('OTP: batas harian per pengguna (jendela bergulir 24 jam) dan tidak ada pengiriman sesudah batas', async () => {
  assert.equal(OTP_DAILY_LIMIT_PER_USER, 5)
  const h = otpHarness()
  for (let i = 0; i < OTP_DAILY_LIMIT_PER_USER; i++) {
    const at = new Date(T0.getTime() + i * 2 * MIN) // lewat cooldown 60 detik
    await requestWhatsappVerificationOtp(h.store.db, h.kapso, USER_ID, `08123456789${i}`.slice(0, 12), at, h.env)
  }
  assert.equal(h.sends(), OTP_DAILY_LIMIT_PER_USER)
  const blockedAt = new Date(T0.getTime() + 12 * MIN)
  await assert.rejects(
    () => requestWhatsappVerificationOtp(h.store.db, h.kapso, USER_ID, '081299990000', blockedAt, h.env),
    (e: any) => e.statusCode === 429 && e.code === 'otp_daily_limit'
  )
  assert.equal(h.sends(), OTP_DAILY_LIMIT_PER_USER)
  assert.equal(h.store.tables.notification_verification_codes.length, OTP_DAILY_LIMIT_PER_USER)

  // Sesudah semua permintaan lama keluar dari jendela 24 jam, pengguna boleh meminta lagi.
  const later = new Date(T0.getTime() + OTP_DAILY_WINDOW_MS + 11 * MIN)
  const again = await requestWhatsappVerificationOtp(h.store.db, h.kapso, USER_ID, '081299990000', later, h.env)
  assert.equal(again.sent, true)
})

test('OTP: batas harian per nomor lintas pengguna (banyak akun tidak bisa membanjiri satu nomor)', async () => {
  assert.equal(OTP_DAILY_LIMIT_PER_PHONE, 5)
  const h = otpHarness()
  const victim = '081234567890'
  for (let i = 0; i < OTP_DAILY_LIMIT_PER_PHONE; i++) {
    await requestWhatsappVerificationOtp(h.store.db, h.kapso, `user-${i}`, victim, new Date(T0.getTime() + i * 1000), h.env)
  }
  await assert.rejects(
    () => requestWhatsappVerificationOtp(h.store.db, h.kapso, 'user-extra', victim, new Date(T0.getTime() + 10_000), h.env),
    (e: any) => e.statusCode === 429 && e.code === 'otp_daily_limit'
  )
  assert.equal(h.sends(), OTP_DAILY_LIMIT_PER_PHONE)
  // Nomor lain milik pengguna yang sama tidak terkena batas nomor korban.
  const other = await requestWhatsappVerificationOtp(h.store.db, h.kapso, 'user-extra', '081377770000', new Date(T0.getTime() + 20_000), h.env)
  assert.equal(other.sent, true)
})

test('OTP: percobaan dinaikkan atomik; tebakan paralel tidak melewati batas dan kode benar sesudah batas ditolak', async () => {
  const h = otpHarness()
  await requestWhatsappVerificationOtp(h.store.db, h.kapso, USER_ID, '081234567890', T0, h.env)
  const correct = h.code()
  const wrong = correct === '000000' ? '000001' : '000000'

  const results = await Promise.allSettled(
    Array.from({ length: 10 }, () => verifyWhatsappVerificationOtp(h.store.db, USER_ID, '081234567890', wrong, T0, h.env))
  )
  const codes = results.map((r) => (r.status === 'rejected' ? (r.reason as any).code : 'ok'))
  assert.equal(codes.filter((c) => c === 'otp_mismatch').length, MAX_OTP_ATTEMPTS)
  assert.equal(codes.filter((c) => c === 'otp_too_many_attempts').length, 10 - MAX_OTP_ATTEMPTS)
  assert.equal(h.store.tables.notification_verification_codes[0].attempts, MAX_OTP_ATTEMPTS)

  // Kode yang benar pun ditolak sesudah batas, dan nomor tidak terverifikasi.
  await assert.rejects(
    () => verifyWhatsappVerificationOtp(h.store.db, USER_ID, '081234567890', correct, T0, h.env),
    (e: any) => e.statusCode === 429 && e.code === 'otp_too_many_attempts'
  )
  assert.equal(h.store.tables.user_notification_settings.length, 0)
})

test('OTP: kode hanya sekali pakai; verifikasi paralel dengan kode benar hanya satu yang berhasil', async () => {
  const h = otpHarness()
  await requestWhatsappVerificationOtp(h.store.db, h.kapso, USER_ID, '081234567890', T0, h.env)
  const results = await Promise.allSettled(
    Array.from({ length: 3 }, () => verifyWhatsappVerificationOtp(h.store.db, USER_ID, '081234567890', h.code(), T0, h.env))
  )
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1)
  const row = h.store.tables.notification_verification_codes[0]
  assert.ok(row.consumed_at) // baris dipertahankan (dihitung di batas harian), hanya ditandai terpakai
  assert.equal(h.store.tables.user_notification_settings[0].whatsapp_verified, true)

  await assert.rejects(
    () => verifyWhatsappVerificationOtp(h.store.db, USER_ID, '081234567890', h.code(), T0, h.env),
    (e: any) => e.code === 'otp_not_found'
  )
})

test('OTP: tanpa RPC atau RPC gagal, verifikasi ditolak 503 (gagal tertutup) dan percobaan tidak dihitung diam-diam', async () => {
  const h = otpHarness()
  await requestWhatsappVerificationOtp(h.store.db, h.kapso, USER_ID, '081234567890', T0, h.env)
  const code = h.code()

  const noRpc = { ...h.store.db, rpc: undefined }
  const missingFn = { ...h.store.db, rpc: async () => ({ data: null, error: { code: '42883', message: 'function does not exist' } }) }
  const throwing = { ...h.store.db, rpc: async () => { throw new Error('network') } }
  for (const db of [noRpc, missingFn, throwing]) {
    await assert.rejects(
      () => verifyWhatsappVerificationOtp(db as any, USER_ID, '081234567890', code, T0, h.env),
      (e: any) => e.statusCode === 503 && e.code === 'otp_attempts_unavailable'
    )
  }
  assert.equal(h.store.tables.user_notification_settings.length, 0) // kode benar sekalipun tidak memverifikasi
  assert.equal(h.store.tables.notification_verification_codes[0].consumed_at, undefined)
})

test('OTP: pepper wajib NOTIFY_OTP_PEPPER, tanpa fallback ke KAPSO_API_KEY atau kunci lain; kosong = gagal tertutup', async () => {
  const noPepper = { NOTIFICATIONS_ENABLED: 'true', KAPSO_API_KEY: 'kapso-test-key', SESSION_ENCRYPTION_KEY: 'super_secret_session_key_minimum_32_characters_long' }
  assert.throws(() => hashVerificationOtp(USER_ID, '+6281234567890', '123456', noPepper), (e: any) => e.statusCode === 503 && e.code === 'otp_not_configured')
  assert.throws(() => hashVerificationOtp(USER_ID, '+6281234567890', '123456', { NOTIFY_OTP_PEPPER: '   ' }), (e: any) => e.code === 'otp_not_configured')
  assert.notEqual(
    hashVerificationOtp(USER_ID, '+6281234567890', '123456', { NOTIFY_OTP_PEPPER: 'a' }),
    hashVerificationOtp(USER_ID, '+6281234567890', '123456', { NOTIFY_OTP_PEPPER: 'b' })
  )

  const h = otpHarness({ env: noPepper })
  await assert.rejects(
    () => requestWhatsappVerificationOtp(h.store.db, h.kapso, USER_ID, '081234567890', T0, noPepper),
    (e: any) => e.statusCode === 503 && e.code === 'otp_not_configured'
  )
  assert.equal(h.sends(), 0)
  assert.equal(h.store.tables.notification_verification_codes.length, 0)
  await assert.rejects(
    () => verifyWhatsappVerificationOtp(h.store.db, USER_ID, '081234567890', '123456', T0, noPepper),
    (e: any) => e.code === 'otp_not_configured'
  )
})

// -------------------------------------------------------------------------------------------------------------
// Notifikasi sesudah balasan (temuan 4)
// -------------------------------------------------------------------------------------------------------------

test('afterReplyFor + runAfterReplyTasks: tugas jalan sesudah balasan terkirim dan galatnya ditelan', async () => {
  const app = Fastify()
  let release!: () => void
  const gate = new Promise<void>((r) => (release = r))
  let started = false
  let finished = false
  app.get('/x', { onResponse: runAfterReplyTasks }, async (request) => {
    const afterReply = afterReplyFor(request)
    afterReply(async () => {
      started = true
      await gate
      finished = true
    })
    afterReply(async () => {
      throw new Error('galat tugas ditelan')
    })
    return { ok: true }
  })
  const res = await app.inject({ method: 'GET', url: '/x' })
  assert.equal(res.statusCode, 200) // balasan datang walau tugas belum selesai
  await waitFor(() => started)
  assert.equal(finished, false)
  release()
  await waitFor(() => finished)
  await app.close()
})

test('report-run submitted: notifikasi tidak ditunggu sebelum membalas; berjalan sesudahnya', async () => {
  const NOW = new Date('2026-11-23T12:00:00Z')
  const APPROVAL = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1'
  const PAGE_URL = 'https://www.kalibrr.com/c/acme/jobs/1/apply'
  const store = makeExtensionTestDb({
    approval_requests: [{ id: APPROVAL, user_id: USER_ID, job_id: 'job-1', application_id: 'app-1', status: 'approved', expires_at: '2026-11-24T12:00:00Z', job_title: 'Backend', company: 'Acme' }],
    jobs: [{ id: 'job-1', platform_source: 'kalibrr', title: 'Backend Engineer', company: 'Acme', external_url: 'https://www.kalibrr.com/c/acme/jobs/1' }],
    ai_applications: [{ id: 'app-1', user_id: USER_ID, job_id: 'job-1', status: 'draft' }],
    subscriptions: [{ user_id: USER_ID, ai_model_tier: 'free' }],
  })
  const app = buildApp({ db: store.db, primaryUserId: USER_ID, now: () => NOW.getTime() })
  const token = await issueToken(app)
  const post = (url: string, payload: Record<string, unknown>) =>
    app.inject({ method: 'POST', url: `/api/extension/${url}`, headers: { authorization: `Bearer ${token}` }, payload })

  let release!: () => void
  const gate = new Promise<void>((r) => (release = r))
  let telegramCalls = 0
  const realSend = notificationsService.sendTelegram
  ;(notificationsService as any).sendTelegram = async () => {
    telegramCalls++
    await gate
    return { ok: true }
  }
  try {
    const auth = await post('authorize-submit', { approvalId: APPROVAL, jobId: 'job-1', pageUrl: PAGE_URL, missingRequiredCount: 0 })
    assert.equal(auth.statusCode, 200)
    const res = await post('report-run', { approvalId: APPROVAL, jobId: 'job-1', pageUrl: PAGE_URL, outcome: 'submitted', runId: auth.json().runId, filledCount: 5 })
    assert.equal(res.statusCode, 200) // tidak menunggu Telegram yang masih tertahan
    assert.equal(res.json().applicationStatus, 'submitted')

    await waitFor(() => telegramCalls === 1)
    assert.equal(store.tables.application_logs.filter((l) => l.action === 'status_notify').length, 0)
    release()
    await waitFor(() => store.tables.application_logs.some((l) => l.action === 'status_notify'))
  } finally {
    ;(notificationsService as any).sendTelegram = realSend
    release()
    await app.close()
  }
})
