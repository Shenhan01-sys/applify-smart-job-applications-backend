import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FakeDb } from './helpers/fakeDb.ts'
import { AutomationService, deriveKeywordsFromProfile, KEYWORDS_REQUIRED_MESSAGE, SearchInputError } from '../services/automation.service.ts'
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

test('searchJobs: tanpa kata kunci, tanpa pengaturan, tanpa profil dan skill: ditolak 400 dengan pesan Indonesia, tidak mencari', async () => {
  const db = new FakeDb({})
  await assert.rejects(search(db), (err: any) => {
    assert.ok(err instanceof SearchInputError)
    assert.equal(err.statusCode, 400)
    assert.equal(err.code, 'keywords_required')
    assert.equal(err.message, KEYWORDS_REQUIRED_MESSAGE)
    assert.match(err.message, /Isi jabatan di profil atau kata kunci di Pengaturan Otomasi/)
    return true
  })
  assert.equal(db.rows('jobs').length, 0)
  // Kata kunci kosong atau spasi saja dari klien sama dengan tidak ada.
  await assert.rejects(search(db, { keywords: '   ' }), SearchInputError)
})

test('searchJobs: pengguna baru tanpa kata kunci memakai jabatan profil + tiga skill teratas', async () => {
  const db = new FakeDb({
    profiles: [{ id: 'u1', current_title: 'Data Analyst', headline: 'Abaikan headline ini karena jabatan ada' }, { id: 'u2', current_title: 'Akuntan' }],
    user_skills: [
      { user_id: 'u1', name: 'Excel', proficiency_level: 2 },
      { user_id: 'u1', name: 'SQL', proficiency_level: 5 },
      { user_id: 'u1', name: 'Python', proficiency_level: 4 },
      { user_id: 'u1', name: 'Tableau', proficiency_level: 3 },
      { user_id: 'u2', name: 'Akuntansi', proficiency_level: 5 },
    ],
  })
  const res = await search(db)
  assert.equal(res.query.keywords, 'Data Analyst SQL Python Tableau')
  const log = db.rows('application_logs').find((r) => r.action === 'scan')!
  assert.equal(log.details.keywords, 'Data Analyst SQL Python Tableau')
  assert.equal(log.details.keywords_source, 'profile')
})

test('searchJobs: tanpa jabatan, headline pendek dipakai; tanpa keduanya cukup skill; keduanya kosong ditolak', async () => {
  const headlineOnly = new FakeDb({ profiles: [{ id: 'u1', current_title: '', headline: 'Product Designer' }] })
  assert.equal((await search(headlineOnly)).query.keywords, 'Product Designer')

  const longHeadline = new FakeDb({
    profiles: [{ id: 'u1', headline: 'Berpengalaman sepuluh tahun membangun produk digital untuk pasar Asia Tenggara dan sekitarnya' }],
    user_skills: [{ user_id: 'u1', name: 'Figma' }],
  })
  assert.equal((await search(longHeadline)).query.keywords, 'Figma', 'headline panjang bukan jabatan, tidak dipakai')

  await assert.rejects(search(new FakeDb({ profiles: [{ id: 'u1', current_title: null, headline: null }] })), SearchInputError)
})

test('searchJobs: kata kunci permintaan atau Pengaturan Otomasi menang atas profil', async () => {
  const profile = { profiles: [{ id: 'u1', current_title: 'Akuntan' }] }
  const fromSettings = new FakeDb({ ...profile, user_automation_settings: [{ user_id: 'u1', search_keywords: ['data', 'analyst'] }] })
  const a = await search(fromSettings)
  assert.equal(a.query.keywords, 'data analyst')
  assert.equal(fromSettings.rows('application_logs').find((r) => r.action === 'scan')!.details.keywords_source, 'settings')

  const request = new FakeDb({ ...profile, user_automation_settings: [{ user_id: 'u1', search_keywords: ['data'] }] })
  const b = await search(request, { keywords: 'backend engineer' })
  assert.equal(b.query.keywords, 'backend engineer')
  assert.equal(request.rows('application_logs').find((r) => r.action === 'scan')!.details.keywords_source, 'request')
})

test('deriveKeywordsFromProfile: tanpa duplikat, urut kemahiran, paling banyak tiga skill', () => {
  assert.equal(
    deriveKeywordsFromProfile({ current_title: 'Data  Analyst' }, [
      { name: 'data analyst', proficiency_level: 9 },
      { name: 'SQL', proficiency_level: 1 },
      { name: 'R', proficiency_level: 3 },
      { name: 'Go', proficiency_level: 2 },
      { name: 'Rust', proficiency_level: 0 },
    ]),
    'Data Analyst R Go'
  )
  assert.equal(deriveKeywordsFromProfile(null, []), '')
  assert.equal(deriveKeywordsFromProfile(undefined, null), '')
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
