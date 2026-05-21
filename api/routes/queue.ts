import { FastifyInstance, FastifyPluginOptions } from 'fastify'
import { queueService } from '../../services/queue.service.js'

export async function queueRoutes(
  app: FastifyInstance,
  _opts: FastifyPluginOptions
) {
  // Get queue status
  app.get('/status', async (request, reply) => {
    const userId = (request as any).user?.id
    if (!userId) {
      return reply.status(401).send({ error: 'Unauthorized' })
    }

    try {
      const status = await queueService.getQueueStatus(userId)
      return status
    } catch (error: any) {
      return reply.status(500).send({ error: error.message })
    }
  })

  // Add scan job to queue
  app.post('/scan', async (request, reply) => {
    const userId = (request as any).user?.id
    if (!userId) {
      return reply.status(401).send({ error: 'Unauthorized' })
    }

    const { keywords, location, platforms } = request.body as any

    try {
      const job = await queueService.addScanJob(userId, {
        keywords,
        location,
        platforms,
      })

      return { success: true, jobId: job.id }
    } catch (error: any) {
      return reply.status(500).send({ error: error.message })
    }
  })

  // Add apply job to queue
  app.post('/apply', async (request, reply) => {
    const userId = (request as any).user?.id
    if (!userId) {
      return reply.status(401).send({ error: 'Unauthorized' })
    }

    try {
      const job = await queueService.addApplyJob(userId, request.body)
      return { success: true, jobId: job.id }
    } catch (error: any) {
      return reply.status(500).send({ error: error.message })
    }
  })

  // Add analyze job to queue
  app.post('/analyze', async (request, reply) => {
    const userId = (request as any).user?.id
    if (!userId) {
      return reply.status(401).send({ error: 'Unauthorized' })
    }

    const { jobDescription, userSkills } = request.body as any

    try {
      const job = await queueService.addAnalyzeJob(userId, jobDescription, userSkills)
      return { success: true, jobId: job.id }
    } catch (error: any) {
      return reply.status(500).send({ error: error.message })
    }
  })
}
