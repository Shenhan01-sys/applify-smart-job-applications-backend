import { FastifyInstance, FastifyPluginOptions } from 'fastify'
import { aiPipelineService } from '../../services/ai-pipeline.service.js'
import { formAutofillService } from '../../services/form-autofill.service.js'

export async function aiRoutes(
  app: FastifyInstance,
  _opts: FastifyPluginOptions
) {
  // Generate cover letter
  app.post('/cover-letter', async (request, reply) => {
    const { jobTitle, company, jobDescription, userProfile, tone } = request.body as any

    try {
      const coverLetter = await aiPipelineService.generateCoverLetter({
        jobTitle,
        company,
        jobDescription,
        userProfile,
        tone,
        userId: (request as any).user?.id || 'anonymous',
      })

      return { success: true, coverLetter, model: aiPipelineService.lastModelUsed }
    } catch (error: any) {
      return reply.status(500).send({ success: false, error: error.message })
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
    const { jobTitle, company, jobDescription, userProfile } = request.body as any

    try {
      const cv = await aiPipelineService.generateCV({
        jobTitle,
        company,
        jobDescription,
        userProfile,
        userId: (request as any).user?.id || 'anonymous',
      })

      return { success: true, cv }
    } catch (error: any) {
      return reply.status(500).send({ success: false, error: error.message })
    }
  })

  // Evaluate CV / Resume against a job (scoring + recommendations)
  app.post('/cv/evaluate', async (request, reply) => {
    const { cvText, jobTitle, company, jobDescription } = request.body as any

    try {
      const evaluation = await aiPipelineService.evaluateCV({
        cvText,
        jobTitle,
        company,
        jobDescription,
        userId: (request as any).user?.id || 'anonymous',
      })

      return { success: true, evaluation }
    } catch (error: any) {
      return reply.status(500).send({ success: false, error: error.message })
    }
  })
}
