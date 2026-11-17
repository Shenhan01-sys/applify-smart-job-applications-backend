import { FastifyInstance, FastifyPluginOptions, FastifyReply, FastifyRequest } from 'fastify'
import {
  SessionDecryptError,
  SessionKeyConfigError,
  decryptSession,
  encryptSession,
  sessionKeyProblem,
} from '../../services/session-crypto.js'

/**
 * Sesi platform (cookie LinkedIn dll.) disimpan terenkripsi di platform_sessions. Kunci hanya dari
 * SESSION_ENCRYPTION_KEY dan tidak ada kunci bawaan (services/session-crypto.ts): tanpa kunci yang sah (kosong,
 * kurang dari 32 karakter, atau nilai contoh .env.example) rute yang menyimpan atau membaca sesi menjawab
 * 503 `session_encryption_not_configured` dan galatnya dicatat di log server. Daftar sesi (tanpa data) tetap jalan.
 */

/** Hanya tes yang mengisi `db`; produksi memuat klien Supabase server saat pertama dipakai. */
export interface SessionRoutesOptions extends FastifyPluginOptions {
  db?: { from(table: string): any }
}

/** 503 untuk kunci yang tidak layak; galat konfigurasi masuk ke log server (tanpa nilai kunci). */
function replyConfigError(request: FastifyRequest, reply: FastifyReply, problem: string) {
  request.log.error(`[config] ${problem}`)
  return reply.status(503).send({ error: problem, code: 'session_encryption_not_configured' })
}

export async function sessionRoutes(
  app: FastifyInstance,
  opts: SessionRoutesOptions
) {
  const getDb = async () => opts.db ?? (await import('../index.js')).supabase

  // Get user's platform sessions
  app.get('/', async (request, reply) => {
    const userId = (request as any).user?.id
    if (!userId) {
      return reply.status(401).send({ error: 'Unauthorized' })
    }

    const supabase = await getDb()
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
    const { session_data, expires_at } = (request.body ?? {}) as any

    // Tanpa kunci yang sah, tidak ada yang disimpan.
    const problem = sessionKeyProblem()
    if (problem) return replyConfigError(request, reply, problem)
    if (!session_data || typeof session_data !== 'object') {
      return reply.status(400).send({ error: 'session_data (object) is required' })
    }

    let encryptedData: string
    try {
      encryptedData = encryptSession(session_data)
    } catch (err: any) {
      if (err instanceof SessionKeyConfigError) return replyConfigError(request, reply, err.message)
      throw err
    }

    const supabase = await getDb()
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

    // Tanpa kunci yang sah, tidak ada yang dibaca.
    const problem = sessionKeyProblem()
    if (problem) return replyConfigError(request, reply, problem)

    const supabase = await getDb()
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
      const decrypted = decryptSession(data.session_data?.encrypted)
      return { session_data: decrypted }
    } catch (err: any) {
      if (err instanceof SessionKeyConfigError) return replyConfigError(request, reply, err.message)
      if (err instanceof SessionDecryptError) {
        request.log.error(`[sessions] ${platform}: ${err.message}`)
        return reply.status(422).send({ error: err.message, code: err.code })
      }
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

    const supabase = await getDb()
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
