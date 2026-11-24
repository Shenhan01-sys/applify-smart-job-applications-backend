// Kolam kunci platform untuk Numes (https://api.numes.ai/api/v1), penyedia model utama Applify.
//
// Salinan identik ada di worker/src/lib/numes-keys.ts dan applify-smart-job-applications/supabase/functions/
// _shared/numes-keys.ts (tiga paket terpisah, tidak saling mengimpor). Ubah ketiganya bersama. TypeScript murni
// tanpa API Node atau Deno, hanya sintaks yang bisa dihapus (tanpa enum atau parameter properties), supaya
// jalan di bawah tsx, node --test, dan Deno.
//
// Kunci dibaca dari NUMES_API_KEY, NUMES_API_KEY_2, NUMES_API_KEY_3, lalu NUMES_API_KEYS (dipisah koma). Duplikat dan
// nilai kosong dibuang, paling banyak MAX_NUMES_KEYS kunci. Satu panggilan model memakai kunci berurutan mulai dari
// indeks yang berputar (round-robin) supaya pemakaian tersebar. Bila sebuah kunci gagal karena kunci itu sendiri
// (401/402/403/429, kuota, galat 5xx, batas waktu), model yang sama dicoba lagi dengan kunci berikutnya. Kunci yang
// ditolak karena kuota atau laju didinginkan sebentar di memori dan dilewati.
//
// Sumber galat: https://numes.ai/docs/api-reference/errors dan /docs/api-reference/limits (dibaca 24 Nov 2026).
// Bentuk galat: {"error":{"code":402,"message":"...","metadata":{"error_type":"insufficient_credits"}}}. Keputusan
// diambil dari status HTTP dan error_type, tidak pernah dari teks pesan. Catatan dokumen: kunci tambahan tidak
// menaikkan batas laju tingkat akun ("Creating additional keys doesn't raise account-level limits"), jadi kunci
// cadangan paling berguna bila berasal dari akun Numes yang berbeda.
//
// Nilai kunci tidak pernah ditulis ke log. Log hanya memuat nomor kunci (1..N).

export const NUMES_CHAT_URL = 'https://api.numes.ai/api/v1/chat/completions'
/** Paling banyak kunci yang dipakai, supaya satu model yang rusak tidak menghabiskan banyak panggilan. */
export const MAX_NUMES_KEYS = 3
/** Pendinginan kunci yang kena 429 tanpa Retry-After, atau 402 (saldo atau batas belanja). */
export const NUMES_COOLDOWN_RATE_MS = 60_000
/** Pendinginan kunci yang ditolak (401, atau 403 yang bukan blokir isi). Kunci dicabut tidak pulih sendiri. */
export const NUMES_COOLDOWN_AUTH_MS = 10 * 60_000
const COOLDOWN_MIN_MS = 1_000
const COOLDOWN_MAX_MS = 5 * 60_000
/** Galat transport (batas waktu, sambungan putus) berturut-turut sebelum model ini dilepas: server yang sama lambat untuk semua kunci. */
export const MAX_NUMES_TRANSPORT_FAILURES = 2

type Env = Record<string, string | undefined>

/** Kunci platform dari env, urutan: NUMES_API_KEY, _2, _3, lalu NUMES_API_KEYS. Tanpa duplikat, tanpa kosong. */
export function parseNumesKeys(env: Env): string[] {
  const raw: Array<string | undefined> = [env.NUMES_API_KEY, env.NUMES_API_KEY_2, env.NUMES_API_KEY_3]
  if (env.NUMES_API_KEYS) raw.push(...env.NUMES_API_KEYS.split(','))
  const out: string[] = []
  for (const value of raw) {
    const key = (value ?? '').trim()
    if (key && !out.includes(key)) out.push(key)
    if (out.length >= MAX_NUMES_KEYS) break
  }
  return out
}

export class NumesKeyPool {
  readonly keys: readonly string[]
  private cursor = 0
  private coolUntil: number[]
  private clock: () => number

  constructor(keys: readonly string[], clock: () => number = () => Date.now()) {
    this.keys = keys
    this.clock = clock
    this.coolUntil = keys.map(() => 0)
  }

  get size(): number {
    return this.keys.length
  }

  isCooling(index: number): boolean {
    return this.coolUntil[index] > this.clock()
  }

  /** Sisa pendinginan (ms), 0 bila kunci siap. */
  coolingLeftMs(index: number): number {
    return Math.max(0, this.coolUntil[index] - this.clock())
  }

  cool(index: number, ms: number): void {
    if (ms > 0 && index >= 0 && index < this.keys.length) this.coolUntil[index] = Math.max(this.coolUntil[index], this.clock() + ms)
  }

  /**
   * Urutan kunci untuk satu panggilan model: mulai dari indeks yang berputar, kunci yang sedang didinginkan
   * dilewati. Kosong bila tidak ada kunci atau semuanya sedang didinginkan.
   */
  plan(): number[] {
    const n = this.keys.length
    const order: number[] = []
    for (let i = 0; i < n; i++) {
      const index = (this.cursor + i) % n
      if (!this.isCooling(index)) order.push(index)
    }
    if (order.length > 0) this.cursor = (order[0] + 1) % n
    return order
  }
}

const pools = new Map<string, NumesKeyPool>()

/** Kolam bersama untuk daftar kunci yang sama, supaya putaran dan pendinginan bertahan antarpanggilan. */
export function numesPoolFor(keys: readonly string[]): NumesKeyPool {
  const id = keys.join('\u0000')
  let pool = pools.get(id)
  if (!pool) {
    pool = new NumesKeyPool(keys)
    pools.set(id, pool)
  }
  return pool
}

export function numesPoolFromEnv(env: Env): NumesKeyPool {
  return numesPoolFor(parseNumesKeys(env))
}

/** Hanya untuk tes: lupakan semua kolam bersama. */
export function resetNumesPools(): void {
  pools.clear()
}

/** error.metadata.error_type dari badan galat Numes, atau null. */
export function numesErrorType(body: unknown): string | null {
  const type = (body as { error?: { metadata?: { error_type?: unknown } } } | null | undefined)?.error?.metadata?.error_type
  return typeof type === 'string' ? type : null
}

export interface NumesReply {
  status: number
  /** Header Retry-After (detik atau tanggal HTTP), bila ada. */
  retryAfter?: string | number | null
  /** error.metadata.error_type bila badan galatnya terbaca. */
  errorType?: string | null
}

export interface NumesVerdict {
  /** true = coba kunci berikutnya untuk model yang sama. */
  rotate: boolean
  /** Lama kunci ini dilewati (ms), 0 = tidak didinginkan. */
  coolMs: number
  /** true = lambat atau timeout di sisi server: dihitung terhadap MAX_NUMES_TRANSPORT_FAILURES. */
  slow: boolean
}

function retryAfterMs(value: NumesReply['retryAfter']): number | null {
  if (value === undefined || value === null || value === '') return null
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000
  const date = Date.parse(String(value))
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null
}

/** Putusan untuk satu jawaban non-2xx dari Numes. */
export function classifyNumesFailure(reply: NumesReply): NumesVerdict {
  const { status, errorType } = reply
  if (status === 401) return { rotate: true, coolMs: NUMES_COOLDOWN_AUTH_MS, slow: false }
  if (status === 402) return { rotate: true, coolMs: NUMES_COOLDOWN_RATE_MS, slow: false }
  if (status === 403) {
    // input_blocked (kebijakan isi) dan cors_forbidden tidak bergantung pada kunci: kunci lain gagal sama.
    if (errorType === 'input_blocked' || errorType === 'cors_forbidden') return { rotate: false, coolMs: 0, slow: false }
    return { rotate: true, coolMs: NUMES_COOLDOWN_AUTH_MS, slow: false }
  }
  if (status === 429) {
    const wait = retryAfterMs(reply.retryAfter)
    const coolMs = wait === null ? NUMES_COOLDOWN_RATE_MS : Math.min(COOLDOWN_MAX_MS, Math.max(COOLDOWN_MIN_MS, wait))
    return { rotate: true, coolMs, slow: false }
  }
  if (status === 408) return errorType === 'cancelled' ? { rotate: false, coolMs: 0, slow: false } : { rotate: true, coolMs: 0, slow: true }
  if (status >= 500) return { rotate: true, coolMs: 0, slow: false }
  // 400, 404, 413, 415, 422 dan sejenisnya: permintaannya yang salah, kunci lain tidak menolong.
  return { rotate: false, coolMs: 0, slow: false }
}

export type NumesTransportError = 'timeout' | 'network' | 'unreachable'

const UNREACHABLE_CODES = new Set(['ENOTFOUND', 'ECONNREFUSED', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH'])
const TIMEOUT_CODES = new Set(['ECONNABORTED', 'ETIMEDOUT', 'ESOCKETTIMEDOUT'])

/** Galat dari fetch atau axios menjadi jenisnya. Server tidak terjangkau = jangan ganti kunci. */
export function classifyTransportError(error: unknown): NumesTransportError {
  const e = error as { code?: unknown; name?: unknown; message?: unknown } | null
  const code = String(e?.code ?? '')
  if (UNREACHABLE_CODES.has(code)) return 'unreachable'
  const name = String(e?.name ?? '')
  if (TIMEOUT_CODES.has(code) || name === 'TimeoutError' || name === 'AbortError' || /timeout|timed out/i.test(String(e?.message ?? ''))) return 'timeout'
  return 'network'
}

export interface RunNumesOptions {
  /** Entri rantai untuk log, misalnya "numes:z-ai/glm-5.3-flash:free". Jangan isi dengan kunci. */
  label: string
  /** Bawaan: console.warn. */
  log?: (line: string) => void
  /** Dipanggil sebelum tiap percobaan tambahan; false = berhenti (anggaran waktu habis). */
  canContinue?: () => boolean
  classifyError?: (error: unknown) => NumesTransportError
}

export interface NumesRunResult<R extends NumesReply> {
  /** Jawaban terakhir (2xx bila berhasil, selain itu jawaban gagal terakhir). null bila percobaan terakhir melempar galat. */
  reply: R | null
  /** Galat transport terakhir bila percobaan terakhir melempar, selain itu null. */
  error: unknown | null
  /** Nomor kunci (indeks, mulai 0) pada percobaan terakhir; null bila tidak ada percobaan. */
  keyIndex: number | null
  attempts: number
}

/**
 * Jalankan satu panggilan model dengan kolam kunci. `attempt(key, index)` mengirim satu permintaan dan
 * mengembalikan status (dan Retry-After serta error_type bila ada); galat jaringan dilempar. Mengembalikan
 * jawaban 2xx pertama, atau hasil percobaan terakhir bila semua kunci gagal (pemanggil lalu pindah ke model berikutnya).
 */
export async function runWithNumesKeys<R extends NumesReply>(
  pool: NumesKeyPool,
  attempt: (key: string, index: number) => Promise<R>,
  opts: RunNumesOptions
): Promise<NumesRunResult<R>> {
  const log = opts.log ?? ((line: string) => console.warn(line))
  const classifyError = opts.classifyError ?? classifyTransportError
  const order = pool.plan()
  if (order.length === 0) {
    log(`[AI] ${opts.label}: ${pool.size === 0 ? 'no Numes key configured' : 'every Numes key is cooling down'}, skipping`)
    return { reply: null, error: null, keyIndex: null, attempts: 0 }
  }
  let reply: R | null = null
  let error: unknown | null = null
  let keyIndex: number | null = null
  let attempts = 0
  let slow = 0
  for (let i = 0; i < order.length; i++) {
    if (i > 0 && opts.canContinue && !opts.canContinue()) break
    const index = order[i]
    const more = i < order.length - 1
    const tag = `[AI] ${opts.label} key ${index + 1}/${pool.size}`
    attempts++
    keyIndex = index
    try {
      const r = await attempt(pool.keys[index], index)
      reply = r
      error = null
      if (r.status >= 200 && r.status < 300) return { reply, error, keyIndex, attempts }
      const verdict = classifyNumesFailure(r)
      pool.cool(index, verdict.coolMs)
      const why = `HTTP ${r.status}${r.errorType ? ` (${r.errorType})` : ''}`
      if (!verdict.rotate) {
        log(`${tag} -> ${why}, not caused by the key, not retrying with another key`)
        break
      }
      if (verdict.slow && ++slow >= MAX_NUMES_TRANSPORT_FAILURES) {
        log(`${tag} -> ${why}, giving up on this model`)
        break
      }
      log(`${tag} -> ${why}${verdict.coolMs ? `, cooling down ${Math.round(verdict.coolMs / 1000)}s` : ''}${more ? ', trying next key' : ''}`)
    } catch (e) {
      reply = null
      error = e
      const kind = classifyError(e)
      if (kind === 'unreachable') {
        log(`${tag} -> server unreachable, not retrying with another key`)
        break
      }
      if (++slow >= MAX_NUMES_TRANSPORT_FAILURES) {
        log(`${tag} -> ${kind}, giving up on this model`)
        break
      }
      log(`${tag} -> ${kind}${more ? ', trying next key' : ''}`)
    }
  }
  return { reply, error, keyIndex, attempts }
}
