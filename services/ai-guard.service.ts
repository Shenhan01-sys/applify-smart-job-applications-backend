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
 * sebelum satu pun baris tertulis, sehingga batas bisa dilampaui jauh. Pengaman: periksa dan catat dijalankan di
 * bawah mutex per (pengguna, action) di dalam proses ini (services/keyed-mutex.ts), jadi permintaan kedua baru
 * membaca setelah baris permintaan pertama tertulis.
 * ASUMSI: backend berjalan sebagai SATU proses/instance (Railway: Dockerfile menjalankan `node dist/api/index.js`,
 * satu replika). Mutex ini tidak terlihat oleh proses lain. Di bawah PM2 mode cluster (ecosystem.config.cjs, jalur
 * AWS) atau lebih dari satu replika, permintaan yang jatuh ke proses berbeda masih bisa berpapasan. Penutup
 * lintas proses: database/migrations/DRAFT_2026-11-26_ai_rate_limit_atomic.sql (consume_ai_rate_slot, kunci
 * advisory per pengguna). Belum diterapkan, dan kode ini belum memanggilnya.
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
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ data: any; error: { message: string } | null }>
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

    // 1) Batas laju.
    const waits = await Promise.all([
      this.retryAfterSec(db, userId, 60_000, limits.perMinute, now),
      this.retryAfterSec(db, userId, 3_600_000, limits.perHour, now),
    ])
    const wait = Math.max(0, ...waits.map((w) => w ?? 0))
    if (wait > 0) {
      throw new AiAccessError(
        429,
        'rate_limited',
        `Terlalu banyak permintaan AI. Coba lagi dalam ${wait} detik.`,
        { retryAfterSec: wait, limits },
      )
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

    // 3) Catat permintaan yang lolos supaya batas laju bisa menghitungnya.
    const { error: logErr } = await db.from('application_logs').insert({
      user_id: userId,
      action: AI_REQUEST_ACTION,
      platform: 'ai',
      status: 'success',
      details: { route },
    })
    if (logErr) {
      console.error(`[ai-guard] pencatatan permintaan gagal: ${logErr.message}`)
      throw new AiAccessError(503, 'rate_limit_check_failed', 'Batas permintaan AI tidak dapat diperiksa sekarang. Coba lagi nanti.')
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
    const waits = await Promise.all([
      this.retryAfterSec(db, userId, 60_000, limits.perMinute, now, action),
      this.retryAfterSec(db, userId, 3_600_000, limits.perHour, now, action),
    ])
    const wait = Math.max(0, ...waits.map((w) => w ?? 0))
    if (wait > 0) {
      throw new AiAccessError(
        429,
        'rate_limited',
        `${messagePrefix}. Coba lagi dalam ${wait} detik.`,
        { retryAfterSec: wait, limits },
      )
    }
    const { error: logErr } = await db.from('application_logs').insert({
      user_id: userId,
      action,
      platform: 'ai',
      status: 'success',
      details: { route },
    })
    if (logErr) {
      console.error(`[ai-guard] pencatatan batas laju ${action} gagal: ${logErr.message}`)
      throw new AiAccessError(503, 'rate_limit_check_failed', 'Batas permintaan tidak dapat diperiksa sekarang. Coba lagi nanti.')
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
