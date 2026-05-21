import { FastifyInstance, FastifyPluginOptions } from 'fastify'
import CryptoJS from 'crypto-js'
import { supabase } from '../index.js'

const ENCRYPTION_KEY = process.env.SESSION_ENCRYPTION_KEY || 'applify-default-key-change-me'

function encrypt(data: any): string {
  return CryptoJS.AES.encrypt(JSON.stringify(data), ENCRYPTION_KEY).toString()
}

function decrypt(encrypted: string): any {
  const bytes = CryptoJS.AES.decrypt(encrypted, ENCRYPTION_KEY)
  return JSON.parse(bytes.toString(CryptoJS.enc.Utf8))
}

export async function sessionRoutes(
  app: FastifyInstance,
  _opts: FastifyPluginOptions
) {
  // Get user's platform sessions
  app.get('/', async (request, reply) => {
    const userId = (request as any).user?.id
    if (!userId) {
      return reply.status(401).send({ error: 'Unauthorized' })
    }

    const { data, error } = await supabase
      .from('platform_sessions')
      .select('id, platform, is_active, expires_at, last_used_at, created_at')
      .eq('user_id', userId)

    if (error) {
      return reply.status(500).send({ error: error.message })
    }

    return data
  })

  // Create/update session for a platform
  app.post('/:platform', async (request, reply) => {
    const userId = (request as any).user?.id
    if (!userId) {
      return reply.status(401).send({ error: 'Unauthorized' })
    }

    const { platform } = request.params as { platform: string }
    const { session_data, expires_at } = request.body as any

    const encryptedData = encrypt(session_data)

    const { data: existing } = await supabase
      .from('platform_sessions')
      .select('id')
      .eq('user_id', userId)
      .eq('platform', platform)
      .single()

    let result
    if (existing) {
      result = await supabase
        .from('platform_sessions')
        .update({
          session_data: { encrypted: encryptedData },
          is_active: true,
          expires_at,
          last_used_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq('user_id', userId)
        .eq('platform', platform)
        .select()
    } else {
      result = await supabase
        .from('platform_sessions')
        .insert({
          user_id: userId,
          platform,
          session_data: { encrypted: encryptedData },
          is_active: true,
          expires_at,
        })
        .select()
    }

    if (result.error) {
      return reply.status(500).send({ error: result.error.message })
    }

    return result.data?.[0]
  })

  // Get decrypted session data (internal use)
  app.get('/:platform/data', async (request, reply) => {
    const userId = (request as any).user?.id
    if (!userId) {
      return reply.status(401).send({ error: 'Unauthorized' })
    }

    const { platform } = request.params as { platform: string }

    const { data, error } = await supabase
      .from('platform_sessions')
      .select('session_data')
      .eq('user_id', userId)
      .eq('platform', platform)
      .single()

    if (error || !data) {
      return reply.status(404).send({ error: 'Session not found' })
    }

    try {
      const decrypted = decrypt(data.session_data.encrypted)
      return { session_data: decrypted }
    } catch (err) {
      return reply.status(500).send({ error: 'Failed to decrypt session' })
    }
  })

  // Deactivate session
  app.delete('/:platform', async (request, reply) => {
    const userId = (request as any).user?.id
    if (!userId) {
      return reply.status(401).send({ error: 'Unauthorized' })
    }

    const { platform } = request.params as { platform: string }

    const { error } = await supabase
      .from('platform_sessions')
      .update({ is_active: false })
      .eq('user_id', userId)
      .eq('platform', platform)

    if (error) {
      return reply.status(500).send({ error: error.message })
    }

    return { success: true }
  })
}
