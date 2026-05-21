import { FastifyInstance, FastifyPluginOptions } from 'fastify'
import { supabase } from '../index.js'
import { automationService } from '../../services/automation.service.js'

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

  // Search jobs across platforms
  app.post('/search', async (request, reply) => {
    const userId = (request as any).user?.id
    if (!userId) {
      return reply.status(401).send({ error: 'Unauthorized' })
    }

    const { keywords, location, platforms } = request.body as any

    const results = await automationService.searchJobs({
      userId,
      keywords,
      location,
      platforms,
    })

    return { results, total_jobs: results.reduce((sum: number, r: any) => sum + r.jobs.length, 0) }
  })

  // Add job to queue
  app.post('/queue', async (request, reply) => {
    const userId = (request as any).user?.id
    if (!userId) {
      return reply.status(401).send({ error: 'Unauthorized' })
    }

    const { job_type, payload, priority = 0 } = request.body as any

    const { data, error } = await supabase
      .from('automation_queue')
      .insert({
        user_id: userId,
        job_type,
        payload,
        priority,
        status: 'pending',
      })
      .select()

    if (error) {
      return reply.status(500).send({ error: error.message })
    }

    return data?.[0]
  })
}
