import { FastifyInstance, FastifyPluginOptions } from 'fastify'
import { queueService, UnsupportedJobTypeError } from '../../services/queue.service.js'
import { clientErrorReply } from '../../services/queue-guard.js'

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
      request.log.error({ err: String(error?.message ?? error).slice(0, 200) }, 'queue: status failed')
      return reply.status(500).send({ error: 'Gagal memuat status antrean' })
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
      request.log.error({ err: String(error?.message ?? error).slice(0, 200) }, 'queue: scan failed')
      return reply.status(500).send({ error: 'Gagal menambahkan tugas pemindaian' })
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
      // A forged or stale approval_request_id (403) or a malformed payload (400) is a client error, not a server fault.
      const clientError = clientErrorReply(error)
      if (clientError) return reply.status(clientError.statusCode).send(clientError.body)
      request.log.error({ err: String(error?.message ?? error).slice(0, 200) }, 'queue: apply failed')
      return reply.status(500).send({ error: 'Gagal menambahkan tugas lamaran' })
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
      request.log.error({ err: String(error?.message ?? error).slice(0, 200) }, 'queue: analyze failed')
      return reply.status(500).send({ error: 'Gagal menambahkan tugas analisis' })
    }
  })
}
