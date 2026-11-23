import { FastifyInstance, FastifyPluginOptions, FastifyReply, FastifyRequest } from 'fastify'
import type { SupabaseClient } from '@supabase/supabase-js'
import { authMiddleware } from '../middleware/auth.js'
import { afterReplyFor, runAfterReplyTasks } from '../../services/after-reply.js'
import {
  createExtensionToken,
  ExtensionTokenConfigError,
  extractBearerToken,
  verifyExtensionToken,
} from '../../services/extension-token.js'
import {
  extensionPlanner,
  ExtensionPlanRateLimitError,
  ExtensionPlanner,
} from '../../services/extension-planner.js'
import {
  authorizeExtensionSubmit,
  ExtensionRunnerError,
  getUserMinTokenVersion,
  listPendingExtensionApprovals,
  REPORT_RUN_BODY_LIMIT,
  reportExtensionRun,
  revokeAllExtensionTokens,
  verifyExtensionApproval,
} from '../../services/extension-runner.js'

export interface ExtensionRoutesOptions extends FastifyPluginOptions {
  /** Injeksi tes offline (DB tiruan). */
  db?: SupabaseClient
  /** Injeksi autentikasi JWT primer untuk POST /token di tes. */
  authenticatePrimary?: (request: FastifyRequest, reply: FastifyReply) => Promise<void>
  /** Injeksi planner tiruan di tes. */
  planner?: ExtensionPlanner
  /** Jam tiruan di tes. */
  now?: () => number
  /** Env tiruan di tes (untuk EXTENSION_TOKEN_SECRET / SESSION_ENCRYPTION_KEY). */
  env?: Record<string, string | undefined>
}

export async function extensionRoutes(app: FastifyInstance, opts: ExtensionRoutesOptions) {
  const now = opts.now ?? Date.now
  const planner = opts.planner ?? extensionPlanner
  const env = opts.env ?? process.env
  const getDb = async (): Promise<SupabaseClient> => opts.db ?? ((await import('../index.js')).supabase as SupabaseClient)
  const primaryAuth = opts.authenticatePrimary ?? authMiddleware

  async function requireExtensionUser(request: FastifyRequest, reply: FastifyReply): Promise<string | null> {
    const bearer = extractBearerToken(request.headers.authorization)
    if (!bearer) {
      reply.status(401).send({ error: 'Token ekstensi diperlukan' })
      return null
    }
    try {
      const verified = verifyExtensionToken(bearer, { now: new Date(now()), env })
      if ('reason' in verified) {
        reply.status(401).send({ error: 'Token ekstensi tidak sah atau sudah kedaluwarsa', code: verified.reason })
        return null
      }
      const minVer = await getUserMinTokenVersion(await getDb(), verified.userId)
      if (verified.tokenVersion < minVer) {
        reply.status(401).send({
          error: 'Token ekstensi sudah dicabut dari Pengaturan. Buat token baru untuk menghubungkan ulang.',
          code: 'token_revoked',
        })
        return null
      }
      return verified.userId
    } catch (err: any) {
      if (err instanceof ExtensionTokenConfigError) {
        reply.status(503).send({ error: err.message, code: err.code })
        return null
      }
      if (err instanceof ExtensionRunnerError) {
        reply.status(err.statusCode).send({ error: err.message, code: err.code })
        return null
      }
      throw err
    }
  }

  // 1. Terbitkan token scoped `extension:apply` hanya untuk pengguna yang terautentikasi JWT Supabase utama.
  app.post('/token', { preHandler: [primaryAuth] }, async (request, reply) => {
    const userId = (request as any).user?.id
    if (!userId) return reply.status(401).send({ error: 'Unauthorized' })
    const rawTtl = (request.body as any)?.ttlSeconds
    try {
      const ver = await getUserMinTokenVersion(await getDb(), userId)
      return createExtensionToken(userId, {
        ttlSec: typeof rawTtl === 'number' ? rawTtl : undefined,
        ver,
        now: new Date(now()),
        env,
      })
    } catch (err: any) {
      if (err instanceof ExtensionTokenConfigError) {
        return reply.status(503).send({ error: err.message, code: err.code })
      }
      if (err instanceof ExtensionRunnerError) {
        return reply.status(err.statusCode).send({ error: err.message, code: err.code })
      }
      return reply.status(400).send({ error: err?.message ?? 'Gagal membuat token ekstensi' })
    }
  })

  // 1b. Cabut seluruh token ekstensi lama ("Putuskan semua perangkat"), wajib JWT utama.
  app.post('/revoke-all', { preHandler: [primaryAuth] }, async (request, reply) => {
    const userId = (request as any).user?.id
    if (!userId) return reply.status(401).send({ error: 'Unauthorized' })
    try {
      return await revokeAllExtensionTokens(await getDb(), userId, new Date(now()))
    } catch (err: any) {
      if (err instanceof ExtensionRunnerError) {
        return reply.status(err.statusCode).send({ error: err.message, code: err.code })
      }
      return reply.status(500).send({ error: err?.message ?? 'Gagal mencabut token ekstensi' })
    }
  })

  // 2. Daftar persetujuan aktif (`approved`, belum dipakai submit, bukan LinkedIn).
  app.get('/pending-approvals', async (request, reply) => {
    const userId = await requireExtensionUser(request, reply)
    if (!userId) return reply
    try {
      const items = await listPendingExtensionApprovals(await getDb(), userId, new Date(now()))
      return { items }
    } catch (err: any) {
      if (err instanceof ExtensionRunnerError) {
        return reply.status(err.statusCode).send({ error: err.message, code: err.code })
      }
      return reply.status(500).send({ error: err?.message ?? 'Gagal mengambil daftar persetujuan' })
    }
  })

  // 3. Rencanakan isian formulir dari kontrol terstruktur tab aktif (tanpa raw HTML / cookie).
  app.post('/plan-form', async (request, reply) => {
    const userId = await requireExtensionUser(request, reply)
    if (!userId) return reply
    const body = (request.body ?? {}) as Record<string, unknown>
    const approvalId = typeof body.approvalId === 'string' ? body.approvalId : ''
    const pageUrl = typeof body.pageUrl === 'string' ? body.pageUrl : ''
    if (!approvalId || !pageUrl) {
      return reply.status(400).send({ error: 'approvalId dan pageUrl wajib diisi' })
    }

    try {
      const db = await getDb()
      const approvalCheck = await verifyExtensionApproval(db, {
        userId,
        approvalId,
        jobId: typeof body.jobId === 'string' ? body.jobId : undefined,
        now: new Date(now()),
      })
      if ('code' in approvalCheck) {
        return reply.status(approvalCheck.statusCode).send({ error: approvalCheck.error, code: approvalCheck.code })
      }

      const authEmail = await (async () => {
        try {
          const admin = (db as any)?.auth?.admin
          if (admin && typeof admin.getUserById === 'function') {
            const res = await admin.getUserById(userId)
            return typeof res?.data?.user?.email === 'string' ? res.data.user.email : undefined
          }
        } catch {
          // Abaikan bila mock DB tidak menyertakan auth.admin
        }
        return undefined
      })()

      return await planner.planForm({
        db,
        userId,
        userEmail: authEmail,
        jobId: approvalCheck.row.job_id,
        coverLetter: approvalCheck.row.cover_letter ?? null,
        pageUrl,
        noticeText: typeof body.noticeText === 'string' ? body.noticeText : '',
        hasPasswordInput: Boolean(body.hasPasswordInput),
        rawControls: body.controls,
      })
    } catch (err: any) {
      if (err instanceof ExtensionPlanRateLimitError) {
        reply.header('Retry-After', String(err.retryAfterSec))
        return reply.status(429).send({ error: err.message, code: err.code, retryAfterSec: err.retryAfterSec })
      }
      const status = typeof err?.statusCode === 'number' ? err.statusCode : 400
      return reply.status(status).send({ error: err?.message ?? 'Gagal merencanakan pengisian', ...(err?.code ? { code: err.code } : {}) })
    }
  })

  // 4. Gate akhir sebelum ekstensi mengklik tombol Submit (HITL + approval + kuota harian).
  app.post('/authorize-submit', async (request, reply) => {
    const userId = await requireExtensionUser(request, reply)
    if (!userId) return reply
    const body = (request.body ?? {}) as Record<string, unknown>
    try {
      return await authorizeExtensionSubmit(
        await getDb(),
        userId,
        {
          approvalId: typeof body.approvalId === 'string' ? body.approvalId : '',
          jobId: typeof body.jobId === 'string' ? body.jobId : '',
          pageUrl: typeof body.pageUrl === 'string' ? body.pageUrl : '',
          missingRequiredCount: Number(body.missingRequiredCount ?? 0),
          runId: typeof body.runId === 'string' ? body.runId : null,
        },
        new Date(now())
      )
    } catch (err: any) {
      if (err instanceof ExtensionRunnerError) {
        return reply.status(err.statusCode).send({ error: err.message, code: err.code })
      }
      return reply.status(500).send({ error: err?.message ?? 'Gagal memverifikasi otorisasi kirim' })
    }
  })

  // 5. Laporkan hasil eksekusi ekstensi + unggah bukti PNG privat ke agent-screenshots.
  //    Batas badan diperbesar hanya di sini: dua PNG base64 melewati 1 MiB bawaan Fastify, dan laporan kirim yang
  //    ditolak 413 sesudah klik Submit membuat pengguna menekan Kirim lagi (temuan keamanan 3).
  app.post('/report-run', { bodyLimit: REPORT_RUN_BODY_LIMIT, onResponse: runAfterReplyTasks }, async (request, reply) => {
    const userId = await requireExtensionUser(request, reply)
    if (!userId) return reply
    const body = (request.body ?? {}) as Record<string, unknown>
    try {
      return await reportExtensionRun(
        await getDb(),
        userId,
        {
          approvalId: typeof body.approvalId === 'string' ? body.approvalId : '',
          jobId: typeof body.jobId === 'string' ? body.jobId : '',
          pageUrl: typeof body.pageUrl === 'string' ? body.pageUrl : '',
          outcome: body.outcome as any,
          runId: typeof body.runId === 'string' ? body.runId : null,
          reason: typeof body.reason === 'string' ? body.reason : null,
          filledCount: typeof body.filledCount === 'number' ? body.filledCount : 0,
          filledFields: Array.isArray(body.filledFields) ? body.filledFields : [],
          filesAttached: body.filesAttached,
          remainingRequired:
            Array.isArray(body.remainingRequired) || typeof body.remainingRequired === 'number' ? body.remainingRequired : 0,
          questions: Array.isArray(body.questions) ? body.questions : [],
          submitCheck: body.submitCheck,
          filledScreenshot: body.filledScreenshot,
          afterScreenshot: body.afterScreenshot,
        },
        new Date(now()),
        afterReplyFor(request)
      )
    } catch (err: any) {
      if (err instanceof ExtensionRunnerError) {
        return reply.status(err.statusCode).send({ error: err.message, code: err.code })
      }
      return reply.status(500).send({ error: err?.message ?? 'Gagal menyimpan laporan ekstensi' })
    }
  })
}
