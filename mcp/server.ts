import 'dotenv/config'
import { createServer, IncomingMessage, ServerResponse } from 'node:http'
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
 *   Streamable HTTP  -> untuk worker Applify (APPLIFY_JOBS_MCP_URL=http://localhost:8090/mcp)
 *        npm run mcp:jobs:http      (port: APPLIFY_JOBS_MCP_PORT, default 8090)
 *
 * Server ini stateless dan TIDAK menyentuh database; penyimpanan dilakukan pemanggil
 * (backend /api/automation/search atau worker handler `search`).
 */

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
        limit: z.number().int().min(1).max(100).optional(),
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
        platforms: z.array(z.string()).optional().describe('default semua sumber non-browser'),
        companies: z.record(z.string(), z.array(z.string())).optional().describe('override papan ATS, mis. {"greenhouse":["acommerce"]}'),
        skills: z.array(z.string()).optional().describe('skill kandidat untuk pembobotan relevansi'),
        limitPerSource: z.number().int().min(1).max(100).optional(),
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

async function readBody(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = []
  for await (const c of req) chunks.push(c as Buffer)
  const raw = Buffer.concat(chunks).toString('utf8')
  return raw ? JSON.parse(raw) : undefined
}

async function startHttp(port: number) {
  const http = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
    if (url.pathname === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ status: 'ok', server: 'applify-jobs-mcp' }))
      return
    }
    if (url.pathname !== '/mcp') {
      res.writeHead(404).end('not found')
      return
    }
    if (req.method !== 'POST') {
      // Mode stateless: tidak ada stream SSE/sesi yang perlu dibuka lewat GET/DELETE.
      res.writeHead(405, { 'content-type': 'application/json' }).end(
        JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed (stateless server)' }, id: null }),
      )
      return
    }
    try {
      const body = await readBody(req)
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
        res.writeHead(500, { 'content-type': 'application/json' }).end(
          JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: err?.message ?? 'internal error' }, id: null }),
        )
      }
    }
  })
  http.listen(port, () => {
    console.error(`[applify-jobs-mcp] Streamable HTTP siap di http://localhost:${port}/mcp`)
  })
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
