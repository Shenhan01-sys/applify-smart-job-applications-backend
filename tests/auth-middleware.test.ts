import { test } from 'node:test'
import assert from 'node:assert/strict'
import { verifyToken } from '../api/middleware/auth.ts'

const user = { id: 'u1' }

test('token sah: lolos pada percobaan pertama', async () => {
  let calls = 0
  const r = await verifyToken(async () => { calls++; return { data: { user }, error: null } }, 't', 0)
  assert.deepEqual(r, { ok: true, user })
  assert.equal(calls, 1)
})

test('token ditolak Supabase (4xx): 401 tanpa percobaan ulang', async () => {
  let calls = 0
  const r = await verifyToken(async () => { calls++; return { data: { user: null }, error: { message: 'invalid JWT', status: 403 } } }, 't', 0)
  assert.deepEqual(r, { ok: false, status: 401, error: 'Invalid token' })
  assert.equal(calls, 1)
})

test('fetch failed sekali (uji klik 20 November 2026): dicoba lagi lalu lolos', async () => {
  let calls = 0
  const r = await verifyToken(async () => {
    calls++
    if (calls === 1) throw new TypeError('fetch failed')
    return { data: { user }, error: null }
  }, 't', 0)
  assert.equal(r.ok, true)
  assert.equal(calls, 2)
})

test('jaringan atau server auth tetap gagal: 503, bukan 401', async () => {
  let calls = 0
  const thrown = await verifyToken(async () => { calls++; throw new TypeError('fetch failed') }, 't', 0)
  assert.equal(thrown.ok, false)
  assert.equal(!thrown.ok && thrown.status, 503)
  assert.equal(calls, 2)
  const wrapped = await verifyToken(async () => ({ data: { user: null }, error: { message: 'fetch failed', status: 0 } }), 't', 0)
  assert.equal(!wrapped.ok && wrapped.status, 503)
  const server = await verifyToken(async () => ({ data: { user: null }, error: { message: 'bad gateway', status: 502 } }), 't', 0)
  assert.equal(!server.ok && server.status, 503)
})
