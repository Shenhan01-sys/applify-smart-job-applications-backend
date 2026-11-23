import crypto from 'crypto'

/**
 * Read per call, not once at module load: the key is the same for the life of a process, but a test (or a
 * late `dotenv` load) can set it after this module was imported.
 */
function getKey(): string {
  return process.env.OAUTH_TOKEN_ENCRYPTION_KEY || process.env.SESSION_ENCRYPTION_KEY || ''
}

function key32(): Buffer {
  // Derive a stable 32-byte key from the configured secret (sha256).
  return crypto.createHash('sha256').update(getKey()).digest()
}

/**
 * AES-256-GCM encrypt a string. Returns a base64 string bundling iv + ciphertext + tag.
 * Decryptable by the matching worker helper (worker/src/lib/crypto.ts).
 */
export function encrypt(plain: string): string {
  if (!getKey()) throw new Error('OAUTH_TOKEN_ENCRYPTION_KEY (or SESSION_ENCRYPTION_KEY) is required to encrypt tokens')
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', key32(), iv)
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return Buffer.concat([iv, tag, enc]).toString('base64')
}

export function decrypt(b64: string): string {
  if (!getKey()) throw new Error('OAUTH_TOKEN_ENCRYPTION_KEY (or SESSION_ENCRYPTION_KEY) is required to decrypt tokens')
  const buf = Buffer.from(b64, 'base64')
  const iv = buf.subarray(0, 12)
  const tag = buf.subarray(12, 28)
  const enc = buf.subarray(28)
  const decipher = crypto.createDecipheriv('aes-256-gcm', key32(), iv)
  decipher.setAuthTag(tag)
  const dec = Buffer.concat([decipher.update(enc), decipher.final()])
  return dec.toString('utf8')
}

/** Perbandingan string konstan waktu (mengembalikan false lebih dulu jika panjang UTF-8 berbeda). */
export function timingSafeStringEqual(a: unknown, b: unknown): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  const ba = Buffer.from(a, 'utf8')
  const bb = Buffer.from(b, 'utf8')
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb)
}

/** Hash SHA-256 dari nonce OAuth untuk disimpan di cookie HttpOnly (bukan nonce mentah). */
export function hashOAuthNonce(nonce: string): string {
  return crypto.createHash('sha256').update(nonce, 'utf8').digest('hex')
}

/** HMAC-sign a short JSON state payload (used for OAuth `state`). */
export function signState(payload: object): string {
  if (!getKey()) throw new Error('SESSION_ENCRYPTION_KEY is required to sign OAuth state')
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const sig = crypto.createHmac('sha256', getKey()).update(body).digest('base64url')
  return `${body}.${sig}`
}

export function verifyState<T = any>(state: string, maxAgeSec = 600): T {
  if (!getKey()) throw new Error('SESSION_ENCRYPTION_KEY is required to verify OAuth state')
  if (typeof state !== 'string') throw new Error('malformed state')
  const parts = state.split('.')
  if (parts.length !== 2 || !parts[0] || !parts[1]) throw new Error('malformed state')
  const [body, sig] = parts
  const expected = crypto.createHmac('sha256', getKey()).update(body).digest('base64url')
  if (!timingSafeStringEqual(sig, expected)) throw new Error('invalid state signature')
  const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as any
  if (!payload || typeof payload !== 'object') throw new Error('malformed state')
  if (typeof payload.exp === 'number' && Date.now() > payload.exp) throw new Error('state expired')
  if (payload.exp === undefined && typeof payload.iat === 'number' && Date.now() - payload.iat > maxAgeSec * 1000) {
    throw new Error('state expired')
  }
  return payload as T
}
