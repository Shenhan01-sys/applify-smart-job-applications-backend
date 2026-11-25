import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import Fastify, { type FastifyInstance } from 'fastify'
import CryptoJS from 'crypto-js'
import { FakeDb } from './helpers/fakeDb.ts'
import {
  MIN_SESSION_KEY_LENGTH,
  SessionDecryptError,
  SessionKeyConfigError,
  decryptSession,
  encryptSession,
  requireSessionKey,
  sessionKeyProblem,
} from '../services/session-crypto.ts'
import { sessionRoutes } from '../api/routes/sessions.ts'
import { linkedinSessionRoutes } from '../api/routes/linkedin-session.ts'
import { sessionManagerService } from '../services/session-manager.service.ts'

/**
 * Enkripsi sesi platform gagal tertutup: tanpa SESSION_ENCRYPTION_KEY yang sah tidak ada kunci bawaan, sesi tidak
 * disimpan dan tidak dibaca. Kunci di tes dibuat acak per proses (tidak ada kunci sungguhan, tidak ada jaringan).
 */

const randomKey = () => crypto.randomBytes(32).toString('base64') // 44 karakter
const GOOD = randomKey()
const OTHER = randomKey()
const env = (key?: string) => ({ SESSION_ENCRYPTION_KEY: key })
const SESSION = { cookies: { li_at: 'AQED-contoh-bukan-cookie-asli', JSESSIONID: 'ajax:123' }, userAgent: 'UA uji' }

// ---- sessionKeyProblem / requireSessionKey -----------------------------------------------------------------

test('kunci kosong, spasi, atau tidak ada = masalah konfigurasi; pesan menyebut variabelnya dan cara memperbaiki', () => {
  for (const v of [undefined, '', '   ']) {
    const p = sessionKeyProblem(env(v))
    assert.match(p!, /SESSION_ENCRYPTION_KEY belum diisi/)
    assert.match(p!, /openssl rand -base64 32/)
  }
})

test(`kunci kurang dari ${MIN_SESSION_KEY_LENGTH} karakter ditolak, tepat ${MIN_SESSION_KEY_LENGTH} diterima`, () => {
  const short = 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P' // 31
  assert.equal(short.length, MIN_SESSION_KEY_LENGTH - 1)
  assert.match(sessionKeyProblem(env(short))!, /kurang dari 32 karakter/)
  assert.equal(sessionKeyProblem(env(short + 'Q')), null)
})

test('nilai contoh dari .env.example, aws-bootstrap.sh, dan kunci bawaan lama ditolak walau panjangnya cukup', () => {
  for (const v of [
    'your-32-character-encryption-key-here!!',
    'change-me-32-characters-key!!-tambahan-agar-panjang',
    'applify-default-key-change-me-applify-default-key',
  ]) {
    assert.ok(v.length >= MIN_SESSION_KEY_LENGTH, v)
    assert.match(sessionKeyProblem(env(v))!, /nilai contoh|\.env\.example/, v)
  }
})

test('pesan galat tidak memuat nilai kunci, juga untuk kunci yang terlalu pendek', () => {
  const secret = 'rahasia-pendek-abc'
  const p = sessionKeyProblem(env(secret))!
  assert.ok(!p.includes(secret))
  assert.throws(() => requireSessionKey(env(secret)), (e: any) => e instanceof SessionKeyConfigError && !e.message.includes(secret))
})

test('requireSessionKey: kunci sah dikembalikan apa adanya (tanpa spasi tepi)', () => {
  assert.equal(requireSessionKey(env(`  ${GOOD}\n`)), GOOD)
})

// ---- encryptSession / decryptSession -----------------------------------------------------------------------

test('tanpa kunci yang sah: tidak ada yang dienkripsi atau didekripsi (tidak ada kunci bawaan)', () => {
  const blob = encryptSession(SESSION, env(GOOD))
  for (const v of [undefined, '', 'k9x2']) {
    assert.throws(() => encryptSession(SESSION, env(v)), SessionKeyConfigError)
    assert.throws(() => decryptSession(blob, env(v)), SessionKeyConfigError)
  }
})

test('bolak-balik: v2 AES-256-GCM, IV acak (dua enkripsi berbeda), isi tidak terbaca di hasil', () => {
  const a = encryptSession(SESSION, env(GOOD))
  const b = encryptSession(SESSION, env(GOOD))
  assert.ok(a.startsWith('v2:'))
  assert.notEqual(a, b)
  assert.ok(!a.includes('AQED'))
  assert.deepEqual(decryptSession(a, env(GOOD)), SESSION)
  assert.deepEqual(decryptSession(b, env(GOOD)), SESSION)
})

test('kunci lain tidak bisa membaca; data yang diubah satu bit ditolak oleh GCM', () => {
  const blob = encryptSession(SESSION, env(GOOD))
  assert.throws(() => decryptSession(blob, env(OTHER)), SessionDecryptError)

  const raw = Buffer.from(blob.slice(3), 'base64')
  raw[raw.length - 1] ^= 1
  assert.throws(() => decryptSession('v2:' + raw.toString('base64'), env(GOOD)), SessionDecryptError)
  assert.throws(() => decryptSession('v2:AAAA', env(GOOD)), SessionDecryptError)
  assert.throws(() => decryptSession('', env(GOOD)), SessionDecryptError)
  assert.throws(() => decryptSession(null, env(GOOD)), SessionDecryptError)
})

test('format lama (CryptoJS) dengan kunci yang sedang dikonfigurasi masih terbaca; yang memakai kunci bawaan lama tidak', () => {
  const legacy = CryptoJS.AES.encrypt(JSON.stringify(SESSION), GOOD).toString()
  assert.deepEqual(decryptSession(legacy, env(GOOD)), SESSION)

  // Sesi lama yang dienkripsi dengan kunci bawaan yang dulu tertulis di kode (kini publik) tidak bisa dibuka lagi.
  const oldDefaultKey = 'applify-default-key-change-me'
  const underDefault = CryptoJS.AES.encrypt(JSON.stringify(SESSION), oldDefaultKey).toString()
  assert.throws(() => decryptSession(underDefault, env(GOOD)), SessionDecryptError)
  assert.throws(() => decryptSession(underDefault, env(oldDefaultKey)), SessionKeyConfigError)
})

// ---- Rute /api/sessions ------------------------------------------------------------------------------------

let app: FastifyInstance
let db: FakeDb
const savedKey = process.env.SESSION_ENCRYPTION_KEY
const setKey = (v?: string) => {
  if (v === undefined) delete process.env.SESSION_ENCRYPTION_KEY
  else process.env.SESSION_ENCRYPTION_KEY = v
}

async function build() {
  app = Fastify()
  app.addHook('preHandler', async (req) => {
    ;(req as any).user = { id: 'u1' }
  })
  await app.register(sessionRoutes, { prefix: '/api/sessions', db: db as any })
  await app.register(linkedinSessionRoutes, { prefix: '/api/linkedin', db: db as any })
}

beforeEach(() => {
  db = new FakeDb({})
  ;(sessionManagerService as any).client = db
})
afterEach(async () => {
  setKey(savedKey)
  ;(sessionManagerService as any).client = undefined
  await app?.close()
})

const postSession = (payload: any = { session_data: SESSION, expires_at: '2999-01-01T00:00:00.000Z' }) =>
  app.inject({ method: 'POST', url: '/api/sessions/linkedin', payload })

test('POST /api/sessions/:platform tanpa kunci, dengan kunci pendek, atau nilai contoh: 503 dan tidak ada yang disimpan', async () => {
  await build()
  for (const v of [undefined, 'k9x2-tidak-ada-di-pesan', 'your-32-character-encryption-key-here!!']) {
    setKey(v)
    const res = await postSession()
    assert.equal(res.statusCode, 503, String(v))
    assert.equal(res.json().code, 'session_encryption_not_configured')
    assert.match(res.json().error, /SESSION_ENCRYPTION_KEY/)
    if (v) assert.ok(!res.body.includes(v))
  }
  assert.equal(db.rows('platform_sessions').length, 0)
})

test('POST dengan kunci sah: tersimpan terenkripsi (v2), respons tidak memantulkan session_data, dan GET /:platform/data sudah dihapus (404)', async () => {
  setKey(GOOD)
  await build()
  const saved = await postSession()
  assert.equal(saved.statusCode, 200)
  assert.equal('session_data' in saved.json(), false, 'ciphertext tidak boleh dipantulkan di respons HTTP')

  const stored = db.rows('platform_sessions')[0]
  assert.ok(stored.session_data.encrypted.startsWith('v2:'))
  assert.ok(!JSON.stringify(stored).includes('AQED'))
  assert.deepEqual(decryptSession(stored.session_data.encrypted, env(GOOD)), SESSION)

  // F-01: endpoint mati GET /:platform/data tidak lagi ada sehingga cookie plaintext tidak pernah bocor lewat HTTP.
  const leaked = await app.inject({ method: 'GET', url: '/api/sessions/linkedin/data' })
  assert.equal(leaked.statusCode, 404)
})

test('BS-08: POST dan DELETE /api/sessions/:platform menolak gmail dan platform di luar allowlist (400 invalid_platform)', async () => {
  db = new FakeDb({
    platform_sessions: [
      { id: 'g1', user_id: 'u1', platform: 'gmail', is_active: true, session_data: { encrypted: 'oauth-token-blob' } },
    ],
  })
  ;(sessionManagerService as any).client = db
  setKey(GOOD)
  await build()

  for (const bad of ['gmail', 'GMAIL', 'unknown', 'admin', 'google']) {
    const postRes = await app.inject({
      method: 'POST',
      url: `/api/sessions/${bad}`,
      payload: { session_data: SESSION, expires_at: '2999-01-01T00:00:00.000Z' },
    })
    assert.equal(postRes.statusCode, 400, `POST /api/sessions/${bad}`)
    assert.equal(postRes.json().code, 'invalid_platform')

    const delRes = await app.inject({ method: 'DELETE', url: `/api/sessions/${bad}` })
    assert.equal(delRes.statusCode, 400, `DELETE /api/sessions/${bad}`)
    assert.equal(delRes.json().code, 'invalid_platform')
  }

  // Baris sesi Gmail milik OAuth tetap utuh dan aktif.
  const gmailRow = db.rows('platform_sessions').find((r) => r.platform === 'gmail')!
  assert.equal(gmailRow.is_active, true)
  assert.equal(gmailRow.session_data.encrypted, 'oauth-token-blob')
})

test('POST tanpa session_data: 400, daftar sesi (tanpa data) tetap jalan tanpa kunci', async () => {
  setKey(GOOD)
  await build()
  assert.equal((await postSession({ expires_at: '2999-01-01T00:00:00.000Z' })).statusCode, 400)

  db = new FakeDb({ platform_sessions: [{ user_id: 'u1', platform: 'linkedin', is_active: true, session_data: { encrypted: 'x' } }] })
  await app.close()
  await build()
  setKey(undefined)
  const list = await app.inject({ method: 'GET', url: '/api/sessions' })
  assert.equal(list.statusCode, 200)
  assert.equal(list.json().length, 1)
})

// ---- Rute /api/linkedin ------------------------------------------------------------------------------------

test('POST /api/linkedin/import tanpa kunci sah: 503 sebelum menghubungi apa pun (tanpa panggilan HTTP ke sesi)', async () => {
  await build()
  const realFetch = globalThis.fetch
  let fetched = 0
  globalThis.fetch = (async () => {
    fetched++
    throw new Error('network must not be used')
  }) as any
  try {
    setKey(undefined)
    const res = await app.inject({ method: 'POST', url: '/api/linkedin/import', payload: { cookies: { li_at: 'x' } } })
    assert.equal(res.statusCode, 503)
    assert.equal(res.json().code, 'session_encryption_not_configured')
    assert.equal(fetched, 0)
  } finally {
    globalThis.fetch = realFetch
  }
})

test('POST /api/linkedin/verify: tanpa kunci sah 503; dengan kunci, sesi terbaca dan valid bila ada cookie li_at', async () => {
  db = new FakeDb({ platform_sessions: [{ user_id: 'u1', platform: 'linkedin', session_data: { encrypted: encryptSession(SESSION, env(GOOD)) } }] })
  ;(sessionManagerService as any).client = db
  await build()

  setKey(undefined)
  assert.equal((await app.inject({ method: 'POST', url: '/api/linkedin/verify' })).statusCode, 503)

  setKey(GOOD)
  const ok = await app.inject({ method: 'POST', url: '/api/linkedin/verify' })
  assert.equal(ok.statusCode, 200)
  assert.equal(ok.json().valid, true)

  setKey(OTHER) // kunci berubah: sesi tidak terbaca -> dianggap tidak ada, bukan galat
  const changed = await app.inject({ method: 'POST', url: '/api/linkedin/verify' })
  assert.equal(changed.statusCode, 200)
  assert.equal(changed.json().valid, false)
})
