import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ingestJobs } from '../../services/job-ingest.service.js'
import type { RankedJob } from '../../services/job-aggregation.service.js'

/**
 * Uji penyimpanan hasil agregasi ke tabel `jobs` dengan klien Supabase palsu:
 * dedupe berdasarkan external_url, fallback bila kolom tambahan belum ada di skema,
 * dan normalisasi nilai enum (type/workplace_type).
 */

function fakeSupabase(opts: {
  existingUrls?: string[]
  /** url -> match_score yang sudah tersimpan pada baris lama (default null). */
  existingScores?: Record<string, number | null>
  rejectExtras?: boolean
  /** Skema live tanpa kolom match_score. */
  noScoreColumn?: boolean
}) {
  const rows: any[] = []
  const updates: Array<{ id: string; patch: any }> = []
  const existing = new Set(opts.existingUrls ?? [])
  const scores = new Map<string, number | null>(Object.entries(opts.existingScores ?? {}))
  const client = {
    from(table: string) {
      assert.equal(table, 'jobs')
      return {
        select(cols: string) {
          return {
            eq(_col: string, url: string) {
              return {
                limit: async () => {
                  if (opts.noScoreColumn && /match_score/.test(cols)) {
                    return { data: null, error: { code: '42703', message: 'column jobs.match_score does not exist' } }
                  }
                  const hit = existing.has(url) ? [{ id: `id:${url}`, match_score: scores.get(url) ?? null }] : []
                  return { data: hit, error: null }
                },
              }
            },
          }
        },
        update(patch: any) {
          return {
            async eq(_col: string, id: string) {
              updates.push({ id, patch })
              return { error: null }
            },
          }
        },
        async insert(row: any) {
          if (opts.rejectExtras && ('posted_at' in row || 'from_ats' in row)) {
            return { error: { code: 'PGRST204', message: "Could not find the 'from_ats' column of 'jobs' in the schema cache" } }
          }
          if (opts.noScoreColumn && 'match_score' in row) {
            return { error: { code: 'PGRST204', message: "Could not find the 'match_score' column of 'jobs' in the schema cache" } }
          }
          rows.push(row)
          existing.add(row.external_url)
          scores.set(row.external_url, row.match_score ?? null)
          return { error: null }
        },
      }
    },
  }
  return { client: client as any, rows, updates }
}

const rj = (p: Partial<RankedJob> & { id: string }): RankedJob => ({
  title: 'Data Analyst',
  company: 'PT Uji',
  location: 'Jakarta',
  description: 'desc',
  url: `https://example.test/${p.id}`,
  platform: 'kalibrr',
  relevance: 50,
  match_score: 50,
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
  assert.equal(s.backfilled, 1) // 'old' ada di DB tanpa skor; 'n1' kedua sudah punya skor dari penyisipan pertama
})

test('ingestJobs: fallback tanpa kolom tambahan bila skema live belum punya', async () => {
  const { client, rows } = fakeSupabase({ rejectExtras: true })
  const s = await ingestJobs(client, [rj({ id: 'a', posted_at: '2026-09-01' }), rj({ id: 'b' })])
  assert.equal(s.inserted, 2)
  assert.equal(s.failed, 0)
  assert.ok(rows.every((r) => !('posted_at' in r) && !('from_ats' in r)))
})

test('ingestJobs: match_score ikut disimpan (bulat, terjepit 0-100, null bila tidak ada dasar penilaian)', async () => {
  const { client, rows } = fakeSupabase({})
  await ingestJobs(client, [
    rj({ id: 's1', match_score: 83 }),
    rj({ id: 's2', match_score: 83.6 }),
    rj({ id: 's3', match_score: 140 }),
    rj({ id: 's4', match_score: -5 }),
    rj({ id: 's5', match_score: null }),
    rj({ id: 's6', match_score: Number.NaN }),
    rj({ id: 's7', match_score: 0 }),
  ])
  assert.deepEqual(rows.map((r) => r.match_score), [83, 84, 100, 0, null, null, 0])
  assert.ok(rows.every((r) => r.match_score === null || Number.isInteger(r.match_score)))
})

test('ingestJobs: duplikat dengan match_score kosong diisi; yang sudah punya skor tidak ditimpa', async () => {
  const { client, rows, updates } = fakeSupabase({
    existingUrls: ['https://example.test/kosong', 'https://example.test/terisi', 'https://example.test/tanpa-skor'],
    existingScores: { 'https://example.test/terisi': 91 },
  })
  const s = await ingestJobs(client, [
    rj({ id: 'kosong', match_score: 42 }),
    rj({ id: 'terisi', match_score: 10 }),
    rj({ id: 'tanpa-skor', match_score: null }),
  ])
  assert.equal(rows.length, 0)
  assert.equal(s.duplicates, 3)
  assert.equal(s.backfilled, 1)
  assert.deepEqual(updates, [{ id: 'id:https://example.test/kosong', patch: { match_score: 42 } }])
})

test('ingestJobs: skema live tanpa kolom match_score -> lowongan tetap tersimpan dan duplikat tetap terdeteksi', async () => {
  const { client, rows, updates } = fakeSupabase({ noScoreColumn: true, existingUrls: ['https://example.test/old'] })
  const s = await ingestJobs(client, [rj({ id: 'old', match_score: 70 }), rj({ id: 'baru', match_score: 70 })])
  assert.equal(s.inserted, 1)
  assert.equal(s.duplicates, 1)
  assert.equal(s.failed, 0)
  assert.equal(updates.length, 0)
  assert.ok(!('match_score' in rows[0]))
})

test('baris lama dengan url halaman perusahaan: tidak diinsert ganda, external_url dipindah ke formulir Greenhouse', async () => {
  const oldUrl = 'https://careers.datadoghq.com/detail/7131726/?gh_jid=7131726'
  const { client, rows, updates } = fakeSupabase({ existingUrls: [oldUrl] })
  const s = await ingestJobs(client, [rj({ id: 'gh1', platform: 'greenhouse', url: oldUrl, apply_url: 'https://job-boards.greenhouse.io/datadog/jobs/7131726' })])
  assert.equal(rows.length, 0)
  assert.equal(s.duplicates, 1)
  assert.equal(updates.length, 1)
  assert.equal(updates[0].id, `id:${oldUrl}`)
  assert.equal(updates[0].patch.external_url, 'https://job-boards.greenhouse.io/datadog/jobs/7131726')
})
