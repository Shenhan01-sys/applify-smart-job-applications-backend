import { FastifyInstance, FastifyPluginOptions } from 'fastify'
import { supabase } from '../index.js'
import { automationService } from '../../services/automation.service.js'
import { queueService } from '../../services/queue.service.js'
import { clientErrorReply } from '../../services/queue-guard.js'

export async function automationRoutes(
  app: FastifyInstance,
  _opts: FastifyPluginOptions
) {
  // Get user's automation settings
  app.get('/settings', async (request, reply) => {
    const userId = (request as any).user?.id
    if (!userId) {
      return reply.status(401).send({ error: 'Unauthorized' })
    }

    const { data, error } = await supabase
      .from('user_automation_settings')
      .select('*')
      .eq('user_id', userId)
      .single()

    if (error && error.code !== 'PGRST116') {
      return reply.status(500).send({ error: error.message })
    }

    return data || {}
  })

  // Update automation settings
  app.put('/settings', async (request, reply) => {
    const userId = (request as any).user?.id
    if (!userId) {
      return reply.status(401).send({ error: 'Unauthorized' })
    }

    const body = request.body as Record<string, any>

    const { data: existing } = await supabase
      .from('user_automation_settings')
      .select('id')
      .eq('user_id', userId)
      .single()

    let result
    if (existing) {
      result = await supabase
        .from('user_automation_settings')
        .update({ ...body, updated_at: new Date().toISOString() })
        .eq('user_id', userId)
        .select()
    } else {
      result = await supabase
        .from('user_automation_settings')
        .insert({ user_id: userId, ...body })
        .select()
    }

    if (result.error) {
      return reply.status(500).send({ error: result.error.message })
    }

    return result.data?.[0]
  })

  // Get application logs
  app.get('/logs', async (request, reply) => {
    const userId = (request as any).user?.id
    if (!userId) {
      return reply.status(401).send({ error: 'Unauthorized' })
    }

    const { limit = 50, offset = 0, action, status } = request.query as any

    let query = supabase
      .from('application_logs')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .range(Number(offset), Number(offset) + Number(limit) - 1)

    if (action) query = query.eq('action', action)
    if (status) query = query.eq('status', status)

    const { data, error } = await query

    if (error) {
      return reply.status(500).send({ error: error.message })
    }

    return data
  })

  // Get queue status
  app.get('/queue', async (request, reply) => {
    const userId = (request as any).user?.id
    if (!userId) {
      return reply.status(401).send({ error: 'Unauthorized' })
    }

    const { status } = request.query as any

    let query = supabase
      .from('automation_queue')
      .select('*')
      .eq('user_id', userId)
      .order('scheduled_at', { ascending: true })

    if (status) query = query.eq('status', status)

    const { data, error } = await query

    if (error) {
      return reply.status(500).send({ error: error.message })
    }

    return data
  })

  // Cari & agregasi lowongan lintas sumber (klien MCP) -> ranking relevansi -> simpan ke tabel jobs.
  // Body: { keywords?, location? ('Indonesia' default, 'any' = tanpa filter), platforms?: string[],
  //         companies?: { [platform]: string[] }, persist?: boolean (default true), limit?: number }
  app.post('/search', async (request, reply) => {
    const userId = (request as any).user?.id
    if (!userId) {
      return reply.status(401).send({ error: 'Unauthorized' })
    }

    const body = (request.body ?? {}) as any
    const platforms = Array.isArray(body.platforms)
      ? body.platforms.map((p: any) => String(p).toLowerCase())
      : undefined
    const limit = Number(body.limit)

    try {
      const result = await automationService.searchJobs({
        userId,
        keywords: typeof body.keywords === 'string' ? body.keywords : undefined,
        location: typeof body.location === 'string' ? body.location : undefined,
        platforms,
        companies: body.companies && typeof body.companies === 'object' ? body.companies : undefined,
        persist: body.persist !== false,
        limitPerSource: Number.isFinite(limit) && limit > 0 ? Math.min(limit, 100) : undefined,
      })

      // Bentuk lama ({ results: [{platform, jobs}], total_jobs }) tetap disertakan demi kompatibilitas.
      const results = result.stats.map((s) => ({
        platform: s.platform,
        jobs: result.jobs.filter((j) => j.platform === s.platform),
        errors: s.errors,
      }))

      return {
        jobs: result.jobs,
        total: result.total,
        results,
        total_jobs: result.total,
        stats: result.stats,
        ingest: result.ingest,
        query: result.query,
        durationMs: result.durationMs,
      }
    } catch (err: any) {
      request.log.error(err)
      return reply.status(500).send({ error: err?.message ?? 'Search failed' })
    }
  })

  // Add job to queue
  app.post('/queue', async (request, reply) => {
    const userId = (request as any).user?.id
    if (!userId) {
      return reply.status(401).send({ error: 'Unauthorized' })
    }

    const { job_type, payload, priority = 0 } = request.body as any

    // Same guard as /api/queue/apply: the client cannot set `approved`, email_apply needs a verified approval
    // row (403), and its apply_email must be one plain address (400, invalid_apply_email).
    try {
      return await queueService.addGenericJob(userId, job_type, payload, priority)
    } catch (error: any) {
      const clientError = clientErrorReply(error)
      if (clientError) return reply.status(clientError.statusCode).send(clientError.body)
      return reply.status(500).send({ error: error.message })
    }
  })
}
