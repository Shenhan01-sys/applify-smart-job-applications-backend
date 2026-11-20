import { FastifyRequest, FastifyReply } from 'fastify'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

type GetUser = (token: string) => Promise<{ data: { user: any | null }; error: { message?: string; status?: number } | null }>

export type TokenCheck =
  | { ok: true; user: any }
  | { ok: false; status: 401 | 503; error: string }

/**
 * Verifikasi token ke Supabase Auth.
 *
 * Uji klik 20 November 2026: `getUser` sempat gagal dengan `TypeError: fetch failed` (jaringan Railway ke Supabase),
 * lalu middleware lama menjawab 401 sesudah 10 detik. Token pengguna sebenarnya sah, sehingga 401 menyesatkan.
 * Sekarang galat jaringan dicoba sekali lagi; bila tetap gagal jawabannya 503 (layanan login tidak terjangkau).
 * Token yang memang ditolak Supabase tetap 401.
 */
export async function verifyToken(getUser: GetUser, token: string, retryDelayMs = 300): Promise<TokenCheck> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const { data, error } = await getUser(token)
      if (data?.user && !error) return { ok: true, user: data.user }
      // Galat dari server auth (5xx) atau galat jaringan yang dibungkus auth-js: boleh dicoba lagi.
      const transient = !!error && (error.status === undefined || error.status === 0 || error.status >= 500)
      if (!transient) return { ok: false, status: 401, error: 'Invalid token' }
    } catch {
      // galat jaringan yang dilempar (TypeError: fetch failed): coba lagi
    }
    if (attempt === 0) await new Promise((r) => setTimeout(r, retryDelayMs))
  }
  return { ok: false, status: 503, error: 'Layanan login sedang tidak terjangkau. Coba lagi sebentar.' }
}

let client: SupabaseClient | null = null
function authClient(): SupabaseClient {
  client ??= createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
  return client
}

export async function authMiddleware(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const authHeader = request.headers.authorization

  if (!authHeader?.startsWith('Bearer ')) {
    return reply.status(401).send({ error: 'Missing or invalid authorization header' })
  }

  const token = authHeader.substring(7)
  const sb = authClient()
  const check = await verifyToken((t) => sb.auth.getUser(t) as any, token)
  // `'status' in` dipakai karena tsconfig tidak strict, sehingga `!check.ok` tidak mempersempit tipe.
  if ('status' in check) {
    if (check.status === 503) request.log.warn('[auth] Supabase Auth tidak terjangkau sesudah dua percobaan')
    return reply.status(check.status).send({ error: check.error })
  }
  ;(request as any).user = check.user
}
