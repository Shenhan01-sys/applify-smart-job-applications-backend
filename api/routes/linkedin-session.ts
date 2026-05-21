import { FastifyInstance, FastifyPluginOptions } from 'fastify'
import { sessionManagerService } from '../../services/session-manager.service.js'
import { supabase } from '../index.js'

export async function linkedinSessionRoutes(
  app: FastifyInstance,
  _opts: FastifyPluginOptions
) {
  // Get LinkedIn session status
  app.get('/status', async (request, reply) => {
    const userId = (request as any).user?.id
    if (!userId) {
      return reply.status(401).send({ error: 'Unauthorized' })
    }

    try {
      const status = await sessionManagerService.checkSession(userId, 'linkedin')
      return status
    } catch (error: any) {
      return reply.status(500).send({ error: error.message })
    }
  })

  // Get login instructions
  app.get('/instructions', async (_request, reply) => {
    return {
      platform: 'linkedin',
      instructions: sessionManagerService.getLoginInstructions('linkedin'),
      requiredCookies: ['li_at', 'JSESSIONID', 'bcookie'],
      recommendedApproach: 'manual_browser_login',
    }
  })

  // Import session from browser
  app.post('/import', async (request, reply) => {
    const userId = (request as any).user?.id
    if (!userId) {
      return reply.status(401).send({ error: 'Unauthorized' })
    }

    const { cookies, userAgent, expiresDays = 30 } = request.body as any

    if (!cookies || !cookies.li_at) {
      return reply.status(400).send({ error: 'Missing required cookies (li_at)' })
    }

    try {
      const expiresAt = new Date()
      expiresAt.setDate(expiresAt.getDate() + expiresDays)

      const sessionData = {
        cookies,
        userAgent: userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        importedAt: new Date().toISOString(),
      }

      // Save to platform_sessions (encrypted by sessions route handler)
      const res = await fetch(`http://localhost:${process.env.PORT || 4000}/api/sessions/linkedin`, {
        method: 'POST',
        headers: {
          Authorization: request.headers.authorization || '',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          session_data: sessionData,
          expires_at: expiresAt.toISOString(),
        }),
      })

      if (!res.ok) {
        const err = await res.text()
        throw new Error(err)
      }

      const result = await res.json()

      return {
        success: true,
        message: 'LinkedIn session imported successfully',
        expiresAt: expiresAt.toISOString(),
        session: result,
      }
    } catch (error: any) {
      return reply.status(500).send({ error: error.message })
    }
  })

  // Verify current session
  app.post('/verify', async (request, reply) => {
    const userId = (request as any).user?.id
    if (!userId) {
      return reply.status(401).send({ error: 'Unauthorized' })
    }

    try {
      const sessionData = await sessionManagerService.getLinkedInSession(userId)

      if (!sessionData) {
        return { valid: false, message: 'No session found' }
      }

      const isValid = await sessionManagerService.verifyLinkedInSession(sessionData)

      return {
        valid: isValid,
        message: isValid ? 'Session is valid' : 'Session invalid or expired',
      }
    } catch (error: any) {
      return reply.status(500).send({ error: error.message })
    }
  })

  // Refresh session
  app.post('/refresh', async (request, reply) => {
    const userId = (request as any).user?.id
    if (!userId) {
      return reply.status(401).send({ error: 'Unauthorized' })
    }

    try {
      // Get existing session
      const { data: existing } = await supabase
        .from('platform_sessions')
        .select('*')
        .eq('user_id', userId)
        .eq('platform', 'linkedin')
        .single()

      if (!existing) {
        return reply.status(404).send({ error: 'No LinkedIn session found to refresh' })
      }

      // Extend expiry by 30 days
      const newExpiresAt = new Date()
      newExpiresAt.setDate(newExpiresAt.getDate() + 30)

      const { error } = await supabase
        .from('platform_sessions')
        .update({
          expires_at: newExpiresAt.toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq('id', existing.id)

      if (error) {
        return reply.status(500).send({ error: error.message })
      }

      return {
        success: true,
        message: 'Session refreshed',
        newExpiresAt: newExpiresAt.toISOString(),
      }
    } catch (error: any) {
      return reply.status(500).send({ error: error.message })
    }
  })
}
