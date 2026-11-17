import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FakeDb } from './helpers/fakeDb.ts'
import { AutomationService } from '../services/automation.service.ts'
import { mcpRegistry } from '../services/mcp-registry.ts'
import { BaseMCPClient, type JobPosting, type MCPResponse } from '../mcp/shared/types.ts'

/**
 * AutomationService.searchJobs dengan database dan sumber lowongan tiruan (tanpa jaringan): skill profil dibaca
 * di tempat yang sama dengan penyimpanan, dan kolom jobs.match_score terisi dengan skor relevansi 0-100.
 */

const posting = (id: string, title: string, description: string): JobPosting => ({
  id,
  title,
  description,
  company: 'PT Uji',
  location: 'Jakarta, Indonesia',
  url: `https://example.test/ms/${id}`,
})

class ScoreBoard extends BaseMCPClient {
  name = 'scoreboard'
  baseUrl = 'https://score.board'
  displayName = 'Score Board'
  kind = 'board' as const
  async searchJobs(): Promise<MCPResponse> {
    return {
      success: true,
      data: {
        jobs: [
          posting('p1', 'Data Analyst', 'Kuasai SQL dan Python untuk dashboard'),
          posting('p2', 'Data Analyst', 'Laporan bulanan'),
          posting('p3', 'Akuntan', 'Pembukuan'),
        ],
      },
    }
  }
  async getJobDetails(): Promise<MCPResponse> {
    return { success: false, error: 'n/a' }
  }
}
mcpRegistry.register('scoreboard', new ScoreBoard())

const search = (db: FakeDb, over: Record<string, any> = {}) =>
  new AutomationService(db as any).searchJobs({ userId: 'u1', platforms: ['scoreboard'], location: 'any', ...over })

test('searchJobs: skill profil dibaca dan jobs.match_score tersimpan (bulat 0-100)', async () => {
  const db = new FakeDb({
    user_skills: [
      { user_id: 'u1', name: 'SQL' },
      { user_id: 'u1', name: 'Python' },
      { user_id: 'u2', name: 'Akuntansi' }, // milik pengguna lain: tidak dipakai
    ],
  })
  const res = await search(db, { keywords: 'data analyst' })
  assert.equal(res.ingest?.inserted, 3)
  const stored = Object.fromEntries(db.rows('jobs').map((r) => [r.external_url.split('/').pop(), r.match_score]))
  // p1: 2 token di judul (6) + SQL (2) + Python (2) = 10 dari 10 -> 100
  assert.equal(stored.p1, 100)
  // p2: 6 dari 10 -> 60 (kedua skill tidak disebut)
  assert.equal(stored.p2, 60)
  // p3 lolos karena filter kata kunci hanya berlaku untuk ATS; tidak ada yang cocok -> 0, bukan null
  assert.equal(stored.p3, 0)
  assert.ok(db.rows('jobs').every((r) => Number.isInteger(r.match_score) && r.match_score >= 0 && r.match_score <= 100))
  // skor per pengguna juga ada di respons
  assert.deepEqual(res.jobs.map((j) => j.match_score as number).sort((a, b) => a - b), [0, 60, 100])
})

test('searchJobs: tanpa kata kunci dan tanpa skill, match_score null (tidak ada yang dibandingkan)', async () => {
  const db = new FakeDb({})
  await search(db)
  assert.equal(db.rows('jobs').length, 3)
  assert.ok(db.rows('jobs').every((r) => r.match_score === null))
})

test('searchJobs: lowongan lama tanpa skor diisi, lowongan yang sudah punya skor tidak ditimpa', async () => {
  const db = new FakeDb({
    user_skills: [{ user_id: 'u1', name: 'SQL' }],
    jobs: [
      { id: 'old1', external_url: 'https://example.test/ms/p1', match_score: null },
      { id: 'old2', external_url: 'https://example.test/ms/p2', match_score: 77 },
    ],
  })
  const res = await search(db, { keywords: 'data analyst' })
  assert.equal(res.ingest?.duplicates, 2)
  assert.equal(res.ingest?.backfilled, 1)
  assert.equal(db.rows('jobs').find((r) => r.id === 'old1')!.match_score, 100)
  assert.equal(db.rows('jobs').find((r) => r.id === 'old2')!.match_score, 77)
})

test('searchJobs: persist=false tidak menulis ke tabel jobs', async () => {
  const db = new FakeDb({ user_skills: [{ user_id: 'u1', name: 'SQL' }] })
  const res = await search(db, { keywords: 'data analyst', persist: false })
  assert.equal(res.ingest, null)
  assert.equal(db.rows('jobs').length, 0)
  assert.ok(res.jobs.every((j) => typeof j.match_score === 'number'))
})
