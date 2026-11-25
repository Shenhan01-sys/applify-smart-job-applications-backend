import { FastifyInstance, FastifyPluginOptions } from 'fastify'
import { aiPipelineService } from '../../services/ai-pipeline.service.js'
import { formAutofillService, type FormField } from '../../services/form-autofill.service.js'
import { AiAccessError, aiGuardService, type AiGuardService } from '../../services/ai-guard.service.js'

/** Batas pengamanan POST /api/ai/fill-form (BS-02): cegah amplifikasi ratusan panggilan LLM per permintaan. */
export const MAX_FILL_FORM_FIELDS = 40
export const MAX_FIELD_LABEL_LENGTH = 500
export const MAX_FIELD_OPTIONS = 100
export const FILL_FORM_CONCURRENCY = 5
const ALLOWED_FIELD_TYPES = new Set(['text', 'textarea', 'select', 'radio', 'checkbox', 'file'])

function validateFillFormBody(body: unknown):
  | { ok: true; fields: FormField[]; context: any }
  | { ok: false; code: string; error: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, code: 'invalid_body', error: 'Body permintaan harus berupa objek JSON.' }
  }
  const { fields, context } = body as { fields?: unknown; context?: unknown }
  if (!Array.isArray(fields)) {
    return { ok: false, code: 'invalid_fields', error: 'fields harus berupa larik (array).' }
  }
  if (fields.length > MAX_FILL_FORM_FIELDS) {
    return {
      ok: false,
      code: 'too_many_fields',
      error: `Jumlah kolom melebihi batas maksimal ${MAX_FILL_FORM_FIELDS} per permintaan.`,
    }
  }
  if (!context || typeof context !== 'object' || Array.isArray(context)) {
    return { ok: false, code: 'invalid_context', error: 'context harus berupa objek.' }
  }

  const sanitized: FormField[] = []
  for (let i = 0; i < fields.length; i++) {
    const raw = fields[i]
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return { ok: false, code: 'invalid_field', error: `fields[${i}] harus berupa objek.` }
    }
    const f = raw as Record<string, unknown>
    const rawType = f.type === undefined ? 'text' : f.type
    const type = typeof rawType === 'string' ? rawType : ''
    if (!ALLOWED_FIELD_TYPES.has(type)) {
      return { ok: false, code: 'invalid_field', error: `fields[${i}].type tidak valid.` }
    }
    const label = typeof f.label === 'string' ? f.label.trim() : ''
    if (!label || label.length > MAX_FIELD_LABEL_LENGTH) {
      return {
        ok: false,
        code: 'invalid_field',
        error: `fields[${i}].label wajib diisi dan maksimal ${MAX_FIELD_LABEL_LENGTH} karakter.`,
      }
    }
    let options: string[] | undefined
    if (f.options !== undefined) {
      if (!Array.isArray(f.options) || f.options.length > MAX_FIELD_OPTIONS || !f.options.every((o) => typeof o === 'string')) {
        return {
          ok: false,
          code: 'invalid_field',
          error: `fields[${i}].options harus berupa larik teks maksimal ${MAX_FIELD_OPTIONS} butir.`,
        }
      }
      options = f.options
    }
    sanitized.push({
      type: type as FormField['type'],
      label,
      ...(typeof f.id === 'string' ? { id: f.id } : {}),
      ...(typeof f.name === 'string' ? { name: f.name } : {}),
      ...(options ? { options } : {}),
      ...(typeof f.required === 'boolean' ? { required: f.required } : {}),
      ...(typeof f.placeholder === 'string' ? { placeholder: f.placeholder } : {}),
    })
  }

  const rawCtx = context as Record<string, unknown>
  const normalizedContext = {
    ...rawCtx,
    jobTitle: typeof rawCtx.jobTitle === 'string' ? rawCtx.jobTitle : '',
    company: typeof rawCtx.company === 'string' ? rawCtx.company : '',
    jobDescription: typeof rawCtx.jobDescription === 'string' ? rawCtx.jobDescription : '',
    userSettings: rawCtx.userSettings && typeof rawCtx.userSettings === 'object' ? rawCtx.userSettings : {},
    userProfile: rawCtx.userProfile && typeof rawCtx.userProfile === 'object' ? rawCtx.userProfile : {},
  }

  return { ok: true, fields: sanitized, context: normalizedContext }
}

async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const idx = next++
      results[idx] = await fn(items[idx])
    }
  })
  await Promise.all(workers)
  return results
}

/**
 * Pemetaan galat generasi: 422 CV tidak valid (tidak dinilai), 502 semua model menjawab tetapi ditolak penjaga
 * mutu (tidak ada yang disimpan), 500 lainnya. `code` dan `reasons` membantu antarmuka menampilkan sebabnya.
 */
function sendAiError(reply: any, error: any) {
  const status = typeof error?.statusCode === 'number' ? error.statusCode : 500
  return reply.status(status).send({
    success: false,
    error: error?.message ?? 'AI request failed',
    ...(error?.code ? { code: error.code } : {}),
    ...(Array.isArray(error?.reasons) ? { reasons: error.reasons } : {}),
  })
}

export interface AiRoutesOptions extends FastifyPluginOptions {
  /** Hanya tes yang mengisi ini (penjaga dengan database tiruan). */
  guard?: Pick<AiGuardService, 'check' | 'recordDraft'>
}

export async function aiRoutes(
  app: FastifyInstance,
  opts: AiRoutesOptions
) {
  const guard = opts.guard ?? aiGuardService

  // Setiap rute /api/ai/* memanggil model AI, jadi semuanya lewat penjaga yang sama SEBELUM pipeline dipanggil:
  // login wajib, lalu batas laju per pengguna, lalu kuota draf bulanan (get_quota_status).
  // 429 = batas tercapai (code rate_limited atau quota_exhausted), 503 = batas tidak dapat diperiksa.
  app.addHook('preHandler', async (request, reply) => {
    const userId = (request as any).user?.id
    if (!userId) {
      return reply.status(401).send({ success: false, error: 'Unauthorized' })
    }
    try {
      const { quota } = await guard.check(userId, request.routeOptions?.url ?? request.url)
      ;(request as any).aiQuota = quota
    } catch (error: any) {
      if (error instanceof AiAccessError) {
        if (error.extra.retryAfterSec) reply.header('Retry-After', String(error.extra.retryAfterSec))
        return reply.status(error.statusCode).send({
          success: false,
          error: error.message,
          code: error.code,
          ...(error.extra.retryAfterSec ? { retryAfterSec: error.extra.retryAfterSec } : {}),
          ...(error.extra.quota ? { quota: error.extra.quota } : {}),
        })
      }
      request.log.error(error)
      return reply.status(503).send({ success: false, error: 'Pemeriksaan kuota AI gagal. Coba lagi nanti.', code: 'quota_check_failed' })
    }
    return undefined
  })

  // Generate cover letter
  app.post('/cover-letter', async (request, reply) => {
    const { jobTitle, company, jobDescription, userProfile, tone, language } = request.body as any

    try {
      const doc = await aiPipelineService.generateCoverLetter({
        jobTitle,
        company,
        jobDescription,
        userProfile,
        tone,
        language,
        userId: (request as any).user?.id,
      })

      // Satu surat lamaran yang berhasil = satu draf pada kuota bulanan (sama dengan satuan Edge Function).
      await guard.recordDraft((request as any).user.id, '/cover-letter')

      // `language`: bahasa yang dipakai (bawaan Indonesia; Inggris bila lowongan berbahasa Inggris atau diminta).
      // `warnings`: angka atau klaim yang tidak ada di profil; tampilkan sebelum pengguna menyetujui.
      return { success: true, coverLetter: doc.text, model: doc.model, language: doc.language, warnings: doc.warnings }
    } catch (error: any) {
      return sendAiError(reply, error)
    }
  })

  // Generate answer for application question
  app.post('/answer', async (request, reply) => {
    const { question, questionType, options, jobDescription, userProfile } = request.body as any

    try {
      const answer = await aiPipelineService.generateAnswer({
        question,
        questionType,
        options,
        jobDescription,
        userProfile,
        userId: (request as any).user?.id,
      })

      return { success: true, answer }
    } catch (error: any) {
      return reply.status(500).send({ success: false, error: error.message })
    }
  })

  // Extract skills from job description
  app.post('/extract-skills', async (request, reply) => {
    const { jobDescription } = (request.body ?? {}) as any
    if (typeof jobDescription !== 'string' || !jobDescription.trim()) {
      return reply.status(400).send({ success: false, error: 'jobDescription wajib berupa teks tidak kosong.', code: 'invalid_job_description' })
    }

    try {
      const skills = await aiPipelineService.extractSkills(jobDescription, (request as any).user?.id)
      return { success: true, skills }
    } catch (error: any) {
      return sendAiError(reply, error)
    }
  })

  // Analyze job match
  app.post('/analyze-match', async (request, reply) => {
    const { jobDescription, userSkills } = (request.body ?? {}) as any
    if (typeof jobDescription !== 'string' || !jobDescription.trim()) {
      return reply.status(400).send({ success: false, error: 'jobDescription wajib berupa teks tidak kosong.', code: 'invalid_job_description' })
    }
    const skills = Array.isArray(userSkills) ? userSkills.filter((s: unknown): s is string => typeof s === 'string') : []

    try {
      const analysis = await aiPipelineService.analyzeJobMatch(jobDescription, skills, (request as any).user?.id)
      return { success: true, analysis }
    } catch (error: any) {
      return sendAiError(reply, error)
    }
  })

  // Fill form fields
  app.post('/fill-form', async (request, reply) => {
    const check = validateFillFormBody(request.body)
    if ('error' in check) {
      return reply.status(400).send({ success: false, error: check.error, code: check.code })
    }
    if (check.fields.length === 0) {
      return { success: true, results: [] }
    }

    try {
      const results = await mapWithConcurrency(
        check.fields,
        FILL_FORM_CONCURRENCY,
        (field) => formAutofillService.fillField(field, check.context),
      )

      return { success: true, results }
    } catch (error: any) {
      return sendAiError(reply, error)
    }
  })

  // Generate CV / Resume (ATS-optimized, tailored to job)
  app.post('/cv', async (request, reply) => {
    const { jobTitle, company, jobDescription, userProfile, language } = request.body as any

    try {
      const doc = await aiPipelineService.generateCV({
        jobTitle,
        company,
        jobDescription,
        userProfile,
        language,
        userId: (request as any).user?.id,
      })

      // Peringatan dasar fakta (angka, proyek, sertifikasi, perusahaan yang tidak ada di profil) ikut dikirim,
      // tidak disimpan diam-diam sebagai fakta. (Hanya /cover-letter yang dicatat sebagai `ai_draft`.)
      return { success: true, cv: doc.text, model: doc.model, language: doc.language, warnings: doc.warnings }
    } catch (error: any) {
      return sendAiError(reply, error)
    }
  })

  // Evaluate CV / Resume against a job (scoring + recommendations)
  app.post('/cv/evaluate', async (request, reply) => {
    const { cvText, jobTitle, company, jobDescription, requireEducation } = request.body as any

    try {
      const evaluation = await aiPipelineService.evaluateCV({
        cvText,
        jobTitle,
        company,
        jobDescription,
        requireEducation: requireEducation === false ? false : undefined,
        userId: (request as any).user?.id,
      })

      return { success: true, evaluation, model: aiPipelineService.lastModelUsed }
    } catch (error: any) {
      // CV rantai pikir atau terpotong: 422 invalid_cv, tidak ada skor.
      return sendAiError(reply, error)
    }
  })
}
