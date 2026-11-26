import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { GreenhouseMCPClient } from '../mcp/greenhouse/index.js'
import { LeverMCPClient } from '../mcp/lever/index.js'
import { AshbyMCPClient } from '../mcp/ashby/index.js'
import { WorkableMCPClient } from '../mcp/workable/index.js'
import { SmartRecruitersMCPClient } from '../mcp/smartrecruiters/index.js'
import { LinkedInMCPClient } from '../mcp/linkedin/index.js'
import { JobStreetMCPClient } from '../mcp/jobstreet/index.js'
import { GlintsMCPClient } from '../mcp/glints/index.js'
import { KalibrrMCPClient } from '../mcp/kalibrr/index.js'
import { DeallsMCPClient } from '../mcp/dealls/index.js'
import { BaseMCPClient } from '../mcp/shared/types.js'

export interface BoardEntry {
  slug: string
  name?: string
  source?: string
}

/** Muat daftar papan ATS dari config/job-boards.json (path relatif terhadap file ini, aman untuk tsx maupun dist/). */
function loadBoards(): Record<string, BoardEntry[]> {
  const here = dirname(fileURLToPath(import.meta.url))
  const candidates = [
    process.env.JOB_BOARDS_CONFIG,
    join(here, '..', 'config', 'job-boards.json'),
    join(here, '..', '..', 'config', 'job-boards.json'), // saat berjalan dari dist/services
  ].filter(Boolean) as string[]
  for (const p of candidates) {
    try {
      const raw = JSON.parse(readFileSync(p, 'utf8'))
      const out: Record<string, BoardEntry[]> = {}
      for (const [k, v] of Object.entries(raw)) {
        if (k.startsWith('_') || !Array.isArray(v)) continue
        out[k] = (v as any[]).map((e) => (typeof e === 'string' ? { slug: e } : e)).filter((e) => e?.slug)
      }
      return out
    } catch (err: any) {
      if (p === process.env.JOB_BOARDS_CONFIG) {
        console.warn(`[mcp-registry] gagal memuat JOB_BOARDS_CONFIG (${p}): ${String(err?.code ?? err?.message ?? 'error').slice(0, 120)}`)
      }
      /* coba kandidat berikutnya */
    }
  }
  console.warn('[mcp-registry] config/job-boards.json tidak ditemukan; daftar papan ATS kosong')
  return {}
}

export class MCPRegistry {
  private clients: Map<string, BaseMCPClient> = new Map()
  readonly boards: Record<string, BoardEntry[]>

  constructor() {
    // ATS global (API publik per perusahaan)
    this.register('greenhouse', new GreenhouseMCPClient())
    this.register('lever', new LeverMCPClient())
    this.register('ashby', new AshbyMCPClient())
    this.register('workable', new WorkableMCPClient())
    this.register('smartrecruiters', new SmartRecruitersMCPClient())
    // Portal lowongan Indonesia (endpoint pencarian publik)
    this.register('jobstreet', new JobStreetMCPClient())
    this.register('glints', new GlintsMCPClient())
    this.register('kalibrr', new KalibrrMCPClient())
    this.register('dealls', new DeallsMCPClient())
    // Butuh sesi browser
    this.register('linkedin', new LinkedInMCPClient())
    this.boards = loadBoards()
  }

  register(name: string, client: BaseMCPClient) {
    this.clients.set(name, client)
  }

  get(name: string): BaseMCPClient | undefined {
    return this.clients.get(name)
  }

  list(): string[] {
    return Array.from(this.clients.keys())
  }

  /** Metadata semua sumber (untuk tool MCP list_platforms & dokumentasi). */
  describe() {
    return this.list().map((name) => {
      const c = this.clients.get(name)!
      return {
        name,
        displayName: c.displayName || name,
        kind: c.kind,
        requiresCompany: c.requiresCompany,
        defaultBoards: (this.boards[name] ?? []).map((b) => b.slug),
      }
    })
  }

  /** Papan default untuk satu sumber ATS. */
  boardsFor(platform: string): BoardEntry[] {
    return this.boards[platform] ?? []
  }
}

export const mcpRegistry = new MCPRegistry()
