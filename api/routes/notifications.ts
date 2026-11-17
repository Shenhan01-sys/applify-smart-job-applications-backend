import { FastifyInstance, FastifyPluginOptions } from 'fastify'
import { notificationsService } from '../../services/notifications.service.js'
import { notifyApplicationStatus } from '../../services/application-status.service.js'

/** Minimum gap between two Telegram test messages from the same user. */
export const TELEGRAM_TEST_COOLDOWN_MS = 60_000
/** The only text this API ever sends on a caller's behalf: fixed, no caller content, no user data. */
export const TELEGRAM_TEST_MESSAGE = '🤖 Applify: this is a test notification from your automation worker.'

export async function notificationRoutes(
  app: FastifyInstance,
  _opts: FastifyPluginOptions
) {
  // Get notification channel configuration status
  app.get('/status', async () => {
    return notificationsService.status()
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
    const now = Date.now()
    const last = lastTestAt.get(userId)
    if (last !== undefined && now - last < TELEGRAM_TEST_COOLDOWN_MS) {
      const retryAfter = Math.ceil((TELEGRAM_TEST_COOLDOWN_MS - (now - last)) / 1000)
      return reply.status(429).header('Retry-After', String(retryAfter)).send({ error: 'Too many test notifications', retry_after_seconds: retryAfter })
    }
    lastTestAt.set(userId, now)
    const result = await notificationsService.sendTelegram(TELEGRAM_TEST_MESSAGE)
    if (!result.ok) {
      return reply.status(503).send({ success: false, error: result.error })
    }
    return { success: true }
  })

  // Announce the current status of one of the caller's applications on Telegram. The status is read from
  // the database, not from the request; a repeat of the last announced status is skipped.
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
      // Loaded here, not at the top, so importing this file (in tests) does not start the server.
      const { supabase } = await import('../index.js')
      return await notifyApplicationStatus(supabase, notificationsService, { userId, applicationId: application_id })
    } catch (error: any) {
      return reply.status(500).send({ error: error.message })
    }
  })
}
