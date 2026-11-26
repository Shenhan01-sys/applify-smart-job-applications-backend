import test from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import { approvalRoutes } from '../api/routes/approval.js'
import { agentCodeRoutes } from '../api/routes/agent-code.js'

/**
 * Temuan uji integrasi: `POST /api/approvals/:id/rerun` dengan id yang bukan UUID menjawab 500 dan membocorkan teks
 * galat Postgres. Sekarang semua rute `/api/approvals/:id/*` menolak id itu 400 `invalid_id` sebelum menyentuh
 * database, dan teks galat database tidak pernah sampai ke klien. Semua database di sini tiruan.
 */

const USER_ID = '11111111-2222-3333-4444-555555555555'
const GOOD_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1'
const PG_LEAK = 'invalid input syntax for type uuid: "SECRET_COLUMN_approval_requests_pkey"'
const BAD_IDS = ['abc', '12345', "1' OR '1'='1", '..%2F..%2Fetc', 'g'.repeat(36), `${GOOD_ID}0`, 'a'.repeat(90)]

/** DB tiruan: setiap kueri berakhir dengan galat Postgres yang berisi teks rahasia. Mencatat tabel yang disentuh. */
function leakyDb() {
  const calls: string[] = []
  const result = { data: null, error: { message: PG_LEAK, code: '22P02' }, count: null }
  const chain: any = new Proxy(function () {}, {
    get(_t, prop) {
      if (prop === 'then') return (res: any, rej: any) => Promise.resolve(result).then(res, rej)
      return () => chain
    },
    apply() {
      return chain
    },
  })
  return { calls, db: { from: (t: string) => (calls.push(t), chain) } }
}

async function build(opts: { user?: boolean } = {}) {
  const { calls, db } = leakyDb()
  const app = Fastify()
  app.addHook('preHandler', async (req: any) => {
    if (opts.user !== false) req.user = { id: USER_ID }
  })
  await app.register(approvalRoutes, { prefix: '/api/approvals', db, guard: { checkActionRateLimit: async () => {} } })
  return { app, calls }
}

const ID_ROUTES: Array<{ method: 'GET' | 'POST'; path: (id: string) => string; payload?: unknown }> = [
  { method: 'GET', path: (id) => `/api/approvals/${id}` },
  { method: 'POST', path: (id) => `/api/approvals/${id}/approve`, payload: {} },
  { method: 'POST', path: (id) => `/api/approvals/${id}/rerun`, payload: {} },
  { method: 'POST', path: (id) => `/api/approvals/${id}/mark-sent`, payload: {} },
  { method: 'POST', path: (id) => `/api/approvals/${id}/not-sent`, payload: {} },
  { method: 'POST', path: (id) => `/api/approvals/${id}/close`, payload: {} },
  { method: 'POST', path: (id) => `/api/approvals/${id}/reject`, payload: { reason: 'x' } },
  { method: 'POST', path: (id) => `/api/approvals/${id}/regenerate`, payload: {} },
  { method: 'POST', path: (id) => `/api/approvals/${id}/resolve-claim`, payload: { resolution: 'mark_sent' } },
]

test('id bukan UUID: semua rute /api/approvals/:id/* menjawab 400 invalid_id tanpa menyentuh database', async () => {
  const { app, calls } = await build()
  for (const route of ID_ROUTES) {
    for (const bad of BAD_IDS) {
      const res = await app.inject({ method: route.method, url: route.path(encodeURIComponent(bad)), payload: route.payload as any })
      const label = `${route.method} ${route.path(bad)}`
      assert.equal(res.statusCode, 400, label)
      assert.equal(res.json().code, 'invalid_id', label)
      assert.doesNotMatch(res.body, /uuid|syntax|SECRET|pkey|postgres/i, label)
    }
  }
  // Parameter lebih panjang dari 100 karakter ditolak Fastify sendiri (404) sebelum handler berjalan.
  for (const route of ID_ROUTES) {
    const res = await app.inject({ method: route.method, url: route.path('a'.repeat(120)), payload: route.payload as any })
    assert.ok(res.statusCode === 400 || res.statusCode === 404, `${route.method} ${route.path('a')}: ${res.statusCode}`)
  }
  assert.deepEqual(calls, []) // tidak ada kueri sama sekali
  await app.close()
})

test('pengguna tanpa login dengan id tidak sah tetap dijawab 401, bukan 400', async () => {
  const { app, calls } = await build({ user: false })
  const res = await app.inject({ method: 'POST', url: '/api/approvals/abc/rerun', payload: {} })
  assert.equal(res.statusCode, 401)
  assert.deepEqual(calls, [])
  await app.close()
})

test('UUID sah tetap sampai ke handler (tidak ditolak oleh pemeriksaan id)', async () => {
  const { app, calls } = await build()
  const res = await app.inject({ method: 'POST', url: `/api/approvals/${GOOD_ID.toUpperCase()}/reject`, payload: { reason: 'x' } })
  assert.notEqual(res.statusCode, 400)
  assert.ok(calls.includes('approval_requests'))
  await app.close()
})

test('galat database tidak pernah dikirim ke klien: 500 generik pada rerun, mark-sent, approve, pending, history, claim-statuses', async () => {
  const { app } = await build()
  const cases: Array<{ method: 'GET' | 'POST'; url: string; payload?: unknown; code?: string }> = [
    { method: 'POST', url: `/api/approvals/${GOOD_ID}/rerun`, payload: {}, code: 'rerun_failed' },
    { method: 'POST', url: `/api/approvals/${GOOD_ID}/mark-sent`, payload: {}, code: 'mark_failed' },
    { method: 'POST', url: `/api/approvals/${GOOD_ID}/not-sent`, payload: {}, code: 'not_sent_failed' },
    { method: 'POST', url: `/api/approvals/${GOOD_ID}/close`, payload: {}, code: 'close_failed' },
    { method: 'GET', url: '/api/approvals/pending', code: 'internal_error' },
    { method: 'GET', url: '/api/approvals/history', code: 'internal_error' },
    { method: 'POST', url: '/api/approvals/claim-statuses', payload: { approval_ids: [GOOD_ID] }, code: 'claims_lookup_failed' },
    { method: 'POST', url: `/api/approvals/${GOOD_ID}/resolve-claim`, payload: { resolution: 'mark_sent' } },
    { method: 'POST', url: `/api/approvals/${GOOD_ID}/regenerate`, payload: {} },
    { method: 'POST', url: `/api/approvals/${GOOD_ID}/approve`, payload: {} },
  ]
  for (const c of cases) {
    const res = await app.inject({ method: c.method, url: c.url, payload: c.payload as any })
    assert.doesNotMatch(res.body, /uuid|syntax|SECRET|pkey|22P02/i, `${c.method} ${c.url}: ${res.body}`)
    if (c.code) {
      assert.equal(res.statusCode, 500, c.url)
      assert.equal(res.json().code, c.code, c.url)
    }
  }
  await app.close()
})

test('POST /api/agent/security-code: id antrean bukan UUID dijawab 400 tanpa menyentuh database', async () => {
  const { calls, db } = leakyDb()
  const app = Fastify()
  app.addHook('preHandler', async (req: any) => {
    req.user = { id: USER_ID }
  })
  await app.register(agentCodeRoutes, { prefix: '/api/agent', db: db as any })
  for (const bad of BAD_IDS) {
    const res = await app.inject({ method: 'POST', url: '/api/agent/security-code', payload: { queue_job_id: bad, code: 'AB12CD34' } })
    assert.equal(res.statusCode, 400, bad)
    assert.equal(res.json().error, 'invalid_job')
    assert.doesNotMatch(res.body, /uuid|syntax|SECRET|pkey/i)
  }
  assert.deepEqual(calls, [])
  await app.close()
})
