import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FakeDb } from './helpers/fakeDb.ts'
import { percentile, salaryBenchmark, titleKeywords } from '../services/salary-benchmark.service.ts'

/**
 * Pembanding gaji dengan FakeDb: persentil interpolasi linear, kata kunci judul, penyaringan (aktif, rupiah per bulan,
 * bukan lowongan itu sendiri), dan batas data cukup (>= 5).
 */

const M = 1_000_000
let seq = 0
const row = (title: string, min: number | null, max: number | null, over: Record<string, any> = {}) => ({
  id: `c${++seq}`, title, location: 'Bandung, Indonesia', status: 'active',
  salary_min: min, salary_max: max, salary_currency: 'IDR', salary_period: 'month', ...over,
})
const target = (over: Record<string, any> = {}) => ({
  id: 'j0', title: 'Senior Data Analyst (Contract)', location: 'Jakarta Selatan, Indonesia', status: 'active',
  salary_min: null, salary_max: null, salary_currency: null, salary_period: null, ...over,
})

test('percentile: interpolasi linear', () => {
  assert.equal(percentile([1, 2, 3, 4, 5], 0.25), 2)
  assert.equal(percentile([1, 2, 3, 4, 5], 0.5), 3)
  assert.equal(percentile([1, 2, 3, 4, 5], 0.75), 4)
  assert.equal(percentile([10, 20], 0.5), 15)
  assert.equal(percentile([10, 20, 30, 40], 0.25), 17.5)
  assert.equal(percentile([10, 20, 30, 40], 0.75), 32.5)
  assert.equal(percentile([7], 0.9), 7)
  assert.ok(Number.isNaN(percentile([], 0.5)))
})

test('titleKeywords: tanpa tingkat jabatan, jenis kontrak, tanda baca, dan kata < 3 huruf', () => {
  assert.deepEqual(titleKeywords('Senior Data Analyst (Contract)'), ['data', 'analyst'])
  assert.deepEqual(titleKeywords('Jr. Backend Engineer / Full-Time'), ['backend', 'engineer'])
  assert.deepEqual(titleKeywords('Staff Manager of IT & Operasional'), ['manager', 'operasional'])
  assert.deepEqual(titleKeywords('Magang Intern II'), [])
  assert.deepEqual(titleKeywords(null), [])
  // karakter yang bisa merusak filter PostgREST tidak pernah lolos ke kata kunci
  assert.deepEqual(titleKeywords('C++ dev, "x%y" (a.b)'), ['dev'])
})

test('benchmark: n, p25, median, p75 dari titik tengah; baris yang tidak sebanding dibuang', async () => {
  const db = new FakeDb({
    jobs: [
      target(),
      // pembanding sah (6): titik tengah 5, 7, 9, 11, 13, 15 juta
      row('Data Analyst', 4 * M, 6 * M, { location: 'Jakarta Selatan, Indonesia' }),
      row('Senior Data Analyst', 6 * M, 8 * M, { location: 'Jakarta Selatan, Indonesia' }),
      row('Data Analyst Intern', 8 * M, 10 * M, { location: 'Jakarta Selatan, Indonesia' }),
      row('Business Data Analyst', 10 * M, 12 * M),
      row('data analyst', 12 * M, 14 * M, { salary_currency: null, salary_period: null }),
      row('Data Analyst Lead', 15 * M, null),
      // tidak sebanding
      row('Data Entry', 40 * M, 60 * M), // hanya 1 kata kunci, ada >= 5 baris dengan 2 kata kunci
      row('Data Analyst', 80_000, 100_000, { salary_currency: 'USD', salary_period: 'year' }),
      row('Data Analyst', 120 * M, 180 * M, { salary_period: 'year' }),
      row('Data Analyst', 90 * M, 95 * M, { status: 'closed' }),
      row('Data Analyst', null, null),
      row('Akuntan', 7 * M, 9 * M),
    ],
  })
  const b = await salaryBenchmark(db as any, 'j0')
  assert.ok(b)
  assert.deepEqual(b.keywords, ['data', 'analyst'])
  assert.equal(b.n, 6)
  assert.equal(b.p25, 7_500_000)
  assert.equal(b.median, 10_000_000)
  assert.equal(b.p75, 12_500_000)
  assert.equal(b.currency, 'IDR')
  assert.equal(b.period, 'month')
  assert.equal(b.sufficient, true)
  assert.equal(b.city, 'jakarta selatan')
  assert.equal(b.same_city_n, 3)
  assert.equal(b.same_city_median, 7_000_000)
})

test('benchmark: kurang dari 2 kata kunci cocok dipakai bila baris dengan >= 2 kata kunci kurang dari 5', async () => {
  const db = new FakeDb({
    jobs: [
      target(),
      row('Data Analyst', 8 * M, 10 * M),
      row('Data Analyst', 10 * M, 12 * M),
      row('Data Engineer', 20 * M, 24 * M),
      row('Business Analyst', 12 * M, 14 * M),
      row('Data Scientist', 16 * M, 18 * M),
    ],
  })
  const b = await salaryBenchmark(db as any, 'j0')
  assert.ok(b)
  assert.equal(b.n, 5)
  assert.equal(b.sufficient, true)
  assert.equal(b.median, 13 * M)
})

test('benchmark: data kurang dari 5 -> sufficient false (angka tetap dihitung dari yang ada)', async () => {
  const db = new FakeDb({ jobs: [target(), row('Data Analyst', 8 * M, 10 * M), row('Data Analyst', 10 * M, 12 * M)] })
  const b = await salaryBenchmark(db as any, 'j0')
  assert.ok(b)
  assert.equal(b.n, 2)
  assert.equal(b.sufficient, false)
  assert.equal(b.median, 10 * M)
})

test('benchmark: tidak ada pembanding, atau judul tanpa kata kunci peran -> n 0, tidak cukup', async () => {
  const none = await salaryBenchmark(new FakeDb({ jobs: [target(), row('Akuntan', 7 * M, 9 * M)] }) as any, 'j0')
  assert.deepEqual(
    { n: none!.n, p25: none!.p25, median: none!.median, p75: none!.p75, sufficient: none!.sufficient, same: none!.same_city_n },
    { n: 0, p25: null, median: null, p75: null, sufficient: false, same: 0 },
  )

  const noTokens = await salaryBenchmark(new FakeDb({ jobs: [target({ title: 'Magang Intern' }), row('Data Analyst', 8 * M, 10 * M)] }) as any, 'j0')
  assert.equal(noTokens!.n, 0)
  assert.equal(noTokens!.sufficient, false)
  assert.deepEqual(noTokens!.keywords, [])
})

test('benchmark: lowongan tidak ada -> null; galat DB dilempar', async () => {
  assert.equal(await salaryBenchmark(new FakeDb({ jobs: [] }) as any, 'nope'), null)
  const broken = new FakeDb({ jobs: [target()] })
  broken.failOn('jobs', 'select')
  await assert.rejects(() => salaryBenchmark(broken as any, 'j0'))
})
