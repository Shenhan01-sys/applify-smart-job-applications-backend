import { FastifyInstance, FastifyPluginOptions } from 'fastify'
import { supabase } from '../index.js'
import { queueService } from '../../services/queue.service.js'

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

export async function approvalRoutes(
  app: FastifyInstance,
  _opts: FastifyPluginOptions
) {
  // Get pending approvals for user
  app.get('/pending', async (request, reply) => {
    const userId = (request as any).user?.id
    if (!userId) {
      return reply.status(401).send({ error: 'Unauthorized' })
    }

    const { data, error } = await supabase
      .from('approval_requests')
      .select('*')
      .eq('user_id', userId)
      .eq('status', 'pending')
      .gt('expires_at', new Date().toISOString())
      .order('created_at', { ascending: false })

    if (error) {
      return reply.status(500).send({ error: error.message })
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

    const { data, error } = await supabase
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
      cover_letter,
      answers,
      resume_url,
    } = request.body as any

    // Default expiry: 1 hour from now
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString()

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
        answers,
        resume_url,
        status: 'pending',
        expires_at: expiresAt,
      })
      .select()

    if (error) {
      return reply.status(500).send({ error: error.message })
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

    // Check if approval request exists and is still pending
    const { data: requestData, error: fetchError } = await supabase
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
      await supabase
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

    // Update status to approved
    const { error } = await supabase
      .from('approval_requests')
      .update({
        status: 'approved',
        reviewed_at: new Date().toISOString(),
        ...(editedCoverLetter ? { cover_letter: editedCoverLetter } : {}),
      })
      .eq('id', id)

    if (error) {
      return reply.status(500).send({ error: error.message })
    }

    if (editedCoverLetter && requestData.application_id) {
      await supabase
        .from('ai_applications')
        .update({ cover_letter: editedCoverLetter })
        .eq('id', requestData.application_id)
        .eq('user_id', userId)
    }

    // Persetujuan pengguna = izin kirim untuk lamaran ini (HITL). Worker tetap memerlukan
    // ALLOW_REAL_SUBMIT=true sebelum benar-benar menekan tombol kirim.
    try {
      const queued = await queueService.addApplyJob(userId, {
        job_id: requestData.job_id,
        application_id: requestData.application_id ?? null,
        approval_request_id: id,
        approved: true,
      })
      return { success: true, message: 'Application approved and queued for submission', queue_job_id: queued.id }
    } catch (err: any) {
      // Jangan biarkan status "approved" tanpa pekerjaan di antrean.
      await supabase
        .from('approval_requests')
        .update({ status: 'pending', reviewed_at: null })
        .eq('id', id)
      return reply.status(500).send({ error: `Failed to queue submission (approval reverted to pending): ${err.message}` })
    }
  })

  // Reject application
  app.post('/:id/reject', async (request, reply) => {
    const userId = (request as any).user?.id
    if (!userId) {
      return reply.status(401).send({ error: 'Unauthorized' })
    }

    const { id } = request.params as { id: string }
    const { reason } = request.body as { reason?: string }

    const { data: requestData, error: fetchError } = await supabase
      .from('approval_requests')
      .select('*')
      .eq('id', id)
      .eq('user_id', userId)
      .eq('status', 'pending')
      .single()

    if (fetchError || !requestData) {
      return reply.status(404).send({ error: 'Approval request not found or already processed' })
    }

    const { data, error } = await supabase
      .from('approval_requests')
      .update({
        status: 'rejected',
        reviewed_at: new Date().toISOString(),
        rejection_reason: reason || 'No reason provided',
      })
      .eq('id', id)
      .select()

    if (error) {
      return reply.status(500).send({ error: error.message })
    }

    // Log rejection for preference learning
    await supabase.from('application_logs').insert({
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

  // Regenerate cover letter with edits
  app.post('/:id/regenerate', async (request, reply) => {
    const userId = (request as any).user?.id
    if (!userId) {
      return reply.status(401).send({ error: 'Unauthorized' })
    }

    const { id } = request.params as { id: string }
    const { instructions } = request.body as { instructions: string }

    const { data: requestData, error: fetchError } = await supabase
      .from('approval_requests')
      .select('*')
      .eq('id', id)
      .eq('user_id', userId)
      .eq('status', 'pending')
      .single()

    if (fetchError || !requestData) {
      return reply.status(404).send({ error: 'Approval request not found' })
    }

    // TODO: Call AI pipeline to regenerate with instructions
    // const newCoverLetter = await aiPipelineService.regenerateCoverLetter({
    //   original: requestData.cover_letter,
    //   instructions,
    //   jobData: requestData
    // })

    // For now, return the request for frontend to handle regeneration
    return {
      success: true,
      message: 'Please use AI endpoint to regenerate with instructions',
      request: requestData,
    }
  })

  // Get approval history
  app.get('/history', async (request, reply) => {
    const userId = (request as any).user?.id
    if (!userId) {
      return reply.status(401).send({ error: 'Unauthorized' })
    }

    const { limit = 50, offset = 0 } = request.query as any

    const { data, error } = await supabase
      .from('approval_requests')
      .select('*')
      .eq('user_id', userId)
      .neq('status', 'pending')
      .order('reviewed_at', { ascending: false })
      .range(Number(offset), Number(offset) + Number(limit) - 1)

    if (error) {
      return reply.status(500).send({ error: error.message })
    }

    return data || []
  })
}
