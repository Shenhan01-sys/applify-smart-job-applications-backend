import crypto from 'crypto'

/**
 * Encryption of a user's own LLM API key (BYOK, table user_llm_keys).
 *
 * Format: base64(iv[12] | tag[16] | ciphertext), AES-256-GCM, the same layout as token-crypto.ts. The edge function
 * that calls the model decrypts it with the same secret, so the layout, the key derivation and the AAD below are a
 * contract between the two sides and must not change without a version bump.
 *
 *  - Secret: env BYOK_ENCRYPTION_KEY, separate from OAUTH_TOKEN_ENCRYPTION_KEY. Read per call (a test or a late
 *    `dotenv` load can set it after this module was imported). Fails closed: a missing secret or one shorter than 32
 *    characters throws, there is no default.
 *  - Key: sha256(secret), 32 bytes.
 *  - AAD: `applify-byok:v1:${userId}:${provider}`. A ciphertext copied to another user's row, or to another
 *    provider's row, no longer decrypts.
 *
 * No error thrown here contains the plaintext, the ciphertext or the secret.
 */

export const BYOK_MIN_SECRET_LENGTH = 32

const IV_LENGTH = 12
const TAG_LENGTH = 16

export interface ByokBinding {
  userId: string
  provider: string
}

/** True when BYOK_ENCRYPTION_KEY is set and long enough. Lets a route fail early, before a provider is called. */
export function byokEncryptionReady(): boolean {
  return (process.env.BYOK_ENCRYPTION_KEY ?? '').length >= BYOK_MIN_SECRET_LENGTH
}

function key32(): Buffer {
  const secret = process.env.BYOK_ENCRYPTION_KEY ?? ''
  if (secret.length < BYOK_MIN_SECRET_LENGTH) {
    throw new Error(`BYOK_ENCRYPTION_KEY is required and must be at least ${BYOK_MIN_SECRET_LENGTH} characters`)
  }
  return crypto.createHash('sha256').update(secret).digest()
}

function aad(binding: ByokBinding): Buffer {
  const { userId, provider } = binding ?? ({} as ByokBinding)
  if (typeof userId !== 'string' || !userId || typeof provider !== 'string' || !provider) {
    throw new Error('byok crypto needs a userId and a provider')
  }
  return Buffer.from(`applify-byok:v1:${userId}:${provider}`, 'utf8')
}

/** AES-256-GCM encrypt a key for one (user, provider) row. */
export function encryptByokKey(plain: string, binding: ByokBinding): string {
  const key = key32()
  const additional = aad(binding)
  const iv = crypto.randomBytes(IV_LENGTH)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_LENGTH })
  cipher.setAAD(additional)
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return Buffer.concat([iv, tag, enc]).toString('base64')
}

/** Reverse of encryptByokKey. Throws when the secret, the user or the provider differ or the text was altered. */
export function decryptByokKey(b64: string, binding: ByokBinding): string {
  const key = key32()
  const additional = aad(binding)
  const buf = Buffer.from(typeof b64 === 'string' ? b64 : '', 'base64')
  if (buf.length < IV_LENGTH + TAG_LENGTH) throw new Error('byok ciphertext is malformed')
  const iv = buf.subarray(0, IV_LENGTH)
  const tag = buf.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH)
  const enc = buf.subarray(IV_LENGTH + TAG_LENGTH)
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_LENGTH })
    decipher.setAAD(additional)
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8')
  } catch {
    // Node's own message is fine, but a fixed text keeps the failure uniform for every cause.
    throw new Error('byok decryption failed')
  }
}
