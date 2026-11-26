import { FastifyInstance, FastifyPluginOptions, FastifyReply, FastifyRequest } from 'fastify'
import { QueueService, queueService } from '../../services/queue.service.js'
import { ApprovalChannelConflictError, PlatformLimitReachedError } from '../../services/queue-guard.js'
import { approvalDispatchTarget, resolveApplyChannel, type ApprovalDispatchTarget } from '../../services/apply-channel.js'
import { grantExtensionConsent, readExtensionAutoUse } from '../../services/extension-consent.js'
import { coverLetterFromApplication, prepareApprovalAnswers, sanitizeClientAnswers } from '../../services/approval-answers.service.js'
import { aiPipelineService } from '../../services/ai-pipeline.service.js'
import { AiAccessError, aiGuardService, type AiGuardService } from '../../services/ai-guard.service.js'
import { regenerateApprovalCoverLetter } from '../../services/approval-regenerate.service.js'
import { currentResumeUrlForApproval, resumeUrlForUser } from '../../services/resume-file.service.js'
import { rerunApproval } from '../../services/rerun-guard.js'
import { markApprovalSent } from '../../services/manual-submit-guard.js'
import { notifyApplicationStatus } from '../../services/application-status.service.js'
import { notificationsService } from '../../services/notifications.service.js'
import { afterReplyFor, runAfterReplyTasks } from '../../services/after-reply.js'
import { isUuid } from '../../services/uuid.js'
import { ClaimRecoveryError, getClaimStatuses, resolveLockedClaim, type ClaimResolution } from '../../services/approval-claim-recovery.js'
import { isJobAccessibleToUser, selectJobWithVisibility } from '../../services/private-job-access.js'

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
  queue?: QueueService
  guard?: Pick<AiGuardService, 'checkActionRateLimit'>
}

/** Baca baris pending terbaru untuk `(user_id, job_id)`. Secara default hanya mengembalikan yang belum kedaluwarsa. */
async function findPendingApproval(
  db: any,
  userId: string,
  jobId: string,
  allowExpiredOnRace = false
): Promise<{ data: any | null; error: any | null }> {
  const approvalLookup = db.from('approval_requests')
  if (!approvalLookup || typeof approvalLookup.select !== 'function') {
    return { data: null, error: null }
  }
  const nowIso = new Date().toISOString()
  const pendingQuery = approvalLookup
    .select('*')
    .eq('user_id', userId)
    .eq('job_id', jobId)
    .eq('status', 'pending')
  const filteredQuery =
    !allowExpiredOnRace && typeof pendingQuery?.gt === 'function' ? pendingQuery.gt('expires_at', nowIso) : pendingQuery
  const orderedQuery =
    typeof filteredQuery?.order === 'function'
      ? filteredQuery.order('created_at', { ascending: false })
      : filteredQuery
  const limitedQuery = typeof orderedQuery?.limit === 'function' ? orderedQuery.limit(1) : orderedQuery
  const res = typeof limitedQuery?.maybeSingle === 'function' ? await limitedQuery.maybeSingle() : await limitedQuery
  if (res?.error) return { data: null, error: res.error }
  const row = Array.isArray(res?.data) ? res.data[0] : res?.data
  if (!row) return { data: null, error: null }
  if (!allowExpiredOnRace && row.expires_at && Date.parse(String(row.expires_at)) <= Date.now()) {
    return { data: null, error: null }
  }
  return { data: row, error: null }
}

function isUniqueViolationError(err: any): boolean {
  if (!err) return false
  const code = String(err.code ?? '')
  const msg = String(err.message ?? '').toLowerCase()
  return code === '23505' || msg.includes('duplicate key') || msg.includes('approval_requests_one_pending_per_job')
}

export async function approvalRoutes(
  app: FastifyInstance,
  opts: ApprovalRoutesOptions = {}
) {
  // Dimuat di dalam handler agar import file ini di tes offline tidak memicu api/index.ts.
  const getDb = async (): Promise<any> => opts.db ?? (await import('../index.js')).supabase
  const getQueue = (): QueueService => opts.queue ?? (opts.db ? new QueueService(opts.db as any) : queueService)
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

    if (!request.body || typeof request.body !== 'object') {
      return reply.status(400).send({ error: 'ID lowongan wajib diisi', code: 'job_id_required' })
    }
    const {
      job_id,
      application_id,
      job_title,
      company,
      platform,
      answers,
    } = request.body as any
    const cleanJobId = typeof job_id === 'string' ? job_id.trim() : ''
    if (!cleanJobId) {
      return reply.status(400).send({ error: 'ID lowongan wajib diisi', code: 'job_id_required' })
    }

    const supabase = await getDb()

    // Prioritas tinggi Gelombang 5: periksa kepemilikan lowongan privat lewat service role
    // (404 untuk lowongan privat milik pengguna lain; tetap aman sebelum kolom visibility & created_by ada).
    const { data: jobRow, error: jobErr } = await selectJobWithVisibility(supabase, cleanJobId, 'id')
    if (jobErr) {
      return failServer(request, reply, jobErr)
    }
    if (!jobRow || !isJobAccessibleToUser(jobRow, userId)) {
      return reply.status(404).send({ error: 'Job not found' })
    }

    // F-21: bila klien mengirim application_id, pastikan baris ai_applications itu memang milik pengguna ini.
    let ownedApplicationId: string | null = null
    if (typeof application_id === 'string' && application_id.trim()) {
      const candidateAppId = application_id.trim()
      if (!isUuid(candidateAppId)) {
        return reply.status(400).send({ error: 'ID lamaran tidak valid', code: 'invalid_application_id' })
      }
      const { data: appRow, error: appErr } = await supabase
        .from('ai_applications')
        .select('id')
        .eq('id', candidateAppId)
        .eq('user_id', userId)
        .maybeSingle()
      if (appErr) return failServer(request, reply, appErr)
      if (!appRow) return reply.status(404).send({ error: 'Application not found' })
      ownedApplicationId = appRow.id
    }

    // E2E-05: idempotensi persetujuan tertunda di server per (user_id, job_id) agar tab ganda tidak membuat dua antrean.
    const { data: existingRow, error: existingErr } = await findPendingApproval(supabase, userId, cleanJobId, false)
    if (existingErr) {
      return failServer(request, reply, existingErr)
    }
    if (existingRow) {
      return existingRow
    }

    // resume_url kiriman klien diabaikan. CV diambil dari profil pengguna (bucket privat `resumes`).
    const resume_url = await resumeUrlForUser(supabase as any, userId)
    let cover_letter = (request.body as any)?.cover_letter as string | undefined

    // Surat tidak dikirim tetapi draf AI ada: pakai surat dari ai_applications milik pengguna ini.
    if (!(typeof cover_letter === 'string' && cover_letter.trim()) && ownedApplicationId) {
      cover_letter = (await coverLetterFromApplication(supabase, userId, ownedApplicationId)) ?? cover_letter
    }

    // Masa berlaku persetujuan: 24 jam (APPROVAL_TTL_MS). Satu jam terlalu pendek: pengguna sering baru membuka
    // halaman Persetujuan sesudahnya (uji Binance 23 November 2026, persetujuan kedaluwarsa sebelum diklik).
    const expiresAt = new Date(Date.now() + APPROVAL_TTL_MS).toISOString()

    // E2E-05: batas laju selalu diperiksa di server meski klien mengirim `answers` siap pakai, dan jawaban dari klien
    // selalu ditandai `needs_review: true` dengan keyakinan maksimal 0.5 agar skor keyakinan tidak bisa dipalsukan.
    try {
      await guard.checkActionRateLimit(userId, 'ai_approval_prepare', '/api/approvals')
    } catch (err: any) {
      if (err instanceof AiAccessError) {
        if (err.extra.retryAfterSec) reply.header('Retry-After', String(err.extra.retryAfterSec))
        return reply.status(err.statusCode).send({ error: err.message, code: err.code })
      }
      return reply.status(503).send({ error: 'Batas laju AI gagal diperiksa' })
    }

    const clientAnswers = sanitizeClientAnswers(answers)
    const preparedAnswers =
      clientAnswers.length > 0
        ? clientAnswers.map((a) => ({
            ...a,
            confidence: Math.min(a.confidence, 0.5),
            needs_review: true,
            source: 'default' as const,
          }))
        : await prepareApprovalAnswers(supabase, {
            userId,
            email: (request as any).user?.email,
            jobId: cleanJobId,
            jobTitle: job_title,
            company,
          })

    const { data, error } = await supabase
      .from('approval_requests')
      .insert({
        user_id: userId,
        job_id: cleanJobId,
        application_id: ownedApplicationId,
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
      // Tutup race (indeks unik approval_requests_one_pending_per_job): tab/permintaan paralel yang kena 23505
      // membaca ulang baris pending pemenang dan mengembalikannya dengan 200, bukan 500.
      if (isUniqueViolationError(error)) {
        const { data: raceRow, error: raceErr } = await findPendingApproval(supabase, userId, cleanJobId, true)
        if (!raceErr && raceRow) {
          return reply.status(200).send(raceRow)
        }
      }
      return failServer(request, reply, error)
    }

    // TODO: Send Telegram notification if user has Telegram linked
    // await sendTelegramApprovalNotification(userId, data[0])

    return data?.[0]
  })

  // E2E-04: sinkronkan sunting / tulis ulang surat lamaran dari AIApplyModal ke persetujuan yang masih tertunda.
  app.patch('/:id/cover-letter', async (request, reply) => {
    const userId = (request as any).user?.id
    if (!userId) {
      return reply.status(401).send({ error: 'Unauthorized' })
    }

    const { id } = request.params as { id: string }
    const rawLetter = (request.body as any)?.cover_letter
    const nextCoverLetter = typeof rawLetter === 'string' ? rawLetter.trim() : ''
    if (!nextCoverLetter) {
      return reply.status(400).send({ error: 'Surat lamaran tidak boleh kosong', code: 'invalid_cover_letter' })
    }
    if (nextCoverLetter.length > 25_000) {
      return reply.status(400).send({ error: 'Surat lamaran terlalu panjang (maksimal 25.000 karakter)', code: 'cover_letter_too_long' })
    }

    const db = await getDb()
    const { data: existing, error: fetchError } = await db
      .from('approval_requests')
      .select('id, status, expires_at, application_id')
      .eq('id', id)
      .eq('user_id', userId)
      .maybeSingle()

    if (fetchError) {
      return failServer(request, reply, fetchError)
    }
    if (!existing) {
      return reply.status(404).send({ error: 'Approval request not found' })
    }
    if (existing.status !== 'pending') {
      return reply.status(409).send({ error: 'Approval request was already processed', code: 'already_processed' })
    }
    if (existing.expires_at && new Date(existing.expires_at) < new Date()) {
      return reply.status(410).send({ error: 'Approval request has expired', code: 'expired' })
    }

    const { data: updated, error: updateError } = await db
      .from('approval_requests')
      .update({ cover_letter: nextCoverLetter })
      .eq('id', id)
      .eq('user_id', userId)
      .eq('status', 'pending')
      .select('*')

    if (updateError) {
      return failServer(request, reply, updateError)
    }
    if (!updated || updated.length === 0) {
      return reply.status(409).send({ error: 'Approval request was already processed', code: 'already_processed' })
    }

    if (existing.application_id) {
      await db
        .from('ai_applications')
        .update({ cover_letter: nextCoverLetter })
        .eq('id', existing.application_id)
        .eq('user_id', userId)
    }

    return { success: true, approval: updated[0] }
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

    // Check if expired (F-20: kunci user_id + status='pending')
    if (new Date(requestData.expires_at) < new Date()) {
      await db
        .from('approval_requests')
        .update({ status: 'expired' })
        .eq('id', id)
        .eq('user_id', userId)
        .eq('status', 'pending')

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

    // Tentukan kanal eksekusi dari metadata lowongan (E2E-01):
    // - `manual` (LinkedIn / manualOnly) & `email_direct`: persetujuan dicatat, TIDAK mengantrekan worker/ekstensi.
    // - `extension`: hanya untuk host portal login / ATS yang didukung ekstensi (bukan `email_direct`).
    // - `worker`: ATS publik atau cadangan bila klasifikasi tidak tersedia.
    let dispatchTarget: ApprovalDispatchTarget = 'worker'
    try {
      const classified = await resolveApplyChannel(db, requestData.job_id, { userId })
      dispatchTarget = approvalDispatchTarget(classified)
    } catch {
      dispatchTarget = 'worker'
    }

    // Update status to approved. Guarded on status 'pending' so a double click (or two tabs) approves,
    // and queues, exactly once. Kolom apply_channel opsional sampai migrasi DRAFT diterapkan dan dibatasi
    // CHECK (apply_channel IN ('worker', 'extension')), jadi hanya ditulis untuk kedua nilai itu.
    // CV pada baris persetujuan dibekukan saat draf diajukan. Bila pengguna mengganti atau menghapus CV di Profil
    // sejak itu, URL lama sudah mati: segarkan dari CV profil saat ini supaya email, worker, dan ekstensi memakai CV yang sama.
    let resumePatch: { resume_url: string | null } | Record<string, never> = {}
    try {
      const cv = await currentResumeUrlForApproval(db as any, userId, requestData.resume_url)
      if (cv.changed) resumePatch = { resume_url: cv.url }
    } catch {
      resumePatch = {}
    }
    const baseApprovalPatch: Record<string, any> = {
      status: 'approved',
      reviewed_at: new Date().toISOString(),
      ...(editedCoverLetter ? { cover_letter: editedCoverLetter } : {}),
      ...resumePatch,
    }
    const channelPatch =
      dispatchTarget === 'worker' || dispatchTarget === 'extension'
        ? { ...baseApprovalPatch, apply_channel: dispatchTarget }
        : baseApprovalPatch
    let approveRes = await db
      .from('approval_requests')
      .update(channelPatch)
      .eq('id', id)
      .eq('user_id', userId)
      .eq('status', 'pending')
      .select('id')

    if (
      approveRes.error &&
      (approveRes.error.code === '42703' ||
        approveRes.error.code === 'PGRST204' ||
        /apply_channel/i.test(String(approveRes.error.message ?? '')))
    ) {
      approveRes = await db
        .from('approval_requests')
        .update(baseApprovalPatch)
        .eq('id', id)
        .eq('user_id', userId)
        .eq('status', 'pending')
        .select('id')
    }

    const { data: updated, error } = approveRes

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

    // Lowongan email langsung dan LinkedIn (manualOnly) tidak boleh masuk antrean worker atau ekstensi.
    if (dispatchTarget === 'email_direct') {
      return {
        success: true,
        message: 'Application approved; send via Email Apply panel',
        queue_job_id: null,
        apply_channel: 'email_direct',
        queued: false,
      }
    }
    if (dispatchTarget === 'manual') {
      return {
        success: true,
        message: 'Application approved; manual submission required for this portal',
        queue_job_id: null,
        apply_channel: 'manual',
        queued: false,
        manual_only: true,
      }
    }

    // Persetujuan pengguna = izin kirim untuk lamaran ini (HITL). Worker tetap memerlukan
    // ALLOW_REAL_SUBMIT=true sebelum benar-benar menekan tombol kirim; ekstensi menunggu klik Kirim Sekarang.
    try {
      // Jalur ekstensi butuh izin pengguna. Bila belum memilih "selalu pakai ekstensi", persetujuan tetap
      // tercatat tetapi TIDAK diantrekan; klien menampilkan pilihan lalu memanggil POST /:id/extension-consent.
      if (dispatchTarget === 'extension' && !(await readExtensionAutoUse(db, userId))) {
        return {
          success: true,
          message: 'Application approved; permission to use the browser extension is required before it is queued',
          queue_job_id: null,
          apply_channel: 'extension',
          extension_consent_required: true,
        }
      }
      const qs = getQueue()
      const queued =
        dispatchTarget === 'extension'
          ? await qs.addApprovedExtensionApplyJob(userId, id)
          : await qs.addApprovedApplyJob(userId, id)
      return {
        success: true,
        message: 'Application approved and queued for submission',
        queue_job_id: queued.id,
        apply_channel: dispatchTarget,
      }
    } catch (err: any) {
      // Jangan biarkan status "approved" tanpa pekerjaan di antrean (kecuali konflik kanal/klaim lain yang memang sudah ada).
      if (err instanceof ApprovalChannelConflictError) {
        return reply.status(409).send({ error: err.message, code: err.code })
      }
      const limitReached = err instanceof PlatformLimitReachedError
      await db
        .from('approval_requests')
        .update({ status: 'pending', reviewed_at: null })
        .eq('id', id)
        .eq('user_id', userId)
        .eq('status', 'approved')
      if (limitReached) {
        if (err.resetAt) reply.header('Retry-After', String(Math.max(1, Math.ceil((err.resetAt.getTime() - Date.now()) / 1000))))
        return reply.status(429).send({ error: err.message, code: err.code })
      }
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
    const result = await rerunApproval(await getDb(), getQueue(), userId, id)
    return reply.status(result.status).send(result.body)
  })

  // Izin memakai ekstensi untuk persetujuan yang sudah disetujui: antre `extension_apply` (payload sama dengan
  // /approve) dan, bila `always: true`, simpan `extension_auto_use` supaya persetujuan berikutnya langsung diantrekan.
  // Juga dipakai saat worker berhenti karena butuh login (`auth_required` / `external_redirect`) dan lamaran
  // belum terkirim. Syarat: milik pengguna, status approved, belum kedaluwarsa, belum terkirim, tidak ada
  // tugas apply/extension_apply yang aktif (409). Logika di services/extension-consent.ts.
  app.post('/:id/extension-consent', async (request, reply) => {
    const userId = (request as any).user?.id
    if (!userId) {
      return reply.status(401).send({ error: 'Unauthorized' })
    }

    const { id } = request.params as { id: string }
    const body = (request.body ?? {}) as { always?: unknown }
    const result = await grantExtensionConsent(await getDb(), getQueue(), userId, id, { always: body.always === true })
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
      .eq('user_id', userId)
      .eq('status', 'pending')
      .select()

    if (error) {
      return failServer(request, reply, error)
    }
    if (Array.isArray(data) && data.length === 0) {
      return reply.status(409).send({ error: 'Approval request already processed', code: 'already_processed' })
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

    const rawQuery = (request.query ?? {}) as { limit?: unknown; offset?: unknown }
    const parsedLimit = Number(rawQuery.limit)
    const parsedOffset = Number(rawQuery.offset)
    const safeLimit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? Math.min(100, Math.floor(parsedLimit)) : 50
    const safeOffset = Number.isFinite(parsedOffset) && parsedOffset >= 0 ? Math.floor(parsedOffset) : 0

    const db = await getDb()
    const { data, error } = await db
      .from('approval_requests')
      .select('*')
      .eq('user_id', userId)
      .neq('status', 'pending')
      // Postgres menaruh NULL paling atas pada DESC. Persetujuan kedaluwarsa tidak punya reviewed_at, jadi tanpa
      // nullsFirst:false 50 baris kedaluwarsa menutup semua persetujuan baru dari halaman pertama (E2E-02).
      .order('reviewed_at', { ascending: false, nullsFirst: false })
      .order('created_at', { ascending: false })
      .range(safeOffset, safeOffset + safeLimit - 1)

    if (error) {
      return failServer(request, reply, error)
    }

    return data || []
  })
}
