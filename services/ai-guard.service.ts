import { parseQuotaStatus, type QuotaSummary } from './quota-status.js'
import { KeyedMutex, type KeyedLock } from './keyed-mutex.js'

/**
 * Penjaga rute /api/ai/*: batas laju per pengguna dan kuota draf AI bulanan, diperiksa SEBELUM pipeline AI
 * dipanggil. Sebelumnya rute ini hanya memeriksa login, sehingga pengguna yang kuotanya habis di Edge Function
 * masih bisa menghasilkan surat lamaran dan CV lewat backend.
 *
 * Urutan: (1) batas laju, murah dan menolak banjir permintaan lebih dulu; (2) kuota bulanan lewat RPC
 * get_quota_status, RPC dan pembaca hasil (parseQuotaStatus) yang sama dengan Edge Function generate-application;
 * (3) permintaan yang lolos dicatat. Galat membaca batas laju atau kuota ditolak (503), bukan diloloskan.
 *
 * Batas laju disimpan di application_logs (action 'ai_request'), bukan di memori proses, karena PM2 menjalankan
 * backend dalam mode cluster (ecosystem.config.cjs) dan memori tiap proses berbeda. Bawaan 10 permintaan per
 * menit dan 60 per jam per pengguna; ubah lewat AI_RATE_LIMIT_PER_MINUTE dan AI_RATE_LIMIT_PER_HOUR.
 *
 * Balapan periksa-lalu-catat: membaca hitungan dan menulis baris catatan adalah dua panggilan database terpisah.
 * Tanpa pengaman, N permintaan paralel dari satu pengguna sama-sama membaca hitungan lama, lalu semuanya lolos
 * sebelum satu pun baris tertulis, sehingga batas bisa dilampaui jauh. Ada dua lapis pengaman:
 * (1) jalur utama: RPC `consume_ai_rate_slot` (database/migrations/DRAFT_2026-11-26_ai_rate_limit_atomic.sql, sudah
 *     diterapkan di production). Satu panggilan memeriksa kedua jendela dan menulis baris catatan di bawah kunci
 *     advisory per (pengguna, action), jadi atomik lintas proses (PM2 mode cluster, lebih dari satu replika).
 *     Jawabannya `{allowed: true}` atau `{allowed: false, retry_after_sec}`.
 * (2) mutex per (pengguna, action) di dalam proses ini (services/keyed-mutex.ts), tetap dipasang sebagai lapis
 *     tambahan. Mutex ini hanya terlihat oleh SATU proses.
 * Bila fungsi RPC belum ada di database (PGRST202 / 42883), penjaga kembali ke jalur lama: baca hitungan lalu
 * insert, di bawah mutex (hanya aman untuk satu proses), dan mencatat satu peringatan per proses tanpa data
 * pengguna. Galat RPC lain, atau jawaban yang bukan bentuk di atas, ditolak 503 rate_limit_check_failed (gagal
 * tertutup, sama dengan galat membaca di jalur lama); permintaan tidak diloloskan.
 * Catatan urutan: di jalur RPC permintaan sudah tercatat sebelum kuota bulanan diperiksa (RPC memeriksa dan
 * mencatat dalam satu langkah), jadi permintaan yang lalu ditolak karena kuota bulanan tetap memakai satu slot
 * batas laju. Di jalur lama permintaan seperti itu tidak dicatat.
 * Kuota bulanan lewat get_quota_status dibaca di sini tetapi baru berkurang saat recordDraft (setelah pipeline
 * selesai), jadi jendela balapan kuota bulanan lebih lebar dan TIDAK ditutup oleh mutex ini.
 *
 * Konsumsi kuota: Edge Function menghitung kuota dari baris ai_applications bulan berjalan. Rute backend tidak
 * membuat baris itu, jadi satu surat lamaran yang berhasil dibuat lewat /api/ai/cover-letter dicatat sebagai
 * application_logs action 'ai_draft' (recordDraft). Migrasi database/migrations/2026-11-18_ai_draft_quota_backend.sql
 * membuat get_quota_status dan consume_monthly_apply ikut menghitung baris itu. Tanpa migrasi, yang berlaku
 * adalah pemeriksaan sisa kuota dan batas laju.
 */

export const AI_REQUEST_ACTION = 'ai_request'
export const AI_DRAFT_ACTION = 'ai_draft'
export const DEFAULT_AI_LIMITS = { perMinute: 10, perHour: 60 } as const

/**
 * Impor profil dari PDF LinkedIn (/api/profile/import/linkedin-pdf). Memanggil model AI, tetapi BUKAN draf lamaran:
 * tidak memeriksa kuota draf bulanan dan tidak mencatat 'ai_draft'. Hanya batas laju sendiri (action terpisah,
 * jadi tidak berbagi hitungan dengan 'ai_request'): bawaan 3 per menit dan 10 per jam per pengguna; ubah lewat
 * PROFILE_IMPORT_RATE_LIMIT_PER_MINUTE dan PROFILE_IMPORT_RATE_LIMIT_PER_HOUR.
 */
export const PROFILE_IMPORT_ACTION = 'profile_import'
export const DEFAULT_IMPORT_LIMITS = { perMinute: 3, perHour: 10 } as const

export interface AiLimits {
  perMinute: number
  perHour: number
}

/** Minimal shape of the Supabase client used here (a fake is passed in tests). */
export interface AiGuardDb {
  from(table: string): any
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ data: any; error: { message: string; code?: string } | null }>
}

/** RPC atomik batas laju (database/migrations/DRAFT_2026-11-26_ai_rate_limit_atomic.sql), hanya untuk service_role. */
export const RATE_SLOT_RPC = 'consume_ai_rate_slot'

const RATE_CHECK_FAILED_AI = 'Batas permintaan AI tidak dapat diperiksa sekarang. Coba lagi nanti.'
const RATE_CHECK_FAILED = 'Batas permintaan tidak dapat diperiksa sekarang. Coba lagi nanti.'

type RateSlot = { status: 'allowed' } | { status: 'denied'; wait: number } | { status: 'missing' }

/** Galat "fungsi tidak ada": kode PostgREST PGRST202 atau Postgres 42883, atau teks pesannya. */
function isRpcMissing(err: { message?: string; code?: string }): boolean {
  if (err.code === 'PGRST202' || err.code === '42883') return true
  return /could not find the function|function .* does not exist/i.test(err.message ?? '')
}

let missingRpcLogged = false
function logMissingRpcOnce(): void {
  if (missingRpcLogged) return
  missingRpcLogged = true
  console.warn(`[ai-guard] fungsi ${RATE_SLOT_RPC} belum ada di database; memakai jalur baca-lalu-catat di bawah mutex proses (tidak atomik lintas proses).`)
}

/** Hanya untuk tes: izinkan peringatan "fungsi tidak ada" tercatat lagi. */
export function resetRateSlotRpcWarningForTests(): void {
  missingRpcLogged = false
}

function rateLimitedError(messagePrefix: string, wait: number, limits: AiLimits): AiAccessError {
  return new AiAccessError(429, 'rate_limited', `${messagePrefix}. Coba lagi dalam ${wait} detik.`, { retryAfterSec: wait, limits })
}

export type AiAccessCode = 'rate_limited' | 'quota_exhausted' | 'quota_check_failed' | 'rate_limit_check_failed'

/** Ditolak sebelum pipeline AI dipanggil. statusCode: 429 (batas tercapai) atau 503 (pemeriksaan gagal). */
export class AiAccessError extends Error {
  constructor(
    readonly statusCode: 429 | 503,
    readonly code: AiAccessCode,
    message: string,
    readonly extra: { retryAfterSec?: number; quota?: QuotaSummary; limits?: AiLimits } = {},
  ) {
    super(message)
    this.name = 'AiAccessError'
  }
}

function positiveInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw)
  return Number.isInteger(n) && n >= 1 && n <= 100000 ? n : fallback
}

/** Batas dari lingkungan; nilai kosong, nol, negatif, atau bukan bilangan bulat memakai bawaan. */
export function aiLimitsFromEnv(env: Record<string, string | undefined> = process.env): AiLimits {
  return {
    perMinute: positiveInt(env.AI_RATE_LIMIT_PER_MINUTE, DEFAULT_AI_LIMITS.perMinute),
    perHour: positiveInt(env.AI_RATE_LIMIT_PER_HOUR, DEFAULT_AI_LIMITS.perHour),
  }
}

/** Batas impor profil dari lingkungan; nilai yang tidak sah memakai bawaan. */
export function importLimitsFromEnv(env: Record<string, string | undefined> = process.env): AiLimits {
  return {
    perMinute: positiveInt(env.PROFILE_IMPORT_RATE_LIMIT_PER_MINUTE, DEFAULT_IMPORT_LIMITS.perMinute),
    perHour: positiveInt(env.PROFILE_IMPORT_RATE_LIMIT_PER_HOUR, DEFAULT_IMPORT_LIMITS.perHour),
  }
}

/** Satu mutex per proses, dipakai bersama semua AiGuardService (rute AI, approval, impor profil). */
const sharedLocks = new KeyedMutex()

export class AiGuardService {
  /** `client`, `limits`, dan `clock` hanya diisi di tes; produksi memuat klien Supabase server saat pertama dipakai. */
  constructor(
    private readonly client?: AiGuardDb,
    private readonly limits?: AiLimits,
    private readonly clock: () => Date = () => new Date(),
    private readonly locks: KeyedLock = sharedLocks,
  ) {}

  private async db(): Promise<AiGuardDb> {
    return this.client ?? ((await import('../api/index.js')).supabase as unknown as AiGuardDb)
  }

  /**
   * Izinkan satu permintaan AI atau lempar AiAccessError. Mengembalikan kuota bulanan terkini untuk antarmuka.
   */
  async check(userId: string, route: string): Promise<{ quota: QuotaSummary }> {
    // Periksa lalu catat harus tak terpisahkan untuk pengguna ini (lihat balapan periksa-lalu-catat di atas).
    return this.locks.run(`${userId}|${AI_REQUEST_ACTION}`, () => this.checkLocked(userId, route))
  }

  private async checkLocked(userId: string, route: string): Promise<{ quota: QuotaSummary }> {
    const db = await this.db()
    const limits = this.limits ?? aiLimitsFromEnv()
    const now = this.clock()

    // 1) Batas laju. Jalur utama: RPC atomik (periksa dan catat sekaligus). RPC belum ada: baca dulu, catat di langkah 3.
    const slot = await this.consumeRateSlot(db, userId, AI_REQUEST_ACTION, route, limits, RATE_CHECK_FAILED_AI)
    if (slot.status === 'denied') throw rateLimitedError('Terlalu banyak permintaan AI', slot.wait, limits)
    if (slot.status === 'missing') {
      const wait = await this.legacyWait(db, userId, AI_REQUEST_ACTION, limits, now)
      if (wait > 0) throw rateLimitedError('Terlalu banyak permintaan AI', wait, limits)
    }

    // 2) Kuota bulanan: RPC dan parser yang sama dengan Edge Function generate-application.
    const { data, error } = await db.rpc('get_quota_status', { p_user_id: userId })
    if (error) {
      console.error(`[ai-guard] get_quota_status gagal untuk ${route}: ${error.message}`)
      throw new AiAccessError(503, 'quota_check_failed', 'Kuota AI tidak dapat diperiksa sekarang. Coba lagi nanti.')
    }
    const quota = parseQuotaStatus(data)
    if (quota.remaining <= 0) {
      throw new AiAccessError(
        429,
        'quota_exhausted',
        `Kuota draf AI bulan ini habis (${quota.used} dari ${quota.quota} terpakai). Kuota diperbarui di awal bulan depan.`,
        { quota },
      )
    }

    // 3) Jalur lama saja: catat permintaan yang lolos supaya batas laju bisa menghitungnya (RPC sudah mencatat).
    if (slot.status === 'missing') {
      const { error: logErr } = await db.from('application_logs').insert({
        user_id: userId,
        action: AI_REQUEST_ACTION,
        platform: 'ai',
        status: 'success',
        details: { route },
      })
      if (logErr) {
        console.error(`[ai-guard] pencatatan permintaan gagal: ${logErr.message}`)
        throw new AiAccessError(503, 'rate_limit_check_failed', RATE_CHECK_FAILED_AI)
      }
    }
    return { quota }
  }

  /**
   * Batas laju untuk impor profil dari PDF, tanpa pemeriksaan kuota draf. Permintaan yang lolos dicatat sebagai
   * application_logs action 'profile_import' (satu-satunya tulisan ke database oleh rute impor; tabel profil
   * tidak disentuh). Melewati batas: AiAccessError 429 rate_limited. Gagal membaca atau mencatat: 503.
   */
  async checkImportRate(userId: string, route: string): Promise<void> {
    return this.checkActionRateLimit(userId, PROFILE_IMPORT_ACTION, route, this.limits ?? importLimitsFromEnv(), 'Terlalu banyak impor PDF')
  }

  /**
   * Batas laju umum untuk rute AI tambahan (`/api/approvals/:id/regenerate`, `/api/approvals` autofill)
   * tanpa mengurangi atau memeriksa kuota draf bulanan.
   */
  async checkActionRateLimit(
    userId: string,
    action: string,
    route: string,
    customLimits?: AiLimits,
    messagePrefix: string = 'Terlalu banyak permintaan AI'
  ): Promise<void> {
    // Kunci per action: hitungan tiap action terpisah, jadi action berbeda tidak perlu saling menunggu.
    return this.locks.run(`${userId}|${action}`, () => this.checkActionLocked(userId, action, route, customLimits, messagePrefix))
  }

  private async checkActionLocked(
    userId: string,
    action: string,
    route: string,
    customLimits: AiLimits | undefined,
    messagePrefix: string,
  ): Promise<void> {
    const db = await this.db()
    const limits = customLimits ?? this.limits ?? aiLimitsFromEnv()
    const now = this.clock()
    // Jalur utama: RPC atomik (periksa dan catat sekaligus). RPC belum ada: jalur lama di bawah mutex proses.
    const slot = await this.consumeRateSlot(db, userId, action, route, limits, RATE_CHECK_FAILED)
    if (slot.status === 'denied') throw rateLimitedError(messagePrefix, slot.wait, limits)
    if (slot.status === 'allowed') return
    const wait = await this.legacyWait(db, userId, action, limits, now)
    if (wait > 0) throw rateLimitedError(messagePrefix, wait, limits)
    const { error: logErr } = await db.from('application_logs').insert({
      user_id: userId,
      action,
      platform: 'ai',
      status: 'success',
      details: { route },
    })
    if (logErr) {
      console.error(`[ai-guard] pencatatan batas laju ${action} gagal: ${logErr.message}`)
      throw new AiAccessError(503, 'rate_limit_check_failed', RATE_CHECK_FAILED)
    }
  }

  /**
   * Catat satu draf yang berhasil dibuat lewat backend agar ikut terhitung di kuota bulanan (lihat migrasi).
   * Kegagalan mencatat tidak menggagalkan respons: surat sudah dibuat, dan galatnya masuk log server.
   */
  async recordDraft(userId: string, route: string): Promise<void> {
    try {
      const db = await this.db()
      const { error } = await db.from('application_logs').insert({
        user_id: userId,
        action: AI_DRAFT_ACTION,
        platform: 'ai',
        status: 'success',
        details: { route },
      })
      if (error) console.error(`[ai-guard] pencatatan draf gagal: ${error.message}`)
    } catch (e: any) {
      console.error(`[ai-guard] pencatatan draf gagal: ${e?.message ?? e}`)
    }
  }

  /**
   * Jalur utama batas laju: satu RPC atomik yang memeriksa jendela 1 menit dan 1 jam lalu menulis baris catatan
   * bila lolos. 'missing' = fungsi belum ada di database (pemanggil memakai jalur lama). Galat lain atau jawaban
   * yang tidak dikenal: 503 rate_limit_check_failed (gagal tertutup, sama dengan galat membaca di jalur lama).
   */
  private async consumeRateSlot(db: AiGuardDb, userId: string, action: string, route: string, limits: AiLimits, failMessage: string): Promise<RateSlot> {
    const { data, error } = await db.rpc(RATE_SLOT_RPC, {
      p_user_id: userId,
      p_action: action,
      p_per_minute: limits.perMinute,
      p_per_hour: limits.perHour,
      p_route: route,
    })
    if (error) {
      if (isRpcMissing(error)) {
        logMissingRpcOnce()
        return { status: 'missing' }
      }
      console.error(`[ai-guard] ${RATE_SLOT_RPC} gagal untuk ${action}: ${error.message}`)
      throw new AiAccessError(503, 'rate_limit_check_failed', failMessage)
    }
    if (data && data.allowed === true) return { status: 'allowed' }
    if (data && data.allowed === false) {
      const sec = Math.ceil(Number(data.retry_after_sec))
      return { status: 'denied', wait: Number.isFinite(sec) ? Math.max(1, sec) : 60 }
    }
    console.error(`[ai-guard] ${RATE_SLOT_RPC} menjawab bentuk yang tidak dikenal untuk ${action}`)
    throw new AiAccessError(503, 'rate_limit_check_failed', failMessage)
  }

  /** Jalur lama: detik tunggu terpanjang dari jendela 1 menit dan 1 jam (0 bila keduanya masih di bawah batas). */
  private async legacyWait(db: AiGuardDb, userId: string, action: string, limits: AiLimits, now: Date): Promise<number> {
    const waits = await Promise.all([
      this.retryAfterSec(db, userId, 60_000, limits.perMinute, now, action),
      this.retryAfterSec(db, userId, 3_600_000, limits.perHour, now, action),
    ])
    return Math.max(0, ...waits.map((w) => w ?? 0))
  }

  /**
   * null bila permintaan masih di bawah batas pada jendela itu; selain itu detik sampai satu slot bebas
   * (permintaan ke-`max` terbaru keluar dari jendela).
   */
  private async retryAfterSec(db: AiGuardDb, userId: string, windowMs: number, max: number, now: Date, action: string = AI_REQUEST_ACTION): Promise<number | null> {
    const since = new Date(now.getTime() - windowMs).toISOString()
    const { data, error } = await db
      .from('application_logs')
      .select('created_at')
      .eq('user_id', userId)
      .eq('action', action)
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .limit(max)
    if (error) {
      console.error(`[ai-guard] pembacaan batas laju gagal: ${error.message}`)
      throw new AiAccessError(503, 'rate_limit_check_failed', 'Batas permintaan AI tidak dapat diperiksa sekarang. Coba lagi nanti.')
    }
    const rows: Array<{ created_at: string }> = data ?? []
    if (rows.length < max) return null
    const oldest = Date.parse(rows[rows.length - 1].created_at)
    if (!Number.isFinite(oldest)) return Math.ceil(windowMs / 1000)
    return Math.max(1, Math.ceil((oldest + windowMs - now.getTime()) / 1000))
  }
}

export const aiGuardService = new AiGuardService()
