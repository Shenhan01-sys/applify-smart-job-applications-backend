import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { byokEncryptionReady, decryptByokKey, encryptByokKey } from '../services/byok-crypto.ts'

const SECRET = 'byok-test-secret-0123456789-abcdefghijklmnop'
const KEY = 'sk-ant-test-' + 'A1b2C3d4E5'.repeat(4)
const BIND = { userId: 'user-a', provider: 'anthropic' }

let keepSecret: string | undefined
beforeEach(() => {
  keepSecret = process.env.BYOK_ENCRYPTION_KEY
  process.env.BYOK_ENCRYPTION_KEY = SECRET
})
afterEach(() => {
  if (keepSecret === undefined) delete process.env.BYOK_ENCRYPTION_KEY
  else process.env.BYOK_ENCRYPTION_KEY = keepSecret
})

test('round trip returns the original key', () => {
  const enc = encryptByokKey(KEY, BIND)
  assert.equal(decryptByokKey(enc, BIND), KEY)
})

test('ciphertext is base64, hides the plaintext and differs on every call (random iv)', () => {
  const a = encryptByokKey(KEY, BIND)
  const b = encryptByokKey(KEY, BIND)
  assert.notEqual(a, b)
  assert.equal(a.includes(KEY), false)
  assert.equal(Buffer.from(a, 'base64').toString('utf8').includes(KEY), false)
  assert.match(a, /^[A-Za-z0-9+/]+=*$/)
})

test('layout is base64(iv[12] | tag[16] | ciphertext), key sha256(secret), AAD applify-byok:v1:user:provider', () => {
  const enc = encryptByokKey(KEY, BIND)
  const buf = Buffer.from(enc, 'base64')
  assert.equal(buf.length, 12 + 16 + Buffer.byteLength(KEY, 'utf8'))
  // Decrypt by hand, the way the edge function does it.
  const decipher = crypto.createDecipheriv('aes-256-gcm', crypto.createHash('sha256').update(SECRET).digest(), buf.subarray(0, 12))
  decipher.setAAD(Buffer.from('applify-byok:v1:user-a:anthropic', 'utf8'))
  decipher.setAuthTag(buf.subarray(12, 28))
  const plain = Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString('utf8')
  assert.equal(plain, KEY)
})

test('a ciphertext made by hand with the documented layout decrypts', () => {
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', crypto.createHash('sha256').update(SECRET).digest(), iv)
  cipher.setAAD(Buffer.from('applify-byok:v1:user-a:openai', 'utf8'))
  const ct = Buffer.concat([cipher.update('sk-hand-made-key-0123456789', 'utf8'), cipher.final()])
  const b64 = Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64')
  assert.equal(decryptByokKey(b64, { userId: 'user-a', provider: 'openai' }), 'sk-hand-made-key-0123456789')
})

test('AAD binds the ciphertext to its user and provider', () => {
  const enc = encryptByokKey(KEY, BIND)
  assert.throws(() => decryptByokKey(enc, { userId: 'user-b', provider: 'anthropic' }), /decryption failed/)
  assert.throws(() => decryptByokKey(enc, { userId: 'user-a', provider: 'openai' }), /decryption failed/)
})

test('a different secret does not decrypt', () => {
  const enc = encryptByokKey(KEY, BIND)
  process.env.BYOK_ENCRYPTION_KEY = SECRET + '-changed'
  assert.throws(() => decryptByokKey(enc, BIND), /decryption failed/)
})

test('a tampered ciphertext, tag or iv fails; truncated or empty input fails', () => {
  const buf = Buffer.from(encryptByokKey(KEY, BIND), 'base64')
  for (const index of [0, 13, 30]) {
    const copy = Buffer.from(buf)
    copy[index] ^= 0x01
    assert.throws(() => decryptByokKey(copy.toString('base64'), BIND), /decryption failed/, `byte ${index}`)
  }
  assert.throws(() => decryptByokKey(buf.subarray(0, 20).toString('base64'), BIND), /malformed/)
  assert.throws(() => decryptByokKey('', BIND), /malformed/)
})

test('missing or short secret throws (fail closed), for encrypt and decrypt', () => {
  const enc = encryptByokKey(KEY, BIND)
  delete process.env.BYOK_ENCRYPTION_KEY
  assert.equal(byokEncryptionReady(), false)
  assert.throws(() => encryptByokKey(KEY, BIND), /BYOK_ENCRYPTION_KEY/)
  assert.throws(() => decryptByokKey(enc, BIND), /BYOK_ENCRYPTION_KEY/)

  process.env.BYOK_ENCRYPTION_KEY = 'x'.repeat(31)
  assert.equal(byokEncryptionReady(), false)
  assert.throws(() => encryptByokKey(KEY, BIND), /BYOK_ENCRYPTION_KEY/)
  assert.throws(() => decryptByokKey(enc, BIND), /BYOK_ENCRYPTION_KEY/)

  process.env.BYOK_ENCRYPTION_KEY = 'x'.repeat(32)
  assert.equal(byokEncryptionReady(), true)
  assert.doesNotThrow(() => encryptByokKey(KEY, BIND))
})

test('the other encryption secrets are not a fallback', () => {
  const keepOauth = process.env.OAUTH_TOKEN_ENCRYPTION_KEY
  const keepSession = process.env.SESSION_ENCRYPTION_KEY
  process.env.OAUTH_TOKEN_ENCRYPTION_KEY = 'o'.repeat(40)
  process.env.SESSION_ENCRYPTION_KEY = 's'.repeat(40)
  delete process.env.BYOK_ENCRYPTION_KEY
  try {
    assert.throws(() => encryptByokKey(KEY, BIND), /BYOK_ENCRYPTION_KEY/)
  } finally {
    if (keepOauth === undefined) delete process.env.OAUTH_TOKEN_ENCRYPTION_KEY
    else process.env.OAUTH_TOKEN_ENCRYPTION_KEY = keepOauth
    if (keepSession === undefined) delete process.env.SESSION_ENCRYPTION_KEY
    else process.env.SESSION_ENCRYPTION_KEY = keepSession
  }
})

test('errors never contain the plaintext, the ciphertext or the secret', () => {
  const enc = encryptByokKey(KEY, BIND)
  const messages: string[] = []
  const grab = (fn: () => unknown) => {
    try {
      fn()
    } catch (e: any) {
      messages.push(String(e?.message))
    }
  }
  grab(() => decryptByokKey(enc, { userId: 'user-b', provider: 'anthropic' }))
  grab(() => decryptByokKey('not-valid', BIND))
  process.env.BYOK_ENCRYPTION_KEY = 'short'
  grab(() => encryptByokKey(KEY, BIND))
  const all = messages.join('\n')
  assert.ok(messages.length === 3)
  assert.equal(all.includes(KEY), false)
  assert.equal(all.includes(enc), false)
  assert.equal(all.includes(SECRET), false)
})

test('userId and provider are required', () => {
  assert.throws(() => encryptByokKey(KEY, { userId: '', provider: 'anthropic' }), /userId/)
  assert.throws(() => encryptByokKey(KEY, { userId: 'u', provider: '' }), /provider/)
})

test('unicode and long input round trip', () => {
  const plain = 'kunci-ü-日本-' + 'z'.repeat(280)
  assert.equal(decryptByokKey(encryptByokKey(plain, BIND), BIND), plain)
})
