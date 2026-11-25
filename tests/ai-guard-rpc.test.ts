import { test, beforeEach, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import { FakeDb } from './helpers/fakeDb.ts'
import {
  AiGuardService,
  AiAccessError,
  AI_REQUEST_ACTION,
  RATE_SLOT_RPC,
  resetRateSlotRpcWarningForTests,
  type AiLimits,
} from '../services/ai-guard.service.ts'
import { KeyedMutex, NO_LOCK } from '../services/keyed-mutex.ts'

/**
 * Jalur utama batas laju: RPC atomik consume_ai_rate_slot (database/migrations/DRAFT_2026-11-26_ai_rate_limit_atomic.sql).
 * Database tiruan tanpa jaringan. AtomicDb meniru fungsi SQL-nya: periksa dua jendela lalu tulis baris dalam satu
 * langkah tanpa jeda di tengah (seperti kunci advisory), dengan satu giliran event loop sebelum mulai (seperti jaringan).
 */

const NOW = new Date('2026-11-26T10:00:00.000Z')
const NOW_MS = NOW.getTime()
const ago = (sec: number) => new Date(NOW_MS - sec * 1000).toISOString()
const LIMITS: AiLimits = { perMinute: 3, perHour: 5 }
const BURST = 20

type Err = { code?: string; message: string }
type RateMode = 'atomic' | { error: Err } | { data: unknown }

class AtomicDb extends FakeDb {
  rateMode: RateMode = 'atomic'
  rateCalls: Array<Record<string, any>> = []
  quotaCalls = 0
  quotaRow: any = { allowed: true, used: 2, limit_qty: 10, remaining: 8, period: 'monthly' }
  /** Tabel yang disentuh lewat from(): jalur RPC tidak boleh membaca atau menulis application_logs sendiri. */
  fromCalls: string[] = []

  from(table: string) {
    this.fromCalls.push(table)
    const q: any = super.from(table)
    const insert = q.insert.bind(q)
    const stamp = (r: any) => ({ created_at: NOW.toISOString(), ...r })
    q.insert = (payload: any) => insert(Array.isArray(payload) ? payload.map(stamp) : stamp(payload))
    return q
  }

  async rpc(fn: string, args: any) {
    await new Promise((r) => setImmediate(r))
    if (fn === 'get_quota_status') {
      this.quotaCalls++
      return { data: [this.quotaRow], error: null }
    }
    assert.equal(fn, RATE_SLOT_RPC)
    this.rateCalls.push(args)
    if (this.rateMode !== 'atomic') {
      return 'error' in this.rateMode ? { data: null, error: this.rateMode.error } : { data: this.rateMode.data, error: null }
    }
    // ---- bagian atomik: tidak ada await dari sini sampai insert ----
    const mine = this.rows('application_logs')
      .filter((r) => r.user_id === args.p_user_id && r.action === args.p_action)
      .map((r) => Date.parse(r.created_at))
      .sort((a, b) => b - a)
    let wait = 0
    for (const [windowMs, max] of [[60_000, args.p_per_minute], [3_600_000, args.p_per_hour]] as const) {
      const recent = mine.filter((t) => t >= NOW_MS - windowMs).slice(0, max)
      if (recent.length >= max) wait = Math.max(wait, Math.max(1, Math.ceil((recent[recent.length - 1] + windowMs - NOW_MS) / 1000)))
    }
    if (wait > 0) return { data: { allowed: false, retry_after_sec: wait }, error: null }
    this.rows('application_logs').push({
      user_id: args.p_user_id,
      action: args.p_action,
      platform: 'ai',
      status: 'success',
      details: { route: args.p_route },
      created_at: NOW.toISOString(),
    })
    return { data: { allowed: true }, error: null }
  }
}

const rows = (db: FakeDb, action: string, userId = 'u1') => db.rows('application_logs').filter((r) => r.user_id === userId && r.action === action)
const seed = (n: number, secondsAgo: number, action = AI_REQUEST_ACTION, userId = 'u1') =>
  Array.from({ length: n }, () => ({ user_id: userId, action, status: 'success', created_at: ago(secondsAgo) }))
const guardFor = (db: AtomicDb, locks = new KeyedMutex()) => new AiGuardService(db as any, LIMITS, () => NOW, locks)
const rejectedCodes = (res: PromiseSettledResult<unknown>[]) =>
  res.filter((r): r is PromiseRejectedResult => r.status === 'rejected').map((r) => (r.reason as AiAccessError).code)
const plain = (e: AiAccessError) => ({ statusCode: e.statusCode, code: e.code, message: e.message, extra: e.extra })

let warn: ReturnType<typeof mock.method>
let errorLog: ReturnType<typeof mock.method>
beforeEach(() => {
  resetRateSlotRpcWarningForTests()
  warn = mock.method(console, 'warn', () => {})
  errorLog = mock.method(console, 'error', () => {})
})
afterEach(() => mock.restoreAll())

// ---- RPC mengizinkan ------------------------------------------------------------------------------------------

test('check: RPC allowed -> lolos, argumen RPC tepat, tidak membaca/menulis application_logs sendiri, kuota diperiksa', async () => {
  const db = new AtomicDb()
  const { quota } = await guardFor(db).check('u1', '/cover-letter')
  assert.deepEqual(quota, { quota: 10, used: 2, remaining: 8, allowed: true })
  assert.deepEqual(db.rateCalls, [{ p_user_id: 'u1', p_action: 'ai_request', p_per_minute: 3, p_per_hour: 5, p_route: '/cover-letter' }])
  assert.equal(db.quotaCalls, 1)
  assert.deepEqual(db.fromCalls, [], 'jalur atomik tidak memakai baca-lalu-catat')
  assert.deepEqual(db.writes, [])
  assert.equal(rows(db, AI_REQUEST_ACTION).length, 1, 'baris dicatat oleh RPC')
  assert.equal(warn.mock.callCount(), 0)
})

test('checkActionRateLimit dan checkImportRate: RPC allowed memakai action masing-masing dan tanpa kuota', async () => {
  const db = new AtomicDb()
  const guard = guardFor(db)
  await guard.checkActionRateLimit('u1', 'ai_regenerate', '/api/approvals/1/regenerate')
  await guard.checkImportRate('u1', '/api/profile/import/linkedin-pdf')
  assert.deepEqual(
    db.rateCalls.map((c) => [c.p_action, c.p_route, c.p_per_minute, c.p_per_hour]),
    [['ai_regenerate', '/api/approvals/1/regenerate', 3, 5], ['profile_import', '/api/profile/import/linkedin-pdf', 3, 5]],
  )
  assert.equal(db.quotaCalls, 0)
  assert.deepEqual(db.fromCalls, [])
  assert.equal(rows(db, 'ai_regenerate').length, 1)
  assert.equal(rows(db, 'profile_import').length, 1)
})

// ---- RPC menolak ----------------------------------------------------------------------------------------------

test('check: RPC denied -> 429 rate_limited dengan retryAfterSec dari RPC, kuota tidak diperiksa, tidak ada baris baru', async () => {
  const db = new AtomicDb({ application_logs: [...seed(1, 50), ...seed(1, 30), ...seed(1, 10)] })
  await assert.rejects(guardFor(db).check('u1', '/cv'), (e: any) => {
    assert.ok(e instanceof AiAccessError)
    assert.equal(e.statusCode, 429)
    assert.equal(e.code, 'rate_limited')
    assert.equal(e.extra.retryAfterSec, 10)
    assert.deepEqual(e.extra.limits, LIMITS)
    assert.equal(e.message, 'Terlalu banyak permintaan AI. Coba lagi dalam 10 detik.')
    return true
  })
  assert.equal(db.quotaCalls, 0, 'ditolak sebelum RPC kuota')
  assert.equal(rows(db, AI_REQUEST_ACTION).length, 3)
  assert.deepEqual(db.fromCalls, [])
})

test('RPC denied menghasilkan galat yang identik dengan jalur lama (status, code, pesan, extra) untuk keadaan yang sama', async () => {
  const seedRows = () => ({ application_logs: [...seed(5, 3000), ...seed(1, 20)] }) // jam: 6 baris >= 5, menit: 1
  const viaRpc = new AtomicDb(seedRows())
  const legacy = new AtomicDb(seedRows())
  legacy.rateMode = { error: { code: 'PGRST202', message: 'Could not find the function' } }
  const grab = async (db: AtomicDb, call: (g: AiGuardService) => Promise<unknown>) => {
    try {
      await call(guardFor(db))
    } catch (e) {
      return plain(e as AiAccessError)
    }
    throw new Error('harus ditolak')
  }
  assert.deepEqual(await grab(viaRpc, (g) => g.check('u1', '/cv')), await grab(legacy, (g) => g.check('u1', '/cv')))
  const action = (g: AiGuardService) => g.checkActionRateLimit('u1', 'ai_request', '/r', undefined, 'Terlalu banyak impor PDF')
  const a = await grab(viaRpc, action)
  assert.deepEqual(a, await grab(legacy, action))
  assert.equal(a.statusCode, 429)
  assert.match(a.message, /^Terlalu banyak impor PDF\. Coba lagi dalam \d+ detik\.$/)
})

test('retry_after_sec dari RPC dibulatkan ke atas, minimal 1, dan 60 bila tidak terbaca', async () => {
  for (const [raw, expected] of [[2.2, 3], [0, 1], [-4, 1], [45, 45], [undefined, 60], ['abc', 60]] as const) {
    const db = new AtomicDb()
    db.rateMode = { data: { allowed: false, retry_after_sec: raw } }
    await assert.rejects(guardFor(db).check('u1', '/cv'), (e: any) => e.statusCode === 429 && e.extra.retryAfterSec === expected, String(raw))
  }
})

test('RPC allowed lalu kuota bulanan habis: 429 quota_exhausted; slot batas laju sudah terpakai (RPC mencatat sebelum kuota diperiksa)', async () => {
  const db = new AtomicDb()
  db.quotaRow = { allowed: false, used: 10, limit_qty: 10, remaining: 0, period: 'monthly' }
  await assert.rejects(guardFor(db).check('u1', '/cv'), (e: any) => e.statusCode === 429 && e.code === 'quota_exhausted')
  assert.equal(rows(db, AI_REQUEST_ACTION).length, 1)
})

// ---- RPC belum ada -> jalur lama -------------------------------------------------------------------------------

const MISSING_ERRORS: Array<[string, Err]> = [
  ['PGRST202', { code: 'PGRST202', message: 'Could not find the function public.consume_ai_rate_slot(...) in the schema cache' }],
  ['42883', { code: '42883', message: 'function public.consume_ai_rate_slot(uuid, text, integer, integer, text) does not exist' }],
  ['hanya pesan', { message: 'function public.consume_ai_rate_slot(uuid, text, integer, integer, text) does not exist' }],
]

for (const [label, error] of MISSING_ERRORS) {
  test(`RPC tidak ada (${label}): kembali ke baca-lalu-catat, permintaan dicatat sekali, batas tetap berlaku`, async () => {
    const db = new AtomicDb()
    db.rateMode = { error }
    const guard = guardFor(db)
    await guard.check('u1', '/cover-letter')
    assert.equal(rows(db, AI_REQUEST_ACTION).length, 1)
    assert.deepEqual(db.writes.map((w) => `${w.table}:${w.op}`), ['application_logs:insert'])
    assert.equal(db.quotaCalls, 1)
    await guard.checkActionRateLimit('u1', 'ai_regenerate', '/r')
    assert.equal(rows(db, 'ai_regenerate').length, 1)

    const full = new AtomicDb({ application_logs: seed(3, 10) })
    full.rateMode = { error }
    await assert.rejects(guardFor(full).check('u1', '/cv'), (e: any) => e.statusCode === 429 && e.code === 'rate_limited' && e.extra.retryAfterSec === 50)
    assert.equal(rows(full, AI_REQUEST_ACTION).length, 3)
  })
}

test('RPC tidak ada: peringatan dicatat sekali saja per proses dan tanpa data pengguna', async () => {
  const db = new AtomicDb()
  db.rateMode = { error: MISSING_ERRORS[0][1] }
  const guard = guardFor(db)
  await guard.check('user-rahasia-123', '/cover-letter')
  await guard.check('user-rahasia-123', '/cover-letter')
  await guard.checkActionRateLimit('user-rahasia-123', 'ai_regenerate', '/rute-rahasia')
  assert.equal(warn.mock.callCount(), 1)
  const msg = String(warn.mock.calls[0].arguments[0])
  assert.match(msg, /consume_ai_rate_slot/)
  assert.doesNotMatch(msg, /user-rahasia-123|rute-rahasia/)
  assert.equal(db.rateCalls.length, 3, 'RPC dicoba lagi tiap panggilan, sehingga jalur atomik aktif begitu migrasi ada')
})

test('RPC tidak ada lalu muncul: panggilan berikutnya otomatis memakai jalur atomik', async () => {
  const db = new AtomicDb()
  db.rateMode = { error: MISSING_ERRORS[0][1] }
  const guard = guardFor(db)
  await guard.check('u1', '/cv')
  assert.equal(db.writes.length, 1)
  db.rateMode = 'atomic'
  await guard.check('u1', '/cv')
  assert.equal(db.writes.length, 1, 'tidak ada insert lewat from() lagi')
  assert.equal(rows(db, AI_REQUEST_ACTION).length, 2)
})

// ---- Galat RPC lain: gagal tertutup (503), seperti galat baca di jalur lama ---------------------------------------

const OTHER_ERRORS: Array<[string, Err]> = [
  ['timeout', { code: '57014', message: 'canceling statement due to statement timeout' }],
  ['jaringan', { message: 'FetchError: connection reset' }],
  ['izin ditolak', { code: '42501', message: 'permission denied for function consume_ai_rate_slot' }],
  ['argumen tidak sah', { code: '22023', message: 'argumen tidak sah' }],
]

for (const [label, error] of OTHER_ERRORS) {
  test(`galat RPC lain (${label}): 503 rate_limit_check_failed, tidak diloloskan, tidak jatuh ke jalur lama, kuota tidak diperiksa`, async () => {
    const db = new AtomicDb()
    db.rateMode = { error }
    await assert.rejects(guardFor(db).check('u1', '/cv'), (e: any) => {
      assert.ok(e instanceof AiAccessError)
      assert.equal(e.statusCode, 503)
      assert.equal(e.code, 'rate_limit_check_failed')
      assert.equal(e.message, 'Batas permintaan AI tidak dapat diperiksa sekarang. Coba lagi nanti.')
      return true
    })
    await assert.rejects(
      guardFor(db).checkActionRateLimit('u1', 'ai_regenerate', '/r'),
      (e: any) => e.statusCode === 503 && e.code === 'rate_limit_check_failed' && e.message === 'Batas permintaan tidak dapat diperiksa sekarang. Coba lagi nanti.',
    )
    assert.equal(db.quotaCalls, 0)
    assert.deepEqual(db.fromCalls, [])
    assert.equal(db.rows('application_logs').length, 0)
    assert.equal(warn.mock.callCount(), 0, 'bukan kasus "fungsi tidak ada"')
    assert.equal(errorLog.mock.callCount(), 2)
  })
}

test('jawaban RPC yang bukan bentuk kontrak (null, kosong, larik, allowed bukan boolean): 503, bukan diloloskan', async () => {
  for (const data of [null, undefined, {}, [], [{ allowed: true }], { allowed: 'true' }, 'ok', 1]) {
    const db = new AtomicDb()
    db.rateMode = { data }
    await assert.rejects(guardFor(db).check('u1', '/cv'), (e: any) => e.statusCode === 503 && e.code === 'rate_limit_check_failed', JSON.stringify(data))
    assert.equal(db.quotaCalls, 0)
    assert.equal(db.rows('application_logs').length, 0)
  }
})

// ---- Ledakan paralel -----------------------------------------------------------------------------------------

test('ledakan paralel TANPA mutex proses: RPC atomik saja meloloskan tepat sebesar batas (meniru banyak proses)', async () => {
  const db = new AtomicDb()
  // Satu AiGuardService per permintaan dengan NO_LOCK = tidak ada serialisasi di dalam proses, seperti proses berbeda.
  const res = await Promise.allSettled(Array.from({ length: BURST }, () => guardFor(db, NO_LOCK as any).check('u1', '/cover-letter')))
  assert.equal(res.filter((r) => r.status === 'fulfilled').length, LIMITS.perMinute)
  const codes = rejectedCodes(res)
  assert.equal(codes.length, BURST - LIMITS.perMinute)
  assert.ok(codes.every((c) => c === 'rate_limited'))
  assert.equal(rows(db, AI_REQUEST_ACTION).length, LIMITS.perMinute)
  assert.equal(db.rateCalls.length, BURST)
  assert.deepEqual(db.fromCalls, [])
})

test('ledakan paralel dengan mutex proses tetap sebagai lapis kedua: hasil sama, checkActionRateLimit juga', async () => {
  const db = new AtomicDb()
  const guard = guardFor(db)
  const res = await Promise.allSettled(Array.from({ length: BURST }, () => guard.check('u1', '/cover-letter')))
  assert.equal(res.filter((r) => r.status === 'fulfilled').length, LIMITS.perMinute)
  assert.ok(rejectedCodes(res).every((c) => c === 'rate_limited'))
  assert.equal(rows(db, AI_REQUEST_ACTION).length, LIMITS.perMinute)

  const res2 = await Promise.allSettled(Array.from({ length: BURST }, () => guardFor(db, NO_LOCK as any).checkActionRateLimit('u1', 'ai_regenerate', '/r')))
  assert.equal(res2.filter((r) => r.status === 'fulfilled').length, LIMITS.perMinute)
  assert.equal(rows(db, 'ai_regenerate').length, LIMITS.perMinute)
})

test('ledakan paralel: pengguna berbeda punya hitungan sendiri-sendiri di RPC', async () => {
  const db = new AtomicDb()
  const res = await Promise.allSettled(
    ['a', 'b'].flatMap((u) => Array.from({ length: BURST }, () => guardFor(db, NO_LOCK as any).check(u, '/cv'))),
  )
  assert.equal(res.filter((r) => r.status === 'fulfilled').length, LIMITS.perMinute * 2)
  assert.equal(rows(db, AI_REQUEST_ACTION, 'a').length, LIMITS.perMinute)
  assert.equal(rows(db, AI_REQUEST_ACTION, 'b').length, LIMITS.perMinute)
})
