import { FastifyInstance, FastifyPluginOptions } from 'fastify'
import { notificationsService } from '../../services/notifications.service.js'
import { notifyApplicationStatus } from '../../services/application-status.service.js'
import { kapsoWhatsAppService, verifyKapsoWebhookSignature } from '../../services/kapso-whatsapp.service.js'
import {
  getUserNotificationSettings,
  notificationDispatcher,
  NotificationPreferenceError,
  recordWhatsappInbound,
  requestWhatsappVerificationOtp,
  updateUserNotificationSettings,
  verifyWhatsappVerificationOtp,
} from '../../services/notification-dispatcher.service.js'
import type { GuardDb } from '../../services/queue-guard.js'

/** Minimum gap between two Telegram test messages from the same user. */
export const TELEGRAM_TEST_COOLDOWN_MS = 60_000
/** The only text this API ever sends on a caller's behalf: fixed, no caller content, no user data. */
export const TELEGRAM_TEST_MESSAGE = '🤖 Applify: this is a test notification from your automation worker.'
export const WHATSAPP_TEST_MESSAGE = 'Applify: ini pesan uji notifikasi WhatsApp otomatis Anda (tidak berisi data eksternal).'

export interface NotificationRoutesOptions extends FastifyPluginOptions {
  db?: GuardDb
  whatsapp?: typeof kapsoWhatsAppService
  dispatcher?: typeof notificationDispatcher
  env?: Record<string, string | undefined>
  now?: () => Date
}

export async function notificationRoutes(
  app: FastifyInstance,
  opts: NotificationRoutesOptions = {}
) {
  const getDb = async (): Promise<GuardDb> => opts.db ?? ((await import('../index.js')).supabase as unknown as GuardDb)
  const whatsapp = opts.whatsapp ?? kapsoWhatsAppService
  const dispatcher = opts.dispatcher ?? notificationDispatcher
  const now = opts.now ?? (() => new Date())

  // Get notification channel configuration status
  app.get('/status', async () => {
    return {
      ...notificationsService.status(),
      whatsappKapso: whatsapp.isConfigured(),
      email: Boolean((process.env.RESEND_API_KEY ?? '').trim() && (process.env.NOTIFY_FROM_EMAIL ?? '').trim()),
    }
  })

  // Preferensi notifikasi per-user (WhatsApp terverifikasi, email transaksional, peristiwa aktif)
  app.get('/preferences', async (request, reply) => {
    const userId = (request as any).user?.id
    if (!userId) return reply.status(401).send({ error: 'Unauthorized' })
    try {
      return await getUserNotificationSettings(await getDb(), userId)
    } catch (err: any) {
      if (err instanceof NotificationPreferenceError) {
        return reply.status(err.statusCode).send({ error: err.message, code: err.code })
      }
      return reply.status(500).send({ error: err?.message ?? 'Gagal membaca preferensi notifikasi' })
    }
  })

  app.put('/preferences', async (request, reply) => {
    const userId = (request as any).user?.id
    if (!userId) return reply.status(401).send({ error: 'Unauthorized' })
    const body = (request.body ?? {}) as Record<string, unknown>
    try {
      return await updateUserNotificationSettings(
        await getDb(),
        userId,
        {
          ...(typeof body.whatsappEnabled === 'boolean' ? { whatsappEnabled: body.whatsappEnabled } : {}),
          ...(typeof body.emailEnabled === 'boolean' ? { emailEnabled: body.emailEnabled } : {}),
          ...(body.emailAddress !== undefined ? { emailAddress: body.emailAddress as string | null } : {}),
          ...(typeof body.telegramEnabled === 'boolean' ? { telegramEnabled: body.telegramEnabled } : {}),
          ...(body.telegramChatId !== undefined ? { telegramChatId: body.telegramChatId as string | null } : {}),
          ...(body.notifyEvents && typeof body.notifyEvents === 'object' ? { notifyEvents: body.notifyEvents as any } : {}),
        },
        now()
      )
    } catch (err: any) {
      if (err instanceof NotificationPreferenceError) {
        return reply.status(err.statusCode).send({ error: err.message, code: err.code })
      }
      return reply.status(500).send({ error: err?.message ?? 'Gagal memperbarui preferensi notifikasi' })
    }
  })

  app.post('/whatsapp/request-otp', async (request, reply) => {
    const userId = (request as any).user?.id
    if (!userId) return reply.status(401).send({ error: 'Unauthorized' })
    const phone = String((request.body as any)?.phone ?? '')
    try {
      return await requestWhatsappVerificationOtp(await getDb(), whatsapp, userId, phone, now())
    } catch (err: any) {
      if (err instanceof NotificationPreferenceError) {
        return reply.status(err.statusCode).send({ error: err.message, code: err.code })
      }
      return reply.status(500).send({ error: err?.message ?? 'Gagal mengirim OTP WhatsApp' })
    }
  })

  app.post('/whatsapp/verify-otp', async (request, reply) => {
    const userId = (request as any).user?.id
    if (!userId) return reply.status(401).send({ error: 'Unauthorized' })
    const phone = String((request.body as any)?.phone ?? '')
    const code = String((request.body as any)?.code ?? '')
    try {
      return await verifyWhatsappVerificationOtp(await getDb(), userId, phone, code, now())
    } catch (err: any) {
      if (err instanceof NotificationPreferenceError) {
        return reply.status(err.statusCode).send({ error: err.message, code: err.code })
      }
      return reply.status(500).send({ error: err?.message ?? 'Gagal memverifikasi OTP WhatsApp' })
    }
  })

  // Uji WhatsApp: pesan tetap, cooldown 60 detik, hanya ke nomor WA terverifikasi milik pengguna sendiri.
  const lastWaTestAt = new Map<string, number>()
  app.post('/whatsapp/test', async (request, reply) => {
    const userId = (request as any).user?.id
    if (!userId) return reply.status(401).send({ error: 'Unauthorized' })
    const tNow = Date.now()
    const prev = lastWaTestAt.get(userId)
    if (prev !== undefined && tNow - prev < TELEGRAM_TEST_COOLDOWN_MS) {
      const retryAfter = Math.ceil((TELEGRAM_TEST_COOLDOWN_MS - (tNow - prev)) / 1000)
      return reply.status(429).header('Retry-After', String(retryAfter)).send({ error: 'Too many test notifications', retry_after_seconds: retryAfter })
    }
    const settings = await getUserNotificationSettings(await getDb(), userId)
    if (!settings.whatsappVerified || !settings.whatsappPhone) {
      return reply.status(400).send({ error: 'Nomor WhatsApp belum terverifikasi', code: 'whatsapp_not_verified' })
    }
    lastWaTestAt.set(userId, tNow)
    const sent = await whatsapp.sendMessage({
      to: settings.whatsappPhone,
      body: WHATSAPP_TEST_MESSAGE,
      lastInboundAt: settings.whatsappLastInboundAt,
      now: now(),
    })
    if (!sent.ok) {
      return reply.status(503).send({ success: false, error: sent.error })
    }
    return { success: true, mode: sent.mode }
  })

  // Send the fixed test message to the configured Telegram chat. The chat is one shared chat for the whole
  // deployment, so a caller can neither choose the text nor send more than one test per cooldown window.
  // There is deliberately no endpoint that forwards free text from a caller to Telegram.
  const lastTestAt = new Map<string, number>()
  app.post('/telegram/test', async (request, reply) => {
    const userId = (request as any).user?.id
    if (!userId) {
      return reply.status(401).send({ error: 'Unauthorized' })
    }
    const nowMs = Date.now()
    const last = lastTestAt.get(userId)
    if (last !== undefined && nowMs - last < TELEGRAM_TEST_COOLDOWN_MS) {
      const retryAfter = Math.ceil((TELEGRAM_TEST_COOLDOWN_MS - (nowMs - last)) / 1000)
      return reply.status(429).header('Retry-After', String(retryAfter)).send({ error: 'Too many test notifications', retry_after_seconds: retryAfter })
    }
    lastTestAt.set(userId, nowMs)
    const result = await notificationsService.sendTelegram(TELEGRAM_TEST_MESSAGE)
    if (!result.ok) {
      return reply.status(503).send({ success: false, error: result.error })
    }
    return { success: true }
  })

  // Announce the current status of one of the caller's applications on Telegram & user channels. The status is
  // read from the database, not from the request; a repeat of the last announced status is skipped.
  app.post('/application-status', async (request, reply) => {
    const userId = (request as any).user?.id
    if (!userId) {
      return reply.status(401).send({ error: 'Unauthorized' })
    }
    const { application_id } = (request.body ?? {}) as any
    if (!application_id || typeof application_id !== 'string') {
      return reply.status(400).send({ error: 'application_id (string) is required' })
    }
    try {
      const db = await getDb()
      return await notifyApplicationStatus(db as any, notificationsService, { userId, applicationId: application_id }, { dispatcher })
    } catch (error: any) {
      return reply.status(500).send({ error: error.message })
    }
  })
}

/**
 * Webhook publik Kapso WhatsApp (didaftarkan di luar authMiddleware JWT Supabase, diproteksi oleh HMAC
 * `x-hub-signature-256` menggunakan `KAPSO_WEBHOOK_SECRET`). Memperbarui `whatsapp_last_inbound_at` agar
 * pesan teks bebas dalam jendela 24 jam Meta Cloud API tetap terbuka.
 */
export async function whatsappWebhookRoutes(app: FastifyInstance, opts: NotificationRoutesOptions = {}) {
  const getDb = async (): Promise<GuardDb> => opts.db ?? ((await import('../index.js')).supabase as unknown as GuardDb)
  const env = opts.env ?? process.env
  const now = opts.now ?? (() => new Date())

  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) => {
    try {
      const raw = Buffer.isBuffer(body) ? body : Buffer.from(String(body ?? ''), 'utf8')
      const parsed = raw.length ? JSON.parse(raw.toString('utf8')) : {}
      done(null, { parsed, raw })
    } catch (err: any) {
      done(err)
    }
  })

  app.post('/whatsapp/webhook', async (request, reply) => {
    const secret = (env.KAPSO_WEBHOOK_SECRET ?? '').trim()
    if (!secret) {
      return reply.status(503).send({ error: 'KAPSO_WEBHOOK_SECRET not configured' })
    }
    const box = (request.body ?? {}) as { parsed?: any; raw?: Buffer }
    const rawBuf = box.raw ?? Buffer.from(JSON.stringify(request.body ?? {}), 'utf8')
    const sig = request.headers['x-hub-signature-256']
    if (!verifyKapsoWebhookSignature(rawBuf, sig, secret)) {
      return reply.status(401).send({ error: 'Invalid webhook signature' })
    }

    const payload = box.parsed ?? request.body
    const phones = new Set<string>()
    const collect = (node: any) => {
      if (!node || typeof node !== 'object') return
      if (typeof node.from === 'string') phones.add(node.from)
      if (Array.isArray(node.messages)) {
        for (const m of node.messages) if (typeof m?.from === 'string') phones.add(m.from)
      }
      if (Array.isArray(node.entry)) {
        for (const e of node.entry) {
          for (const ch of Array.isArray(e?.changes) ? e.changes : []) collect(ch?.value)
        }
      }
    }
    collect(payload)

    const db = await getDb()
    let updated = 0
    for (const phone of phones) {
      const res = await recordWhatsappInbound(db, phone, now())
      updated += res.updated
    }
    return { ok: true, updated }
  })
}
