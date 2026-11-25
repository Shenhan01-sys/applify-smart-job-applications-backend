import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_NUMES_CALL_TIMEOUT_MS,
  MAX_NUMES_KEYS,
  MIN_NUMES_CALL_MS,
  NUMES_BUDGET_SHARE,
  NUMES_COOLDOWN_AUTH_MS,
  NUMES_COOLDOWN_RATE_MS,
  NUMES_MAX_TOTAL_MS,
  NUMES_MODEL_COOLDOWN_MS,
  NumesBudget,
  NumesKeyPool,
  classifyNumesFailure,
  classifyTransportError,
  numesErrorType,
  numesPoolFor,
  parseNumesKeys,
  resetNumesPools,
  runWithNumesKeys,
  type NumesReply,
} from '../services/numes-keys.ts'

/**
 * Kolam kunci Numes tanpa jaringan: attempt() diganti naskah, jam diganti jam palsu. Nilai kunci di sini palsu.
 * Salinan tes ini ada di worker/tests/numes-keys.test.ts dan applify-smart-job-applications/tests/numesKeys.test.ts.
 */

const K1 = 'nk-one-not-real'
const K2 = 'nk-two-not-real'
const K3 = 'nk-three-not-real'

function fakeClock() {
  let t = 1_000_000
  return { now: () => t, advance: (ms: number) => (t += ms) }
}

test('parseNumesKeys: urutan NUMES_API_KEY, _2, _3, lalu NUMES_API_KEYS; duplikat dan kosong dibuang', () => {
  assert.deepEqual(parseNumesKeys({}), [])
  assert.deepEqual(parseNumesKeys({ NUMES_API_KEY: K1 }), [K1])
  assert.deepEqual(parseNumesKeys({ NUMES_API_KEY: K1, NUMES_API_KEY_2: K2, NUMES_API_KEY_3: K3 }), [K1, K2, K3])
  // kosong dan spasi diabaikan, kunci yang sama di dua variabel dihitung sekali
  assert.deepEqual(parseNumesKeys({ NUMES_API_KEY: '  ', NUMES_API_KEY_2: ` ${K2} `, NUMES_API_KEY_3: K2 }), [K2])
  // format daftar dipisah koma
  assert.deepEqual(parseNumesKeys({ NUMES_API_KEYS: `${K1}, ${K2},,  ,${K3}` }), [K1, K2, K3])
  // gabungan: variabel tunggal lebih dulu, lalu daftar, tanpa duplikat
  assert.deepEqual(parseNumesKeys({ NUMES_API_KEY: K1, NUMES_API_KEYS: `${K1},${K2}` }), [K1, K2])
  // paling banyak MAX_NUMES_KEYS
  assert.equal(MAX_NUMES_KEYS, 5)
  assert.deepEqual(parseNumesKeys({ NUMES_API_KEYS: 'a,b,c,d,e,f,g' }), ['a', 'b', 'c', 'd', 'e'])
  // tanpa NUMES_API_KEY: _2 sampai _5 tetap terbaca (setelan worker production 24 Nov 2026)
  assert.deepEqual(parseNumesKeys({ NUMES_API_KEY_2: K1, NUMES_API_KEY_3: K2, NUMES_API_KEY_4: K3 }), [K1, K2, K3])
  assert.deepEqual(parseNumesKeys({ NUMES_API_KEY: 'a', NUMES_API_KEY_2: 'b', NUMES_API_KEY_3: 'c', NUMES_API_KEY_4: 'd', NUMES_API_KEY_5: 'e' }), ['a', 'b', 'c', 'd', 'e'])
})

test('plan: indeks awal berputar tiap panggilan (round-robin)', () => {
  const pool = new NumesKeyPool([K1, K2, K3])
  assert.deepEqual(pool.plan(), [0, 1, 2])
  assert.deepEqual(pool.plan(), [1, 2, 0])
  assert.deepEqual(pool.plan(), [2, 0, 1])
  assert.deepEqual(pool.plan(), [0, 1, 2])
  assert.deepEqual(new NumesKeyPool([]).plan(), [])
  assert.deepEqual(new NumesKeyPool([K1]).plan(), [0])
})

test('plan: kunci yang sedang didinginkan dilewati, putaran tetap merata, dan kunci kembali setelah masa dingin', () => {
  const clock = fakeClock()
  const pool = new NumesKeyPool([K1, K2, K3], clock.now)
  pool.cool(0, 60_000)
  assert.equal(pool.isCooling(0), true)
  assert.deepEqual(pool.plan(), [1, 2])
  assert.deepEqual(pool.plan(), [2, 1])
  assert.deepEqual(pool.plan(), [1, 2])
  clock.advance(60_001)
  assert.equal(pool.isCooling(0), false)
  assert.equal(pool.coolingLeftMs(0), 0)
  assert.ok(pool.plan().includes(0))
  // semua dingin: kosong
  pool.cool(0, 1000)
  pool.cool(1, 1000)
  pool.cool(2, 1000)
  assert.deepEqual(pool.plan(), [])
  assert.equal(pool.coolingLeftMs(1), 1000)
})

test('numesPoolFor: daftar kunci yang sama berbagi kolam (putaran dan pendinginan bertahan)', () => {
  resetNumesPools()
  const a = numesPoolFor([K1, K2])
  const b = numesPoolFor([K1, K2])
  assert.equal(a, b)
  assert.notEqual(a, numesPoolFor([K1]))
  resetNumesPools()
  assert.notEqual(a, numesPoolFor([K1, K2]))
})

test('numesErrorType membaca error.metadata.error_type dan tahan terhadap badan lain', () => {
  assert.equal(numesErrorType({ error: { code: 402, message: 'x', metadata: { error_type: 'insufficient_credits' } } }), 'insufficient_credits')
  for (const body of [null, undefined, 'teks biasa', {}, { error: 'x' }, { error: { metadata: {} } }, { error: { metadata: { error_type: 5 } } }]) {
    assert.equal(numesErrorType(body), null)
  }
})

test('classifyNumesFailure: hanya 401/402/403/429 berganti kunci; 5xx, 408, kesalahan permintaan, dan blokir isi tidak', () => {
  const v = (status: number, extra: Partial<NumesReply> = {}) => classifyNumesFailure({ status, ...extra })
  assert.deepEqual(v(401), { rotate: true, coolMs: NUMES_COOLDOWN_AUTH_MS, slow: false })
  assert.deepEqual(v(402), { rotate: true, coolMs: NUMES_COOLDOWN_RATE_MS, slow: false })
  assert.deepEqual(v(402, { errorType: 'funding_held' }), { rotate: true, coolMs: NUMES_COOLDOWN_RATE_MS, slow: false })
  assert.deepEqual(v(403), { rotate: true, coolMs: NUMES_COOLDOWN_AUTH_MS, slow: false })
  assert.deepEqual(v(403, { errorType: 'verified_email_required' }), { rotate: true, coolMs: NUMES_COOLDOWN_AUTH_MS, slow: false })
  // isi diblokir kebijakan: kunci lain gagal sama, dan kunci ini tidak boleh didinginkan
  assert.deepEqual(v(403, { errorType: 'input_blocked' }), { rotate: false, coolMs: 0, slow: false })
  assert.deepEqual(v(403, { errorType: 'cors_forbidden' }), { rotate: false, coolMs: 0, slow: false })
  assert.deepEqual(v(429), { rotate: true, coolMs: 60_000, slow: false })
  assert.deepEqual(v(429, { retryAfter: '7' }), { rotate: true, coolMs: 7_000, slow: false })
  assert.deepEqual(v(429, { retryAfter: 0 }), { rotate: true, coolMs: 1_000, slow: false }, 'batas bawah 1 detik')
  assert.deepEqual(v(429, { retryAfter: '86400' }), { rotate: true, coolMs: 300_000, slow: false }, 'batas atas 5 menit')
  assert.deepEqual(v(429, { retryAfter: 'bukan angka atau tanggal' }), { rotate: true, coolMs: 60_000, slow: false })
  // galat server dan batas waktu server adalah soal modelnya, bukan kuncinya: kunci lain tidak menolong
  for (const status of [500, 502, 503, 504]) assert.deepEqual(v(status), { rotate: false, coolMs: 0, slow: false })
  assert.deepEqual(v(408, { errorType: 'timeout' }), { rotate: false, coolMs: 0, slow: true })
  assert.deepEqual(v(408), { rotate: false, coolMs: 0, slow: true })
  assert.deepEqual(v(408, { errorType: 'cancelled' }), { rotate: false, coolMs: 0, slow: false })
  for (const status of [400, 404, 413, 415, 422]) assert.deepEqual(v(status), { rotate: false, coolMs: 0, slow: false })
})

test('classifyTransportError: batas waktu, tidak terjangkau, dan galat jaringan lain', () => {
  assert.equal(classifyTransportError(Object.assign(new Error('x'), { code: 'ECONNABORTED' })), 'timeout')
  assert.equal(classifyTransportError(Object.assign(new Error('x'), { name: 'TimeoutError' })), 'timeout')
  assert.equal(classifyTransportError(new Error('timeout of 25000ms exceeded')), 'timeout')
  assert.equal(classifyTransportError(Object.assign(new Error('x'), { code: 'ENOTFOUND' })), 'unreachable')
  assert.equal(classifyTransportError(Object.assign(new Error('x'), { code: 'ECONNREFUSED' })), 'unreachable')
  assert.equal(classifyTransportError(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })), 'network')
  assert.equal(classifyTransportError(null), 'network')
})

// ───────────────────────────────────────────────────────────── runWithNumesKeys

function harness(keys: string[], script: Record<string, NumesReply | Error | ((n: number) => NumesReply | Error)>) {
  const clock = fakeClock()
  const pool = new NumesKeyPool(keys, clock.now)
  const used: number[] = []
  const logs: string[] = []
  const counts: Record<string, number> = {}
  const attempt = async (key: string, index: number) => {
    used.push(index)
    counts[key] = (counts[key] ?? 0) + 1
    let reply = script[key] ?? { status: 200 }
    if (typeof reply === 'function') reply = reply(counts[key])
    if (reply instanceof Error) throw reply
    return reply
  }
  return { clock, pool, used, logs, attempt, run: () => runWithNumesKeys(pool, attempt, { label: 'numes:test/model:free', log: (l) => logs.push(l) }) }
}

test('run: kunci pertama berhasil, kunci lain tidak disentuh', async () => {
  const h = harness([K1, K2, K3], {})
  const out = await h.run()
  assert.equal(out.reply?.status, 200)
  assert.equal(out.keyIndex, 0)
  assert.deepEqual(h.used, [0])
  assert.deepEqual(h.logs, [])
})

for (const [status, extra] of [
  [429, { retryAfter: '5' }],
  [402, { errorType: 'insufficient_credits' }],
  [401, { errorType: 'invalid_credentials' }],
  [403, { errorType: 'verified_email_required' }],
] as Array<[number, Partial<NumesReply>]>) {
  test(`run: ${status} pada kunci pertama = model yang sama dicoba lagi dengan kunci berikutnya`, async () => {
    const h = harness([K1, K2, K3], { [K1]: { status, ...extra } })
    const out = await h.run()
    assert.equal(out.reply?.status, 200)
    assert.deepEqual(h.used, [0, 1])
    assert.equal(out.keyIndex, 1)
    assert.match(h.logs[0], /key 1\/3 -> HTTP \d{3}/)
    assert.match(h.logs[0], /trying next key/)
  })
}

for (const [status, extra] of [
  [500, {}],
  [503, { errorType: 'service_unavailable' }],
] as Array<[number, Partial<NumesReply>]>) {
  test(`run: ${status} (galat server) melepas model itu, kunci berikutnya TIDAK dicoba`, async () => {
    const h = harness([K1, K2, K3], { [K1]: { status, ...extra } })
    const out = await h.run()
    assert.equal(out.reply?.status, status)
    assert.deepEqual(h.used, [0])
    assert.match(h.logs[0], /not caused by the key/)
    assert.equal(h.pool.modelCoolingLeftMs('numes:test/model:free'), 0, '5xx tidak mendinginkan model')
  })
}

test('run: batas waktu pada kunci pertama = model dilepas, kunci kedua TIDAK dicoba', async () => {
  const slow = Object.assign(new Error('timeout of 12000ms exceeded'), { code: 'ECONNABORTED' })
  const h = harness([K1, K2], { [K1]: slow })
  const out = await h.run()
  assert.equal(out.reply, null)
  assert.equal(out.error, slow)
  assert.equal(out.attempts, 1)
  assert.deepEqual(h.used, [0])
  assert.match(h.logs[0], /key 1\/2 -> timeout, giving up on this model/)
  assert.doesNotMatch(h.logs.join('\n'), /trying next key/)
})

test('run: TimeoutError dari fetch (AbortSignal.timeout) juga melepas model dan mendinginkannya', async () => {
  const h = harness([K1, K2, K3], { [K1]: new DOMException('The operation timed out.', 'TimeoutError') })
  const out = await h.run()
  assert.equal(out.reply, null)
  assert.deepEqual(h.used, [0])
  assert.equal(h.pool.modelCoolingLeftMs('numes:test/model:free'), NUMES_MODEL_COOLDOWN_MS)
})

test('run: galat sambungan (bukan batas waktu) melepas model tanpa mencoba kunci lain dan tanpa mendinginkan model', async () => {
  const reset = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })
  const h = harness([K1, K2], { [K1]: reset })
  const out = await h.run()
  assert.equal(out.error, reset)
  assert.deepEqual(h.used, [0])
  assert.equal(h.pool.modelCoolingLeftMs('numes:test/model:free'), 0)
})

test('run: 408 dari server = model lambat: dilepas dan didinginkan, kunci lain tidak dicoba', async () => {
  const h = harness([K1, K2], { [K1]: { status: 408, errorType: 'timeout' } })
  const out = await h.run()
  assert.equal(out.reply?.status, 408)
  assert.deepEqual(h.used, [0])
  assert.equal(h.pool.modelCoolingLeftMs('numes:test/model:free'), NUMES_MODEL_COOLDOWN_MS)
  assert.match(h.logs[0], /giving up on this model/)
})

test('run: model yang kena batas waktu dilewati tanpa percobaan sampai pendinginannya selesai (5 menit), lalu dicoba lagi', async () => {
  const slow = Object.assign(new Error('timeout'), { code: 'ECONNABORTED' })
  const h = harness([K1, K2], { [K1]: slow, [K2]: slow })
  const first = await h.run()
  assert.equal(first.error, slow)
  assert.deepEqual(h.used, [0])
  h.used.length = 0
  h.logs.length = 0
  h.clock.advance(60_000)
  const second = await h.run()
  assert.deepEqual([second.reply, second.error, second.attempts, second.skipped], [null, null, 0, 'model_cooling'])
  assert.deepEqual(h.used, [], 'tidak ada panggilan jaringan selama model didinginkan')
  assert.match(h.logs[0], /too slow, cooling down 240s more, skipping/)
  // model lain di kolam yang sama tidak terpengaruh
  const other = await runWithNumesKeys(h.pool, async (_k, i) => (h.used.push(i), { status: 200 }), { label: 'numes:other/model:free', log: () => {} })
  assert.equal(other.reply?.status, 200)
  // sesudah 5 menit model dicoba lagi
  h.clock.advance(NUMES_MODEL_COOLDOWN_MS)
  h.used.length = 0
  await h.run()
  assert.equal(h.used.length, 1)
})

test('run: 429 pada semua kunci tidak mendinginkan modelnya (itu urusan kunci)', async () => {
  const h = harness([K1, K2], { [K1]: { status: 429 }, [K2]: { status: 429 } })
  await h.run()
  assert.equal(h.pool.modelCoolingLeftMs('numes:test/model:free'), 0)
})

test('run: attempt menerima batas waktu: bawaan 12 detik, callTimeoutMs, dan limitMs (sisa anggaran pemanggil) yang lebih kecil', async () => {
  const seen: number[] = []
  const go = (extra: Record<string, unknown>) => {
    seen.length = 0
    return runWithNumesKeys(new NumesKeyPool([K1]), async (_k, _i, ms) => (seen.push(ms), { status: 200 }), { label: 'x', log: () => {}, ...extra })
  }
  assert.equal(DEFAULT_NUMES_CALL_TIMEOUT_MS, 12_000)
  const all: number[] = []
  for (const extra of [{}, { callTimeoutMs: 7_000 }, { callTimeoutMs: 20_000, limitMs: () => 9_000 }, { limitMs: () => 30_000 }]) {
    await go(extra)
    all.push(seen[0])
  }
  assert.deepEqual(all, [12_000, 7_000, 9_000, 12_000])
  // pemanggil bilang waktunya habis: tidak ada percobaan
  const none = await go({ limitMs: () => 0 })
  assert.deepEqual([none.attempts, none.skipped], [0, 'budget'])
})

// ───────────────────────────────────────────────────────────── NumesBudget

test('NumesBudget: batas = min(15 detik, 40% anggaran total); tanpa anggaran total hanya batas tetap', () => {
  assert.equal(NUMES_MAX_TOTAL_MS, 15_000)
  assert.equal(NUMES_BUDGET_SHARE, 0.4)
  assert.equal(new NumesBudget({ totalBudgetMs: 34_000 }).limitMs, 13_600, 'Edge generate-application: 40% dari 34 detik')
  assert.equal(new NumesBudget({ totalBudgetMs: 100_000 }).limitMs, 15_000, 'green-career-assessment: batas tetap 15 detik')
  assert.equal(new NumesBudget({ totalBudgetMs: 10_000 }).limitMs, 4_000)
  assert.equal(new NumesBudget({}).limitMs, 15_000)
  assert.equal(new NumesBudget({ totalBudgetMs: 0 }).limitMs, 0)
  assert.equal(new NumesBudget({ totalBudgetMs: 34_000, share: 0.5, maxTotalMs: 20_000 }).limitMs, 17_000)
})

test('NumesBudget: callTimeoutMs dipangkas ke sisa anggaran dan 0 bila sisa terlalu sedikit untuk satu panggilan', () => {
  let t = 0
  const b = new NumesBudget({ totalBudgetMs: 34_000, clock: () => t })
  assert.equal(b.callTimeoutMs(12_000), 12_000)
  b.spend(12_000)
  assert.equal(b.spentMs, 12_000)
  assert.equal(b.remainingMs, 1_600)
  assert.equal(MIN_NUMES_CALL_MS, 4_000)
  assert.equal(b.callTimeoutMs(12_000), 0, 'sisa 1,6 detik < 4 detik: dilewati')
  const c = new NumesBudget({ totalBudgetMs: 100_000 })
  c.spend(9_000)
  assert.equal(c.callTimeoutMs(12_000), 6_000, 'sisa 6 detik: percobaan dipangkas ke 6 detik')
  // batas per percobaan yang lebih kecil dari ambang minimum tetap bisa dipakai
  const d = new NumesBudget({ totalBudgetMs: 100_000 })
  assert.equal(d.callTimeoutMs(2_000), 2_000)
  d.spend(14_000)
  assert.equal(d.callTimeoutMs(2_000), 0, 'sisa 1 detik < 2 detik')
  d.spend(-5)
  assert.equal(d.spentMs, 14_000, 'nilai negatif diabaikan')
})

test('run: Numes lambat di semua entri = jatah Numes habis, entri berikutnya dilewati tanpa percobaan (Gemini tidak terdesak)', async () => {
  const slow = Object.assign(new Error('timeout of 12000ms exceeded'), { code: 'ECONNABORTED' })
  let t = 0
  const budget = new NumesBudget({ totalBudgetMs: 34_000, clock: () => t })
  const pool = new NumesKeyPool([K1, K2, K3])
  const used: string[] = []
  const logs: string[] = []
  const call = (label: string) =>
    runWithNumesKeys(
      pool,
      async (_key, index, timeoutMs) => {
        used.push(`${label} key${index + 1} ${timeoutMs}ms`)
        t += timeoutMs // tiap percobaan memakai seluruh batas waktunya
        throw slow
      },
      { label, budget, log: (l) => logs.push(l) }
    )
  const glm = await call('numes:glm:free')
  assert.equal(glm.error, slow)
  const deepseek = await call('numes:deepseek:free')
  assert.deepEqual(used, ['numes:glm:free key1 12000ms'], 'model kedua tidak memanggil jaringan sama sekali')
  assert.deepEqual([deepseek.reply, deepseek.error, deepseek.attempts, deepseek.skipped], [null, null, 0, 'budget'])
  assert.ok(t <= 13_600, `Numes memakai ${t} ms, lebih dari jatahnya`)
  assert.ok(34_000 - t >= 20_000, 'sisa anggaran total cukup untuk satu panggilan Gemini penuh (20 detik)')
  assert.match(logs.at(-1)!, /Numes time budget used up, skipping/)
})

test('run: jatah Numes yang tersisa memangkas batas waktu percobaan, dan percobaan tambahan tidak melewati jatah', async () => {
  let t = 0
  const budget = new NumesBudget({ totalBudgetMs: 34_000, clock: () => t })
  const pool = new NumesKeyPool([K1, K2, K3])
  const seen: number[] = []
  const out = await runWithNumesKeys(
    pool,
    async (_key, _index, timeoutMs) => {
      seen.push(timeoutMs)
      t += 6_000 // 429 setelah 6 detik, tiap kali
      return { status: 429 }
    },
    { label: 'x', budget, log: () => {} }
  )
  // 13,6 detik: percobaan 1 (12 detik, memakai 6), percobaan 2 (7,6 detik, memakai 6), sisa 1,6 detik < 4 detik: berhenti
  assert.deepEqual(seen, [12_000, 7_600])
  assert.equal(out.reply?.status, 429)
  assert.equal(out.attempts, 2)
})

test('run: server tidak terjangkau = berhenti di kunci pertama (kunci lain gagal sama)', async () => {
  const down = Object.assign(new Error('getaddrinfo ENOTFOUND api.numes.ai'), { code: 'ENOTFOUND' })
  const h = harness([K1, K2], { [K1]: down })
  const out = await h.run()
  assert.equal(out.error, down)
  assert.deepEqual(h.used, [0])
})

test('run: semua kunci gagal mengembalikan jawaban gagal terakhir, supaya pemanggil pindah ke model berikutnya', async () => {
  const h = harness([K1, K2, K3], { [K1]: { status: 429 }, [K2]: { status: 402 }, [K3]: { status: 503 } })
  const out = await h.run()
  assert.equal(out.reply?.status, 503)
  assert.equal(out.error, null)
  assert.equal(out.attempts, 3)
  assert.deepEqual(h.used, [0, 1, 2])
})

test('run: 400 atau blokir isi tidak berganti kunci dan tidak mendinginkan kunci', async () => {
  const h = harness([K1, K2], { [K1]: { status: 403, errorType: 'input_blocked' } })
  const out = await h.run()
  assert.equal(out.reply?.status, 403)
  assert.deepEqual(h.used, [0])
  assert.equal(h.pool.isCooling(0), false)
  assert.match(h.logs[0], /not caused by the key/)
  const bad = harness([K1, K2], { [K1]: { status: 400, errorType: 'invalid_request' } })
  assert.equal((await bad.run()).reply?.status, 400)
  assert.deepEqual(bad.used, [0])
})

test('run: 429 mendinginkan kunci 60 detik; panggilan berikutnya melewatinya, lalu kunci kembali', async () => {
  const h = harness([K1, K2, K3], { [K1]: { status: 429 }, [K2]: { status: 429 } })
  await h.run() // K1 429, K2 429, K3 ok
  assert.deepEqual(h.used, [0, 1, 2])
  assert.equal(h.pool.isCooling(0), true)
  assert.equal(h.pool.isCooling(1), true)
  h.used.length = 0
  await h.run()
  assert.deepEqual(h.used, [2], 'K1 dan K2 dilewati selama pendinginan')
  h.clock.advance(NUMES_COOLDOWN_RATE_MS + 1)
  h.used.length = 0
  await h.run()
  assert.equal(h.used[0], 0, 'K1 dicoba lagi setelah masa dingin berakhir')
})

test('run: 402 mendinginkan 60 detik, 401 mendinginkan lebih lama (kunci dicabut)', async () => {
  const h = harness([K1, K2, K3], { [K1]: { status: 402 }, [K2]: { status: 401 } })
  await h.run()
  assert.equal(h.pool.coolingLeftMs(0), NUMES_COOLDOWN_RATE_MS)
  assert.equal(h.pool.coolingLeftMs(1), NUMES_COOLDOWN_AUTH_MS)
})

test('run: Retry-After dipakai sebagai lama pendinginan', async () => {
  const h = harness([K1, K2], { [K1]: { status: 429, retryAfter: '12' } })
  await h.run()
  assert.equal(h.pool.coolingLeftMs(0), 12_000)
})

test('run: tanpa kunci atau semua kunci dingin = tidak ada panggilan, hasil kosong dan log jelas', async () => {
  const none = harness([], {})
  const out = await none.run()
  assert.deepEqual([out.reply, out.error, out.keyIndex, out.attempts], [null, null, null, 0])
  assert.deepEqual(none.used, [])
  assert.match(none.logs[0], /no Numes key configured/)
  const cold = harness([K1, K2], {})
  cold.pool.cool(0, 5000)
  cold.pool.cool(1, 5000)
  await cold.run()
  assert.deepEqual(cold.used, [])
  assert.match(cold.logs[0], /cooling down/)
})

test('run: canContinue=false menghentikan percobaan tambahan (anggaran waktu habis)', async () => {
  const h = harness([K1, K2, K3], { [K1]: { status: 429 } })
  let budget = true
  const out = await runWithNumesKeys(
    h.pool,
    async (key, index) => {
      h.used.push(index)
      budget = false // waktu habis sesudah percobaan pertama
      return { status: 429 }
    },
    { label: 'x', log: () => {}, canContinue: () => budget }
  )
  assert.equal(out.reply?.status, 429)
  assert.deepEqual(h.used, [0])
})

test('run: log hanya memuat nomor kunci, tidak pernah nilainya', async () => {
  const h = harness([K1, K2, K3], {
    [K1]: { status: 429, retryAfter: '3' },
    [K2]: { status: 401 },
    [K3]: Object.assign(new Error(`socket hang up (Bearer ${K3})`), { code: 'ECONNRESET' }),
  })
  await h.run()
  assert.ok(h.logs.length >= 3)
  const all = h.logs.join('\n')
  for (const key of [K1, K2, K3]) assert.ok(!all.includes(key), `log memuat nilai kunci: ${all}`)
  assert.match(all, /key 1\/3/)
  assert.match(all, /key 2\/3/)
  assert.match(all, /key 3\/3/)
})
