import { FastifyInstance, FastifyPluginOptions } from 'fastify'
import { queueService, UnsupportedJobTypeError } from '../../services/queue.service.js'
import { ApprovalRequiredError } from '../../services/queue-guard.js'

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
      // A forged or stale approval_request_id is a client error, not a server fault.
      if (error instanceof ApprovalRequiredError) {
        return reply.status(error.statusCode).send({ error: error.message, code: error.code })
      }
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
      if (error instanceof UnsupportedJobTypeError) {
        return reply.status(501).send({ error: error.message })
      }
      return reply.status(500).send({ error: error.message })
    }
  })
}
