import 'dotenv/config'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mcpRegistry } from '../services/mcp-registry.js'
import { aggregateJobs, AggregateResult } from '../services/job-aggregation.service.js'

/**
 * Smoke test & bukti empiris agregasi multi-portal.
 *
 *   npm run smoke:portals                         # semua sumber non-browser, 4 kata kunci
 *   npm run smoke:portals -- --platforms kalibrr,jobstreet --keywords "data analyst"
 *   npm run smoke:portals -- --via-mcp            # + uji jalur MCP (spawn server stdio, panggil tool)
 *   npm run smoke:portals -- --persist            # + simpan hasil ke tabel jobs (butuh SUPABASE_* di .env)
 *
 * Output: project/uat/aggregation/proof-aggregation-<timestamp>.json (+ salinan proof-aggregation-latest.json)
 * Berisi per sumber: papan yang dicoba, jumlah diambil, lolos filter, error, latensi, dan contoh lowongan
 * (judul, perusahaan, lokasi, URL) sehingga setiap angka bisa ditelusuri ke URL lowongan aslinya.
 */

const here = dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const arg = (name: string) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : undefined
}
const has = (name: string) => args.includes(`--${name}`)

const KEYWORD_SETS = arg('keywords')?.split('|') ?? ['software engineer', 'data analyst', 'marketing', 'accounting']
const PLATFORMS = arg('platforms')?.split(',').map((s) => s.trim()).filter(Boolean)
const LOCATION = arg('location') ?? 'Indonesia'

async function viaMcp() {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js')
  const backendRoot = resolve(here, '..')
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(backendRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs'), join(backendRoot, 'mcp', 'server.ts')],
    cwd: backendRoot,
    // Teruskan env penuh (proxy, JOB_BOARDS_CONFIG, GLINTS_BROWSER_FALLBACK) — default SDK hanya meneruskan PATH/HOME dkk.
    env: Object.fromEntries(Object.entries(process.env).filter(([, v]) => typeof v === 'string')) as Record<string, string>,
    stderr: 'ignore',
  })
  const client = new Client({ name: 'applify-smoke', version: '1.0.0' })
  const t0 = Date.now()
  await client.connect(transport)
  const tools = await client.listTools()
  const t1 = Date.now()
  const res: any = await client.callTool({
    name: 'search_all_platforms',
    arguments: { keywords: KEYWORD_SETS[0], location: LOCATION, platforms: PLATFORMS, limitPerSource: 10 },
  })
  const t2 = Date.now()
  await client.close()
  const text = res?.content?.[0]?.text ?? '{}'
  const parsed = JSON.parse(text)
  return {
    tools: tools.tools.map((t) => t.name),
    connectAndListMs: t1 - t0,
    callMs: t2 - t1,
    keywords: KEYWORD_SETS[0],
    total: parsed.total,
    perSource: (parsed.stats ?? []).map((s: any) => ({ platform: s.platform, afterFilter: s.afterFilter, errors: s.errors.length })),
  }
}

async function main() {
  const startedAt = new Date()
  console.log(`Sumber terdaftar: ${mcpRegistry.list().join(', ')}`)
  const runs: Array<{ keywords: string; result: AggregateResult; ingest?: any }> = []

  for (const keywords of KEYWORD_SETS) {
    const result = await aggregateJobs({ keywords, location: LOCATION, platforms: PLATFORMS, limitPerSource: 25 })
    let ingest: any
    if (has('persist')) {
      const { createClient } = await import('@supabase/supabase-js')
      const { ingestJobs } = await import('../services/job-ingest.service.js')
      const sb = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
      ingest = await ingestJobs(sb, result.jobs)
    }
    runs.push({ keywords, result, ingest })
    const line = result.stats.map((s) => `${s.platform}=${s.afterFilter}${s.errors.length ? `(!${s.errors.length})` : ''}`).join('  ')
    console.log(`[${keywords}] total=${result.total} ${line} (${result.durationMs} ms)`)
  }

  // Ringkasan per sumber lintas kata kunci
  const perSource: Record<string, any> = {}
  for (const run of runs) {
    for (const s of run.result.stats) {
      const agg = (perSource[s.platform] ??= {
        platform: s.platform, displayName: s.displayName, kind: s.kind, boards: s.boards,
        fetched: 0, kept: 0, runsWithResults: 0, errors: [] as string[], latencyMs: [] as number[], samples: [] as any[],
      })
      agg.fetched += s.fetched
      agg.kept += s.afterFilter
      if (s.afterFilter > 0) agg.runsWithResults++
      agg.latencyMs.push(s.ms)
      for (const e of s.errors) if (agg.errors.length < 8) agg.errors.push(`[${run.keywords}] ${e}`)
    }
    for (const j of run.result.jobs) {
      const agg = perSource[j.platform]
      if (agg && agg.samples.length < 5) {
        agg.samples.push({ keywords: run.keywords, title: j.title, company: j.company, location: j.location, url: j.url, relevance: j.relevance })
      }
    }
  }
  const sources = Object.values(perSource)
  const uniqueUrls = new Set(runs.flatMap((r) => r.result.jobs.map((j) => j.url)))

  const proof = {
    description: 'Bukti agregasi lowongan multi-portal Applify (klien MCP + filter lokasi + ranking relevansi deterministik).',
    generatedAt: new Date().toISOString(),
    startedAt: startedAt.toISOString(),
    environment: { node: process.version, platform: process.platform },
    location: LOCATION,
    keywordSets: KEYWORD_SETS,
    platformsRequested: PLATFORMS ?? 'default (semua non-browser)',
    summary: {
      sourcesTried: sources.length,
      sourcesWithResults: sources.filter((s: any) => s.kept > 0).length,
      uniqueVacancies: uniqueUrls.size,
      totalKeptAcrossRuns: sources.reduce((a: number, s: any) => a + s.kept, 0),
    },
    sources,
    viaMcp: has('via-mcp') ? await viaMcp().catch((e) => ({ error: String(e?.message ?? e) })) : 'tidak dijalankan (pakai --via-mcp)',
    ingest: has('persist') ? runs.map((r) => ({ keywords: r.keywords, ...r.ingest })) : 'tidak dijalankan (pakai --persist)',
  }

  const outDir = resolve(here, '..', '..', 'uat', 'aggregation')
  mkdirSync(outDir, { recursive: true })
  const stamp = startedAt.toISOString().replace(/[:.]/g, '-')
  const file = join(outDir, `proof-aggregation-${stamp}.json`)
  writeFileSync(file, JSON.stringify(proof, null, 2))
  writeFileSync(join(outDir, 'proof-aggregation-latest.json'), JSON.stringify(proof, null, 2))
  console.log(`\nSumber berhasil: ${proof.summary.sourcesWithResults}/${proof.summary.sourcesTried} · lowongan unik: ${proof.summary.uniqueVacancies}`)
  console.log(`Bukti tersimpan: ${file}`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
