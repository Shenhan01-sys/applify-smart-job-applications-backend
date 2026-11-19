import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import Fastify, { type FastifyInstance } from 'fastify'
import { readFileSync } from 'node:fs'
import { FakeDb } from './helpers/fakeDb.ts'
import { AiGuardService, AiAccessError, AI_DRAFT_ACTION, aiLimitsFromEnv, DEFAULT_AI_LIMITS, type AiLimits } from '../services/ai-guard.service.ts'
import { parseQuotaStatus, DEFAULT_MONTHLY_QUOTA } from '../services/quota-status.ts'
import { aiPipelineService } from '../services/ai-pipeline.service.ts'
import { formAutofillService } from '../services/form-autofill.service.ts'
import { aiRoutes } from '../api/routes/ai.ts'

/**
 * /api/ai/* menolak pengguna yang kuota draf bulanannya habis atau yang melewati batas laju, SEBELUM pipeline
 * AI dipanggil. Database dan pipeline sepenuhnya tiruan; tidak ada panggilan jaringan.
 */

const NOW = new Date('2026-11-18T10:00:00.000Z')
const NOW_MS = NOW.getTime()
const ago = (sec: number) => new Date(NOW_MS - sec * 1000).toISOString()
const LIMITS: AiLimits = { perMinute: 3, perHour: 5 }

type RpcResult = { data: any; error: { message: string } | null }

/** FakeDb + rpc() tiruan untuk get_quota_status. */
class GuardDb extends FakeDb {
  rpcCalls: Array<{ fn: string; args: any }> = []
  quotaRow: any = { allowed: true, used: 2, limit_qty: 10, remaining: 8, period: 'monthly' }
  rpcError: string | null = null
  /** Seperti default now() di database: baris baru bertanda waktu NOW (jam tiruan yang dipakai penjaga). */
  from(table: string) {
    const q: any = super.from(table)
    const insert = q.insert.bind(q)
    const stamp = (r: any) => ({ created_at: NOW.toISOString(), ...r })
    q.insert = (payload: any) => insert(Array.isArray(payload) ? payload.map(stamp) : stamp(payload))
    return q
  }
  async rpc(fn: string, args: any): Promise<RpcResult> {
    this.rpcCalls.push({ fn, args })
    if (this.rpcError) return { data: null, error: { message: this.rpcError } }
    return { data: [this.quotaRow], error: null }
  }
}

const aiRequests = (db: FakeDb, userId = 'u1') => db.rows('application_logs').filter((r) => r.user_id === userId && r.action === 'ai_request')
const seedRequests = (n: number, secondsAgo: number, userId = 'u1') =>
  Array.from({ length: n }, () => ({ user_id: userId, action: 'ai_request', status: 'success', created_at: ago(secondsAgo) }))

const guardFor = (db: GuardDb, limits = LIMITS) => new AiGuardService(db as any, limits, () => NOW)

// ---- parseQuotaStatus: salinan logika Edge Function, vektor uji yang sama dengan frontend ----------------------

test('parseQuotaStatus: array satu baris (bentuk RPC), habis, objek tunggal, kosong, angka salah', () => {
  assert.deepEqual(parseQuotaStatus([{ allowed: true, used: 3, limit_qty: 10, remaining: 7, period: 'monthly' }]), { quota: 10, used: 3, remaining: 7, allowed: true })
  const full = parseQuotaStatus([{ allowed: false, used: 10, limit_qty: 10, remaining: 0 }])
  assert.equal(full.remaining, 0)
  assert.equal(full.allowed, false)
  assert.deepEqual(parseQuotaStatus({ used: 4, limit_qty: 20 }), { quota: 20, used: 4, remaining: 16, allowed: true })
  assert.deepEqual(parseQuotaStatus({ used: 25, limit_qty: 20 }), { quota: 20, used: 25, remaining: 0, allowed: false })
  const fresh = { quota: DEFAULT_MONTHLY_QUOTA, used: 0, remaining: DEFAULT_MONTHLY_QUOTA, allowed: true }
  for (const raw of [null, undefined, [], 'x', 42]) assert.deepEqual(parseQuotaStatus(raw), fresh)
  assert.deepEqual(parseQuotaStatus([{ used: -5, limit_qty: '20', remaining: 'abc' }]), { quota: 20, used: 0, remaining: 20, allowed: true })
  assert.equal(DEFAULT_MONTHLY_QUOTA, 10)
})

// ---- AiGuardService -------------------------------------------------------------------------------------------

test('check: kuota tersisa dan di bawah batas laju -> lolos, RPC get_quota_status dipanggil untuk pengguna itu, permintaan dicatat', async () => {
  const db = new GuardDb()
  const { quota } = await guardFor(db).check('u1', '/cover-letter')
  assert.deepEqual(quota, { quota: 10, used: 2, remaining: 8, allowed: true })
  assert.deepEqual(db.rpcCalls, [{ fn: 'get_quota_status', args: { p_user_id: 'u1' } }])
  assert.equal(aiRequests(db).length, 1)
  assert.equal(aiRequests(db)[0].details.route, '/cover-letter')
})

test('check: kuota bulanan habis -> 429 quota_exhausted dengan angka kuota, dan permintaan tidak dicatat', async () => {
  const db = new GuardDb()
  db.quotaRow = { allowed: false, used: 10, limit_qty: 10, remaining: 0, period: 'monthly' }
  await assert.rejects(guardFor(db).check('u1', '/cv'), (e: any) => {
    assert.ok(e instanceof AiAccessError)
    assert.equal(e.statusCode, 429)
    assert.equal(e.code, 'quota_exhausted')
    assert.match(e.message, /habis \(10 dari 10 terpakai\)/)
    assert.deepEqual(e.extra.quota, { quota: 10, used: 10, remaining: 0, allowed: false })
    return true
  })
  assert.equal(aiRequests(db).length, 0)
})

test('check: sisa kuota 1 masih lolos; sisa 0 dengan allowed true dari RPC tetap ditolak (remaining yang menentukan, seperti Edge Function)', async () => {
  const db = new GuardDb()
  db.quotaRow = { allowed: true, used: 9, limit_qty: 10, remaining: 1 }
  await guardFor(db).check('u1', '/cv')
  db.quotaRow = { allowed: true, used: 10, limit_qty: 10, remaining: 0 }
  await assert.rejects(guardFor(db).check('u1', '/cv'), (e: any) => e.code === 'quota_exhausted')
})

test('check: galat RPC kuota -> 503 quota_check_failed (ditolak, bukan diloloskan)', async () => {
  const db = new GuardDb()
  db.rpcError = 'connection reset'
  await assert.rejects(guardFor(db).check('u1', '/cv'), (e: any) => e.statusCode === 503 && e.code === 'quota_check_failed')
  assert.equal(aiRequests(db).length, 0)
})

test('check: batas per menit tercapai -> 429 rate_limited dengan retryAfterSec dari permintaan tertua di jendela', async () => {
  const db = new GuardDb({ application_logs: [...seedRequests(1, 50), ...seedRequests(1, 30), ...seedRequests(1, 10)] })
  await assert.rejects(guardFor(db).check('u1', '/cv'), (e: any) => {
    assert.equal(e.statusCode, 429)
    assert.equal(e.code, 'rate_limited')
    // slot bebas saat permintaan terlama (50 detik lalu) keluar dari jendela 60 detik: 10 detik lagi
    assert.equal(e.extra.retryAfterSec, 10)
    assert.match(e.message, /Coba lagi dalam 10 detik/)
    return true
  })
  assert.equal(db.rpcCalls.length, 0, 'ditolak sebelum RPC kuota')
  assert.equal(aiRequests(db).length, 3, 'permintaan yang ditolak tidak dicatat')
})

test('check: batas per jam tercapai walau per menit longgar; retry mengikuti permintaan ke-5 terbaru', async () => {
  const db = new GuardDb({ application_logs: [...seedRequests(5, 3000)] })
  await assert.rejects(guardFor(db).check('u1', '/cv'), (e: any) => {
    assert.equal(e.code, 'rate_limited')
    assert.equal(e.extra.retryAfterSec, 600) // 3600 - 3000
    return true
  })
})

test('check: permintaan pengguna lain, lama (di luar jendela), atau aksi lain tidak dihitung', async () => {
  const db = new GuardDb({
    application_logs: [
      ...seedRequests(5, 5, 'u2'),
      ...seedRequests(5, 4000), // lebih dari satu jam
      ...Array.from({ length: 5 }, () => ({ user_id: 'u1', action: 'apply', status: 'success', created_at: ago(5) })),
    ],
  })
  await guardFor(db).check('u1', '/cv')
  assert.equal(aiRequests(db).length, 6)
})

test('check: tepat satu di bawah batas lolos, di batas ditolak', async () => {
  const db = new GuardDb({ application_logs: seedRequests(2, 20) })
  await guardFor(db).check('u1', '/cv') // permintaan ke-3 dari 3 per menit
  await assert.rejects(guardFor(db).check('u1', '/cv'), (e: any) => e.code === 'rate_limited') // ke-4
})

test('check: galat membaca batas laju atau mencatat permintaan -> 503 rate_limit_check_failed', async () => {
  const readFail = new GuardDb()
  readFail.failOn('application_logs', 'select')
  await assert.rejects(guardFor(readFail).check('u1', '/cv'), (e: any) => e.statusCode === 503 && e.code === 'rate_limit_check_failed')

  const writeFail = new GuardDb()
  writeFail.failOn('application_logs', 'insert')
  await assert.rejects(guardFor(writeFail).check('u1', '/cv'), (e: any) => e.statusCode === 503 && e.code === 'rate_limit_check_failed')
})

test('recordDraft: mencatat action ai_draft; galat database tidak dilempar', async () => {
  const db = new GuardDb()
  await guardFor(db).recordDraft('u1', '/cover-letter')
  assert.equal(db.rows('application_logs').filter((r) => r.action === 'ai_draft' && r.user_id === 'u1').length, 1)

  const broken = new GuardDb()
  broken.failOn('application_logs', 'insert')
  await guardFor(broken).recordDraft('u1', '/cover-letter') // tidak melempar
})

test('aiLimitsFromEnv: bawaan 10/menit dan 60/jam; nilai tidak valid diabaikan', () => {
  assert.deepEqual(aiLimitsFromEnv({}), DEFAULT_AI_LIMITS)
  assert.deepEqual(aiLimitsFromEnv({ AI_RATE_LIMIT_PER_MINUTE: '4', AI_RATE_LIMIT_PER_HOUR: '20' }), { perMinute: 4, perHour: 20 })
  assert.deepEqual(aiLimitsFromEnv({ AI_RATE_LIMIT_PER_MINUTE: '0', AI_RATE_LIMIT_PER_HOUR: '-3' }), DEFAULT_AI_LIMITS)
  assert.deepEqual(aiLimitsFromEnv({ AI_RATE_LIMIT_PER_MINUTE: 'abc', AI_RATE_LIMIT_PER_HOUR: '1.5' }), DEFAULT_AI_LIMITS)
})

// ---- Rute /api/ai/*: penjaga berlaku sebelum pipeline --------------------------------------------------------------

let app: FastifyInstance
let db: GuardDb
let pipelineCalls: string[]
const original = {
  generateCoverLetter: aiPipelineService.generateCoverLetter,
  generateCV: aiPipelineService.generateCV,
  evaluateCV: aiPipelineService.evaluateCV,
  generateAnswer: aiPipelineService.generateAnswer,
  extractSkills: aiPipelineService.extractSkills,
  analyzeJobMatch: aiPipelineService.analyzeJobMatch,
  fillField: formAutofillService.fillField,
}

async function build(opts: { user?: string | null; limits?: AiLimits } = {}) {
  app = Fastify()
  if (opts.user !== null) {
    app.addHook('preHandler', async (req) => {
      ;(req as any).user = { id: opts.user ?? 'u1' }
    })
  }
  await app.register(aiRoutes, { prefix: '/api/ai', guard: guardFor(db, opts.limits ?? LIMITS) })
}

beforeEach(() => {
  db = new GuardDb()
  pipelineCalls = []
  const track = (name: string, value: any) => async () => {
    pipelineCalls.push(name)
    return value
  }
  Object.assign(aiPipelineService, {
    generateCoverLetter: track('cover-letter', { text: 'Surat', warnings: [], language: 'id', model: 'm' }),
    generateCV: track('cv', { text: 'CV', warnings: [], language: 'id', model: 'm' }),
    evaluateCV: track('cv/evaluate', { overallScore: 80 }),
    generateAnswer: track('answer', 'jawaban'),
    extractSkills: track('extract-skills', ['ts']),
    analyzeJobMatch: track('analyze-match', { matchScore: 70 }),
  })
  ;(formAutofillService as any).fillField = track('fill-form', { value: 'x' })
})
afterEach(async () => {
  Object.assign(aiPipelineService, original)
  ;(formAutofillService as any).fillField = original.fillField
  await app?.close()
})

const post = (url: string, payload: any = {}) => app.inject({ method: 'POST', url, payload })
const ROUTES: Array<[string, any]> = [
  ['/api/ai/cover-letter', { jobTitle: 'Dev', company: 'PT X', jobDescription: 'd', userProfile: {} }],
  ['/api/ai/cv', { jobTitle: 'Dev', company: 'PT X', jobDescription: 'd', userProfile: {} }],
  ['/api/ai/cv/evaluate', { cvText: 'CV', jobTitle: 'Dev', company: 'PT X', jobDescription: 'd' }],
  ['/api/ai/answer', { question: 'q', questionType: 'text' }],
  ['/api/ai/extract-skills', { jobDescription: 'd' }],
  ['/api/ai/analyze-match', { jobDescription: 'd', userSkills: ['ts'] }],
  ['/api/ai/fill-form', { fields: [{ label: 'Nama' }], context: {} }],
]

test('kuota habis: SEMUA rute /api/ai/* menjawab 429 quota_exhausted dan pipeline AI tidak dipanggil', async () => {
  db.quotaRow = { allowed: false, used: 10, limit_qty: 10, remaining: 0, period: 'monthly' }
  await build()
  for (const [url, payload] of ROUTES) {
    const res = await post(url, payload)
    assert.equal(res.statusCode, 429, url)
    const body = res.json()
    assert.equal(body.success, false, url)
    assert.equal(body.code, 'quota_exhausted', url)
    assert.match(body.error, /Kuota draf AI bulan ini habis/, url)
    assert.deepEqual(body.quota, { quota: 10, used: 10, remaining: 0, allowed: false }, url)
  }
  assert.deepEqual(pipelineCalls, [])
})

test('kuota tersisa: semua rute diteruskan ke pipeline dan permintaan dicatat', async () => {
  await build({ limits: { perMinute: 100, perHour: 100 } })
  for (const [url, payload] of ROUTES) {
    const res = await post(url, payload)
    assert.equal(res.statusCode, 200, url)
  }
  assert.equal(pipelineCalls.length, ROUTES.length)
  assert.equal(aiRequests(db).length, ROUTES.length)
})

test('batas laju: permintaan ke-4 dalam semenit = 429 rate_limited dengan header Retry-After; pipeline hanya dipanggil 3 kali', async () => {
  await build()
  for (let i = 0; i < 3; i++) assert.equal((await post('/api/ai/extract-skills', { jobDescription: 'd' })).statusCode, 200)
  const res = await post('/api/ai/extract-skills', { jobDescription: 'd' })
  assert.equal(res.statusCode, 429)
  assert.equal(res.json().code, 'rate_limited')
  assert.ok(res.json().retryAfterSec >= 1 && res.json().retryAfterSec <= 60)
  assert.equal(res.headers['retry-after'], String(res.json().retryAfterSec))
  assert.equal(pipelineCalls.length, 3)
})

test('batas laju per pengguna: pengguna lain tidak ikut terblokir', async () => {
  db = new GuardDb({ application_logs: seedRequests(3, 5, 'u1') })
  await build({ user: 'u1' })
  assert.equal((await post('/api/ai/extract-skills', { jobDescription: 'd' })).statusCode, 429)
  await app.close()
  await build({ user: 'u2' })
  assert.equal((await post('/api/ai/extract-skills', { jobDescription: 'd' })).statusCode, 200)
})

test('tanpa login: 401, tanpa memanggil RPC kuota atau pipeline', async () => {
  await build({ user: null })
  const res = await post('/api/ai/cover-letter', ROUTES[0][1])
  assert.equal(res.statusCode, 401)
  assert.deepEqual(db.rpcCalls, [])
  assert.deepEqual(pipelineCalls, [])
})

test('galat RPC kuota: 503 quota_check_failed dan pipeline tidak dipanggil', async () => {
  db.rpcError = 'timeout'
  await build()
  const res = await post('/api/ai/cv', ROUTES[1][1])
  assert.equal(res.statusCode, 503)
  assert.equal(res.json().code, 'quota_check_failed')
  assert.deepEqual(pipelineCalls, [])
})

test('surat lamaran yang berhasil dicatat sebagai draf (ai_draft); gagal atau rute lain tidak', async () => {
  await build({ limits: { perMinute: 100, perHour: 100 } })
  const drafts = () => db.rows('application_logs').filter((r) => r.action === 'ai_draft')

  assert.equal((await post('/api/ai/cv', ROUTES[1][1])).statusCode, 200)
  assert.equal((await post('/api/ai/answer', ROUTES[3][1])).statusCode, 200)
  assert.equal(drafts().length, 0)

  ;(aiPipelineService as any).generateCoverLetter = async () => {
    throw new Error('AI generation failed')
  }
  assert.equal((await post('/api/ai/cover-letter', ROUTES[0][1])).statusCode, 500)
  assert.equal(drafts().length, 0, 'gagal menghasilkan surat tidak memakai kuota')

  ;(aiPipelineService as any).generateCoverLetter = async () => ({ text: 'Surat', warnings: [], language: 'id', model: 'm' })
  assert.equal((await post('/api/ai/cover-letter', ROUTES[0][1])).statusCode, 200)
  assert.equal(drafts().length, 1)
  assert.equal(drafts()[0].user_id, 'u1')
})

test('migrasi kuota: kedua RPC menghitung baris yang ditulis backend (action dan status sama) dan memeriksa auth.uid()', () => {
  const sql = readFileSync(new URL('../../database/migrations/2026-11-18_ai_draft_quota_backend.sql', import.meta.url), 'utf8')
  for (const fn of ['get_quota_status', 'consume_monthly_apply']) {
    const body = sql.slice(sql.indexOf(`function public.${fn}(`)).split('end $$;')[0]
    // Selaras dengan remote (2026-11-19): hasil jsonb dan penghitung subscriptions, bukan returns table dan ai_applications.
    assert.ok(body.includes('returns jsonb'), `${fn}: tipe kembalian sama dengan remote (jsonb)`)
    assert.ok(body.includes('monthly_quota') && body.includes('used_quota'), `${fn}: memakai penghitung subscriptions`)
    assert.ok(body.includes('from public.application_logs'), `${fn}: menghitung baris yang ditulis backend`)
    assert.ok(body.includes(`action = '${AI_DRAFT_ACTION}'`), `${fn}: action yang sama dengan recordDraft`)
    assert.ok(body.includes(`status = 'success'`), `${fn}: status yang sama dengan recordDraft`)
    assert.ok(body.includes('auth.uid() <> p_user_id'), `${fn}: hanya untuk diri sendiri`)
    assert.ok(body.includes(`'limit_qty'`), `${fn}: kunci limit_qty dibaca parseQuotaStatus`)
    assert.ok(!body.includes('monthly_apply_used'), `${fn}: kolom itu tidak ada di remote`)
  }
  assert.ok(!/grant execute[^;]*authenticated/i.test(sql), 'EXECUTE tidak dibuka ke authenticated (sama dengan remote)')
  for (const fn of ['get_quota_status', 'consume_monthly_apply']) {
    assert.ok(sql.includes(`grant execute on function public.${fn}(uuid)`), `${fn}: grant ke service_role`)
  }
})
