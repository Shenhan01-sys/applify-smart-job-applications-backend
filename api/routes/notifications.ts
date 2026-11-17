import { FastifyInstance, FastifyPluginOptions } from 'fastify'
import { notificationsService } from '../../services/notifications.service.js'
import { notifyApplicationStatus } from '../../services/application-status.service.js'
import { supabase } from '../index.js'

export async function notificationRoutes(
  app: FastifyInstance,
  _opts: FastifyPluginOptions
) {
  // Get notification channel configuration status
  app.get('/status', async () => {
    return notificationsService.status()
  })

  // Send a test message to the configured Telegram chat
  app.post('/telegram/test', async (_request, reply) => {
    const result = await notificationsService.sendTelegram(
      '🤖 Applify: this is a test notification from your automation worker.'
    )
    if (!result.ok) {
      return reply.status(503).send({ success: false, error: result.error })
    }
    return { success: true }
  })

  // Send an arbitrary notification to the configured Telegram chat
  app.post('/telegram', async (request, reply) => {
    const { message } = request.body as any
    if (!message || typeof message !== 'string') {
      return reply.status(400).send({ error: 'message (string) is required' })
    }
    const result = await notificationsService.sendTelegram(message)
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
      return await notifyApplicationStatus(supabase, notificationsService, { userId, applicationId: application_id })
    } catch (error: any) {
      return reply.status(500).send({ error: error.message })
    }
  })
}
