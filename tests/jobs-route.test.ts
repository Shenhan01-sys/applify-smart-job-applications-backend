import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import Fastify, { type FastifyInstance } from 'fastify'
import { FakeDb } from './helpers/fakeDb.ts'
import { jobRoutes, ENRICH_LIMIT_PER_MINUTE, ENRICH_WINDOW_MS } from '../api/routes/jobs.ts'

/**
 * HTTP-level: POST /api/jobs/:id/enrich dan GET /api/jobs/:id/salary-benchmark dengan FakeDb dan fetch tiruan.
 * Tidak ada jaringan; yang diuji adalah rute asli, bukan tiruannya.
 */

const JS_URL = 'https://id.jobstreet.com/id/job/92996157'
const PAGE =
  '<html><script>window.SEEK_REDUX_DATA = ' +
  JSON.stringify({
    jobdetails: { result: { job: {
      content: '<p>Deskripsi lengkap lowongan analis data.</p><h2>Requirements</h2><ul><li>Minimal S1 Statistik atau Teknik Informatika</li><li>Menguasai SQL</li></ul>',
      salary: { label: 'Rp 9.000.000 – Rp 13.000.000 per month' },
    } } },
  }) +
  ';</script></html>'

let app: FastifyInstance
let db: FakeDb
let user: { id: string } | undefined
let clock: number
let fetchCalls: string[]

const fakeFetch = (async (input: any) => {
  fetchCalls.push(String(input))
  return new Response(PAGE, { status: 200 })
}) as unknown as typeof fetch

beforeEach(async () => {
  user = { id: 'u1' }
  clock = 1_000_000
  fetchCalls = []
  db = new FakeDb({
    jobs: [
      { id: 'j1', title: 'Data Analyst', company: 'PT Uji', location: 'Jakarta, Indonesia', status: 'active', platform_source: 'jobstreet', external_url: JS_URL, description: 'teaser', requirements: [], salary_min: null, salary_max: null },
      { id: 'j2', title: 'Data Analyst', company: 'PT Lain', location: 'Jakarta, Indonesia', status: 'active', salary_min: 8_000_000, salary_max: 10_000_000, salary_currency: 'IDR', salary_period: 'month', external_url: 'https://id.jobstreet.com/id/job/2', platform_source: 'jobstreet' },
    ],
  })
  app = Fastify()
  app.addHook('preHandler', async (req) => {
    if (user) (req as any).user = user
  })
  await app.register(jobRoutes, { prefix: '/api/jobs', db: db as any, fetchImpl: fakeFetch, now: () => clock })
})

afterEach(async () => {
  await app.close()
})

const enrich = (id = 'j1') => app.inject({ method: 'POST', url: `/api/jobs/${id}/enrich` })
const bench = (id = 'j1') => app.inject({ method: 'GET', url: `/api/jobs/${id}/salary-benchmark` })

test('POST /:id/enrich: 200 { job, enriched, reason } dan baris jobs terisi', async () => {
  const res = await enrich()
  assert.equal(res.statusCode, 200)
  const body = res.json()
  assert.deepEqual(Object.keys(body).sort(), ['enriched', 'job', 'reason'])
  assert.equal(body.enriched, true)
  assert.equal(body.reason, 'detail lowongan diperbarui')
  assert.equal(body.job.id, 'j1')
  assert.match(body.job.description, /Deskripsi lengkap lowongan analis data/)
  assert.deepEqual(body.job.requirements, ['Minimal S1 Statistik atau Teknik Informatika', 'Menguasai SQL'])
  assert.equal(body.job.salary_min, 9_000_000)
  assert.equal(body.job.salary_max, 13_000_000)
  assert.equal(body.job.salary_currency, 'IDR')
  assert.equal(body.job.salary_period, 'month')
  assert.deepEqual(fetchCalls, [JS_URL])
  assert.equal(db.rows('jobs')[0].salary_min, 9_000_000)
})

test('POST /:id/enrich: situs tidak didukung -> 200 enriched false dengan alasan (bukan galat)', async () => {
  db.rows('jobs')[0].external_url = 'https://glints.com/id/opportunities/jobs/abc'
  db.rows('jobs')[0].platform_source = 'glints'
  const res = await enrich()
  assert.equal(res.statusCode, 200)
  assert.deepEqual({ enriched: res.json().enriched, reason: res.json().reason }, { enriched: false, reason: 'situs tidak didukung' })
  assert.equal(res.json().job.id, 'j1')
  assert.equal(fetchCalls.length, 0)
})

test('tanpa pengguna: 401 di kedua rute, tanpa menyentuh DB atau situs', async () => {
  user = undefined
  assert.equal((await enrich()).statusCode, 401)
  assert.equal((await bench()).statusCode, 401)
  assert.equal(fetchCalls.length, 0)
  assert.equal(db.writes.length, 0)
})

test('lowongan tidak ada atau id tidak sah: 404 di kedua rute', async () => {
  for (const id of ['tidak-ada', 'a%20b', 'x'.repeat(100)]) {
    assert.equal((await enrich(id)).statusCode, 404, id)
    assert.equal((await bench(id)).statusCode, 404, id)
  }
  assert.deepEqual((await enrich('tidak-ada')).json(), { error: 'Job not found' })
  assert.equal(fetchCalls.length, 0)
})

test('POST /:id/enrich: batas 30 per menit per pengguna -> 429 dengan Retry-After; jendela bergeser; pengguna lain tidak terkena', async () => {
  for (let i = 0; i < ENRICH_LIMIT_PER_MINUTE; i++) assert.equal((await enrich()).statusCode, 200, `permintaan ${i + 1}`)
  const blocked = await enrich()
  assert.equal(blocked.statusCode, 429)
  assert.equal(blocked.headers['retry-after'], '60')
  assert.equal(blocked.json().retry_after_seconds, 60)

  user = { id: 'u2' }
  assert.equal((await enrich()).statusCode, 200)

  user = { id: 'u1' }
  clock += ENRICH_WINDOW_MS + 1
  assert.equal((await enrich()).statusCode, 200)
})

test('GET /:id/salary-benchmark: 200 dengan bentuk JSON lengkap', async () => {
  const res = await bench('j1')
  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.json(), {
    n: 1, p25: 9_000_000, median: 9_000_000, p75: 9_000_000,
    currency: 'IDR', period: 'month', keywords: ['data', 'analyst'], sufficient: false,
    city: 'jakarta', same_city_n: 1, same_city_median: 9_000_000,
  })
})

test('galat DB: 500 dengan pesan; tidak membocorkan stack', async () => {
  db.failOn('jobs', 'select')
  const e = await enrich()
  assert.equal(e.statusCode, 500)
  assert.equal(typeof e.json().error, 'string')
  const b = await bench()
  assert.equal(b.statusCode, 500)
})

// ---- pemasangan di api/index.ts (tanpa menyalakan server) -----------------------------------------------

test('api/index.ts memasang jobRoutes di /api/jobs di dalam blok yang memakai authMiddleware', () => {
  const src = readFileSync(new URL('../api/index.ts', import.meta.url), 'utf8')
  assert.match(src, /import \{ jobRoutes \} from '\.\/routes\/jobs\.js'/)
  const authBlock = src.slice(src.indexOf("addHook('preHandler', authMiddleware)"), src.indexOf('// Public routes'))
  assert.match(authBlock, /register\(jobRoutes, \{ prefix: '\/api\/jobs' \}\)/)
  const publicPart = src.slice(src.indexOf('// Public routes'))
  assert.doesNotMatch(publicPart, /jobRoutes/)
})

test('api/routes/jobs.ts: enam rute (enrich, pembanding, channel, backfill, status backfill, off-portal/parse), semuanya menolak tanpa user.id dan memakai klien service-role lewat import dinamis', () => {
  const src = readFileSync(new URL('../api/routes/jobs.ts', import.meta.url), 'utf8')
  assert.match(src, /app\.post\('\/:id\/enrich'/)
  assert.match(src, /app\.get\('\/:id\/salary-benchmark'/)
  assert.match(src, /app\.get\('\/:id\/channel'/)
  assert.match(src, /app\.post\('\/backfill'/)
  assert.match(src, /app\.get\('\/backfill\/status'/)
  assert.match(src, /app\.post\('\/off-portal\/parse'/)
  assert.equal((src.match(/\(request as any\)\.user\?\.id/g) ?? []).length, 6)
  assert.equal((src.match(/status\(401\)/g) ?? []).length, 6)
  assert.match(src, /await import\('\.\.\/index\.js'\)/)
  assert.doesNotMatch(src.split('\n').filter((l) => /^import /.test(l)).join('\n'), /\.\.\/index\.js/)
})
