import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createExtensionToken,
  DEFAULT_EXTENSION_TTL_SEC,
  MAX_EXTENSION_TTL_SEC,
  EXTENSION_SCOPE,
  ExtensionTokenConfigError,
  isExtensionOriginAllowed,
  verifyExtensionToken,
} from '../services/extension-token.js'

const VALID_ENV = {
  EXTENSION_TOKEN_SECRET: '0123456789abcdef0123456789abcdef_secret_ok',
}
const USER_ID = '11111111-2222-3333-4444-555555555555'

test('createExtensionToken & verifyExtensionToken: menerbitkan token bertanda tangan dengan TTL terbatas dan scope ketat', () => {
  const t0 = new Date('2026-11-23T12:00:00Z')
  const issued = createExtensionToken(USER_ID, { ttlSec: 3600, now: t0, env: VALID_ENV })
  assert.ok(issued.token.startsWith('ext_tok_v1.'))
  assert.equal(issued.scope, EXTENSION_SCOPE)
  assert.equal(issued.ttlSeconds, 3600)

  const check = verifyExtensionToken(issued.token, { now: new Date('2026-11-23T12:30:00Z'), env: VALID_ENV })
  assert.equal(check.ok, true)
  if (check.ok) {
    assert.equal(check.userId, USER_ID)
    assert.equal(check.claims.scope, EXTENSION_SCOPE)
  }

  const expired = verifyExtensionToken(issued.token, { now: new Date('2026-11-23T13:00:01Z'), env: VALID_ENV })
  assert.deepEqual(expired, { ok: false, reason: 'expired' })
})

test('TTL token ekstensi UAT: bawaan 8 jam (keputusan Hans 26 Nov), batas maksimum tetap 8 jam, minimum 60 detik', () => {
  assert.equal(DEFAULT_EXTENSION_TTL_SEC, 8 * 60 * 60)
  assert.equal(MAX_EXTENSION_TTL_SEC, 8 * 60 * 60)
  assert.equal(DEFAULT_EXTENSION_TTL_SEC, MAX_EXTENSION_TTL_SEC)

  const t0 = new Date('2026-11-26T00:00:00Z')
  // Tanpa ttlSec: bawaan 8 jam.
  const byDefault = createExtensionToken(USER_ID, { now: t0, env: VALID_ENV })
  assert.equal(byDefault.ttlSeconds, 28_800)
  assert.equal(byDefault.expiresAt, '2026-11-26T08:00:00.000Z')
  // Sesudah 7 jam 59 menit masih sah, sesudah 8 jam lewat 1 detik kedaluwarsa.
  assert.equal(verifyExtensionToken(byDefault.token, { now: new Date('2026-11-26T07:59:00Z'), env: VALID_ENV }).ok, true)
  assert.deepEqual(verifyExtensionToken(byDefault.token, { now: new Date('2026-11-26T08:00:01Z'), env: VALID_ENV }), {
    ok: false,
    reason: 'expired',
  })
  // Permintaan lebih dari 8 jam dipotong ke 8 jam; di bawah 1 menit dinaikkan ke 60 detik.
  assert.equal(createExtensionToken(USER_ID, { ttlSec: 24 * 3600, now: t0, env: VALID_ENV }).ttlSeconds, 28_800)
  assert.equal(createExtensionToken(USER_ID, { ttlSec: 5, now: t0, env: VALID_ENV }).ttlSeconds, 60)
})

test('verifyExtensionToken: menolak manipulasi payload atau tanda tangan palsu', () => {
  const issued = createExtensionToken(USER_ID, { env: VALID_ENV })
  const [prefixPayload, sig] = [issued.token.slice(0, issued.token.lastIndexOf('.')), issued.token.slice(issued.token.lastIndexOf('.') + 1)]
  const [head, payloadB64] = prefixPayload.split('.')
  const tamperedPayload = Buffer.from(
    JSON.stringify({ ...JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8')), sub: '99999999-9999-9999-9999-999999999999' }),
    'utf8'
  ).toString('base64url')

  assert.equal(verifyExtensionToken(`${head}.${tamperedPayload}.${sig}`, { env: VALID_ENV }).ok, false)
  assert.equal(verifyExtensionToken(`${prefixPayload}.tampered`, { env: VALID_ENV }).ok, false)
  assert.deepEqual(verifyExtensionToken('not-an-ext-token', { env: VALID_ENV }), { ok: false, reason: 'malformed' })
})

test('extension-token fail-closed: melempar ExtensionTokenConfigError jika tidak ada kunci yang aman', () => {
  assert.throws(() => createExtensionToken(USER_ID, { env: {} }), ExtensionTokenConfigError)
  assert.throws(
    () => createExtensionToken(USER_ID, { env: { SESSION_ENCRYPTION_KEY: 'change-me-too-short-placeholder' } }),
    ExtensionTokenConfigError
  )
})

test('isExtensionOriginAllowed: hanya mengizinkan origin chrome-extension valid, menolak web origin dan wildcard', () => {
  assert.equal(isExtensionOriginAllowed('chrome-extension://abcdefghijklmnopabcdefghijklmnop', {}), true)
  assert.equal(isExtensionOriginAllowed('https://evil.example', {}), false)
  assert.equal(isExtensionOriginAllowed('chrome-extension://short', {}), false)
  assert.equal(isExtensionOriginAllowed('*', {}), false)

  const pinnedEnv = { EXTENSION_ORIGINS: 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }
  assert.equal(isExtensionOriginAllowed('chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', pinnedEnv), true)
  assert.equal(isExtensionOriginAllowed('chrome-extension://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', pinnedEnv), false)
})

test('isExtensionOriginAllowed: tanpa EXTENSION_ORIGINS, produksi menolak semua origin ekstensi; non-produksi mengizinkan format resmi', () => {
  const origin = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop'
  assert.equal(isExtensionOriginAllowed(origin, { NODE_ENV: 'production' }), false)
  assert.equal(isExtensionOriginAllowed(origin, { NODE_ENV: ' Production ' }), false)
  assert.equal(isExtensionOriginAllowed(origin, { NODE_ENV: 'development' }), true)
  assert.equal(isExtensionOriginAllowed(origin, { NODE_ENV: 'test' }), true)
  // Dengan daftar eksplisit, produksi hanya menerima yang terdaftar
  const pinned = { NODE_ENV: 'production', EXTENSION_ORIGINS: `${origin}, chrome-extension://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb` }
  assert.equal(isExtensionOriginAllowed(origin, pinned), true)
  assert.equal(isExtensionOriginAllowed('chrome-extension://cccccccccccccccccccccccccccccccc', pinned), false)
  assert.equal(isExtensionOriginAllowed('https://evil.example', pinned), false)
})
