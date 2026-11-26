import { FastifyInstance, FastifyPluginOptions, FastifyReply, FastifyRequest } from 'fastify'
import {
  SessionKeyConfigError,
  encryptSession,
  sessionKeyProblem,
} from '../../services/session-crypto.js'

/**
 * Sesi platform (cookie LinkedIn dll.) disimpan terenkripsi di platform_sessions. Kunci hanya dari
 * SESSION_ENCRYPTION_KEY dan tidak ada kunci bawaan (services/session-crypto.ts): tanpa kunci yang sah (kosong,
 * kurang dari 32 karakter, atau nilai contoh .env.example) rute yang menyimpan sesi menjawab
 * 503 `session_encryption_not_configured` dan galatnya dicatat di log server. Daftar sesi (tanpa data) tetap jalan.
 *
 * Keamanan (F-01, BS-08):
 *   - Endpoint `GET /:platform/data` dihapus supaya cookie terdekripsi tidak pernah dikembalikan lewat HTTP.
 *   - Parameter `:platform` dibatasi ke daftar izin eksplisit (menolak `gmail` milik OAuth dan nilai sembarang).
 *   - Respons POST hanya mengembalikan metadata baris (tanpa ciphertext `session_data`).
 */

export const ALLOWED_SESSION_PLATFORMS = new Set([
  'linkedin',
  'jobstreet',
  'kalibrr',
  'glints',
  'dealls',
])

const SESSION_PUBLIC_COLUMNS = 'id, platform, is_active, expires_at, last_used_at, created_at'

function normalizeAllowedPlatform(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const p = raw.trim().toLowerCase()
  return ALLOWED_SESSION_PLATFORMS.has(p) ? p : null
}

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
      .select(SESSION_PUBLIC_COLUMNS)
      .eq('user_id', userId)

    if (error) {
      request.log.error({ err: String(error.message ?? error).slice(0, 200) }, 'sessions: list failed')
      return reply.status(500).send({ error: 'Gagal memuat sesi platform' })
    }

    return data
  })

  // Create/update session for a platform
  app.post('/:platform', async (request, reply) => {
    const userId = (request as any).user?.id
    if (!userId) {
      return reply.status(401).send({ error: 'Unauthorized' })
    }

    const { platform: rawPlatform } = request.params as { platform: string }
    const platform = normalizeAllowedPlatform(rawPlatform)
    if (!platform) {
      return reply.status(400).send({ error: 'Platform sesi tidak didukung', code: 'invalid_platform' })
    }
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
        .select(SESSION_PUBLIC_COLUMNS)
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
        .select(SESSION_PUBLIC_COLUMNS)
    }

    if (result.error) {
      request.log.error({ err: String(result.error.message ?? result.error).slice(0, 200) }, 'sessions: save failed')
      return reply.status(500).send({ error: 'Gagal menyimpan sesi platform' })
    }

    const row = result.data?.[0]
    if (row && typeof row === 'object') {
      const { session_data: _omitted, ...safeRow } = row as Record<string, unknown>
      return safeRow
    }
    return row
  })

  // Deactivate session
  app.delete('/:platform', async (request, reply) => {
    const userId = (request as any).user?.id
    if (!userId) {
      return reply.status(401).send({ error: 'Unauthorized' })
    }

    const { platform: rawPlatform } = request.params as { platform: string }
    const platform = normalizeAllowedPlatform(rawPlatform)
    if (!platform) {
      return reply.status(400).send({ error: 'Platform sesi tidak didukung', code: 'invalid_platform' })
    }

    const supabase = await getDb()
    // F-06: bersihkan ciphertext cookie saat sesi dinonaktifkan agar tidak tertinggal di DB.
    const { error } = await supabase
      .from('platform_sessions')
      .update({
        is_active: false,
        session_data: {},
        updated_at: new Date().toISOString(),
      })
      .eq('user_id', userId)
      .eq('platform', platform)

    if (error) {
      request.log.error({ err: String(error.message ?? error).slice(0, 200) }, 'sessions: delete failed')
      return reply.status(500).send({ error: 'Gagal menonaktifkan sesi platform' })
    }

    return { success: true }
  })
}
