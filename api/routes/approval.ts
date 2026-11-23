import { FastifyInstance, FastifyPluginOptions, FastifyReply, FastifyRequest } from 'fastify'
import { queueService } from '../../services/queue.service.js'
import { coverLetterFromApplication, prepareApprovalAnswers, sanitizeClientAnswers } from '../../services/approval-answers.service.js'
import { aiPipelineService } from '../../services/ai-pipeline.service.js'
import { AiAccessError, aiGuardService, type AiGuardService } from '../../services/ai-guard.service.js'
import { regenerateApprovalCoverLetter } from '../../services/approval-regenerate.service.js'
import { resumeUrlForUser } from '../../services/resume-file.service.js'
import { rerunApproval } from '../../services/rerun-guard.js'
import { markApprovalSent } from '../../services/manual-submit-guard.js'
import { notifyApplicationStatus } from '../../services/application-status.service.js'
import { notificationsService } from '../../services/notifications.service.js'
import { afterReplyFor, runAfterReplyTasks } from '../../services/after-reply.js'
import { isUuid } from '../../services/uuid.js'
import { ClaimRecoveryError, getClaimStatuses, resolveLockedClaim, type ClaimResolution } from '../../services/approval-claim-recovery.js'

/** Masa berlaku permintaan persetujuan sejak dibuat: 24 jam. */
export const APPROVAL_TTL_MS = 24 * 60 * 60 * 1000

interface ApprovalRequest {
  id: string
  user_id: string
  application_id?: string
  job_id: string
  job_title: string
  company: string
  platform: string
  cover_letter?: string
  answers?: Array<{
    question: string
    answer: string
    confidence: number
    needs_review: boolean
  }>
  resume_url?: string
  status: 'pending' | 'approved' | 'rejected' | 'expired'
  expires_at: string
  created_at: string
  reviewed_at?: string
  rejection_reason?: string
}

/**
 * Jawaban 500 untuk semua rute persetujuan: teks galat database tidak pernah sampai ke klien (bisa memuat nama
 * kolom, tabel, atau nilai). Detailnya hanya masuk log server.
 */
function failServer(request: FastifyRequest, reply: FastifyReply, err: unknown, code = 'internal_error') {
  request.log.error({ err: String((err as any)?.message ?? err), dbCode: (err as any)?.code, route: request.routeOptions?.url }, 'approval route failed')
  return reply.status(500).send({ error: 'Terjadi kesalahan pada server', code })
}

export interface ApprovalRoutesOptions extends FastifyPluginOptions {
  db?: any
  guard?: Pick<AiGuardService, 'checkActionRateLimit'>
}

export async function approvalRoutes(
  app: FastifyInstance,
  opts: ApprovalRoutesOptions = {}
) {
  // Dimuat di dalam handler agar import file ini di tes offline tidak memicu api/index.ts.
  const getDb = async (): Promise<any> => opts.db ?? (await import('../index.js')).supabase
  const guard = opts.guard ?? aiGuardService

  // Semua rute `/:id/*` menerima id persetujuan. Id yang bukan UUID ditolak 400 sebelum menyentuh Postgres (kolom
  // bertipe uuid melempar galat sintaks, yang dulu menjadi 500 berisi teks galat database). Pengguna tanpa login
  // dibiarkan lewat ke handler supaya tetap dijawab 401.
  app.addHook('preHandler', async (request, reply) => {
    const params = request.params as Record<string, unknown> | undefined
    if (params && 'id' in params && (request as any).user?.id && !isUuid(params.id)) {
      return reply.status(400).send({ error: 'ID persetujuan tidak valid', code: 'invalid_id' })
    }
    return undefined
  })

  // Get pending approvals for user
  app.get('/pending', async (request, reply) => {
    const userId = (request as any).user?.id
    if (!userId) {
      return reply.status(401).send({ error: 'Unauthorized' })
    }

    const db = await getDb()
    const { data, error } = await db
      .from('approval_requests')
      .select('*')
      .eq('user_id', userId)
      .eq('status', 'pending')
      .gt('expires_at', new Date().toISOString())
      .order('created_at', { ascending: false })

    if (error) {
      return failServer(request, reply, error)
    }

    return data || []
  })

  // Get single approval request
  app.get('/:id', async (request, reply) => {
    const userId = (request as any).user?.id
    if (!userId) {
      return reply.status(401).send({ error: 'Unauthorized' })
    }

    const { id } = request.params as { id: string }

    const db = await getDb()
    const { data, error } = await db
      .from('approval_requests')
      .select('*')
      .eq('id', id)
      .eq('user_id', userId)
      .single()

    if (error) {
      return reply.status(404).send({ error: 'Approval request not found' })
    }

    return data
  })

  // Create approval request (called by automation service)
  app.post('/', async (request, reply) => {
    const userId = (request as any).user?.id
    if (!userId) {
      return reply.status(401).send({ error: 'Unauthorized' })
    }

    const {
      job_id,
      application_id,
      job_title,
      company,
      platform,
      answers,
    } = request.body as any
    const supabase = await getDb()
    // resume_url kiriman klien diabaikan. CV diambil dari profil pengguna (bucket privat `resumes`).
    const resume_url = await resumeUrlForUser(supabase as any, userId)
    let cover_letter = (request.body as any).cover_letter as string | undefined

    // Surat tidak dikirim tetapi draf AI ada: pakai surat dari ai_applications milik pengguna ini.
    if (!(typeof cover_letter === 'string' && cover_letter.trim()) && application_id) {
      cover_letter = (await coverLetterFromApplication(supabase, userId, application_id)) ?? cover_letter
    }

    // Masa berlaku persetujuan: 24 jam (APPROVAL_TTL_MS). Satu jam terlalu pendek: pengguna sering baru membuka
    // halaman Persetujuan sesudahnya (uji Binance 23 November 2026, persetujuan kedaluwarsa sebelum diklik).
    const expiresAt = new Date(Date.now() + APPROVAL_TTL_MS).toISOString()

    // Jawaban formulir beserta skor keyakinan datang dari jalur pengisian yang nyata (FormAutofillService),
    // dihitung di server dari Pengaturan Otomasi pengguna. `answers` kiriman klien hanya dipakai bila ada
    // dan bentuknya benar; kalau tidak, server menyiapkannya sendiri (melewati batas laju AI).
    const clientAnswers = sanitizeClientAnswers(answers)
    let preparedAnswers = clientAnswers
    if (clientAnswers.length === 0) {
      try {
        await guard.checkActionRateLimit(userId, 'ai_approval_prepare', '/api/approvals')
      } catch (err: any) {
        if (err instanceof AiAccessError) {
          if (err.extra.retryAfterSec) reply.header('Retry-After', String(err.extra.retryAfterSec))
          return reply.status(err.statusCode).send({ error: err.message, code: err.code })
        }
        return reply.status(503).send({ error: 'Batas laju AI gagal diperiksa' })
      }
      preparedAnswers = await prepareApprovalAnswers(supabase, {
        userId,
        email: (request as any).user?.email,
        jobId: job_id,
        jobTitle: job_title,
        company,
      })
    }

    const { data, error } = await supabase
      .from('approval_requests')
      .insert({
        user_id: userId,
        job_id,
        application_id: application_id ?? null,
        job_title,
        company,
        platform,
        cover_letter,
        answers: preparedAnswers,
        resume_url,
        status: 'pending',
        expires_at: expiresAt,
      })
      .select()

    if (error) {
      return failServer(request, reply, error)
    }

    // TODO: Send Telegram notification if user has Telegram linked
    // await sendTelegramApprovalNotification(userId, data[0])

    return data?.[0]
  })

  // Approve application
  app.post('/:id/approve', async (request, reply) => {
    const userId = (request as any).user?.id
    if (!userId) {
      return reply.status(401).send({ error: 'Unauthorized' })
    }

    const { id } = request.params as { id: string }
    const db = await getDb()

    // Check if approval request exists and is still pending
    const { data: requestData, error: fetchError } = await db
      .from('approval_requests')
      .select('*')
      .eq('id', id)
      .eq('user_id', userId)
      .eq('status', 'pending')
      .single()

    if (fetchError || !requestData) {
      return reply.status(404).send({ error: 'Approval request not found or already processed' })
    }

    // Check if expired
    if (new Date(requestData.expires_at) < new Date()) {
      await db
        .from('approval_requests')
        .update({ status: 'expired' })
        .eq('id', id)

      return reply.status(410).send({ error: 'Approval request has expired' })
    }

    // Worker `apply` membutuhkan job_id (baris jobs dengan external_url) untuk membuka formulir.
    if (!requestData.job_id) {
      return reply.status(422).send({ error: 'Approval request has no job_id; cannot queue submission' })
    }

    // Cover letter hasil edit pengguna di layar review = versi yang disetujui.
    const body = (request.body ?? {}) as { cover_letter?: unknown }
    const editedCoverLetter =
      typeof body.cover_letter === 'string' && body.cover_letter.trim() ? body.cover_letter : undefined

    // Update status to approved. Guarded on status 'pending' so a double click (or two tabs) approves,
    // and queues, exactly once.
    const { data: updated, error } = await db
      .from('approval_requests')
      .update({
        status: 'approved',
        reviewed_at: new Date().toISOString(),
        ...(editedCoverLetter ? { cover_letter: editedCoverLetter } : {}),
      })
      .eq('id', id)
      .eq('user_id', userId)
      .eq('status', 'pending')
      .select('id')

    if (error) {
      return failServer(request, reply, error)
    }
    if (!updated || updated.length === 0) {
      return reply.status(409).send({ error: 'Approval request was already processed' })
    }

    if (editedCoverLetter && requestData.application_id) {
      await db
        .from('ai_applications')
        .update({ cover_letter: editedCoverLetter })
        .eq('id', requestData.application_id)
        .eq('user_id', userId)
    }

    // Persetujuan pengguna = izin kirim untuk lamaran ini (HITL). Worker tetap memerlukan
    // ALLOW_REAL_SUBMIT=true sebelum benar-benar menekan tombol kirim.
    try {
      // addApprovedApplyJob re-reads the row: `approved: true` is written by the server, from the database.
      const queued = await queueService.addApprovedApplyJob(userId, id)
      return { success: true, message: 'Application approved and queued for submission', queue_job_id: queued.id }
    } catch (err: any) {
      // Jangan biarkan status "approved" tanpa pekerjaan di antrean.
      await db
        .from('approval_requests')
        .update({ status: 'pending', reviewed_at: null })
        .eq('id', id)
      request.log.error({ err: String(err?.message ?? err) }, 'approval queueing failed, approval reverted to pending')
      return reply.status(500).send({ error: 'Failed to queue submission (approval reverted to pending)', code: 'queue_failed' })
    }
  })

  // Run an approved application again, e.g. after the user answered the questions the worker could not.
  // Queues the same approved apply job; the worker only sends if no earlier run of this approval was sent.
  // Same protection as /approve: the auth preHandler of the /api scope plus the user_id filter on every read.
  // On top of that, rerun-guard.ts refuses a rerun while a job is active and caps the runs per approval.
  app.post('/:id/rerun', async (request, reply) => {
    const userId = (request as any).user?.id
    if (!userId) {
      return reply.status(401).send({ error: 'Unauthorized' })
    }

    const { id } = request.params as { id: string }
    const result = await rerunApproval(await getDb(), queueService, userId, id)
    return reply.status(result.status).send(result.body)
  })

  // The user sent the application themselves on the job site (the agent stopped before Submit, for example
  // because the site is not on the auto-send allowlist). Records a 'success' log row marked manual, which also
  // uses the approval up for the worker, and moves the application to 'submitted'. Nothing is sent anywhere.
  // Expiry is not checked: consent for the agent no longer matters. Rules: manual-submit-guard.ts.
  app.post('/:id/mark-sent', { onResponse: runAfterReplyTasks }, async (request, reply) => {
    const userId = (request as any).user?.id
    if (!userId) {
      return reply.status(401).send({ error: 'Unauthorized' })
    }

    const { id } = request.params as { id: string }
    const supabase = await getDb()
    // Notifikasi jalan sesudah balasan terkirim (hook onResponse), tidak menahan jawaban ke pengguna.
    const afterReply = afterReplyFor(request)
    const result = await markApprovalSent(supabase as any, userId, id, new Date(), async (applicationId) => {
      afterReply(() => notifyApplicationStatus(supabase as any, notificationsService, { userId, applicationId }))
    })
    return reply.status(result.status).send(result.body)
  })

  // Reject application
  app.post('/:id/reject', async (request, reply) => {
    const userId = (request as any).user?.id
    if (!userId) {
      return reply.status(401).send({ error: 'Unauthorized' })
    }

    const { id } = request.params as { id: string }
    const { reason } = request.body as { reason?: string }
    const db = await getDb()

    const { data: requestData, error: fetchError } = await db
      .from('approval_requests')
      .select('*')
      .eq('id', id)
      .eq('user_id', userId)
      .eq('status', 'pending')
      .single()

    if (fetchError || !requestData) {
      return reply.status(404).send({ error: 'Approval request not found or already processed' })
    }

    const { data, error } = await db
      .from('approval_requests')
      .update({
        status: 'rejected',
        reviewed_at: new Date().toISOString(),
        rejection_reason: reason || 'No reason provided',
      })
      .eq('id', id)
      .select()

    if (error) {
      return failServer(request, reply, error)
    }

    // Log rejection for preference learning
    await db.from('application_logs').insert({
      user_id: userId,
      action: 'reject',
      platform: requestData.platform,
      job_id: requestData.job_id,
      job_title: requestData.job_title,
      company: requestData.company,
      status: 'rejected',
      details: { reason: reason || 'No reason provided' },
    })

    return { success: true, message: 'Application rejected' }
  })

  // Regenerate the cover letter of a pending approval request through the AI pipeline.
  // Nothing is sent; the user still has to approve the version on screen.
  app.post('/:id/regenerate', async (request, reply) => {
    const userId = (request as any).user?.id
    if (!userId) {
      return reply.status(401).send({ error: 'Unauthorized' })
    }

    const { id } = request.params as { id: string }
    const { instructions } = (request.body ?? {}) as { instructions?: unknown }

    try {
      await guard.checkActionRateLimit(userId, 'ai_regenerate', '/api/approvals/:id/regenerate')
      const { coverLetter, model, warnings } = await regenerateApprovalCoverLetter(await getDb(), aiPipelineService, {
        userId,
        approvalId: id,
        instructions,
      })
      // warnings: numbers added by the rewrite that the original letter did not have (shown on the approval screen).
      return { success: true, cover_letter: coverLetter, model, warnings }
    } catch (error: any) {
      if (error instanceof AiAccessError) {
        if (error.extra.retryAfterSec) reply.header('Retry-After', String(error.extra.retryAfterSec))
        return reply.status(error.statusCode).send({ error: error.message, code: error.code })
      }
      // 404 unknown request, 410 expired, 502 AI gave nothing: the messages of these errors are fixed texts.
      // Anything else is a server fault and gets a generic answer (details only in the server log).
      const status = typeof error?.statusCode === 'number' ? error.statusCode : 500
      if (status >= 500 && status !== 502) return failServer(request, reply, error, 'regenerate_failed')
      return reply.status(status).send({ error: error?.message ?? 'Regenerate failed' })
    }
  })

  // Status klaim pengiriman untuk daftar persetujuan (menampilkan status "terkunci" bila worker/ekstensi crash sesudah klaim).
  app.post('/claim-statuses', async (request, reply) => {
    const userId = (request as any).user?.id
    if (!userId) return reply.status(401).send({ error: 'Unauthorized' })
    const rawIds = (request.body as any)?.approval_ids
    try {
      const claims = await getClaimStatuses(await getDb(), userId, rawIds)
      return { claims }
    } catch (error: any) {
      if (error instanceof ClaimRecoveryError) {
        return reply.status(error.statusCode).send({ error: error.message, code: error.code })
      }
      return failServer(request, reply, error, 'claims_lookup_failed')
    }
  })

  // Pemulihan aman untuk klaim macet tanpa menghapus klaim lama (mark_sent atau create_fresh_approval).
  app.post('/:id/resolve-claim', async (request, reply) => {
    const userId = (request as any).user?.id
    if (!userId) return reply.status(401).send({ error: 'Unauthorized' })
    const { id } = request.params as { id: string }
    const resolution = (request.body as any)?.resolution as ClaimResolution
    try {
      return await resolveLockedClaim(await getDb(), userId, id, resolution)
    } catch (error: any) {
      if (error instanceof ClaimRecoveryError) {
        return reply.status(error.statusCode).send({ error: error.message, code: error.code })
      }
      return failServer(request, reply, error, 'claim_resolve_failed')
    }
  })

  // Get approval history
  app.get('/history', async (request, reply) => {
    const userId = (request as any).user?.id
    if (!userId) {
      return reply.status(401).send({ error: 'Unauthorized' })
    }

    const { limit = 50, offset = 0 } = request.query as any

    const db = await getDb()
    const { data, error } = await db
      .from('approval_requests')
      .select('*')
      .eq('user_id', userId)
      .neq('status', 'pending')
      .order('reviewed_at', { ascending: false })
      .range(Number(offset), Number(offset) + Number(limit) - 1)

    if (error) {
      return failServer(request, reply, error)
    }

    return data || []
  })
}
