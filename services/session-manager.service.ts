import { supabase } from '../api/index.js'
import { LinkedInMCPClient } from '../mcp/linkedin/index.js'

export class SessionManagerService {
  private linkedinClient = new LinkedInMCPClient()

  /**
   * Check if user has a valid session for a platform
   */
  async checkSession(userId: string, platform: string): Promise<{
    hasSession: boolean
    isValid: boolean
    expiresAt?: string
    lastUsed?: string
  }> {
    const { data, error } = await supabase
      .from('platform_sessions')
      .select('*')
      .eq('user_id', userId)
      .eq('platform', platform)
      .single()

    if (error || !data) {
      return { hasSession: false, isValid: false }
    }

    const now = new Date()
    const expiresAt = data.expires_at ? new Date(data.expires_at) : null
    const isValid = data.is_active && (!expiresAt || expiresAt > now)

    return {
      hasSession: true,
      isValid,
      expiresAt: data.expires_at,
      lastUsed: data.last_used_at,
    }
  }

  /**
   * Get session data for LinkedIn browser initialization
   */
  async getLinkedInSession(userId: string): Promise<any> {
    const { data, error } = await supabase
      .from('platform_sessions')
      .select('session_data')
      .eq('user_id', userId)
      .eq('platform', 'linkedin')
      .single()

    if (error || !data) {
      return null
    }

    try {
      // Decrypt session data (decryption handled by sessions route)
      return data.session_data
    } catch (err) {
      console.error('Failed to parse session data:', err)
      return null
    }
  }

  /**
   * Verify LinkedIn session by testing a page load
   */
  async verifyLinkedInSession(sessionData: any): Promise<boolean> {
    try {
      // Initialize browser with session
      const client = new LinkedInMCPClient()
      // This would need to be implemented with actual browser context
      // For now, return based on session data presence
      return !!sessionData && Object.keys(sessionData).length > 0
    } catch (error) {
      console.error('Session verification failed:', error)
      return false
    }
  }

  /**
   * Get instructions for user to login manually
   */
  getLoginInstructions(platform: string): string {
    const instructions: Record<string, string> = {
      linkedin: `To enable LinkedIn automation:
1. Open Chrome browser
2. Login to LinkedIn with your credentials
3. Stay logged in (do not logout)
4. Export cookies using browser dev tools or extension
5. Paste the exported session data in the field below

Alternatively, our team can help setup persistent browser profiles.`,
      jobstreet: `To enable JobStreet automation:
1. Login to JobStreet Indonesia (jobstreet.co.id)
2. Keep browser session active
3. Export session cookies
4. Paste below for automation use`,
    }

    return instructions[platform] || `Login to ${platform} and export session cookies.`
  }

  /**
   * Delete expired sessions
   */
  async cleanupExpiredSessions(): Promise<number> {
    const { data, error } = await supabase
      .from('platform_sessions')
      .delete()
      .lt('expires_at', new Date().toISOString())
      .neq('expires_at', null)

    if (error) {
      console.error('Failed to cleanup sessions:', error)
      return 0
    }

    return (data as any[])?.length || 0
  }
}

export const sessionManagerService = new SessionManagerService()
