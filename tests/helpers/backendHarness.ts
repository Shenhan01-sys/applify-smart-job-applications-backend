import './offlineGuard.ts'
import net from 'node:net'
import crypto from 'node:crypto'
import { startFakeSupabase, type FakeSupabase } from './fakeSupabase.ts'

/**
 * Menjalankan server backend SUNGGUHAN (api/index.ts: Fastify, authMiddleware, rute, services, klien supabase-js)
 * terhadap Supabase tiruan strik (fakeSupabase.ts) di 127.0.0.1. Yang dipanggil tes adalah HTTP sungguhan.
 *
 * Aturan keselamatan, ditegakkan di sini:
 *   - SUPABASE_URL selalu alamat tiruan lokal. Berkas .env tidak dimuat (DOTENV_CONFIG_PATH menunjuk ke berkas yang tidak ada).
 *   - fetch hanya boleh ke 127.0.0.1 / localhost; lainnya melempar. Kunci AI dan Telegram dihapus dari env.
 *   - Supabase production (dreexbadvlxufkrvvwrq) tidak pernah disentuh: tidak ada URL atau kunci sungguhan di proses ini.
 *
 * Berkas ini dimuat dengan top-level await, jadi berkas tes cukup `await import('../helpers/backendHarness.ts')`.
 */

export const USER_A = { id: '11111111-1111-4111-8111-111111111111', email: 'budi.uji@contoh.test', token: 'token-user-a' }
export const USER_B = { id: '22222222-2222-4222-8222-222222222222', email: 'sari.uji@contoh.test', token: 'token-user-b' }

const LOCAL = new Set(['127.0.0.1', 'localhost', '[::1]'])
const realFetch = globalThis.fetch
globalThis.fetch = (async (input: any, init?: any) => {
  const u = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
  if (!LOCAL.has(u.hostname)) throw new Error(`integration harness: outbound request to ${u.hostname} blocked`)
  return realFetch(input, init)
}) as typeof fetch

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer()
    s.once('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as net.AddressInfo).port
      s.close(() => resolve(port))
    })
  })
}

export const fake: FakeSupabase = await startFakeSupabase()
fake.addUser(USER_A.token, { id: USER_A.id, email: USER_A.email })
fake.addUser(USER_B.token, { id: USER_B.id, email: USER_B.email })

const port = await freePort()
export const BASE = `http://127.0.0.1:${port}`

process.env.DOTENV_CONFIG_PATH = '/nonexistent/applify-integration.env'
process.env.SUPABASE_URL = fake.url
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key-not-real'
process.env.PORT = String(port)
process.env.NODE_ENV = 'production' // log JSON polos, bukan pino-pretty
process.env.FRONTEND_URL = 'http://127.0.0.1:5173'
process.env.OAUTH_TOKEN_ENCRYPTION_KEY = 'integration-test-key-not-real'
for (const k of [
  'ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY', 'GROQ_API_KEY', 'GEMINI_API_KEY', 'NUMES_API_KEY', 'NUMES_API_KEY_2', 'NUMES_API_KEY_3', 'NUMES_API_KEYS', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID',
  'LANGFUSE_SECRET_KEY', 'LANGFUSE_PUBLIC_KEY', 'SESSION_ENCRYPTION_KEY',
]) delete process.env[k]

await import('../../api/index.ts')

// Tunggu server siap.
{
  const end = Date.now() + 20_000
  for (;;) {
    try {
      const r = await fetch(`${BASE}/health`)
      if (r.ok) break
    } catch {
      /* belum siap */
    }
    if (Date.now() > end) throw new Error('backend did not start')
    await new Promise((r) => setTimeout(r, 100))
  }
}

export interface ApiResult<T = any> {
  status: number
  body: T
  text: string
}

export async function api<T = any>(
  method: string,
  path: string,
  opts: { user?: { token: string } | null; body?: unknown; rawBody?: string } = {}
): Promise<ApiResult<T>> {
  const user = opts.user === undefined ? USER_A : opts.user
  const headers: Record<string, string> = {}
  if (user) headers.authorization = `Bearer ${user.token}`
  let body: string | undefined
  if (opts.rawBody !== undefined) {
    body = opts.rawBody
    headers['content-type'] = 'application/json'
  } else if (opts.body !== undefined) {
    body = JSON.stringify(opts.body)
    headers['content-type'] = 'application/json'
  }
  const res = await fetch(`${BASE}${path}`, { method, headers, body })
  const text = await res.text()
  let parsed: any = text
  try {
    parsed = text ? JSON.parse(text) : null
  } catch {
    /* bukan JSON */
  }
  return { status: res.status, body: parsed, text }
}

/** Dekripsi format token-crypto (iv 12 + tag 16 + ciphertext, base64), sama dengan worker/src/lib/crypto.ts. */
export function decryptLikeWorker(b64: string): string {
  const key = crypto.createHash('sha256').update(process.env.OAUTH_TOKEN_ENCRYPTION_KEY!).digest()
  const buf = Buffer.from(b64, 'base64')
  const d = crypto.createDecipheriv('aes-256-gcm', key, buf.subarray(0, 12))
  d.setAuthTag(buf.subarray(12, 28))
  return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8')
}

let n = 0
/** UUID deterministik per awalan, supaya baris seed mudah dibaca di pesan galat. */
export function uuid(prefix = 'a'): string {
  const hex = (++n).toString(16).padStart(12, '0')
  const p = (prefix.replace(/[^0-9a-f]/gi, '') || 'a').padEnd(8, '0').slice(0, 8)
  return `${p}-0000-4000-8000-${hex}`
}

export const future = (ms = 3_600_000) => new Date(Date.now() + ms).toISOString()
export const past = (ms = 60_000) => new Date(Date.now() - ms).toISOString()

/** Pasang baris dasar untuk satu pengguna: lowongan, lamaran draf, dan persetujuan. */
export function seedApproval(over: { approval?: Record<string, any>; application?: Record<string, any>; job?: Record<string, any>; user?: { id: string } } = {}) {
  const user = over.user ?? USER_A
  const jobId = uuid('b0b0')
  const appId = uuid('a99')
  const approvalId = uuid('a77')
  fake.seed('jobs', { id: jobId, title: 'Backend Engineer', company: 'Fixture Co', platform_source: 'greenhouse', external_url: 'https://boards.greenhouse.io/fixture/jobs/1', ...over.job })
  fake.seed('ai_applications', { id: appId, user_id: user.id, job_id: jobId, status: 'ready', cover_letter: 'Surat awal', ...over.application })
  fake.seed('approval_requests', {
    id: approvalId, user_id: user.id, job_id: jobId, application_id: appId, job_title: 'Backend Engineer', company: 'Fixture Co',
    platform: 'greenhouse', cover_letter: 'Surat awal', status: 'approved', expires_at: future(), ...over.approval,
  })
  return { jobId, appId, approvalId }
}
