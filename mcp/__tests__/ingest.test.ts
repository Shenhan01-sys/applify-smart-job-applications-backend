import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ingestJobs } from '../../services/job-ingest.service.js'
import type { RankedJob } from '../../services/job-aggregation.service.js'

/**
 * Uji penyimpanan hasil agregasi ke tabel `jobs` dengan klien Supabase palsu:
 * dedupe berdasarkan external_url, fallback bila kolom tambahan belum ada di skema,
 * dan normalisasi nilai enum (type/workplace_type).
 */

function fakeSupabase(opts: { existingUrls?: string[]; rejectExtras?: boolean }) {
  const rows: any[] = []
  const existing = new Set(opts.existingUrls ?? [])
  const client = {
    from(table: string) {
      assert.equal(table, 'jobs')
      return {
        select() {
          return {
            eq(_col: string, url: string) {
              return { limit: async () => ({ data: existing.has(url) ? [{ id: 'x' }] : [], error: null }) }
            },
          }
        },
        async insert(row: any) {
          if (opts.rejectExtras && ('posted_at' in row || 'from_ats' in row)) {
            return { error: { code: 'PGRST204', message: "Could not find the 'from_ats' column of 'jobs' in the schema cache" } }
          }
          rows.push(row)
          existing.add(row.external_url)
          return { error: null }
        },
      }
    },
  }
  return { client: client as any, rows }
}

const rj = (p: Partial<RankedJob> & { id: string }): RankedJob => ({
  title: 'Data Analyst',
  company: 'PT Uji',
  location: 'Jakarta',
  description: 'desc',
  url: `https://example.test/${p.id}`,
  platform: 'kalibrr',
  relevance: 50,
  matchedKeywords: [],
  matchedSkills: [],
  ...p,
})

test('ingestJobs: lewati duplikat, isi kolom terbukti, normalisasi enum', async () => {
  const { client, rows } = fakeSupabase({ existingUrls: ['https://example.test/old'] })
  const s = await ingestJobs(client, [
    rj({ id: 'old' }),
    rj({ id: 'n1', job_type: 'internship', work_type: 'remote', posted_at: '2026-09-30T00:00:00Z' }),
    rj({ id: 'n2', job_type: 'weird', work_type: 'onsite', platform: 'greenhouse', apply_url: 'https://example.test/n2/apply' }),
    rj({ id: 'n1' }), // duplikat dalam batch yang sama
  ])
  assert.equal(s.attempted, 4)
  assert.equal(s.inserted, 2)
  assert.equal(s.duplicates, 2)
  assert.equal(s.failed, 0)
  assert.deepEqual(s.byPlatform.kalibrr, { inserted: 1, duplicates: 2, failed: 0 })
  assert.equal(rows[0].type, 'internship')
  assert.equal(rows[0].workplace_type, 'remote')
  assert.equal(rows[0].from_ats, false)
  assert.equal(rows[1].type, 'full-time') // nilai tak dikenal -> default
  assert.equal(rows[1].workplace_type, null)
  assert.equal(rows[1].external_url, 'https://example.test/n2/apply')
  assert.equal(rows[1].from_ats, true)
  assert.equal(rows[1].platform_source, 'greenhouse')
  assert.ok(!('match_score' in rows[0]))
})

test('ingestJobs: fallback tanpa kolom tambahan bila skema live belum punya', async () => {
  const { client, rows } = fakeSupabase({ rejectExtras: true })
  const s = await ingestJobs(client, [rj({ id: 'a', posted_at: '2026-09-01' }), rj({ id: 'b' })])
  assert.equal(s.inserted, 2)
  assert.equal(s.failed, 0)
  assert.ok(rows.every((r) => !('posted_at' in r) && !('from_ats' in r)))
})
