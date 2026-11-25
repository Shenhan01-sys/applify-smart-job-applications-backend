import { test } from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import { FakeDb } from './helpers/fakeDb.ts'
import { AiGuardService, AiAccessError, AI_DRAFT_ACTION, type AiLimits } from '../services/ai-guard.service.ts'
import { NO_LOCK } from '../services/keyed-mutex.ts'
import { aiPipelineService } from '../services/ai-pipeline.service.ts'
import { aiRoutes } from '../api/routes/ai.ts'

/**
 * Reservasi kuota bulanan dalam proses: N permintaan paralel dari satu pengguna pada sisa kuota 1 hanya boleh
 * meloloskan satu. Database tiruan tanpa jaringan; get_quota_status menghitung baris 'ai_draft' seperti migrasi
 * 2026-11-18_ai_draft_quota_backend.sql, jadi sisa kuota baru berkurang saat recordDraft menulis barisnya.
 */

const NOW = new Date('2026-11-26T10:00:00.000Z')
const LIMITS: AiLimits = { perMinute: 1000, perHour: 10000 }
const BURST = 10

class QuotaDb extends FakeDb {
  constructor(private readonly monthlyQuota: number, private usedBefore = 0) {
    super()
  }
  /** Bila true, insert 'ai_request' (jalur lama) gagal. */
  failRequestInsert = false
  from(table: string) {
    const q: any = super.from(table)
    const insert = q.insert.bind(q)
    q.insert = (payload: any) => {
      if (this.failRequestInsert && payload?.action === 'ai_request') return Promise.resolve({ data: null, error: { message: 'insert gagal' } })
      return insert({ created_at: NOW.toISOString(), ...payload })
    }
    return q
  }
  get drafts() {
    return this.rows('application_logs').filter((r) => r.action === AI_DRAFT_ACTION).length
  }
  async rpc(fn: string, _args: any) {
    await new Promise((r) => setImmediate(r)) // seperti jaringan: giliran dilepas
    if (fn === 'consume_ai_rate_slot') return { data: { allowed: true }, error: null }
    const used = this.usedBefore + this.drafts
    return { data: [{ allowed: used < this.monthlyQuota, used, limit_qty: this.monthlyQuota, remaining: Math.max(0, this.monthlyQuota - used) }], error: null }
  }
}

const codes = (res: PromiseSettledResult<unknown>[]) =>
  res.filter((r): r is PromiseRejectedResult => r.status === 'rejected').map((r) => (r.reason as AiAccessError).code)

test('check reserve: BURST paralel pada sisa 1 -> tepat 1 lolos, sisanya 429 quota_exhausted', async () => {
  const db = new QuotaDb(5, 4) // sisa 1
  const guard = new AiGuardService(db as any, LIMITS, () => NOW)
  const res = await Promise.allSettled(Array.from({ length: BURST }, () => guard.check('u1', '/cover-letter', { reserve: true })))
  assert.equal(res.filter((r) => r.status === 'fulfilled').length, 1)
  assert.deepEqual(codes(res), Array(BURST - 1).fill('quota_exhausted'))
  assert.equal(guard.inFlightDrafts('u1'), 1)
  const first = res.find((r): r is PromiseFulfilledResult<any> => r.status === 'fulfilled')!
  first.value.release()
  assert.equal(guard.inFlightDrafts('u1'), 0)
})

test('check reserve: tetap tepat 1 walau tanpa mutex (reservasi sendiri atomik, tanpa await antara periksa dan tahan)', async () => {
  const db = new QuotaDb(5, 4)
  const guard = new AiGuardService(db as any, LIMITS, () => NOW, NO_LOCK)
  const res = await Promise.allSettled(Array.from({ length: BURST }, () => guard.check('u1', '/cover-letter', { reserve: true })))
  // Semua permintaan membaca get_quota_status lebih dulu (sisa 1 untuk semuanya). Perbandingan memakai hitungan
  // reservasi terkini dan hitungan naik tanpa await sesudahnya, jadi hanya jawaban pertama yang lolos.
  assert.equal(res.filter((r) => r.status === 'fulfilled').length, 1)
  assert.deepEqual(codes(res), Array(BURST - 1).fill('quota_exhausted'))
})

test('galat kuota karena draf berjalan: bentuk sama dengan kuota habis biasa, angka konsisten dengan pesannya', async () => {
  const db = new QuotaDb(5, 4)
  const guard = new AiGuardService(db as any, LIMITS, () => NOW)
  await guard.check('u1', '/cover-letter', { reserve: true })
  await assert.rejects(guard.check('u1', '/cover-letter', { reserve: true }), (e: any) => {
    assert.ok(e instanceof AiAccessError)
    assert.equal(e.statusCode, 429)
    assert.equal(e.code, 'quota_exhausted')
    assert.deepEqual(e.extra.quota, { quota: 5, used: 5, remaining: 0, allowed: false })
    assert.deepEqual(Object.keys(e.extra).sort(), ['quota'])
    assert.match(e.message, /habis \(5 dari 5 terpakai\)/)
    return true
  })
})

test('check tanpa reserve ikut menghitung draf yang sedang berjalan, tetapi tidak menahan kuota', async () => {
  const db = new QuotaDb(5, 4)
  const guard = new AiGuardService(db as any, LIMITS, () => NOW)
  const held = await guard.check('u1', '/cover-letter', { reserve: true })
  await assert.rejects(guard.check('u1', '/cv'), (e: any) => e.code === 'quota_exhausted')
  assert.equal(guard.inFlightDrafts('u1'), 1, 'check tanpa reserve tidak menambah hitungan')
  held.release()
  const plain = await guard.check('u1', '/cv')
  plain.release() // tanpa reserve: pelepas tidak berbuat apa-apa
  assert.equal(guard.inFlightDrafts('u1'), 0)
})

test('release: idempoten, melepas giliran pengguna itu saja, dan kunci dibersihkan di 0', async () => {
  const db = new QuotaDb(5, 0)
  const guard = new AiGuardService(db as any, LIMITS, () => NOW)
  const a = await guard.check('u1', '/cover-letter', { reserve: true })
  const b = await guard.check('u1', '/cover-letter', { reserve: true })
  const other = await guard.check('u2', '/cover-letter', { reserve: true })
  assert.equal(guard.inFlightDrafts('u1'), 2)
  a.release()
  a.release() // kedua kali tidak boleh mengurangi reservasi b
  assert.equal(guard.inFlightDrafts('u1'), 1)
  b.release()
  assert.equal(guard.inFlightDrafts('u1'), 0)
  assert.equal(guard.inFlightDrafts('u2'), 1)
  other.release()
  assert.equal((guard as any).inFlight.size, 0)
})

test('check reserve: pencatatan jalur lama gagal (503) -> reservasi dilepas, tidak bocor', async () => {
  const db = new QuotaDb(5, 0)
  db.failRequestInsert = true
  const guard = new AiGuardService(db as any, LIMITS, () => NOW)
  // Paksa jalur lama (RPC batas laju belum ada) supaya insert 'ai_request' dijalankan.
  const rpc = db.rpc.bind(db)
  db.rpc = async (fn: string, args: any) =>
    fn === 'consume_ai_rate_slot' ? { data: null, error: { code: 'PGRST202', message: 'Could not find the function' } } : rpc(fn, args)
  await assert.rejects(guard.check('u1', '/cover-letter', { reserve: true }), (e: any) => e.code === 'rate_limit_check_failed')
  assert.equal(guard.inFlightDrafts('u1'), 0)
})

// ---- Lewat HTTP: rute /api/ai/cover-letter dengan penjaga asli ----

const original = aiPipelineService.generateCoverLetter
const sleepTick = () => new Promise((r) => setImmediate(r))

async function buildApp(guard: AiGuardService) {
  const app = Fastify()
  app.addHook('preHandler', async (req) => {
    ;(req as any).user = { id: 'u1' }
  })
  await app.register(aiRoutes, { prefix: '/api/ai', guard })
  return app
}

const body = { jobTitle: 'Dev', company: 'PT X', jobDescription: 'd', userProfile: {} }

test('POST /cover-letter: BURST paralel pada sisa 1 -> pipeline dipanggil sekali, satu 200, sisanya 429 identik', async () => {
  const db = new QuotaDb(5, 4)
  const guard = new AiGuardService(db as any, LIMITS, () => NOW)
  const app = await buildApp(guard)
  let calls = 0
  let openGate!: () => void
  const gate = new Promise<void>((r) => (openGate = r))
  ;(aiPipelineService as any).generateCoverLetter = async () => {
    calls++
    await gate
    return { text: 'Surat', warnings: [], language: 'id', model: 'm' }
  }
  try {
    let settled = 0
    const reqs = Array.from({ length: BURST }, () =>
      app.inject({ method: 'POST', url: '/api/ai/cover-letter', payload: body }).then((r) => {
        settled++
        return r
      }),
    )
    // Tahan generasi sampai semua permintaan lain sudah dijawab, supaya terbukti ditolak saat yang satu berjalan.
    for (let i = 0; i < 200 && settled < BURST - 1; i++) await sleepTick()
    assert.equal(settled, BURST - 1, 'sembilan permintaan ditolak selagi satu masih menghasilkan')
    assert.equal(guard.inFlightDrafts('u1'), 1)
    openGate()
    const res = await Promise.all(reqs)
    assert.equal(calls, 1)
    const ok = res.filter((r) => r.statusCode === 200)
    const rejected = res.filter((r) => r.statusCode === 429)
    assert.equal(ok.length, 1)
    assert.equal(rejected.length, BURST - 1)
    const first = rejected[0].json()
    assert.equal(first.success, false)
    assert.equal(first.code, 'quota_exhausted')
    assert.deepEqual(Object.keys(first).sort(), ['code', 'error', 'quota', 'success'])
    for (const r of rejected) assert.deepEqual(r.json(), first)
    assert.equal(db.drafts, 1, 'tepat satu draf dicatat')
    assert.equal(guard.inFlightDrafts('u1'), 0, 'reservasi dilepas sesudah selesai')
  } finally {
    aiPipelineService.generateCoverLetter = original
    await app.close()
  }
})

test('POST /cover-letter: pipeline melempar galat -> reservasi dilepas dan kuota tidak terpakai, permintaan berikutnya lolos', async () => {
  const db = new QuotaDb(5, 4)
  const guard = new AiGuardService(db as any, LIMITS, () => NOW)
  const app = await buildApp(guard)
  let mode: 'throw' | 'ok' = 'throw'
  ;(aiPipelineService as any).generateCoverLetter = async () => {
    if (mode === 'throw') throw new Error('AI generation failed')
    return { text: 'Surat', warnings: [], language: 'id', model: 'm' }
  }
  try {
    const failed = await app.inject({ method: 'POST', url: '/api/ai/cover-letter', payload: body })
    assert.equal(failed.statusCode, 500)
    assert.equal(guard.inFlightDrafts('u1'), 0, 'dilepas walau pipeline melempar')
    assert.equal(db.drafts, 0)
    mode = 'ok'
    const retry = await app.inject({ method: 'POST', url: '/api/ai/cover-letter', payload: body })
    assert.equal(retry.statusCode, 200)
    assert.equal(db.drafts, 1)
    assert.equal(guard.inFlightDrafts('u1'), 0)
    const after = await app.inject({ method: 'POST', url: '/api/ai/cover-letter', payload: body })
    assert.equal(after.statusCode, 429)
    assert.equal(after.json().code, 'quota_exhausted')
  } finally {
    aiPipelineService.generateCoverLetter = original
    await app.close()
  }
})
