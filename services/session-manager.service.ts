import { LinkedInMCPClient } from '../mcp/linkedin/index.js'
import { SessionDecryptError, decryptSession } from './session-crypto.js'

export class SessionManagerService {
  private linkedinClient = new LinkedInMCPClient()

  /**
   * `client` hanya diisi di tes. Tanpa itu, klien Supabase milik server dimuat saat pertama dipakai
   * (bukan saat modul di-import, supaya modul ini bisa di-import tanpa menyalakan server).
   */
  constructor(private readonly client?: { from(table: string): any }) {}

  private async db(): Promise<{ from(table: string): any }> {
    return this.client ?? ((await import('../api/index.js')).supabase as unknown as { from(table: string): any })
  }

  /**
   * Check if user has a valid session for a platform
   */
  async checkSession(userId: string, platform: string): Promise<{
    hasSession: boolean
    isValid: boolean
    expiresAt?: string
    lastUsed?: string
  }> {
    const supabase = await this.db()
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
   * Data sesi LinkedIn yang sudah didekripsi, atau null bila tidak ada sesi atau sesinya tidak dapat dibaca.
   * Melempar SessionKeyConfigError bila SESSION_ENCRYPTION_KEY tidak layak (kosong, pendek, atau nilai contoh):
   * sesi tidak dibaca tanpa kunci yang sah, dan tidak ada kunci bawaan (session-crypto.ts).
   */
  async getLinkedInSession(userId: string): Promise<any> {
    const supabase = await this.db()
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
      return decryptSession(data.session_data?.encrypted)
    } catch (err) {
      if (err instanceof SessionDecryptError) {
        console.error('LinkedIn session cannot be decrypted with the current key:', err.message)
        return null
      }
      throw err
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
      // For now, return based on the decrypted session holding the LinkedIn login cookie
      return !!sessionData?.cookies?.li_at
    } catch (error) {
      console.error('Session verification failed:', String((error as any)?.message ?? error).slice(0, 120))
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
    const supabase = await this.db()
    const { data, error } = await supabase
      .from('platform_sessions')
      .delete()
      .lt('expires_at', new Date().toISOString())
      .neq('expires_at', null)

    if (error) {
      console.error('Failed to cleanup sessions:', String((error as any)?.code ?? (error as any)?.message ?? 'db_error').slice(0, 120))
      return 0
    }

    return (data as any[])?.length || 0
  }
}

export const sessionManagerService = new SessionManagerService()
