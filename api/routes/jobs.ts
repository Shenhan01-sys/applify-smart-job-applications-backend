import { FastifyInstance, FastifyPluginOptions } from 'fastify'
import type { SupabaseClient } from '@supabase/supabase-js'
import { enrichJob } from '../../services/job-detail.service.js'
import { resolveApplyChannel } from '../../services/apply-channel.js'
import { salaryBenchmark } from '../../services/salary-benchmark.service.js'
import { backfillState, isBackfillAdmin, runBackfill, selectBackfillTargets } from '../../services/job-backfill.service.js'
import {
  MAX_OFF_PORTAL_QR_URLS,
  MAX_OFF_PORTAL_TEXT_CHARS,
  parseOffPortalPosting,
  type OffPortalSourceType,
} from '../../services/off-portal-ingest.service.js'

/** Batas POST /:id/enrich per pengguna: tiap permintaan bisa memicu satu fetch ke situs lowongan. */
export const ENRICH_LIMIT_PER_MINUTE = 30
export const ENRICH_WINDOW_MS = 60_000

export interface JobRouteOptions extends FastifyPluginOptions {
  /** Hanya tes yang mengisinya. Produksi memakai klien service-role dari api/index.ts (dimuat saat dipakai). */
  db?: SupabaseClient
  /** Hanya tes yang mengisinya (tanpa jaringan). */
  fetchImpl?: typeof fetch
  /** Jam tiruan untuk tes (ms). */
  now?: () => number
}

/** id lowongan: huruf, angka, '-' dan '_' saja. Selain itu pasti bukan lowongan (404), tanpa menyentuh DB. */
const validId = (id: unknown): id is string => typeof id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(id)

export async function jobRoutes(app: FastifyInstance, opts: JobRouteOptions) {
  const now = opts.now ?? Date.now
  // Dimuat di dalam handler, bukan di atas, supaya meng-import file ini (di tes) tidak menyalakan server.
  const getDb = async (): Promise<SupabaseClient> => opts.db ?? ((await import('../index.js')).supabase as SupabaseClient)

  // Jendela geser per pengguna, di memori (satu proses). Cukup untuk menahan klik beruntun atau skrip.
  const hits = new Map<string, number[]>()
  const retryAfterSeconds = (userId: string): number => {
    const t = now()
    const recent = (hits.get(userId) ?? []).filter((x) => t - x < ENRICH_WINDOW_MS)
    if (recent.length >= ENRICH_LIMIT_PER_MINUTE) {
      hits.set(userId, recent)
      return Math.max(1, Math.ceil((ENRICH_WINDOW_MS - (t - recent[0])) / 1000))
    }
    recent.push(t)
    hits.set(userId, recent)
    return 0
  }

  // Lengkapi lowongan dari halaman aslinya (deskripsi, syarat, gaji). Hanya JobStreet dan Dealls.
  // 200 { job, enriched, reason }: `enriched` false bukan galat (mis. sudah lengkap, situs tidak didukung).
  app.post('/:id/enrich', async (request, reply) => {
    const userId = (request as any).user?.id
    if (!userId) return reply.status(401).send({ error: 'Unauthorized' })
    const { id } = request.params as { id: string }
    if (!validId(id)) return reply.status(404).send({ error: 'Job not found' })

    const wait = retryAfterSeconds(userId)
    if (wait > 0) {
      return reply.status(429).header('Retry-After', String(wait)).send({ error: 'Too many requests', retry_after_seconds: wait })
    }

    try {
      const result = await enrichJob(await getDb(), id, { fetchImpl: opts.fetchImpl })
      if (result.status === 'not_found') return reply.status(404).send({ error: 'Job not found' })
      if (result.status === 'error') return reply.status(500).send({ error: result.reason })
      return { job: result.job, enriched: result.enriched, reason: result.reason }
    } catch (error: any) {
      return reply.status(500).send({ error: error?.message ?? 'Failed to enrich job' })
    }
  })

  // Backfill detail lowongan lama. Hanya id di env BACKFILL_ADMIN_IDS (403 untuk pengguna lain). Berjalan di latar,
  // satu per satu dengan jeda; 202 { started, total }, 409 bila backfill lain masih berjalan.
  app.post('/backfill', async (request, reply) => {
    const userId = (request as any).user?.id
    if (!userId) return reply.status(401).send({ error: 'Unauthorized' })
    if (!isBackfillAdmin(userId)) return reply.status(403).send({ error: 'Forbidden' })
    if (backfillState().running) return reply.status(409).send({ error: 'Backfill sedang berjalan', state: backfillState() })
    const limit = Number((request.body as any)?.limit ?? 500)
    try {
      const db = await getDb()
      const ids = await selectBackfillTargets(db, Number.isFinite(limit) ? limit : 500)
      void runBackfill(db, ids, { startedBy: userId }).catch((e) => request.log.error(e, '[backfill] berhenti'))
      return reply.status(202).send({ started: true, total: ids.length })
    } catch (error: any) {
      return reply.status(500).send({ error: error?.message ?? 'Failed to start backfill' })
    }
  })

  app.get('/backfill/status', async (request, reply) => {
    const userId = (request as any).user?.id
    if (!userId) return reply.status(401).send({ error: 'Unauthorized' })
    if (!isBackfillAdmin(userId)) return reply.status(403).send({ error: 'Forbidden' })
    return backfillState()
  })

  // Pembanding gaji: persentil gaji (IDR per bulan) lowongan aktif lain dengan judul mirip.
  app.get('/:id/salary-benchmark', async (request, reply) => {
    const userId = (request as any).user?.id
    if (!userId) return reply.status(401).send({ error: 'Unauthorized' })
    const { id } = request.params as { id: string }
    if (!validId(id)) return reply.status(404).send({ error: 'Job not found' })

    try {
      const result = await salaryBenchmark(await getDb(), id)
      if (!result) return reply.status(404).send({ error: 'Job not found' })
      return result
    } catch (error: any) {
      return reply.status(500).send({ error: error?.message ?? 'Failed to compute salary benchmark' })
    }
  })

  // Pratinjau parsing lowongan off-portal (link/caption/poster/QR) secara stateless (tanpa menulis ke DB).
  app.post('/off-portal/parse', async (request, reply) => {
    const userId = (request as any).user?.id
    if (!userId) return reply.status(401).send({ error: 'Unauthorized' })

    const wait = retryAfterSeconds(userId)
    if (wait > 0) {
      return reply.status(429).header('Retry-After', String(wait)).send({ error: 'Too many requests', retry_after_seconds: wait })
    }

    const body = (request.body ?? {}) as Record<string, unknown>
    const rawText = typeof body.rawText === 'string' ? body.rawText : ''
    const sourceUrl = typeof body.sourceUrl === 'string' ? body.sourceUrl : undefined
    const qrUrls = Array.isArray(body.qrUrls)
      ? body.qrUrls.filter((u): u is string => typeof u === 'string').slice(0, MAX_OFF_PORTAL_QR_URLS)
      : undefined
    if (!rawText.trim() && !sourceUrl?.trim() && (!qrUrls || qrUrls.length === 0)) {
      return reply.status(400).send({ error: 'Isi rawText, sourceUrl, atau qrUrls terlebih dahulu.', code: 'empty_off_portal_input' })
    }
    if (rawText.length > MAX_OFF_PORTAL_TEXT_CHARS) {
      return reply.status(400).send({ error: `rawText maksimal ${MAX_OFF_PORTAL_TEXT_CHARS} karakter.`, code: 'off_portal_text_too_long' })
    }
    const sourceType: OffPortalSourceType =
      body.sourceType === 'off_portal_poster' || body.sourceType === 'off_portal_caption'
        ? body.sourceType
        : 'off_portal_link'

    return parseOffPortalPosting(
      {
        rawText,
        sourceUrl,
        sourceType,
        qrUrls,
        companyHint: typeof body.companyHint === 'string' ? body.companyHint : undefined,
        locationHint: typeof body.locationHint === 'string' ? body.locationHint : undefined,
      },
      new Date(now()),
    )
  })

  // Klasifikasi kanal lamaran (public_ats | email_direct | auth_portal | external_web) beserta aturan LinkedIn manual.
  app.get('/:id/channel', async (request, reply) => {
    const userId = (request as any).user?.id
    if (!userId) return reply.status(401).send({ error: 'Unauthorized' })
    const { id } = request.params as { id: string }
    if (!validId(id)) return reply.status(404).send({ error: 'Job not found' })

    try {
      const channel = await resolveApplyChannel(await getDb(), id)
      if (!channel) return reply.status(404).send({ error: 'Job not found' })
      return channel
    } catch (error: any) {
      return reply.status(500).send({ error: error?.message ?? 'Failed to classify job channel' })
    }
  })
}
