import test from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import { approvalRoutes } from '../api/routes/approval.js'

/**
 * E2E-02 (audit 26 Nov 2026): GET /api/approvals/history mengurutkan `reviewed_at DESC`. Di PostgreSQL, DESC
 * menaruh NULL paling atas (NULLS FIRST). Persetujuan kedaluwarsa tidak punya reviewed_at, jadi 50 baris
 * kedaluwarsa memenuhi halaman pertama dan persetujuan yang baru disetujui lenyap dari /approvals.
 * DB tiruan di sini meniru aturan NULL bawaan PostgREST/Postgres: DESC menaruh NULL di awal kecuali pemanggil
 * meminta `nullsFirst: false`.
 */

const USER_ID = '11111111-2222-3333-4444-555555555555'

type Row = { id: string; user_id: string; status: string; reviewed_at: string | null; created_at: string }
type Order = { column: string; ascending: boolean; nullsFirst: boolean }

function historyDb(rows: Row[]) {
  const orders: Order[] = []
  let from = 0
  let to = Infinity
  const eqs: Array<[string, unknown]> = []
  const neqs: Array<[string, unknown]> = []
  const chain: any = {
    select: () => chain,
    eq: (col: string, val: unknown) => (eqs.push([col, val]), chain),
    neq: (col: string, val: unknown) => (neqs.push([col, val]), chain),
    order: (column: string, opts: { ascending?: boolean; nullsFirst?: boolean } = {}) => {
      const ascending = opts.ascending ?? true
      // Aturan Postgres: ASC -> NULLS LAST, DESC -> NULLS FIRST, kecuali diminta lain.
      orders.push({ column, ascending, nullsFirst: opts.nullsFirst ?? !ascending })
      return chain
    },
    range: (a: number, b: number) => ((from = a), (to = b), chain),
    then: (res: any, rej: any) => {
      let out = rows.filter((r) => eqs.every(([c, v]) => (r as any)[c] === v) && neqs.every(([c, v]) => (r as any)[c] !== v))
      out = [...out].sort((a, b) => {
        for (const o of orders) {
          const av = (a as any)[o.column]
          const bv = (b as any)[o.column]
          if (av === bv) continue
          if (av === null) return o.nullsFirst ? -1 : 1
          if (bv === null) return o.nullsFirst ? 1 : -1
          const c = av < bv ? -1 : 1
          return o.ascending ? c : -c
        }
        return 0
      })
      return Promise.resolve({ data: out.slice(from, to + 1), error: null }).then(res, rej)
    },
  }
  return { db: { from: () => chain }, orders }
}

async function getHistory(rows: Row[], query = '') {
  const { db, orders } = historyDb(rows)
  const app = Fastify()
  app.addHook('preHandler', async (req: any) => {
    req.user = { id: USER_ID }
  })
  await app.register(approvalRoutes, { prefix: '/api/approvals', db: db as any, guard: { checkActionRateLimit: async () => {} } })
  const res = await app.inject({ method: 'GET', url: `/api/approvals/history${query}` })
  await app.close()
  return { res, body: res.json() as Row[], orders }
}

function expiredRows(n: number): Row[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `exp-${i}`,
    user_id: USER_ID,
    status: 'expired',
    reviewed_at: null,
    created_at: `2026-10-${String((i % 28) + 1).padStart(2, '0')}T00:00:00Z`,
  }))
}

test('50 persetujuan kedaluwarsa (reviewed_at NULL) tidak menutup persetujuan yang baru disetujui', async () => {
  const fresh: Row[] = [
    { id: 'fresh-approved', user_id: USER_ID, status: 'approved', reviewed_at: '2026-11-26T09:00:00Z', created_at: '2026-11-26T08:00:00Z' },
    { id: 'older-rejected', user_id: USER_ID, status: 'rejected', reviewed_at: '2026-11-20T09:00:00Z', created_at: '2026-11-20T08:00:00Z' },
  ]
  const { res, body } = await getHistory([...expiredRows(50), ...fresh], '?limit=50')
  assert.equal(res.statusCode, 200)
  assert.equal(body.length, 50)
  assert.deepEqual(body.slice(0, 2).map((r) => r.id), ['fresh-approved', 'older-rejected'])
  assert.equal(body[2].reviewed_at, null, 'baris kedaluwarsa ikut, tetapi setelah yang sudah ditinjau')
})

test('query meminta reviewed_at DESC NULLS LAST, lalu created_at DESC sebagai pemisah baris kedaluwarsa', async () => {
  const { orders } = await getHistory(expiredRows(3))
  assert.deepEqual(orders, [
    { column: 'reviewed_at', ascending: false, nullsFirst: false },
    { column: 'created_at', ascending: false, nullsFirst: true },
  ])
})

test('baris kedaluwarsa tetap berurutan dari yang terbaru dibuat', async () => {
  const rows = expiredRows(3)
  rows[0].created_at = '2026-11-01T00:00:00Z'
  rows[1].created_at = '2026-11-25T00:00:00Z'
  rows[2].created_at = '2026-11-10T00:00:00Z'
  const { body } = await getHistory(rows)
  assert.deepEqual(body.map((r) => r.id), ['exp-1', 'exp-2', 'exp-0'])
})
