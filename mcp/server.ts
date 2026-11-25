import 'dotenv/config'
import crypto from 'node:crypto'
import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'
import { mcpRegistry } from '../services/mcp-registry.js'
import { aggregateJobs } from '../services/job-aggregation.service.js'

/**
 * Applify Jobs MCP Server — server Model Context Protocol SUNGGUHAN yang
 * membungkus seluruh klien sumber lowongan Applify (Greenhouse, Lever, Ashby,
 * Workable, SmartRecruiters, JobStreet, Glints, Kalibrr, LinkedIn) sebagai tool MCP.
 *
 * Tool:
 *   - list_platforms        : daftar sumber + jenis + papan default
 *   - search_jobs           : cari di SATU sumber (butuh `company` untuk sumber ATS)
 *   - search_all_platforms  : agregasi lintas sumber + ranking relevansi deterministik
 *   - get_job_details       : detail satu lowongan (bila sumber mendukung)
 *
 * Transport:
 *   stdio (default)  -> untuk agen AI desktop (Claude Code, Kilo, dll.)
 *        npm run mcp:jobs
 *   Streamable HTTP  -> untuk worker Applify (APPLIFY_JOBS_MCP_URL=http://127.0.0.1:8090/mcp)
 *        npm run mcp:jobs:http      (port: APPLIFY_JOBS_MCP_PORT, default 8090; host default 127.0.0.1)
 *
 * Pengamanan HTTP (BS-P1-01, BS-P1-03):
 *   - Secara default mengikat hanya ke 127.0.0.1 (APPLIFY_JOBS_MCP_HOST).
 *   - Mengikat di luar loopback wajib menyertakan APPLIFY_JOBS_MCP_TOKEN (Bearer / x-mcp-token).
 *   - Pemeriksaan header Host & Origin (tolak browser cross-origin / DNS rebinding).
 *   - Batas ukuran body 256 KB (413), batas waktu baca (408), dan rate limit per pemanggil (429).
 *     Default 300/menit untuk pemanggil loopback (worker) dan 30/menit untuk lainnya;
 *     APPLIFY_JOBS_MCP_RATE_PER_MIN menimpa keduanya.
 *   - Batas fan-out tool: maksimal 10 platform dan limitPerSource maksimal 25.
 *
 * Server ini stateless dan TIDAK menyentuh database; penyimpanan dilakukan pemanggil
 * (backend /api/automation/search atau worker handler `search`).
 */

export const DEFAULT_MCP_HOST = '127.0.0.1'
export const MAX_MCP_BODY_BYTES = 256 * 1024
export const DEFAULT_BODY_READ_TIMEOUT_MS = 10_000
export const MAX_MCP_PLATFORMS = 10
export const MAX_MCP_LIMIT_PER_SOURCE = 25
export const MAX_MCP_SINGLE_LIMIT = 50
export const DEFAULT_MCP_RATE_LIMIT = { maxRequests: 30, windowMs: 60_000 } as const
/** Pemanggil loopback (worker Applify di mesin yang sama) memakai batas lebih longgar: satu pencarian = ~3 POST. */
export const DEFAULT_MCP_LOOPBACK_RATE_LIMIT = { maxRequests: 300, windowMs: 60_000 } as const

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host.trim().toLowerCase())
}

/** Alamat socket pemanggil ada di loopback (IPv4 127.x.x.x, IPv6 ::1, atau IPv4-mapped). */
export function isLoopbackAddress(addr: string | undefined | null): boolean {
  if (!addr) return false
  const a = addr.trim().toLowerCase().replace(/^::ffff:/, '')
  return a === '::1' || /^127(?:\.\d{1,3}){3}$/.test(a)
}

/**
 * Batas request per menit per pemanggil. APPLIFY_JOBS_MCP_RATE_PER_MIN (bilangan bulat positif) mengatur
 * batas untuk semua pemanggil; tanpa env, pemanggil loopback 300/menit dan pemanggil lain 30/menit.
 * Nilai env yang tidak valid diabaikan.
 */
export function resolveMcpRateLimits(
  envValue: string | undefined = process.env.APPLIFY_JOBS_MCP_RATE_PER_MIN,
): { loopback: { maxRequests: number; windowMs: number }; remote: { maxRequests: number; windowMs: number } } {
  const raw = envValue?.trim()
  const parsed = raw && /^\d+$/.test(raw) ? Number(raw) : NaN
  if (Number.isSafeInteger(parsed) && parsed > 0) {
    const limit = { maxRequests: parsed, windowMs: DEFAULT_MCP_RATE_LIMIT.windowMs }
    return { loopback: limit, remote: limit }
  }
  return {
    loopback: { ...DEFAULT_MCP_LOOPBACK_RATE_LIMIT },
    remote: { ...DEFAULT_MCP_RATE_LIMIT },
  }
}

function parseHostname(rawHostHeader: string | undefined): string {
  if (!rawHostHeader) return ''
  const trimmed = rawHostHeader.trim().toLowerCase()
  if (!trimmed) return ''
  const match = trimmed.match(/^(\[[0-9a-f:]+\]|[^:\s/@]+)(?::\d{1,5})?$/)
  return match ? match[1] : ''
}

export function isAllowedHostHeader(
  rawHostHeader: string | undefined,
  allowedHosts?: ReadonlySet<string>,
): boolean {
  const host = parseHostname(rawHostHeader)
  if (!host) return false
  if (isLoopbackHost(host)) return true
  if (allowedHosts && allowedHosts.has(host)) return true
  return false
}

export function isAllowedOriginHeader(
  originHeader: string | undefined,
  allowedOrigins?: ReadonlySet<string>,
): boolean {
  if (!originHeader) return true
  const normalized = originHeader.trim().toLowerCase()
  if (!normalized) return true
  return Boolean(allowedOrigins && allowedOrigins.has(normalized))
}

export function tokensEqual(provided: string, expected: string): boolean {
  const a = crypto.createHash('sha256').update(provided, 'utf8').digest()
  const b = crypto.createHash('sha256').update(expected, 'utf8').digest()
  return crypto.timingSafeEqual(a, b)
}

function extractRequestToken(req: IncomingMessage): string | null {
  const auth = req.headers.authorization
  if (typeof auth === 'string') {
    const m = auth.match(/^Bearer\s+(.+)$/i)
    if (m && m[1].trim()) return m[1].trim()
  }
  const header = req.headers['x-mcp-token']
  if (typeof header === 'string' && header.trim()) return header.trim()
  return null
}

function parseCsvSet(raw: string | undefined): Set<string> {
  if (!raw) return new Set()
  return new Set(
    raw
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  )
}

class HttpBodyError extends Error {
  constructor(
    readonly statusCode: 400 | 408 | 413,
    message: string,
  ) {
    super(message)
    this.name = 'HttpBodyError'
  }
}

export function createMcpRateLimiter(
  maxRequests: number = DEFAULT_MCP_RATE_LIMIT.maxRequests,
  windowMs: number = DEFAULT_MCP_RATE_LIMIT.windowMs,
) {
  const hits = new Map<string, number[]>()
  return (key: string, now: number = Date.now()): { allowed: true } | { allowed: false; retryAfterSec: number } => {
    const cutoff = now - windowMs
    if (hits.size > 1000) {
      for (const [k, ts] of hits) {
        if (ts.every((t) => t <= cutoff)) hits.delete(k)
      }
    }
    const recent = (hits.get(key) ?? []).filter((t) => t > cutoff)
    if (recent.length >= maxRequests) {
      hits.set(key, recent)
      const oldest = recent[0] ?? now
      const retryAfterSec = Math.max(1, Math.ceil((oldest + windowMs - now) / 1000))
      return { allowed: false, retryAfterSec }
    }
    recent.push(now)
    hits.set(key, recent)
    return { allowed: true }
  }
}

const json = (data: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] })

export function buildServer(): McpServer {
  const server = new McpServer({ name: 'applify-jobs', version: '1.0.0' })

  server.registerTool(
    'list_platforms',
    {
      title: 'Daftar sumber lowongan',
      description: 'Daftar sumber lowongan yang didukung Applify beserta jenisnya (ats/board/browser) dan papan perusahaan default.',
      inputSchema: {},
    },
    async () => json(mcpRegistry.describe()),
  )

  server.registerTool(
    'search_jobs',
    {
      title: 'Cari lowongan di satu sumber',
      description:
        'Cari lowongan di satu sumber. Sumber ATS (greenhouse, lever, ashby, workable, smartrecruiters) wajib diberi `company` (slug papan karier).',
      inputSchema: {
        platform: z.string().describe('id sumber, mis. kalibrr, jobstreet, glints, greenhouse'),
        keywords: z.string().optional(),
        location: z.string().optional(),
        company: z.string().optional().describe('slug papan karier untuk sumber ATS'),
        limit: z.number().int().min(1).max(MAX_MCP_SINGLE_LIMIT).optional(),
      },
    },
    async ({ platform, keywords, location, company, limit }) => {
      const client = mcpRegistry.get(platform.toLowerCase())
      if (!client) return { ...json({ success: false, error: `sumber tidak dikenal: ${platform}` }), isError: true }
      const res = await client.searchJobs({ keywords, location, company, limit })
      return { ...json(res), isError: !res.success }
    },
  )

  server.registerTool(
    'search_all_platforms',
    {
      title: 'Agregasi lowongan lintas sumber',
      description:
        'Agregasi lowongan dari banyak sumber sekaligus, filter lokasi (default Indonesia), hapus duplikat, dan urutkan dengan skor relevansi weighted keyword overlap (0-100).',
      inputSchema: {
        keywords: z.string().optional(),
        location: z.string().optional().describe("default 'Indonesia'; 'any' untuk tanpa filter"),
        platforms: z.array(z.string()).max(MAX_MCP_PLATFORMS).optional().describe('default semua sumber non-browser (maks 10)'),
        companies: z.record(z.string(), z.array(z.string()).max(20)).optional().describe('override papan ATS, mis. {"greenhouse":["acommerce"]}'),
        skills: z.array(z.string()).max(30).optional().describe('skill kandidat untuk pembobotan relevansi'),
        limitPerSource: z.number().int().min(1).max(MAX_MCP_LIMIT_PER_SOURCE).optional(),
      },
    },
    async (args) => json(await aggregateJobs(args)),
  )

  server.registerTool(
    'get_job_details',
    {
      title: 'Detail lowongan',
      description: 'Ambil detail satu lowongan dari sumber yang mendukung (greenhouse, lever, smartrecruiters memerlukan company).',
      inputSchema: {
        platform: z.string(),
        jobId: z.string(),
        company: z.string().optional(),
      },
    },
    async ({ platform, jobId, company }) => {
      const client = mcpRegistry.get(platform.toLowerCase())
      if (!client) return { ...json({ success: false, error: `sumber tidak dikenal: ${platform}` }), isError: true }
      const res = await client.getJobDetails(jobId, company)
      return { ...json(res), isError: !res.success }
    },
  )

  return server
}

async function readBody(
  req: IncomingMessage,
  maxBytes: number = MAX_MCP_BODY_BYTES,
  timeoutMs: number = DEFAULT_BODY_READ_TIMEOUT_MS,
): Promise<any> {
  const declaredLength = Number(req.headers['content-length'])
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    req.resume()
    throw new HttpBodyError(413, `Request body exceeds ${maxBytes} bytes`)
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let totalBytes = 0
    let done = false

    const finish = (fn: () => void) => {
      if (done) return
      done = true
      clearTimeout(timer)
      req.off('data', onData)
      req.off('end', onEnd)
      req.off('error', onError)
      fn()
    }

    const timer = setTimeout(() => {
      finish(() => {
        req.destroy()
        reject(new HttpBodyError(408, 'Request body read timeout'))
      })
    }, timeoutMs)
    timer.unref?.()

    const onData = (chunk: Buffer | string) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      totalBytes += buf.length
      if (totalBytes > maxBytes) {
        finish(() => {
          req.resume()
          reject(new HttpBodyError(413, `Request body exceeds ${maxBytes} bytes`))
        })
        return
      }
      chunks.push(buf)
    }

    const onEnd = () => {
      finish(() => {
        const raw = Buffer.concat(chunks).toString('utf8')
        if (!raw) {
          resolve(undefined)
          return
        }
        try {
          resolve(JSON.parse(raw))
        } catch {
          reject(new HttpBodyError(400, 'Invalid JSON body'))
        }
      })
    }

    const onError = (err: Error) => {
      finish(() => reject(err))
    }

    req.on('data', onData)
    req.on('end', onEnd)
    req.on('error', onError)
  })
}

export interface McpHttpOptions {
  host?: string
  token?: string
  maxBodyBytes?: number
  bodyReadTimeoutMs?: number
  allowedHosts?: ReadonlySet<string>
  allowedOrigins?: ReadonlySet<string>
  rateLimit?: { maxRequests: number; windowMs: number }
}

export function createMcpHttpServer(opts: McpHttpOptions = {}): Server {
  const host = (opts.host ?? process.env.APPLIFY_JOBS_MCP_HOST ?? DEFAULT_MCP_HOST).trim() || DEFAULT_MCP_HOST
  const token = (opts.token ?? process.env.APPLIFY_JOBS_MCP_TOKEN ?? '').trim()
  if (!isLoopbackHost(host) && !token) {
    throw new Error(
      `[applify-jobs-mcp] Binding ke host non-loopback (${host}) wajib menyertakan APPLIFY_JOBS_MCP_TOKEN.`,
    )
  }

  const maxBodyBytes = opts.maxBodyBytes ?? MAX_MCP_BODY_BYTES
  const bodyReadTimeoutMs = opts.bodyReadTimeoutMs ?? DEFAULT_BODY_READ_TIMEOUT_MS
  const configuredHosts = opts.allowedHosts ?? parseCsvSet(process.env.APPLIFY_JOBS_MCP_ALLOWED_HOSTS)
  const allowedHosts = new Set(configuredHosts)
  const normalizedBoundHost = host.toLowerCase()
  if (normalizedBoundHost !== '0.0.0.0' && normalizedBoundHost !== '::' && normalizedBoundHost !== '[::]') {
    allowedHosts.add(normalizedBoundHost)
  }
  const allowedOrigins = opts.allowedOrigins ?? parseCsvSet(process.env.APPLIFY_JOBS_MCP_ALLOWED_ORIGINS)
  // opts.rateLimit (eksplisit, dipakai tes) berlaku untuk semua pemanggil; selain itu batas dipilih menurut env dan asal pemanggil.
  const rateLimits = opts.rateLimit ? { loopback: opts.rateLimit, remote: opts.rateLimit } : resolveMcpRateLimits()
  const checkLoopbackRate = createMcpRateLimiter(rateLimits.loopback.maxRequests, rateLimits.loopback.windowMs)
  const checkRemoteRate = createMcpRateLimiter(rateLimits.remote.maxRequests, rateLimits.remote.windowMs)

  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    let url: URL
    try {
      url = new URL(req.url ?? '/', 'http://127.0.0.1')
    } catch {
      res.writeHead(400, { 'content-type': 'application/json' }).end(
        JSON.stringify({ jsonrpc: '2.0', error: { code: -32600, message: 'Invalid request URL' }, id: null }),
      )
      return
    }
    if (url.pathname === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ status: 'ok', server: 'applify-jobs-mcp' }))
      return
    }
    if (url.pathname !== '/mcp') {
      res.writeHead(404).end('not found')
      return
    }
    if (!isAllowedOriginHeader(req.headers.origin, allowedOrigins)) {
      res.writeHead(403, { 'content-type': 'application/json' }).end(
        JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message: 'Forbidden Origin' }, id: null }),
      )
      return
    }
    if (!isAllowedHostHeader(req.headers.host, allowedHosts)) {
      res.writeHead(403, { 'content-type': 'application/json' }).end(
        JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message: 'Forbidden Host' }, id: null }),
      )
      return
    }
    if (req.method !== 'POST') {
      // Mode stateless: tidak ada stream SSE/sesi yang perlu dibuka lewat GET/DELETE.
      res.writeHead(405, { 'content-type': 'application/json' }).end(
        JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed (stateless server)' }, id: null }),
      )
      return
    }

    const providedToken = extractRequestToken(req)
    if (token) {
      if (!providedToken || !tokensEqual(providedToken, token)) {
        res.writeHead(401, { 'content-type': 'application/json' }).end(
          JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message: 'Unauthorized' }, id: null }),
        )
        return
      }
    }

    const callerKey = providedToken
      ? `tok:${crypto.createHash('sha256').update(providedToken).digest('hex').slice(0, 16)}`
      : `ip:${req.socket.remoteAddress ?? 'unknown'}`
    const rate = (isLoopbackAddress(req.socket.remoteAddress) ? checkLoopbackRate : checkRemoteRate)(callerKey)
    if ('retryAfterSec' in rate) {
      res.writeHead(429, {
        'content-type': 'application/json',
        'retry-after': String(rate.retryAfterSec),
      }).end(
        JSON.stringify({ jsonrpc: '2.0', error: { code: -32002, message: 'Too many requests' }, id: null }),
      )
      return
    }

    try {
      const body = await readBody(req, maxBodyBytes, bodyReadTimeoutMs)
      const server = buildServer()
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
      res.on('close', () => {
        transport.close()
        server.close()
      })
      await server.connect(transport)
      await transport.handleRequest(req, res, body)
    } catch (err: any) {
      if (!res.headersSent) {
        if (err instanceof HttpBodyError) {
          res.writeHead(err.statusCode, { 'content-type': 'application/json' }).end(
            JSON.stringify({ jsonrpc: '2.0', error: { code: -32700, message: err.message }, id: null }),
          )
          return
        }
        res.writeHead(500, { 'content-type': 'application/json' }).end(
          JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: err?.message ?? 'internal error' }, id: null }),
        )
      }
    }
  })
}

export async function startHttp(port: number, host: string = process.env.APPLIFY_JOBS_MCP_HOST || DEFAULT_MCP_HOST) {
  const http = createMcpHttpServer({ host })
  await new Promise<void>((resolve, reject) => {
    http.once('error', reject)
    http.listen(port, host, () => {
      console.error(`[applify-jobs-mcp] Streamable HTTP siap di http://${host}:${port}/mcp`)
      resolve()
    })
  })
  return http
}

async function main() {
  if (process.argv.includes('--http')) {
    await startHttp(Number(process.env.APPLIFY_JOBS_MCP_PORT) || 8090)
  } else {
    const server = buildServer()
    await server.connect(new StdioServerTransport())
    console.error('[applify-jobs-mcp] berjalan via stdio')
  }
}

// Jalankan hanya bila file ini dieksekusi langsung (bukan saat di-import oleh test).
const invokedDirectly = process.argv[1] && /mcp[\\/]server\.(ts|js)$/.test(process.argv[1])
if (invokedDirectly) {
  main().catch((err) => {
    console.error('[applify-jobs-mcp] gagal start:', err)
    process.exit(1)
  })
}
