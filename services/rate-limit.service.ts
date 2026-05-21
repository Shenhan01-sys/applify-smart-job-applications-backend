import { supabase } from '../api/index.js'

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
  private platformLimits: Map<string, RateLimitConfig> = new Map([
    ['linkedin', { platform: 'linkedin', maxRequestsPerHour: 30, maxRequestsPerDay: 100 }],
    ['greenhouse', { platform: 'greenhouse', maxRequestsPerHour: 100, maxRequestsPerDay: 500 }],
    ['lever', { platform: 'lever', maxRequestsPerHour: 100, maxRequestsPerDay: 500 }],
    ['ashby', { platform: 'ashby', maxRequestsPerHour: 100, maxRequestsPerDay: 500 }],
    ['workable', { platform: 'workable', maxRequestsPerHour: 100, maxRequestsPerDay: 500 }],
    ['jobstreet', { platform: 'jobstreet', maxRequestsPerHour: 20, maxRequestsPerDay: 50 }],
    ['kalibrr', { platform: 'kalibrr', maxRequestsPerHour: 20, maxRequestsPerDay: 50 }],
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
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString()
    const { count, error } = await supabase
      .from('application_logs')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', userId)
      .eq('platform', platform)
      .gte('created_at', oneHourAgo)

    if (error) {
      console.error('Rate limit check failed:', error)
      return { allowed: true, remaining: 0, resetAt: new Date(Date.now() + 3600000) }
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
  async checkUserQuota(userId: string): Promise<{
    allowed: boolean
    remaining: number
    tier: 'free' | 'pro'
    resetsAt: Date
  }> {
    // Get user subscription tier
    const { data: subscription } = await supabase
      .from('subscriptions')
      .select('tier')
      .eq('user_id', userId)
      .single()

    const tier = subscription?.tier || 'free'
    const dailyLimit = tier === 'pro' ? 20 : 10

    // Count today's applications
    const startOfDay = new Date()
    startOfDay.setHours(0, 0, 0, 0)

    const { count, error } = await supabase
      .from('application_logs')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', userId)
      .eq('action', 'submit')
      .gte('created_at', startOfDay.toISOString())

    if (error) {
      console.error('Quota check failed:', error)
      return { allowed: true, remaining: 0, tier, resetsAt: new Date(Date.now() + 86400000) }
    }

    const used = count || 0
    const remaining = Math.max(0, dailyLimit - used)

    // Calculate reset time (next midnight)
    const resetsAt = new Date()
    resetsAt.setHours(24, 0, 0, 0)

    return {
      allowed: used < dailyLimit,
      remaining,
      tier,
      resetsAt,
    }
  }

  // Record platform request
  async recordRequest(userId: string, platform: string, action: string) {
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
    const results = []

    for (const [platform, config] of this.platformLimits) {
      const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString()
      const { count, error } = await supabase
        .from('application_logs')
        .select('*', { count: 'exact', head: true })
        .eq('user_id', userId)
        .eq('platform', platform)
        .gte('created_at', oneHourAgo)

      if (!error) {
        results.push({
          platform,
          limit: config.maxRequestsPerHour,
          used: count || 0,
          remaining: Math.max(0, config.maxRequestsPerHour - (count || 0)),
          resetAt: new Date(Date.now() + 60 * 60 * 1000),
        })
      }
    }

    return results
  }
}

export const rateLimitService = new RateLimitService()
