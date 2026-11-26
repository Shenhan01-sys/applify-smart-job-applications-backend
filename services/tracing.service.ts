import { createHash } from 'node:crypto'
import { Langfuse } from 'langfuse'

// Nilai contoh dari .env.example ('pk-...', 'sk-...', 'your-...') dianggap belum diisi,
// supaya Langfuse tetap nonaktif (bukan mengirim trace dengan kunci palsu lalu gagal 401).
const realKey = (v?: string) => (v && !/\.\.\.$|^your-/i.test(v) ? v : '')

const langfuse = new Langfuse({
  publicKey: realKey(process.env.LANGFUSE_PUBLIC_KEY),
  secretKey: realKey(process.env.LANGFUSE_SECRET_KEY),
  baseUrl: process.env.LANGFUSE_BASE_URL || 'https://cloud.langfuse.com',
})

const SENSITIVE_META_KEY = /prompt|output|content|resume|cv|cover[_-]?letter|email|phone|whatsapp|address|salary|token|secret|password/i

export interface RedactedLangfuseContent {
  redacted: true
  sha256: string
  chars: number
}

/**
 * Redaksi konten prompt/output AI sebelum dikirim ke Langfuse (47.5 U6-P2-11).
 * Bawaan: hanya hash SHA-256 + panjang karakter (tidak pernah mengirim isi CV/surat/PII ke pihak ketiga).
 * Konten mentah hanya dikirim bila `LANGFUSE_INCLUDE_CONTENT=true` diset eksplisit.
 */
export function redactLangfuseText(
  text: string,
  env: Record<string, string | undefined> = process.env
): string | RedactedLangfuseContent {
  const value = String(text ?? '')
  if ((env.LANGFUSE_INCLUDE_CONTENT ?? '').trim().toLowerCase() === 'true') {
    return value
  }
  return {
    redacted: true,
    sha256: createHash('sha256').update(value, 'utf8').digest('hex'),
    chars: value.length,
  }
}

export function sanitizeTraceMetadata(metadata: unknown): Record<string, unknown> {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return {}
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(metadata as Record<string, unknown>)) {
    if (SENSITIVE_META_KEY.test(k)) continue
    if (typeof v === 'string' && v.length > 200) {
      out[k] = { redacted: true, chars: v.length }
    } else {
      out[k] = v
    }
  }
  return out
}

export function buildGenerationTracePayload(
  params: {
    type: string
    model: string
    prompt: string
    output: string
    tokensUsed?: number
    cost?: number
    duration?: number
    metadata?: unknown
  },
  env: Record<string, string | undefined> = process.env
) {
  return {
    name: params.type,
    model: params.model,
    input: redactLangfuseText(params.prompt, env),
    output: redactLangfuseText(params.output, env),
    usage: params.tokensUsed
      ? {
          input: Math.floor(params.tokensUsed * 0.4),
          output: Math.floor(params.tokensUsed * 0.6),
          total: params.tokensUsed,
        }
      : undefined,
    metadata: {
      ...sanitizeTraceMetadata(params.metadata),
      cost: params.cost,
      duration: params.duration,
      contentRedacted: (env.LANGFUSE_INCLUDE_CONTENT ?? '').trim().toLowerCase() !== 'true',
    },
  }
}

export class TracingService {
  /**
   * Trace an AI generation call (cover letter, answer, etc.)
   */
  async traceAIGeneration(params: {
    userId: string
    type: 'cover_letter' | 'answer' | 'skill_extraction' | 'match_analysis' | 'cv_generation' | 'cv_evaluation'
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
        ...sanitizeTraceMetadata(params.metadata),
      },
    })

    const generation = trace.generation(buildGenerationTracePayload(params))

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
