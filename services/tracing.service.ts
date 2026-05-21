import { Langfuse } from 'langfuse'

const langfuse = new Langfuse({
  publicKey: process.env.LANGFUSE_PUBLIC_KEY || '',
  secretKey: process.env.LANGFUSE_SECRET_KEY || '',
  baseUrl: process.env.LANGFUSE_BASE_URL || 'https://cloud.langfuse.com',
})

export class TracingService {
  /**
   * Trace an AI generation call (cover letter, answer, etc.)
   */
  async traceAIGeneration(params: {
    userId: string
    type: 'cover_letter' | 'answer' | 'skill_extraction' | 'match_analysis'
    model: string
    prompt: string
    output: string
    tokensUsed?: number
    cost?: number
    duration?: number
    metadata?: any
  }) {
    const trace = langfuse.trace({
      name: `ai-${params.type}`,
      userId: params.userId,
      metadata: {
        type: params.type,
        model: params.model,
        ...params.metadata,
      },
    })

    const generation = trace.generation({
      name: params.type,
      model: params.model,
      input: params.prompt,
      output: params.output,
      usage: params.tokensUsed
        ? {
            input: Math.floor(params.tokensUsed * 0.4),
            output: Math.floor(params.tokensUsed * 0.6),
            total: params.tokensUsed,
          }
        : undefined,
      metadata: {
        cost: params.cost,
        duration: params.duration,
      },
    })

    await trace.update({})

    return { traceId: trace.id, generationId: generation.id }
  }

  /**
   * Trace a job application submission
   */
  async traceApplication(params: {
    userId: string
    jobId: string
    platform: string
    status: 'started' | 'completed' | 'failed'
    steps: Array<{
      name: string
      status: 'success' | 'error'
      duration: number
      error?: string
    }>
    metadata?: any
  }) {
    const trace = langfuse.trace({
      name: 'job-application',
      userId: params.userId,
      metadata: {
        jobId: params.jobId,
        platform: params.platform,
        status: params.status,
        ...params.metadata,
      },
    })

    for (const step of params.steps) {
      trace.span({
        name: step.name,
        statusMessage: step.status === 'error' ? step.error : undefined,
        input: { step: step.name },
        output: { status: step.status },
      })
    }

    await trace.update({})

    return trace.id
  }

  /**
   * Trace an MCP/browser automation call
   */
  async traceAutomation(params: {
    userId: string
    platform: string
    action: string
    duration: number
    success: boolean
    error?: string
    metadata?: any
  }) {
    const trace = langfuse.trace({
      name: `automation-${params.platform}`,
      userId: params.userId,
      metadata: {
        platform: params.platform,
        action: params.action,
        ...params.metadata,
      },
    })

    trace.span({
      name: params.action,
      statusMessage: params.error,
      input: { platform: params.platform, action: params.action },
      output: { success: params.success },
    })

    await trace.update({})

    return trace.id
  }

  /**
   * Get user's AI usage stats
   */
  async getUserStats(userId: string, startDate?: Date, endDate?: Date) {
    // This would query Langfuse API for user-specific traces
    // Implementation depends on Langfuse SDK capabilities
    return {
      userId,
      period: { start: startDate, end: endDate },
      totalCalls: 0,
      totalTokens: 0,
      totalCost: 0,
      // TODO: Implement actual querying
    }
  }
}

export const tracingService = new TracingService()
