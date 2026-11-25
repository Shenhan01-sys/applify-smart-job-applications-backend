// Kolam kunci platform untuk Numes (https://api.numes.ai/api/v1), penyedia model utama Applify.
//
// Salinan identik ada di worker/src/lib/numes-keys.ts dan applify-smart-job-applications/supabase/functions/
// _shared/numes-keys.ts (tiga paket terpisah, tidak saling mengimpor). Ubah ketiganya bersama. TypeScript murni
// tanpa API Node atau Deno, hanya sintaks yang bisa dihapus (tanpa enum atau parameter properties), supaya
// jalan di bawah tsx, node --test, dan Deno.
//
// Kunci dibaca dari NUMES_API_KEY, NUMES_API_KEY_2 sampai NUMES_API_KEY_5, lalu NUMES_API_KEYS (dipisah koma). Duplikat dan
// nilai kosong dibuang, paling banyak MAX_NUMES_KEYS kunci. Satu panggilan model memakai kunci berurutan mulai dari
// indeks yang berputar (round-robin) supaya pemakaian tersebar. Hanya status yang khas untuk kunci (401/402/403
// kredit atau izin, 429 laju) yang membuat model yang sama dicoba lagi dengan kunci berikutnya; kunci yang ditolak
// karena kuota atau laju didinginkan sebentar di memori dan dilewati.
//
// Batas waktu dan galat sambungan BUKAN soal kunci: modelnya yang lambat, kunci lain sama lambatnya. Model itu
// langsung dilepas (tanpa mencoba kunci berikutnya) dan, bila karena batas waktu, didinginkan NUMES_MODEL_COOLDOWN_MS
// di memori supaya permintaan berikutnya melewatinya tanpa menunggu lagi. Insiden 25 Nov 2026: dua kunci kali dua
// model kali 12 sampai 20 detik menghabiskan seluruh anggaran waktu Edge Function (galat 502) sebelum Gemini sempat
// dipanggil. Karena itu juga ada NumesBudget: seluruh entri Numes dalam satu permintaan hanya boleh memakai
// NUMES_BUDGET_SHARE dari anggaran total (paling banyak NUMES_MAX_TOTAL_MS), sisanya dipastikan untuk penyedia lain.
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
export const MAX_NUMES_KEYS = 5
/** Pendinginan kunci yang kena 429 tanpa Retry-After, atau 402 (saldo atau batas belanja). */
export const NUMES_COOLDOWN_RATE_MS = 60_000
/** Pendinginan kunci yang ditolak (401, atau 403 yang bukan blokir isi). Kunci dicabut tidak pulih sendiri. */
export const NUMES_COOLDOWN_AUTH_MS = 10 * 60_000
const COOLDOWN_MIN_MS = 1_000
const COOLDOWN_MAX_MS = 5 * 60_000
/** Batas waktu satu percobaan Numes (model gratis yang menjawab lambat tidak ditunggu lebih lama). Env NUMES_TIMEOUT_MS menimpanya. */
export const DEFAULT_NUMES_CALL_TIMEOUT_MS = 12_000
/** Seluruh entri Numes dalam satu permintaan memakai paling banyak ini (ms), apa pun anggaran totalnya. */
export const NUMES_MAX_TOTAL_MS = 15_000
/** Bagian anggaran total satu permintaan yang boleh dipakai seluruh entri Numes. Sisanya untuk Gemini dan penyedia lain. */
export const NUMES_BUDGET_SHARE = 0.4
/** Sisa anggaran Numes di bawah ini (atau di bawah batas per percobaan bila lebih kecil) tidak cukup untuk satu panggilan. */
export const MIN_NUMES_CALL_MS = 4_000
/** Model yang kena batas waktu dilewati selama ini (ms) di instance yang sama. */
export const NUMES_MODEL_COOLDOWN_MS = 5 * 60_000

type Env = Record<string, string | undefined>

/** Kunci platform dari env, urutan: NUMES_API_KEY, _2 sampai _5, lalu NUMES_API_KEYS. Tanpa duplikat, tanpa kosong. */
export function parseNumesKeys(env: Env): string[] {
  const raw: Array<string | undefined> = [
    env.NUMES_API_KEY, env.NUMES_API_KEY_2, env.NUMES_API_KEY_3, env.NUMES_API_KEY_4, env.NUMES_API_KEY_5,
  ]
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
  private modelCoolUntil: Map<string, number>
  private clock: () => number

  constructor(keys: readonly string[], clock: () => number = () => Date.now()) {
    this.keys = keys
    this.clock = clock
    this.coolUntil = keys.map(() => 0)
    this.modelCoolUntil = new Map()
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

  /** Sisa pendinginan model (ms), 0 bila model siap. Model didinginkan karena lambat, bukan karena kuncinya. */
  modelCoolingLeftMs(label: string): number {
    return Math.max(0, (this.modelCoolUntil.get(label) ?? 0) - this.clock())
  }

  coolModel(label: string, ms: number): void {
    if (ms > 0) this.modelCoolUntil.set(label, Math.max(this.modelCoolUntil.get(label) ?? 0, this.clock() + ms))
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

/** Hanya untuk tes: lupakan semua kolam bersama (termasuk pendinginan kunci dan model). */
export function resetNumesPools(): void {
  pools.clear()
}

export interface NumesBudgetOptions {
  /** Anggaran total waktu permintaan (ms). Entri Numes boleh memakai `share` darinya. Kosong = hanya batas tetap. */
  totalBudgetMs?: number
  /** Bagian dari anggaran total. Bawaan NUMES_BUDGET_SHARE. */
  share?: number
  /** Batas tetap total waktu semua entri Numes (ms). Bawaan NUMES_MAX_TOTAL_MS. */
  maxTotalMs?: number
  clock?: () => number
}

/**
 * Anggaran waktu bersama semua entri Numes dalam SATU permintaan: buat satu per permintaan dan berikan ke setiap
 * runWithNumesKeys / postChat. Batasnya min(batas tetap, share * anggaran total); waktu tiap percobaan dijumlahkan.
 * Bila sudah terlampaui, entri Numes sisanya dilewati dan rantai langsung ke penyedia berikutnya, jadi Numes yang
 * lambat tidak pernah menghabiskan anggaran yang dicadangkan untuk Gemini.
 */
export class NumesBudget {
  /** Batas total waktu Numes (ms) untuk permintaan ini. */
  readonly limitMs: number
  private spent = 0
  private clock: () => number

  constructor(opts: NumesBudgetOptions = {}) {
    const maxTotal = opts.maxTotalMs !== undefined && opts.maxTotalMs >= 0 ? opts.maxTotalMs : NUMES_MAX_TOTAL_MS
    const total = opts.totalBudgetMs
    const share = opts.share !== undefined && opts.share >= 0 ? opts.share : NUMES_BUDGET_SHARE
    this.limitMs = total !== undefined && Number.isFinite(total) ? Math.min(maxTotal, Math.max(0, Math.floor(total * share))) : maxTotal
    this.clock = opts.clock ?? (() => Date.now())
  }

  now(): number {
    return this.clock()
  }

  get spentMs(): number {
    return this.spent
  }

  get remainingMs(): number {
    return Math.max(0, this.limitMs - this.spent)
  }

  spend(ms: number): void {
    if (ms > 0) this.spent += ms
  }

  /** Batas waktu percobaan berikutnya: `perCallMs` dipangkas ke sisa anggaran. 0 = sisa terlalu sedikit, lewati. */
  callTimeoutMs(perCallMs: number): number {
    const left = this.remainingMs
    if (!(perCallMs > 0) || left < Math.min(MIN_NUMES_CALL_MS, perCallMs)) return 0
    return Math.min(perCallMs, left)
  }
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
  /** true = coba kunci berikutnya untuk model yang sama (hanya untuk status yang khas untuk kunci). */
  rotate: boolean
  /** Lama kunci ini dilewati (ms), 0 = tidak didinginkan. */
  coolMs: number
  /** true = server menjawab bahwa modelnya lambat (408): model dilepas dan didinginkan, kunci lain tidak dicoba. */
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
  // 408 (server menyerah menunggu modelnya): modelnya lambat, kunci lain sama saja.
  if (status === 408) return { rotate: false, coolMs: 0, slow: errorType !== 'cancelled' }
  // 5xx, 400, 404, 413, 415, 422 dan sejenisnya: modelnya atau permintaannya yang bermasalah, kunci lain tidak menolong.
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
  /** Batas waktu satu percobaan Numes (ms). Bawaan DEFAULT_NUMES_CALL_TIMEOUT_MS. */
  callTimeoutMs?: number
  /** Batas dari pemanggil (sisa anggaran total permintaan, ms), dihitung ulang tiap percobaan. 0 = habis. */
  limitMs?: () => number
  /** Anggaran bersama semua entri Numes dalam satu permintaan. Tanpa ini hanya batas per percobaan yang berlaku. */
  budget?: NumesBudget
}

export type NumesSkipReason = 'no_key' | 'model_cooling' | 'budget'

export interface NumesRunResult<R extends NumesReply> {
  /** Jawaban terakhir (2xx bila berhasil, selain itu jawaban gagal terakhir). null bila percobaan terakhir melempar galat. */
  reply: R | null
  /** Galat transport terakhir bila percobaan terakhir melempar, selain itu null. */
  error: unknown | null
  /** Nomor kunci (indeks, mulai 0) pada percobaan terakhir; null bila tidak ada percobaan. */
  keyIndex: number | null
  attempts: number
  /** Alasan tidak ada satu pun percobaan: tanpa kunci, model sedang didinginkan karena lambat, atau anggaran waktu habis. */
  skipped?: NumesSkipReason
}

/**
 * Jalankan satu panggilan model dengan kolam kunci. `attempt(key, index, timeoutMs)` mengirim satu permintaan dengan
 * batas waktu `timeoutMs` dan mengembalikan status (dan Retry-After serta error_type bila ada); galat jaringan
 * dilempar. Mengembalikan jawaban 2xx pertama, atau hasil percobaan terakhir bila semua kunci gagal (pemanggil lalu
 * pindah ke model berikutnya).
 *
 * Kunci berikutnya hanya dicoba untuk status khas kunci (401/402/403/429). Batas waktu, galat sambungan, 408, 5xx, dan
 * galat permintaan melepas model ini saat itu juga. Batas waktu dan 408 juga mendinginkan model selama
 * NUMES_MODEL_COOLDOWN_MS, sehingga panggilan berikutnya melewatinya tanpa percobaan (`skipped: 'model_cooling'`).
 */
export async function runWithNumesKeys<R extends NumesReply>(
  pool: NumesKeyPool,
  attempt: (key: string, index: number, timeoutMs: number) => Promise<R>,
  opts: RunNumesOptions
): Promise<NumesRunResult<R>> {
  const log = opts.log ?? ((line: string) => console.warn(line))
  const classifyError = opts.classifyError ?? classifyTransportError
  const skip = (reason: NumesSkipReason, why: string): NumesRunResult<R> => {
    log(`[AI] ${opts.label}: ${why}, skipping`)
    return { reply: null, error: null, keyIndex: null, attempts: 0, skipped: reason }
  }
  const coolingLeft = pool.modelCoolingLeftMs(opts.label)
  if (coolingLeft > 0) return skip('model_cooling', `model was too slow, cooling down ${Math.ceil(coolingLeft / 1000)}s more`)
  const order = pool.plan()
  if (order.length === 0) return skip('no_key', pool.size === 0 ? 'no Numes key configured' : 'every Numes key is cooling down')
  const perCallMs = opts.callTimeoutMs !== undefined && opts.callTimeoutMs > 0 ? opts.callTimeoutMs : DEFAULT_NUMES_CALL_TIMEOUT_MS
  /** Batas waktu percobaan berikutnya: batas Numes, sisa anggaran pemanggil, dan sisa anggaran Numes. 0 = jangan coba. */
  const nextTimeoutMs = (): number => {
    let ms = perCallMs
    if (opts.limitMs) {
      const limit = opts.limitMs()
      if (!(limit > 0)) return 0
      ms = Math.min(ms, limit)
    }
    return opts.budget ? opts.budget.callTimeoutMs(ms) : ms
  }
  const giveUp = (index: number, why: string, coolModelMs: number): string => {
    if (coolModelMs > 0) pool.coolModel(opts.label, coolModelMs)
    return `[AI] ${opts.label} key ${index + 1}/${pool.size} -> ${why}, giving up on this model${coolModelMs > 0 ? ` (skipped for ${Math.round(coolModelMs / 1000)}s)` : ''}`
  }
  let reply: R | null = null
  let error: unknown | null = null
  let keyIndex: number | null = null
  let attempts = 0
  for (let i = 0; i < order.length; i++) {
    if (i > 0 && opts.canContinue && !opts.canContinue()) break
    const timeoutMs = nextTimeoutMs()
    if (timeoutMs <= 0) {
      if (attempts === 0) return skip('budget', 'Numes time budget used up')
      log(`[AI] ${opts.label}: Numes time budget used up, no more keys tried`)
      break
    }
    const index = order[i]
    const more = i < order.length - 1
    const tag = `[AI] ${opts.label} key ${index + 1}/${pool.size}`
    attempts++
    keyIndex = index
    const startedAt = opts.budget ? opts.budget.now() : 0
    try {
      const r = await attempt(pool.keys[index], index, timeoutMs)
      if (opts.budget) opts.budget.spend(opts.budget.now() - startedAt)
      reply = r
      error = null
      if (r.status >= 200 && r.status < 300) return { reply, error, keyIndex, attempts }
      const verdict = classifyNumesFailure(r)
      pool.cool(index, verdict.coolMs)
      const why = `HTTP ${r.status}${r.errorType ? ` (${r.errorType})` : ''}`
      if (verdict.slow) {
        log(giveUp(index, why, NUMES_MODEL_COOLDOWN_MS))
        break
      }
      if (!verdict.rotate) {
        log(`${tag} -> ${why}, not caused by the key, not retrying with another key`)
        break
      }
      log(`${tag} -> ${why}${verdict.coolMs ? `, cooling down ${Math.round(verdict.coolMs / 1000)}s` : ''}${more ? ', trying next key' : ''}`)
    } catch (e) {
      if (opts.budget) opts.budget.spend(opts.budget.now() - startedAt)
      reply = null
      error = e
      const kind = classifyError(e)
      if (kind === 'unreachable') {
        log(`${tag} -> server unreachable, not retrying with another key`)
      } else {
        // Batas waktu: modelnya yang lambat, kunci lain sama lambatnya. Didinginkan supaya permintaan berikutnya tidak menunggu lagi.
        log(giveUp(index, kind, kind === 'timeout' ? NUMES_MODEL_COOLDOWN_MS : 0))
      }
      break
    }
  }
  return { reply, error, keyIndex, attempts }
}
