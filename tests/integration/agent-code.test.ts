import { test, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'

/**
 * Integrasi: POST /api/agent/security-code pada server sungguhan. Pengguna mengetik kode keamanan yang dikirim
 * situs lowongan lewat email; backend hanya menerimanya bila agen memang sedang menunggu, menyimpannya terenkripsi
 * (format yang dibaca worker), dan tidak pernah memantulkan kode itu.
 */
const h = await import('../helpers/backendHarness.ts')
const { api, fake, USER_A, USER_B, uuid, future, past, decryptLikeWorker } = h

beforeEach(() => {
  fake.reset()
})
after(async () => {
  await fake.close()
  setTimeout(() => process.exit(process.exitCode ?? 0), 50).unref()
})

const CODE = 'AB12CD34'

/** Pekerjaan apply yang sedang memproses dan baru saja mencatat awaiting_code. */
function waitingJob(over: { status?: string; logStatus?: string; until?: string | null; user?: { id: string } } = {}) {
  const user = over.user ?? USER_A
  const queueJobId = uuid('c0de')
  fake.seed('automation_queue', { id: queueJobId, user_id: user.id, job_type: 'apply', status: over.status ?? 'processing', payload: {} })
  fake.seed('application_logs', {
    user_id: user.id,
    action: 'apply',
    status: over.logStatus ?? 'awaiting_code',
    details: { queue_job_id: queueJobId, ...(over.until === null ? {} : { awaiting_until: over.until ?? future(600_000) }) },
  })
  return queueJobId
}
const codes = () => fake.rows('agent_security_codes')

test('tanpa token: 401 dan tidak ada kode tersimpan', async () => {
  const id = waitingJob()
  const res = await api('POST', '/api/agent/security-code', { user: null, body: { queue_job_id: id, code: CODE } })
  assert.equal(res.status, 401)
  assert.equal(codes().length, 0)
})

test('agen menunggu: 202, kode tersimpan terenkripsi dan terbaca worker, jawaban tidak memuat kode', async () => {
  const id = waitingJob()
  const res = await api('POST', '/api/agent/security-code', { body: { queue_job_id: id, code: 'ab12 cd34' } })
  assert.equal(res.status, 202, res.text)
  assert.deepEqual(res.body, { accepted: true })
  assert.ok(!res.text.includes('CD34') && !res.text.toLowerCase().includes('cd34'))

  assert.equal(codes().length, 1)
  const row = codes()[0]
  assert.equal(row.queue_job_id, id)
  assert.equal(row.user_id, USER_A.id)
  assert.equal(row.used_at, null)
  assert.ok(!JSON.stringify(row).toLowerCase().includes('ab12cd34'), 'kode tidak tersimpan sebagai teks biasa')
  assert.equal(decryptLikeWorker(row.code_encrypted), 'ab12cd34', 'spasi dibuang, huruf besar-kecil dipertahankan, format dibaca worker')
  const ttl = new Date(row.expires_at).getTime() - Date.now()
  assert.ok(ttl > 14 * 60_000 && ttl <= 15 * 60_000, `masa berlaku ${ttl} ms`)
})

test('agen tidak menunggu: 409 untuk job selesai, log bukan awaiting_code, batas waktu lewat atau tanpa batas waktu', async () => {
  for (const [name, over] of [
    ['job completed', { status: 'completed' }],
    ['job pending', { status: 'pending' }],
    ['log bukan awaiting_code', { logStatus: 'ready' }],
    ['batas waktu lewat', { until: past() }],
    ['tanpa awaiting_until', { until: null }],
  ] as const) {
    const id = waitingJob(over as any)
    const res = await api('POST', '/api/agent/security-code', { body: { queue_job_id: id, code: CODE } })
    assert.equal(res.status, 409, name)
    assert.equal(res.body.error, 'agent_not_waiting', name)
  }
  assert.equal(codes().length, 0)
})

test('pekerjaan milik pengguna lain atau tidak ada: 404', async () => {
  const mine = waitingJob()
  assert.equal((await api('POST', '/api/agent/security-code', { user: USER_B, body: { queue_job_id: mine, code: CODE } })).status, 404)
  assert.equal((await api('POST', '/api/agent/security-code', { body: { queue_job_id: uuid('dead'), code: CODE } })).status, 404)
  assert.equal(codes().length, 0)
})

test('masukan tidak sah: 400 untuk kode kosong/terlalu pendek/berisi simbol dan id bukan uuid', async () => {
  const id = waitingJob()
  for (const code of ['', 'abc', 'AB!2CD34', 'x'.repeat(13), 12345678, null]) {
    const res = await api('POST', '/api/agent/security-code', { body: { queue_job_id: id, code } })
    assert.equal(res.status, 400, `kode ${JSON.stringify(code)}`)
    assert.equal(res.body.error, 'invalid_code')
  }
  const badJob = await api('POST', '/api/agent/security-code', { body: { queue_job_id: 'bukan-uuid', code: CODE } })
  assert.equal(badJob.status, 400)
  assert.equal(badJob.body.error, 'invalid_job')
  assert.equal(codes().length, 0)
})

test('badan bukan JSON atau terlalu besar: galat tetap dan tidak memantulkan isi badan', async () => {
  const bad = await api('POST', '/api/agent/security-code', { rawBody: `{"code":"${CODE}", oops` })
  assert.equal(bad.status, 400)
  assert.ok(!bad.text.includes(CODE), 'badan galat tidak memuat kode')

  const big = await api('POST', '/api/agent/security-code', { body: { queue_job_id: uuid('c0de'), code: CODE, pad: 'x'.repeat(5000) } })
  assert.equal(big.status, 413)
  assert.ok(!big.text.includes(CODE))
})

test('batas tiga kode per pekerjaan: keempat 429', async () => {
  const id = waitingJob()
  for (let i = 0; i < 3; i++) {
    const r = await api('POST', '/api/agent/security-code', { body: { queue_job_id: id, code: `CODE${i}XYZ` } })
    assert.equal(r.status, 202, `kode ke-${i + 1}: ${r.text}`)
  }
  const over = await api('POST', '/api/agent/security-code', { body: { queue_job_id: id, code: 'CODE9XYZ' } })
  assert.equal(over.status, 429)
  assert.equal(codes().length, 3)
})
