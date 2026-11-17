import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BaseMCPClient, MCPResponse, SearchParams, JobPosting } from '../shared/types.js'
import { mcpRegistry } from '../../services/mcp-registry.js'
import { aggregateJobs } from '../../services/job-aggregation.service.js'

/**
 * Uji alur agregasi TANPA jaringan: dua sumber palsu didaftarkan ke registry lalu
 * aggregateJobs() diperiksa untuk filter lokasi, filter kata kunci ATS, deduplikasi
 * lintas sumber, pemeringkatan, batas per sumber, dan pencatatan error per papan.
 */

const job = (p: Partial<JobPosting> & { id: string; title: string }): JobPosting => ({
  company: 'PT Uji',
  location: 'Jakarta, Indonesia',
  description: '',
  url: `https://example.test/${p.id}`,
  ...p,
})

class FakeBoard extends BaseMCPClient {
  name = 'fakeboard'
  baseUrl = 'https://fake.board'
  displayName = 'Fake Board'
  kind = 'board' as const
  async searchJobs(): Promise<MCPResponse> {
    return {
      success: true,
      data: {
        jobs: [
          job({ id: 'b1', title: 'Data Analyst', description: 'SQL dan Python', posted_at: '2026-09-01' }),
          job({ id: 'b2', title: 'Data Analyst Intern', location: 'Singapore' }), // dibuang: lokasi
          job({ id: 'b3', title: 'Business Intelligence', description: 'dashboard data analyst', posted_at: 'bukan-tanggal' }),
          job({ id: 'dup', title: 'Senior Data Analyst', url: 'https://example.test/SAME' }),
        ],
      },
    }
  }
  async getJobDetails(): Promise<MCPResponse> {
    return { success: false, error: 'n/a' }
  }
}

class FakeAts extends BaseMCPClient {
  name = 'fakeats'
  baseUrl = 'https://fake.ats'
  displayName = 'Fake ATS'
  kind = 'ats' as const
  requiresCompany = true
  async searchJobs(p: SearchParams): Promise<MCPResponse> {
    if (p.company === 'rusak') return { success: false, error: 'HTTP 404: papan tidak ada' }
    return {
      success: true,
      data: {
        jobs: [
          job({ id: 'a1', title: 'Data Analyst', description: 'SQL Tableau', company: p.company! }),
          job({ id: 'a2', title: 'Frontend Developer', company: p.company! }), // dibuang: kata kunci (ATS)
          job({ id: 'a3', title: 'Data Analyst', url: 'https://example.test/SAME', company: p.company! }), // duplikat URL
        ],
      },
    }
  }
  async getJobDetails(): Promise<MCPResponse> {
    return { success: false, error: 'n/a' }
  }
}

mcpRegistry.register('fakeboard', new FakeBoard())
mcpRegistry.register('fakeats', new FakeAts())

test('aggregateJobs: filter lokasi & kata kunci, dedupe, ranking, error per papan', async () => {
  const r = await aggregateJobs({
    keywords: 'data analyst',
    location: 'Indonesia',
    platforms: ['fakeboard', 'fakeats', 'tidak-ada'],
    companies: { fakeats: ['acme', 'rusak'] },
    skills: ['SQL'],
  })

  // sumber tak dikenal diabaikan, urutan stats mengikuti permintaan
  assert.deepEqual(r.query.platforms, ['fakeboard', 'fakeats'])
  assert.deepEqual(r.stats.map((s) => s.platform), ['fakeboard', 'fakeats'])

  const board = r.stats.find((s) => s.platform === 'fakeboard')!
  assert.equal(board.fetched, 4)
  assert.equal(board.afterFilter, 3) // Singapore dibuang

  const ats = r.stats.find((s) => s.platform === 'fakeats')!
  assert.deepEqual(ats.boards, ['acme', 'rusak'])
  assert.equal(ats.fetched, 3)
  assert.equal(ats.afterFilter, 2) // Frontend dibuang oleh filter kata kunci ATS
  assert.equal(ats.errors.length, 1)
  assert.match(ats.errors[0], /404/)

  // 3 (board) + 2 (ats) - 1 duplikat URL = 4
  assert.equal(r.total, 4)
  assert.equal(new Set(r.jobs.map((j) => j.url.toLowerCase())).size, 4)

  // terurut menurun menurut relevansi; lowongan berjudul "Data Analyst" + SQL di atas
  for (let i = 1; i < r.jobs.length; i++) assert.ok(r.jobs[i - 1].relevance >= r.jobs[i].relevance)
  assert.equal(r.jobs[0].title, 'Data Analyst')
  assert.deepEqual(r.jobs[0].matchedSkills, ['sql'])
  assert.ok(r.jobs.every((j) => j.relevance >= 0 && j.relevance <= 100))
  // match_score (kolom jobs.match_score) = relevansi yang sama, bulat 0-100, karena ada kata kunci dan skill
  assert.ok(r.jobs.every((j) => j.match_score === j.relevance && Number.isInteger(j.match_score)))
})

test('aggregateJobs: match_score null bila tidak ada kata kunci dan tidak ada skill; dari skill saja tetap dihitung', async () => {
  const none = await aggregateJobs({ keywords: '', location: 'any', platforms: ['fakeboard'] })
  assert.ok(none.jobs.length > 0)
  assert.ok(none.jobs.every((j) => j.match_score === null))

  const skillsOnly = await aggregateJobs({ keywords: '', location: 'any', platforms: ['fakeboard'], skills: ['SQL'] })
  const analyst = skillsOnly.jobs.find((j) => j.title === 'Data Analyst')!
  assert.equal(analyst.match_score, 100) // satu-satunya skill (SQL) ada di deskripsi
  const intern = skillsOnly.jobs.find((j) => j.title === 'Data Analyst Intern')!
  assert.equal(intern.match_score, 0) // ada dasar penilaian tetapi tidak ada yang cocok: 0, bukan null
})

test('aggregateJobs: batas per sumber & lokasi "any"', async () => {
  const r = await aggregateJobs({ keywords: 'data analyst', location: 'any', platforms: ['fakeboard'], limitPerSource: 2 })
  assert.equal(r.query.location, 'any')
  assert.equal(r.stats[0].fetched, 4)
  assert.equal(r.stats[0].afterFilter, 2) // Singapore ikut (tanpa filter lokasi) tapi dipotong ke 2 teratas
  assert.equal(r.total, 2)
})

test('registry: sumber default non-browser & papan ATS dari config', () => {
  const d = mcpRegistry.describe()
  const names = d.map((s) => s.name)
  for (const p of ['greenhouse', 'lever', 'ashby', 'workable', 'smartrecruiters', 'jobstreet', 'glints', 'kalibrr', 'linkedin']) {
    assert.ok(names.includes(p), `sumber ${p} terdaftar`)
  }
  assert.equal(d.find((s) => s.name === 'linkedin')!.kind, 'browser')
  assert.equal(d.find((s) => s.name === 'kalibrr')!.kind, 'board')
  assert.equal(d.find((s) => s.name === 'smartrecruiters')!.requiresCompany, true)
  assert.ok(mcpRegistry.boardsFor('smartrecruiters').length > 0)
})
