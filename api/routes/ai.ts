import { FastifyInstance, FastifyPluginOptions } from 'fastify'
import { aiPipelineService } from '../../services/ai-pipeline.service.js'
import { formAutofillService } from '../../services/form-autofill.service.js'

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

export async function aiRoutes(
  app: FastifyInstance,
  _opts: FastifyPluginOptions
) {
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
        userId: (request as any).user?.id || 'anonymous',
      })

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
      })

      return { success: true, answer }
    } catch (error: any) {
      return reply.status(500).send({ success: false, error: error.message })
    }
  })

  // Extract skills from job description
  app.post('/extract-skills', async (request, reply) => {
    const { jobDescription } = request.body as any

    try {
      const skills = await aiPipelineService.extractSkills(jobDescription)
      return { success: true, skills }
    } catch (error: any) {
      return reply.status(500).send({ success: false, error: error.message })
    }
  })

  // Analyze job match
  app.post('/analyze-match', async (request, reply) => {
    const { jobDescription, userSkills } = request.body as any

    try {
      const analysis = await aiPipelineService.analyzeJobMatch(jobDescription, userSkills)
      return { success: true, analysis }
    } catch (error: any) {
      return reply.status(500).send({ success: false, error: error.message })
    }
  })

  // Fill form fields
  app.post('/fill-form', async (request, reply) => {
    const { fields, context } = request.body as any

    try {
      const results = await Promise.all(
        fields.map((field: any) => formAutofillService.fillField(field, context))
      )

      return { success: true, results }
    } catch (error: any) {
      return reply.status(500).send({ success: false, error: error.message })
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
        userId: (request as any).user?.id || 'anonymous',
      })

      // Peringatan dasar fakta (angka, proyek, sertifikasi, perusahaan yang tidak ada di profil) ikut dikirim,
      // tidak disimpan diam-diam sebagai fakta.
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
        userId: (request as any).user?.id || 'anonymous',
      })

      return { success: true, evaluation, model: aiPipelineService.lastModelUsed }
    } catch (error: any) {
      // CV rantai pikir atau terpotong: 422 invalid_cv, tidak ada skor.
      return sendAiError(reply, error)
    }
  })
}
