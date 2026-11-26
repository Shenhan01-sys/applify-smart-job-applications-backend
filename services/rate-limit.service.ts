/** Minimal shape of the Supabase client used here (a fake is passed in tests). */
export interface RateLimitDb {
  from(table: string): any
}

/**
 * Daily submission quota. Must match worker/src/lib/quota.ts, which enforces it before an apply job runs:
 * free 10, pro 20; counted from application_logs rows with action 'apply' or 'email_apply' and status
 * 'success' (what the worker writes for a real submission) since 00:00 UTC.
 */
export const DAILY_APPLY_LIMIT = { free: 10, pro: 20 } as const
export const COUNTED_ACTIONS = ['apply', 'email_apply'] as const

export function startOfUtcDay(now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
}

interface RateLimitConfig {
  platform: string
  maxRequestsPerHour: number
  maxRequestsPerDay: number
}

interface UserQuota {
  userId: string
  tier: 'free' | 'pro'
  dailyAppliesUsed: number
  dailyAppliesLimit: number
  resetsAt: Date
}

export class RateLimitService {
  /** `client` is only passed in tests; otherwise the server's Supabase client is loaded on first use. */
  constructor(private readonly client?: RateLimitDb) {}

  private async db(): Promise<RateLimitDb> {
    return this.client ?? ((await import('../api/index.js')).supabase as unknown as RateLimitDb)
  }

  private platformLimits: Map<string, RateLimitConfig> = new Map([
    ['linkedin', { platform: 'linkedin', maxRequestsPerHour: 30, maxRequestsPerDay: 100 }],
    ['greenhouse', { platform: 'greenhouse', maxRequestsPerHour: 100, maxRequestsPerDay: 500 }],
    ['lever', { platform: 'lever', maxRequestsPerHour: 100, maxRequestsPerDay: 500 }],
    ['ashby', { platform: 'ashby', maxRequestsPerHour: 100, maxRequestsPerDay: 500 }],
    ['workable', { platform: 'workable', maxRequestsPerHour: 100, maxRequestsPerDay: 500 }],
    ['jobstreet', { platform: 'jobstreet', maxRequestsPerHour: 20, maxRequestsPerDay: 50 }],
    ['kalibrr', { platform: 'kalibrr', maxRequestsPerHour: 20, maxRequestsPerDay: 50 }],
    ['glints', { platform: 'glints', maxRequestsPerHour: 20, maxRequestsPerDay: 50 }],
    ['smartrecruiters', { platform: 'smartrecruiters', maxRequestsPerHour: 100, maxRequestsPerDay: 500 }],
  ])

  // Platform rate limiting
  async checkPlatformLimit(platform: string, userId: string): Promise<{
    allowed: boolean
    remaining: number
    resetAt: Date
  }> {
    const config = this.platformLimits.get(platform)
    if (!config) {
      return { allowed: true, remaining: 999, resetAt: new Date(Date.now() + 3600000) }
    }

    // Count requests in last hour from application_logs
    const supabase = await this.db()
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString()
    const { count, error } = await supabase
      .from('application_logs')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', userId)
      .eq('platform', platform)
      .gte('created_at', oneHourAgo)

    if (error) {
      // Gagal tertutup (47.6 F-09): galat DB tidak boleh meloloskan batas platform tanpa batas.
      console.error('Rate limit check failed:', String((error as any)?.code ?? 'db_error'))
      throw new Error('rate_limit_check_failed')
    }

    const used = count || 0
    const remaining = Math.max(0, config.maxRequestsPerHour - used)
    const resetAt = new Date(Date.now() + 60 * 60 * 1000)

    return {
      allowed: used < config.maxRequestsPerHour,
      remaining,
      resetAt,
    }
  }

  // User daily apply quota
  async checkUserQuota(userId: string, now: Date = new Date()): Promise<{
    allowed: boolean
    remaining: number
    used: number
    limit: number
    tier: 'free' | 'pro'
    resetsAt: Date
  }> {
    const supabase = await this.db()
    // Tier lives in subscriptions.ai_model_tier (schema.sql); the old code read a non-existent `tier`
    // column, got an error it ignored, and so treated every user as free.
    const { data: subscription, error: subError } = await supabase
      .from('subscriptions')
      .select('ai_model_tier')
      .eq('user_id', userId)
      .maybeSingle()
    if (subError) {
      console.error('Quota tier lookup failed:', String((subError as any)?.code ?? 'db_error'))
      throw new Error('quota_check_failed')
    }

    const tier: 'free' | 'pro' = subscription?.ai_model_tier === 'pro' ? 'pro' : 'free'
    const dailyLimit = DAILY_APPLY_LIMIT[tier]
    const startOfDay = startOfUtcDay(now)
    const resetsAt = new Date(startOfDay.getTime() + 24 * 60 * 60 * 1000)

    // Same rows the worker counts: real submissions only (action 'apply'/'email_apply', status 'success').
    // This used to count action 'submit', which nothing writes, so the quota always showed unused.
    const { count, error } = await supabase
      .from('application_logs')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', userId)
      .in('action', [...COUNTED_ACTIONS])
      .eq('status', 'success')
      .gte('created_at', startOfDay.toISOString())

    if (error) {
      // Gagal tertutup (47.6 F-09): galat DB tidak boleh melaporkan kuota masih terbuka.
      console.error('Quota check failed:', String((error as any)?.code ?? 'db_error'))
      throw new Error('quota_check_failed')
    }

    const used = count || 0
    return {
      allowed: used < dailyLimit,
      remaining: Math.max(0, dailyLimit - used),
      used,
      limit: dailyLimit,
      tier,
      resetsAt,
    }
  }

  // Record platform request
  async recordRequest(userId: string, platform: string, action: string) {
    const supabase = await this.db()
    await supabase.from('application_logs').insert({
      user_id: userId,
      action,
      platform,
      status: 'success',
    })
  }

  // Get rate limit status for all platforms
  async getRateLimitStatus(userId: string): Promise<Array<{
    platform: string
    limit: number
    used: number
    remaining: number
    resetAt: Date
  }>> {
    // One count per platform, run in parallel. Run one after another, the nine round trips made this the
    // slowest authenticated route in E2E (median 1.55 s, p95 2.35 s).
    const supabase = await this.db()
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString()
    const counted = await Promise.all(
      [...this.platformLimits].map(async ([platform, config]) => {
        const { count, error } = await supabase
          .from('application_logs')
          .select('*', { count: 'exact', head: true })
          .eq('user_id', userId)
          .eq('platform', platform)
          .gte('created_at', oneHourAgo)
        return { platform, config, count, error }
      })
    )

    return counted
      .filter((c) => !c.error)
      .map(({ platform, config, count }) => ({
        platform,
        limit: config.maxRequestsPerHour,
        used: count || 0,
        remaining: Math.max(0, config.maxRequestsPerHour - (count || 0)),
        resetAt: new Date(Date.now() + 60 * 60 * 1000),
      }))
  }
}

export const rateLimitService = new RateLimitService()
