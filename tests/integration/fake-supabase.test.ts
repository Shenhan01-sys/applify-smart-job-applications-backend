import './../helpers/offlineGuard.ts'
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { startFakeSupabase } from '../helpers/fakeSupabase.ts'

/**
 * Supabase tiruan harus benar-benar strik, kalau tidak ia hanya mengulang kesalahan FakeDb yang longgar.
 * Tes ini bicara HTTP langsung ke tiruan itu dan memastikan ia menolak yang akan ditolak PostgREST sungguhan.
 */
const fake = await startFakeSupabase()
after(() => fake.close())

const rest = async (method: string, pathAndQuery: string, body?: unknown, headers: Record<string, string> = {}) => {
  const res = await fetch(`${fake.url}/rest/v1/${pathAndQuery}`, {
    method,
    headers: { 'content-type': 'application/json', prefer: 'return=representation', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  return { status: res.status, body: text ? JSON.parse(text) : null }
}

const USER = '11111111-1111-4111-8111-111111111111'

test('skema dibaca dari SQL: tabel inti dan tabel migrasi ada, tabel DRAFT tidak', () => {
  const names = fake.tableNames()
  for (const t of ['approval_requests', 'automation_queue', 'application_logs', 'ai_applications', 'approval_submit_claims', 'agent_security_codes', 'user_form_answers']) {
    assert.ok(names.includes(t), `tabel ${t} ada`)
  }
  assert.ok(!names.includes('user_llm_keys'), 'tabel dari migrasi DRAFT belum diterapkan, jadi tidak ada')
})

test('tabel yang tidak ada: 404 PGRST205', async () => {
  const r = await rest('GET', 'tabel_fiktif?select=id')
  assert.equal(r.status, 404)
  assert.equal(r.body.code, 'PGRST205')
})

test('kolom tak dikenal di select, filter, dan isi tulis ditolak', async () => {
  assert.equal((await rest('GET', 'approval_requests?select=id,kolom_fiktif')).body.code, '42703')
  assert.equal((await rest('GET', 'approval_requests?kolom_fiktif=eq.1')).body.code, '42703')
  const ins = await rest('POST', 'application_logs', { user_id: USER, action: 'apply', kolom_fiktif: 1 })
  assert.equal(ins.status, 400)
  assert.equal(ins.body.code, 'PGRST204')
  assert.equal((await rest('PATCH', 'application_logs?user_id=eq.' + USER, { kolom_fiktif: 1 })).body.code, 'PGRST204')
})

test('kolom dari migrasi (ALTER TABLE ADD COLUMN) dikenal: profiles.transcript_url', async () => {
  const r = await rest('GET', 'profiles?select=id,transcript_url,portfolio_file_url')
  assert.equal(r.status, 200)
})

test('tipe diperiksa: uuid salah, boolean salah, enum CHECK, NOT NULL', async () => {
  assert.equal((await rest('GET', 'approval_requests?id=eq.q1')).body.code, '22P02')
  assert.equal((await rest('POST', 'automation_queue', { user_id: 'bukan-uuid', job_type: 'apply' })).body.code, '22P02')
  const badEnum = await rest('POST', 'automation_queue', { user_id: USER, job_type: 'apply', status: 'awaiting_code' })
  assert.equal(badEnum.body.code, '23514', 'status di luar CHECK ditolak')
  const noJobType = await rest('POST', 'automation_queue', { user_id: USER })
  assert.equal(noJobType.body.code, '23502', 'job_type NOT NULL tanpa default')
})

test('default, kunci utama, dan UNIQUE bekerja; filter JSON ->> dan cs dipahami', async () => {
  const claim = { approval_request_id: '33333333-3333-4333-8333-333333333333', user_id: USER, channel: 'worker' }
  const first = await rest('POST', 'approval_submit_claims', claim)
  assert.equal(first.status, 201)
  assert.ok(first.body[0].created_at, 'default now()')
  const dup = await rest('POST', 'approval_submit_claims', claim)
  assert.equal(dup.status, 409)
  assert.equal(dup.body.code, '23505')

  const q = await rest('POST', 'automation_queue', { user_id: USER, job_type: 'apply', payload: { approval_request_id: 'abc', n: 1 } })
  assert.equal(q.body[0].status, 'pending', 'default status')
  assert.equal(q.body[0].payload.n, 1)
  const byPath = await rest('GET', 'automation_queue?payload->>approval_request_id=eq.abc&select=id')
  assert.equal(byPath.body.length, 1)
  const byContains = await rest('GET', 'application_logs?details=cs.' + encodeURIComponent('{"a":1}'))
  assert.equal(byContains.status, 200)
})

test('operator filter yang belum didukung gagal keras, tidak diam-diam mengembalikan semua baris', async () => {
  const r = await rest('GET', 'automation_queue?status=fts.pending')
  assert.equal(r.status, 400)
  assert.match(r.body.message, /not supported by the test fake/)
})

test('single() pada nol baris: 406 PGRST116, seperti PostgREST', async () => {
  const r = await rest('GET', `approval_requests?id=eq.${'44444444-4444-4444-8444-444444444444'}`, undefined, { accept: 'application/vnd.pgrst.object+json' })
  assert.equal(r.status, 406)
  assert.equal(r.body.code, 'PGRST116')
})

test('GoTrue: token terdaftar diterima, lainnya 401', async () => {
  fake.addUser('tok', { id: USER, email: 'a@contoh.test' })
  const ok = await fetch(`${fake.url}/auth/v1/user`, { headers: { authorization: 'Bearer tok' } })
  assert.equal(ok.status, 200)
  const bad = await fetch(`${fake.url}/auth/v1/user`, { headers: { authorization: 'Bearer lain' } })
  assert.equal(bad.status, 401)
})
