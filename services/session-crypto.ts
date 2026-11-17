import crypto from 'crypto'
import CryptoJS from 'crypto-js'

/**
 * Enkripsi sesi platform (platform_sessions.session_data.encrypted), mis. cookie LinkedIn `li_at`.
 *
 * Gagal tertutup (fail closed): kunci hanya dibaca dari SESSION_ENCRYPTION_KEY dan TIDAK ADA kunci bawaan.
 * Kunci yang kosong, kurang dari 32 karakter, atau masih berupa contoh dari .env.example (yang tertulis di kode
 * publik) ditolak: sesi tidak disimpan dan tidak dibaca sampai kunci diperbaiki. Sebelumnya, tanpa env var,
 * sesi dienkripsi dengan kunci bawaan yang tertulis di kode (temuan penguji no. 12).
 *
 * Format baru "v2:<base64(iv 12 | tag 16 | ciphertext)>": AES-256-GCM, kunci turunan HKDF-SHA256 dari
 * SESSION_ENCRYPTION_KEY (terpisah dari kunci token Gmail di token-crypto.ts). Format lama (CryptoJS, sandi
 * dengan EVP_BytesToKey) tetap bisa DIBACA bila dienkripsi dengan kunci yang sama dengan yang sedang
 * dikonfigurasi, tetapi tidak pernah ditulis lagi. Sesi lama yang dienkripsi dengan kunci bawaan lama tidak
 * dapat dibaca lagi, jadi pengguna perlu mengimpor ulang sesinya.
 *
 * Kunci tidak pernah dicetak, termasuk di pesan galat dan log.
 */

export const SESSION_KEY_ENV = 'SESSION_ENCRYPTION_KEY'
export const MIN_SESSION_KEY_LENGTH = 32
const V2_PREFIX = 'v2:'

/** Nilai contoh di .env.example, aws-bootstrap.sh, dan aws-userdata.sh: publik, jadi sama saja dengan tanpa kunci. */
const PLACEHOLDER_PATTERNS = [/change[-_ ]?me/i, /your[-_ ](\d+[-_ ])?(char|secret|key|encryption)/i, /encryption-key-here/i, /^applify-default-key/i]

export class SessionKeyConfigError extends Error {
  readonly code = 'session_encryption_not_configured'
  constructor(message: string) {
    super(message)
    this.name = 'SessionKeyConfigError'
  }
}

export class SessionDecryptError extends Error {
  readonly code = 'session_undecryptable'
  constructor(message: string) {
    super(message)
    this.name = 'SessionDecryptError'
  }
}

type Env = Record<string, string | undefined>

const HOWTO = 'Buat kunci acak dengan `openssl rand -base64 32`, isi SESSION_ENCRYPTION_KEY di .env backend, lalu jalankan ulang server.'

/** Penjelasan masalah konfigurasi kunci, atau null bila kunci layak dipakai. Tidak memuat nilai kunci. */
export function sessionKeyProblem(env: Env = process.env): string | null {
  const key = (env[SESSION_KEY_ENV] ?? '').trim()
  if (!key) return `${SESSION_KEY_ENV} belum diisi. Sesi platform tidak disimpan atau dibaca tanpa kunci. ${HOWTO}`
  if (key.length < MIN_SESSION_KEY_LENGTH) {
    return `${SESSION_KEY_ENV} kurang dari ${MIN_SESSION_KEY_LENGTH} karakter. Sesi platform tidak disimpan atau dibaca dengan kunci sependek itu. ${HOWTO}`
  }
  if (PLACEHOLDER_PATTERNS.some((p) => p.test(key))) {
    return `${SESSION_KEY_ENV} masih berisi nilai contoh dari .env.example, yang tertulis di kode publik. Sesi platform tidak disimpan atau dibaca dengan kunci itu. ${HOWTO}`
  }
  return null
}

/** Kunci yang sah, atau SessionKeyConfigError. */
export function requireSessionKey(env: Env = process.env): string {
  const problem = sessionKeyProblem(env)
  if (problem) throw new SessionKeyConfigError(problem)
  return (env[SESSION_KEY_ENV] as string).trim()
}

function aesKey(secret: string): Buffer {
  return Buffer.from(
    crypto.hkdfSync('sha256', Buffer.from(secret, 'utf8'), Buffer.from('applify/platform-sessions/salt'), Buffer.from('applify/platform-sessions/aes-256-gcm/v2'), 32),
  )
}

/** Enkripsi data sesi (objek apa pun yang bisa di-JSON) ke string v2. Melempar SessionKeyConfigError tanpa kunci sah. */
export function encryptSession(data: unknown, env: Env = process.env): string {
  const secret = requireSessionKey(env)
  const plain = JSON.stringify(data)
  if (plain === undefined) throw new TypeError('session data must be JSON-serialisable')
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', aesKey(secret), iv)
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  return V2_PREFIX + Buffer.concat([iv, cipher.getAuthTag(), enc]).toString('base64')
}

/**
 * Baca string terenkripsi. Melempar SessionKeyConfigError tanpa kunci sah, dan SessionDecryptError bila data
 * rusak, diubah, atau dienkripsi dengan kunci lain (termasuk kunci bawaan lama).
 */
export function decryptSession(stored: unknown, env: Env = process.env): any {
  const secret = requireSessionKey(env)
  if (typeof stored !== 'string' || !stored) throw new SessionDecryptError('Sesi tersimpan kosong atau rusak. Impor ulang sesi.')
  try {
    if (stored.startsWith(V2_PREFIX)) {
      const buf = Buffer.from(stored.slice(V2_PREFIX.length), 'base64')
      if (buf.length < 12 + 16 + 1) throw new Error('too short')
      const decipher = crypto.createDecipheriv('aes-256-gcm', aesKey(secret), buf.subarray(0, 12))
      decipher.setAuthTag(buf.subarray(12, 28))
      return JSON.parse(Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString('utf8'))
    }
    // Format lama (CryptoJS). Hanya dengan kunci yang sedang dikonfigurasi; tidak ada kunci bawaan.
    const text = CryptoJS.AES.decrypt(stored, secret).toString(CryptoJS.enc.Utf8)
    return JSON.parse(text)
  } catch {
    throw new SessionDecryptError('Sesi tersimpan tidak dapat dibaca dengan kunci saat ini (kunci berubah atau data rusak). Impor ulang sesi.')
  }
}
