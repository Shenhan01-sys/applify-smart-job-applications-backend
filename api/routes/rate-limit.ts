import { FastifyInstance, FastifyPluginOptions } from 'fastify'
import { rateLimitService } from '../../services/rate-limit.service.js'

export async function rateLimitRoutes(
  app: FastifyInstance,
  _opts: FastifyPluginOptions
) {
  // Get user's current rate limits
  app.get('/status', async (request, reply) => {
    const userId = (request as any).user?.id
    if (!userId) {
      return reply.status(401).send({ error: 'Unauthorized' })
    }

    try {
      const [platformLimits, userQuota] = await Promise.all([
        rateLimitService.getRateLimitStatus(userId),
        rateLimitService.checkUserQuota(userId),
      ])

      return {
        platforms: platformLimits,
        quota: {
          tier: userQuota.tier,
          daily_limit: userQuota.tier === 'pro' ? 20 : 10,
          daily_used: (userQuota.tier === 'pro' ? 20 : 10) - userQuota.remaining,
          daily_remaining: userQuota.remaining,
          resets_at: userQuota.resetsAt,
        },
      }
    } catch (error: any) {
      return reply.status(500).send({ error: error.message })
    }
  })

  // Check specific platform limit
  app.get('/platform/:name', async (request, reply) => {
    const userId = (request as any).user?.id
    if (!userId) {
      return reply.status(401).send({ error: 'Unauthorized' })
    }

    const { name } = request.params as { name: string }

    try {
      const result = await rateLimitService.checkPlatformLimit(name, userId)
      return result
    } catch (error: any) {
      return reply.status(500).send({ error: error.message })
    }
  })
}
