import { FastifyInstance, FastifyPluginOptions } from 'fastify'
import { automationService } from '../../services/automation.service.js'
import { queueService } from '../../services/queue.service.js'
import { clientErrorReply } from '../../services/queue-guard.js'
import {
  isMissingColumnError,
  OPTIONAL_SETTINGS_COLUMNS,
  sanitizeSettingsPatch,
} from '../../services/automation-settings.js'

export interface AutomationRoutesOptions extends FastifyPluginOptions {
  /** Hanya tes yang mengisinya. Produksi memakai klien service-role dari api/index.ts (dimuat saat dipakai). */
  db?: any
}

export async function automationRoutes(
  app: FastifyInstance,
  opts: AutomationRoutesOptions = {}
) {
  // Dimuat di dalam handler agar meng-import file ini di tes tidak menyalakan server.
  const getDb = async (): Promise<any> => opts.db ?? (await import('../index.js')).supabase

  // Get user's automation settings
  app.get('/settings', async (request, reply) => {
    const userId = (request as any).user?.id
    if (!userId) {
      return reply.status(401).send({ error: 'Unauthorized' })
    }

    const supabase = await getDb()
    const { data, error } = await supabase
      .from('user_automation_settings')
      .select('*')
      .eq('user_id', userId)
      .maybeSingle()

    if (error && error.code !== 'PGRST116') {
      request.log.error({ dbCode: error.code, err: String(error.message ?? '') }, 'automation settings read failed')
      return reply.status(500).send({ error: 'Pengaturan belum bisa dimuat. Coba lagi.', code: 'settings_load_failed' })
    }

    // Sebelum migrasi DRAFT_2026-11-24b kolom `extension_auto_use` belum ada: dianggap mati.
    return data ? { extension_auto_use: false, ...data } : {}
  })

  // Update automation settings.
  // Hanya kolom yang boleh diedit pengguna yang ditulis (daftar putih di automation-settings.ts): badan permintaan
  // tidak pernah disebar ke insert/update, karena penulisan memakai kunci service-role.
  app.put('/settings', async (request, reply) => {
    const userId = (request as any).user?.id
    if (!userId) {
      return reply.status(401).send({ error: 'Unauthorized' })
    }

    const supabase = await getDb()
    const patch = sanitizeSettingsPatch(request.body)

    const { data: existing, error: lookupError } = await supabase
      .from('user_automation_settings')
      .select('id')
      .eq('user_id', userId)
      .maybeSingle()
    if (lookupError && lookupError.code !== 'PGRST116') {
      request.log.error({ dbCode: lookupError.code, err: String(lookupError.message ?? '') }, 'automation settings lookup failed')
      return reply.status(500).send({ error: 'Pengaturan belum bisa disimpan. Coba lagi.', code: 'settings_save_failed' })
    }

    const write = (values: Record<string, unknown>) =>
      existing
        ? supabase
            .from('user_automation_settings')
            .update({ ...values, updated_at: new Date().toISOString() })
            .eq('user_id', userId)
            .select()
        : supabase
            .from('user_automation_settings')
            .insert({ ...values, user_id: userId })
            .select()

    let result = await write(patch)
    // Kolom opsional (extension_auto_use) belum ada sebelum migrasi dijalankan: ulangi tanpa kolom itu.
    if (result.error && isMissingColumnError(result.error)) {
      const withoutOptional = { ...patch }
      let dropped = false
      for (const col of OPTIONAL_SETTINGS_COLUMNS) {
        if (col in withoutOptional) {
          delete withoutOptional[col]
          dropped = true
        }
      }
      if (dropped) result = await write(withoutOptional)
    }

    if (result.error) {
      request.log.error({ dbCode: result.error.code, err: String(result.error.message ?? '') }, 'automation settings save failed')
      return reply.status(500).send({ error: 'Pengaturan belum bisa disimpan. Coba lagi.', code: 'settings_save_failed' })
    }

    const row = result.data?.[0]
    return row ? { extension_auto_use: false, ...row } : {}
  })

  // Get application logs
  app.get('/logs', async (request, reply) => {
    const userId = (request as any).user?.id
    if (!userId) {
      return reply.status(401).send({ error: 'Unauthorized' })
    }

    const { limit = 50, offset = 0, action, status } = request.query as any

    const supabase = await getDb()
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
      request.log.error({ dbCode: error.code, err: String(error.message ?? '') }, 'application logs read failed')
      return reply.status(500).send({ error: 'Log belum bisa dimuat. Coba lagi.', code: 'logs_load_failed' })
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

    const supabase = await getDb()
    let query = supabase
      .from('automation_queue')
      .select('*')
      .eq('user_id', userId)
      .order('scheduled_at', { ascending: true })

    if (status) query = query.eq('status', status)

    const { data, error } = await query

    if (error) {
      request.log.error({ dbCode: error.code, err: String(error.message ?? '') }, 'queue read failed')
      return reply.status(500).send({ error: 'Antrean belum bisa dimuat. Coba lagi.', code: 'queue_load_failed' })
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
    const pages = Number(body.pages)

    try {
      const result = await automationService.searchJobs({
        userId,
        keywords: typeof body.keywords === 'string' ? body.keywords : undefined,
        location: typeof body.location === 'string' ? body.location : undefined,
        platforms,
        companies: body.companies && typeof body.companies === 'object' ? body.companies : undefined,
        persist: body.persist !== false,
        limitPerSource: Number.isFinite(limit) && limit > 0 ? Math.min(limit, 100) : undefined,
        pages: Number.isFinite(pages) && pages > 0 ? Math.min(Math.floor(pages), 5) : undefined,
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
      request.log.error({ err: String(error?.message ?? error) }, 'queue add failed')
      return reply.status(500).send({ error: 'Pekerjaan belum bisa dimasukkan ke antrean. Coba lagi.', code: 'queue_add_failed' })
    }
  })
}
