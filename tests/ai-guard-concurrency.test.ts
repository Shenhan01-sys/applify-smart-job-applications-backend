import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FakeDb } from './helpers/fakeDb.ts'
import { AiGuardService, AiAccessError, AI_REQUEST_ACTION, type AiLimits } from '../services/ai-guard.service.ts'
import { KeyedMutex, NO_LOCK } from '../services/keyed-mutex.ts'

/**
 * Balapan periksa-lalu-catat pada batas laju AI: N permintaan paralel dari satu pengguna tidak boleh meloloskan
 * lebih dari batas. Database tiruan (FakeDb) tanpa jaringan; tiap panggilan database melepas giliran ke event loop
 * seperti panggilan sungguhan, jadi semua pembacaan terjadi sebelum satu pun penulisan bila tidak ada kunci.
 */

const NOW = new Date('2026-11-26T10:00:00.000Z')
const LIMITS: AiLimits = { perMinute: 3, perHour: 5 }
const BURST = 20

class RaceDb extends FakeDb {
  /** Bila diisi, rpc() menunggu promise ini (untuk menahan satu pengguna di tengah pemeriksaan). */
  hold: Promise<void> | null = null
  holdUser: string | null = null
  /** Jawaban galat untuk satu panggilan rpc berikutnya saja. */
  rpcFailOnce = false
  from(table: string) {
    const q: any = super.from(table)
    const insert = q.insert.bind(q)
    const stamp = (r: any) => ({ created_at: NOW.toISOString(), ...r })
    q.insert = (payload: any) => insert(Array.isArray(payload) ? payload.map(stamp) : stamp(payload))
    return q
  }
  async rpc(fn: string, args: any) {
    // Berkas ini menguji mutex proses pada jalur lama; jalur RPC atomik ada di ai-guard-rpc.test.ts.
    if (fn === 'consume_ai_rate_slot') return { data: null, error: { code: 'PGRST202', message: 'Could not find the function' } }
    if (this.hold && args.p_user_id === this.holdUser) await this.hold
    await new Promise((r) => setImmediate(r)) // seperti jaringan: giliran dilepas
    if (this.rpcFailOnce) {
      this.rpcFailOnce = false
      return { data: null, error: { message: 'connection reset' } }
    }
    return { data: [{ allowed: true, used: 0, limit_qty: 100, remaining: 100 }], error: null }
  }
}

const rows = (db: FakeDb, action: string, userId = 'u1') => db.rows('application_logs').filter((r) => r.user_id === userId && r.action === action)
const rejectedCodes = (res: PromiseSettledResult<unknown>[]) =>
  res.filter((r): r is PromiseRejectedResult => r.status === 'rejected').map((r) => (r.reason as AiAccessError).code)

test('check: tanpa kunci, ledakan paralel melampaui batas (bukti balapan pada database tiruan)', async () => {
  const db = new RaceDb()
  const guard = new AiGuardService(db as any, LIMITS, () => NOW, NO_LOCK)
  const res = await Promise.allSettled(Array.from({ length: BURST }, () => guard.check('u1', '/cover-letter')))
  const passed = res.filter((r) => r.status === 'fulfilled').length
  assert.ok(passed > LIMITS.perMinute, `tanpa kunci harus lolos lebih dari ${LIMITS.perMinute}, dapat ${passed}`)
  assert.equal(rows(db, AI_REQUEST_ACTION).length, passed)
})

test('check: dengan kunci, ledakan paralel meloloskan tepat sebesar batas dan sisanya 429 rate_limited', async () => {
  const db = new RaceDb()
  const guard = new AiGuardService(db as any, LIMITS, () => NOW)
  const res = await Promise.allSettled(Array.from({ length: BURST }, () => guard.check('u1', '/cover-letter')))
  assert.equal(res.filter((r) => r.status === 'fulfilled').length, LIMITS.perMinute)
  const codes = rejectedCodes(res)
  assert.equal(codes.length, BURST - LIMITS.perMinute)
  assert.ok(codes.every((c) => c === 'rate_limited'))
  assert.equal(rows(db, AI_REQUEST_ACTION).length, LIMITS.perMinute)
})

test('checkActionRateLimit: tanpa kunci melampaui batas, dengan kunci tepat sebesar batas', async () => {
  const open = new RaceDb()
  const resOpen = await Promise.allSettled(
    Array.from({ length: BURST }, () => new AiGuardService(open as any, LIMITS, () => NOW, NO_LOCK).checkActionRateLimit('u1', 'ai_regenerate', '/r')),
  )
  assert.ok(resOpen.filter((r) => r.status === 'fulfilled').length > LIMITS.perMinute)

  const db = new RaceDb()
  const guard = new AiGuardService(db as any, LIMITS, () => NOW)
  const res = await Promise.allSettled(Array.from({ length: BURST }, () => guard.checkActionRateLimit('u1', 'ai_regenerate', '/r')))
  assert.equal(res.filter((r) => r.status === 'fulfilled').length, LIMITS.perMinute)
  assert.ok(rejectedCodes(res).every((c) => c === 'rate_limited'))
  assert.equal(rows(db, 'ai_regenerate').length, LIMITS.perMinute)
})

test('kunci dipakai bersama oleh beberapa AiGuardService (rute AI, approval, impor memakai satu proses)', async () => {
  const db = new RaceDb()
  const res = await Promise.allSettled(
    Array.from({ length: BURST }, () => new AiGuardService(db as any, LIMITS, () => NOW).check('u1', '/cv')),
  )
  assert.equal(res.filter((r) => r.status === 'fulfilled').length, LIMITS.perMinute)
})

test('pengguna berbeda tidak saling menunggu dan tidak berbagi hitungan', async () => {
  const db = new RaceDb()
  let release!: () => void
  db.hold = new Promise<void>((r) => (release = r))
  db.holdUser = 'slow'
  const guard = new AiGuardService(db as any, LIMITS, () => NOW)

  const slow = guard.check('slow', '/cv') // tertahan di rpc sambil memegang kunci 'slow'
  const fast = await Promise.allSettled(Array.from({ length: BURST }, () => guard.check('fast', '/cv')))
  assert.equal(fast.filter((r) => r.status === 'fulfilled').length, LIMITS.perMinute) // selesai walau 'slow' belum
  assert.equal(rows(db, AI_REQUEST_ACTION, 'slow').length, 0)

  release()
  await slow
  assert.equal(rows(db, AI_REQUEST_ACTION, 'slow').length, 1)
})

test('galat di tengah pemeriksaan melepas kunci: permintaan berikutnya tetap jalan', async () => {
  const db = new RaceDb()
  db.rpcFailOnce = true
  const guard = new AiGuardService(db as any, LIMITS, () => NOW)
  const [a, b] = await Promise.allSettled([guard.check('u1', '/cv'), guard.check('u1', '/cv')])
  assert.equal(a.status, 'rejected')
  assert.equal((a as PromiseRejectedResult).reason.code, 'quota_check_failed')
  assert.equal(b.status, 'fulfilled')
  assert.equal(rows(db, AI_REQUEST_ACTION).length, 1)
})

test('KeyedMutex: kunci sama berjalan berurutan, kunci beda bebas, entri dibersihkan', async () => {
  const m = new KeyedMutex()
  const log: string[] = []
  const task = (name: string, ms: number) => async () => {
    log.push(`mulai ${name}`)
    await new Promise((r) => setTimeout(r, ms))
    log.push(`selesai ${name}`)
    return name
  }
  const out = await Promise.all([m.run('k', task('a', 15)), m.run('k', task('b', 1)), m.run('lain', task('c', 1))])
  assert.deepEqual(out, ['a', 'b', 'c'])
  assert.ok(log.indexOf('selesai a') < log.indexOf('mulai b'), 'b menunggu a')
  assert.ok(log.indexOf('mulai c') < log.indexOf('selesai a'), 'kunci lain tidak menunggu a')
  assert.equal(m.size, 0)

  await assert.rejects(m.run('k', async () => { throw new Error('x') }), /x/)
  assert.equal(await m.run('k', async () => 'ok'), 'ok')
  assert.equal(m.size, 0)
})
