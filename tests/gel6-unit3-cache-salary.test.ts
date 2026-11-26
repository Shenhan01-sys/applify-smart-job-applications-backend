import test from 'node:test'
import assert from 'node:assert/strict'
import { clearBoardCache, getOrFetchBoardPayload } from '../mcp/shared/board-cache.js'
import { cityAliasOf, cityOf, salaryBenchmark } from '../services/salary-benchmark.service.js'

test('47.3 P2-07: getOrFetchBoardPayload menyimpan payload board selama TTL dan mengambil ulang setelah kedaluwarsa', async () => {
  clearBoardCache()
  let hits = 0
  const fetcher = async () => ({ jobs: [{ id: ++hits }] })
  const a = await getOrFetchBoardPayload('greenhouse:acme', fetcher, { ttlMs: 1000, nowMs: 10_000 })
  const b = await getOrFetchBoardPayload('greenhouse:acme', fetcher, { ttlMs: 1000, nowMs: 10_500 })
  assert.equal(hits, 1)
  assert.deepEqual(a, b)

  const c = await getOrFetchBoardPayload('greenhouse:acme', fetcher, { ttlMs: 1000, nowMs: 11_500 })
  assert.equal(hits, 2)
  assert.deepEqual(c, { jobs: [{ id: 2 }] })
  clearBoardCache()
})

test('47.3 P3-02: cityAliasOf menyamakan alias Jakarta/Jogja untuk same_city_* sambil menjaga cityOf & mengecualikan periode year', async () => {
  assert.equal(cityOf('Jakarta Selatan, DKI Jakarta'), 'jakarta selatan')
  assert.equal(cityAliasOf('Jakarta Selatan, DKI Jakarta'), 'jakarta')
  assert.equal(cityAliasOf('Jaksel'), 'jakarta')
  assert.equal(cityAliasOf('Jogja, Indonesia'), 'yogyakarta')
  assert.equal(cityAliasOf('Sby'), 'surabaya')

  const peers = [
    { id: 'p1', title: 'Backend Engineer', location: 'Jakarta Pusat', salary_min: 10_000_000, salary_max: 12_000_000, salary_currency: 'IDR', salary_period: 'month', external_url: 'https://a.test/1', platform_source: 'jobstreet' },
    { id: 'p2', title: 'Backend Engineer', location: 'Jakarta Selatan', salary_min: 10_000_000, salary_max: 12_000_000, salary_currency: 'IDR', salary_period: 'month', external_url: 'https://a.test/2', platform_source: 'jobstreet' },
    { id: 'p3', title: 'Backend Engineer', location: 'Jakarta', salary_min: 11_000_000, salary_max: 13_000_000, salary_currency: 'IDR', salary_period: 'month', external_url: 'https://a.test/3', platform_source: 'jobstreet' },
    { id: 'p4', title: 'Backend Engineer', location: 'Bandung', salary_min: 9_000_000, salary_max: 11_000_000, salary_currency: 'IDR', salary_period: 'month', external_url: 'https://a.test/4', platform_source: 'jobstreet' },
    { id: 'p5', title: 'Backend Engineer', location: 'Surabaya', salary_min: 8_000_000, salary_max: 10_000_000, salary_currency: 'IDR', salary_period: 'month', external_url: 'https://a.test/5', platform_source: 'jobstreet' },
  ]
  const db: any = {
    from() {
      let isSingle = false
      const chain: any = {
        select() { return chain },
        eq() { return chain },
        gt() { return chain },
        or() { return chain },
        limit() { return Promise.resolve({ data: peers, error: null }) },
        maybeSingle() {
          isSingle = true
          return Promise.resolve({ data: { id: 'target', title: 'Backend Engineer', location: 'Jaksel', visibility: 'public', created_by: null }, error: null })
        },
      }
      void isSingle
      return chain
    },
  }
  const res = await salaryBenchmark(db, 'target', { userId: 'u1' })
  assert.ok(res)
  assert.equal(res.n, 5)
  assert.equal(res.sufficient, true)
  assert.equal(res.city, 'jaksel')
  assert.equal(res.same_city_n, 3)
  assert.equal(res.same_city_median, 11_000_000)
})
