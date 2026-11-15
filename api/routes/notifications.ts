import { FastifyInstance, FastifyPluginOptions } from 'fastify'
import { notificationsService } from '../../services/notifications.service.js'

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
}
