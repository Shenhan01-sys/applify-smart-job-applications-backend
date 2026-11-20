import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FakeDb } from './helpers/fakeDb.ts'
import { detailPatch, ingestJobs, requirementsOf } from '../services/job-ingest.service.ts'
import type { RankedJob } from '../services/job-aggregation.service.ts'

/**
 * Penyimpanan gaji dan syarat dari hasil pencarian, dan pelengkapan baris lama (duplikat) tanpa menimpa data bagus.
 * FakeDb menggantikan Supabase; tidak ada jaringan.
 */

const rj = (p: Partial<RankedJob> & { id: string }): RankedJob => ({
  title: 'Data Analyst',
  company: 'PT Uji',
  location: 'Jakarta',
  description: 'teaser singkat',
  url: `https://example.test/${p.id}`,
  platform: 'jobstreet',
  relevance: 50,
  match_score: 50,
  matchedKeywords: [],
  matchedSkills: [],
  ...p,
})

const existing = (id: string, over: Record<string, any> = {}) => ({
  id: `row-${id}`, title: 'Data Analyst', company: 'PT Uji', external_url: `https://example.test/${id}`, status: 'active',
  match_score: 70, description: 'teaser singkat', requirements: [], salary_min: null, salary_max: null, ...over,
})

test('insert: gaji terstruktur dan skills ikut tersimpan (bilangan bulat; requirements sebagai larik)', async () => {
  const db = new FakeDb({ jobs: [] })
  const s = await ingestJobs(db as any, [
    rj({ id: 'a', salary_min: 9_000_000, salary_max: 13_000_000, salary_currency: 'IDR', salary_period: 'month', salary_range: 'Rp 9.000.000 - Rp 13.000.000 per month' }),
    rj({ id: 'b', salary_range: 'Rp 6,5 jt', skills: ['Excel', 'SQL', 'Excel'] }), // hanya teks: diurai
    rj({ id: 'c', requirements: ['Minimal S1', 'Menguasai SQL'], skills: ['abaikan'] }),
    rj({ id: 'd', salary_range: 'Gaji kompetitif' }),
    rj({ id: 'e', salary_min: 3e9, salary_max: 4.5e9, salary_currency: 'IDR', salary_period: 'year' }),
    rj({ id: 'f', salary_min: 6_500_000.4, salary_max: 7_000_000.6, salary_currency: 'IDR', salary_period: 'month' }),
  ])
  assert.equal(s.inserted, 6)
  const [a, b, c, d, e, f] = db.rows('jobs')
  assert.deepEqual([a.salary_min, a.salary_max, a.salary_currency, a.salary_period], [9_000_000, 13_000_000, 'IDR', 'month'])
  assert.deepEqual([b.salary_min, b.salary_max, b.salary_period], [6_500_000, 6_500_000, 'month'])
  assert.deepEqual(b.requirements, ['Excel', 'SQL'])
  assert.deepEqual(c.requirements, ['Minimal S1', 'Menguasai SQL'], 'requirements sumber didahulukan atas skills')
  assert.equal('salary_min' in d, false, 'gaji tak terbaca tidak ditulis sama sekali')
  assert.equal('requirements' in d, false)
  assert.equal(e.salary_min, 2147483647, 'terjepit ke int32')
  assert.equal(e.salary_max, 2147483647)
  assert.deepEqual([f.salary_min, f.salary_max], [6_500_000, 7_000_001])
  for (const r of [a, b, e, f]) assert.ok(Number.isInteger(r.salary_min) && Number.isInteger(r.salary_max))
})

test('duplikat: gaji kosong, syarat kosong, dan deskripsi lebih pendek dilengkapi; summary.enriched dihitung', async () => {
  const db = new FakeDb({ jobs: [existing('a')] })
  const s = await ingestJobs(db as any, [
    rj({
      id: 'a', description: 'deskripsi yang jauh lebih panjang dari teaser lama',
      salary_min: 9_000_000, salary_max: 13_000_000, salary_currency: 'IDR', salary_period: 'month',
      skills: ['Excel', 'SQL'], match_score: 66,
    }),
  ])
  assert.equal(s.inserted, 0)
  assert.equal(s.duplicates, 1)
  assert.equal(s.enriched, 1)
  assert.equal(db.rows('jobs').length, 1)
  const r = db.rows('jobs')[0]
  assert.deepEqual([r.salary_min, r.salary_max, r.salary_currency, r.salary_period], [9_000_000, 13_000_000, 'IDR', 'month'])
  assert.deepEqual(r.requirements, ['Excel', 'SQL'])
  assert.equal(r.description, 'deskripsi yang jauh lebih panjang dari teaser lama')
  assert.equal(r.match_score, 70, 'skor lama tidak ditimpa')
  assert.ok(Date.parse(r.updated_at) > 0)
  assert.equal(db.writes.filter((w) => w.op === 'update').length, 1, 'satu update untuk semua bidang')
})

test('duplikat: data yang sudah ada tidak ditimpa (gaji, syarat) dan deskripsi yang lebih pendek ditolak', async () => {
  const db = new FakeDb({
    jobs: [existing('a', { salary_min: 7_000_000, salary_max: 8_000_000, salary_currency: 'IDR', salary_period: 'month', requirements: ['Syarat lama'], description: 'deskripsi lama yang panjang sekali dan lengkap' })],
  })
  const s = await ingestJobs(db as any, [
    rj({ id: 'a', description: 'pendek', salary_min: 9_000_000, salary_max: 13_000_000, salary_currency: 'IDR', salary_period: 'month', skills: ['Excel'] }),
  ])
  assert.equal(s.duplicates, 1)
  assert.equal(s.enriched, 0)
  assert.equal(db.writes.length, 0)
  const r = db.rows('jobs')[0]
  assert.equal(r.salary_min, 7_000_000)
  assert.deepEqual(r.requirements, ['Syarat lama'])
  assert.equal(r.description, 'deskripsi lama yang panjang sekali dan lengkap')
})

test('duplikat: match_score kosong tetap diisi (backfill) bersama bidang lain; tanpa bidang lain tidak ada updated_at', async () => {
  const db = new FakeDb({ jobs: [existing('a', { match_score: null }), existing('b', { match_score: null })] })
  const s = await ingestJobs(db as any, [
    rj({ id: 'a', match_score: 42, salary_range: 'Rp 5jt - 7jt' }),
    rj({ id: 'b', match_score: 42 }),
  ])
  assert.equal(s.backfilled, 2)
  assert.equal(s.enriched, 1)
  const [a, b] = db.rows('jobs')
  assert.equal(a.match_score, 42)
  assert.equal(a.salary_min, 5_000_000)
  assert.equal(b.match_score, 42)
  assert.equal('updated_at' in b, false)
  assert.deepEqual(db.writes.filter((w) => w.op === 'update').map((w) => Object.keys(w.payload).sort()), [
    ['match_score', 'salary_currency', 'salary_max', 'salary_min', 'salary_period', 'updated_at'],
    ['match_score'],
  ])
})

test('detailPatch: hanya bidang yang ikut terbaca dari DB yang dipertimbangkan', () => {
  const job = rj({ id: 'x', description: 'deskripsi baru yang lebih panjang', salary_range: 'Rp 5jt - 7jt', skills: ['SQL'] })
  assert.deepEqual(detailPatch({ id: '1' }, job), {})
  assert.deepEqual(Object.keys(detailPatch({ id: '1', salary_min: null }, job)).sort(), ['salary_currency', 'salary_max', 'salary_min', 'salary_period'])
  assert.deepEqual(detailPatch({ id: '1', requirements: null }, job), { requirements: ['SQL'] })
  assert.deepEqual(detailPatch({ id: '1', requirements: ['sudah'] }, job), {})
  assert.deepEqual(detailPatch({ id: '1', description: 'pendek' }, job), { description: 'deskripsi baru yang lebih panjang' })
  assert.deepEqual(detailPatch({ id: '1', description: null }, rj({ id: 'y', description: '' })), {})
})

test('requirementsOf: rapikan spasi, buang duplikat dan butir kosong, potong 200 karakter, maksimum 20', () => {
  assert.deepEqual(requirementsOf({ requirements: ['  Minimal   S1 ', '', 'Minimal S1', 5 as any] }), ['Minimal S1'])
  assert.deepEqual(requirementsOf({ skills: ['SQL'] }), ['SQL'])
  assert.deepEqual(requirementsOf({}), [])
  assert.equal(requirementsOf({ requirements: ['a'.repeat(300)] })[0].length, 200)
  assert.equal(requirementsOf({ skills: Array.from({ length: 40 }, (_, i) => `s${i}`) }).length, 20)
})

// ---- skema live yang belum punya kolom baru ---------------------------------------------------------------

/** Bungkus FakeDb: semua kolom di `missing` dianggap tidak ada di skema (insert/select/update menolaknya). */
function schemaWithout(db: FakeDb, missing: string[]) {
  return {
    from(table: string) {
      const q: any = db.from(table)
      const hasMissing = (obj: any) => missing.find((c) => obj && typeof obj === 'object' && c in obj)
      const insert = q.insert.bind(q)
      q.insert = (payload: any) => {
        const bad = hasMissing(payload)
        return bad ? Promise.resolve({ error: { code: 'PGRST204', message: `Could not find the '${bad}' column of 'jobs' in the schema cache` } }) : insert(payload)
      }
      const update = q.update.bind(q)
      q.update = (payload: any) => {
        const bad = hasMissing(payload)
        if (!bad) return update(payload)
        return { eq: async () => ({ error: { code: 'PGRST204', message: `Could not find the '${bad}' column of 'jobs' in the schema cache` } }) }
      }
      const select = q.select.bind(q)
      q.select = (cols: string, opts?: any) => {
        const bad = missing.find((c) => cols.includes(c))
        if (!bad) return select(cols, opts)
        return { eq: () => ({ limit: async () => ({ data: null, error: { code: '42703', message: `column jobs.${bad} does not exist` } }) }) }
      }
      return q
    },
  }
}

test('skema live tanpa kolom salary_*: insert diulang tanpa kolom itu, lowongan tetap tersimpan', async () => {
  const inner = new FakeDb({ jobs: [] })
  const s = await ingestJobs(
    schemaWithout(inner, ['salary_min', 'salary_max', 'salary_currency', 'salary_period']) as any,
    [rj({ id: 'a', salary_min: 9e6, salary_max: 13e6, salary_currency: 'IDR', salary_period: 'month', skills: ['SQL'] }), rj({ id: 'b', salary_range: 'Rp 5jt' })],
  )
  assert.equal(s.inserted, 2)
  assert.equal(s.failed, 0)
  const [a, b] = inner.rows('jobs')
  assert.equal('salary_min' in a, false)
  assert.equal('requirements' in a, false, 'requirements ikut dilepas bersama gaji (satu kelompok kolom detail)')
  assert.equal(a.match_score, 50)
  assert.equal('salary_min' in b, false)
})

test('skema live tanpa kolom detail: duplikat tetap terdeteksi dan match_score tetap diisi', async () => {
  const inner = new FakeDb({ jobs: [existing('a', { match_score: null })] })
  const s = await ingestJobs(schemaWithout(inner, ['salary_min']) as any, [rj({ id: 'a', match_score: 42, salary_range: 'Rp 5jt - 7jt' }), rj({ id: 'b' })])
  assert.equal(s.duplicates, 1)
  assert.equal(s.inserted, 1)
  assert.equal(s.enriched, 0)
  assert.equal(s.backfilled, 1)
  assert.equal(inner.rows('jobs').find((r) => r.id === 'row-a')!.match_score, 42)
})
