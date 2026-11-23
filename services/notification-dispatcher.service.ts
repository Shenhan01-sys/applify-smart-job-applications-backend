import crypto from 'crypto'
import type { GuardDb } from './queue-guard.js'
import { KapsoWhatsAppService, kapsoWhatsAppService, normalizeWhatsAppPhone } from './kapso-whatsapp.service.js'
import { networkErrorCode, notificationsEnabled, notifyTimeoutSignal } from './notifications-switch.js'

/**
 * Dispatcher notifikasi multi-kanal per-user (WhatsApp via Kapso, Email transaksional).
 *
 * Prasyarat skema:
 *   - Tabel `user_notification_settings` & `notification_verification_codes` serta fungsi
 *     `register_notification_otp_attempt` (lihat database/migrations/DRAFT_2026-11-23_user_notification_channels.sql).
 *   - Jika migrasi belum dijalankan (`42P01` / `PGRST205`), getter mengembalikan status default
 *     `migrationPending: true`, sedangkan mutasi mengembalikan 503 `notification_tables_unavailable`.
 *
 * Keamanan:
 *   - Email notifikasi HANYA ke email akun Supabase Auth milik pengguna (sudah terkonfirmasi), dibaca server
 *     lewat `auth.admin.getUserById`. Alamat email dari klien tidak pernah disimpan atau dipakai.
 *   - Tidak ada chat Telegram per pengguna: chat Telegram hanya milik operator (env `TELEGRAM_CHAT_ID`).
 *   - OTP WhatsApp: batas harian per pengguna dan per nomor, penghitung percobaan atomik lewat RPC (tanpa RPC
 *     verifikasi ditolak), dan kode hanya bisa dipakai sekali. Pepper hash dari `NOTIFY_OTP_PEPPER`, tanpa fallback.
 *   - Semua pengiriman hanya jalan bila `NOTIFICATIONS_ENABLED=true` (lihat notifications-switch.ts).
 */

export const NOTIFICATION_SETTINGS_TABLE = 'user_notification_settings'
export const NOTIFICATION_OTP_TABLE = 'notification_verification_codes'
export const OTP_TTL_MS = 10 * 60 * 1000
export const OTP_COOLDOWN_MS = 60 * 1000
export const MAX_OTP_ATTEMPTS = 5
/** Permintaan OTP per pengguna dalam jendela 24 jam (jendela bergulir). */
export const OTP_DAILY_LIMIT_PER_USER = 5
/** Permintaan OTP ke satu nomor telepon dalam jendela 24 jam, dari semua pengguna. */
export const OTP_DAILY_LIMIT_PER_PHONE = 5
export const OTP_DAILY_WINDOW_MS = 24 * 60 * 60 * 1000
/** Fungsi SQL atomik: `update ... set attempts = attempts + 1 where id = p_id and attempts < p_max returning attempts`. */
export const OTP_ATTEMPT_RPC = 'register_notification_otp_attempt'

export type NotifyEventKey = 'ready' | 'submitted' | 'awaiting_code' | 'follow_up' | 'locked_claim'

export const DEFAULT_NOTIFY_EVENTS: Record<NotifyEventKey, boolean> = {
  ready: true,
  submitted: true,
  awaiting_code: true,
  follow_up: true,
  locked_claim: true,
}

export class NotificationPreferenceError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string
  ) {
    super(message)
  }
}

export interface UserNotificationSettings {
  userId: string
  whatsappPhone: string | null
  whatsappVerified: boolean
  whatsappEnabled: boolean
  whatsappLastInboundAt: string | null
  /** Email akun (read-only, dari Supabase Auth). `null` bila tidak tersedia atau belum dikonfirmasi. */
  emailAddress: string | null
  emailEnabled: boolean
  notifyEvents: Record<NotifyEventKey, boolean>
  migrationPending?: boolean
}

const isMissingTable = (err: { code?: string } | null | undefined): boolean =>
  err?.code === '42P01' || err?.code === 'PGRST205'

const tablesUnavailable = (): NotificationPreferenceError =>
  new NotificationPreferenceError(503, 'notification_tables_unavailable', 'Tabel verifikasi OTP WhatsApp belum dimigrasi.')

type Env = Record<string, string | undefined>

/** Pepper hash OTP. Wajib `NOTIFY_OTP_PEPPER`; tanpa itu verifikasi gagal tertutup (503). */
function otpPepper(env: Env = process.env): string {
  const pepper = (env.NOTIFY_OTP_PEPPER ?? '').trim()
  if (!pepper) {
    throw new NotificationPreferenceError(503, 'otp_not_configured', 'Verifikasi WhatsApp belum dikonfigurasi di server.')
  }
  return pepper
}

export function hashVerificationOtp(userId: string, targetE164: string, code: string, env?: Env): string {
  return crypto
    .createHmac('sha256', otpPepper(env))
    .update(`${userId}:${targetE164}:${code.trim()}`)
    .digest('hex')
}

function sanitizeNotifyEvents(raw: unknown): Record<NotifyEventKey, boolean> {
  const rec = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  return {
    ready: typeof rec.ready === 'boolean' ? rec.ready : DEFAULT_NOTIFY_EVENTS.ready,
    submitted: typeof rec.submitted === 'boolean' ? rec.submitted : DEFAULT_NOTIFY_EVENTS.submitted,
    awaiting_code: typeof rec.awaiting_code === 'boolean' ? rec.awaiting_code : DEFAULT_NOTIFY_EVENTS.awaiting_code,
    follow_up: typeof rec.follow_up === 'boolean' ? rec.follow_up : DEFAULT_NOTIFY_EVENTS.follow_up,
    locked_claim: typeof rec.locked_claim === 'boolean' ? rec.locked_claim : DEFAULT_NOTIFY_EVENTS.locked_claim,
  }
}

function toSettingsView(
  userId: string,
  row: Record<string, any> | null,
  accountEmail: string | null,
  migrationPending = false
): UserNotificationSettings {
  return {
    userId,
    whatsappPhone: typeof row?.whatsapp_phone === 'string' ? row.whatsapp_phone : null,
    whatsappVerified: Boolean(row?.whatsapp_verified),
    whatsappEnabled: Boolean(row?.whatsapp_enabled),
    whatsappLastInboundAt: typeof row?.whatsapp_last_inbound_at === 'string' ? row.whatsapp_last_inbound_at : null,
    emailAddress: accountEmail,
    emailEnabled: Boolean(row?.email_enabled),
    notifyEvents: sanitizeNotifyEvents(row?.notify_events),
    ...(migrationPending ? { migrationPending: true } : {}),
  }
}

const SIMPLE_EMAIL_RE = /^[^\s@<>(),;"']+@[^\s@<>(),;"']+\.[A-Za-z]{2,63}$/

/**
 * Email akun pengguna dari Supabase Auth (service role). Hanya email yang sudah terkonfirmasi yang dipakai.
 * Mengembalikan null bila klien DB tidak punya `auth.admin` atau pencarian gagal: gagal tertutup, tidak ada email.
 */
export async function getAccountEmail(db: GuardDb, userId: string): Promise<string | null> {
  try {
    const admin = (db as any)?.auth?.admin
    if (!admin || typeof admin.getUserById !== 'function') return null
    const res = await admin.getUserById(userId)
    const user = res?.data?.user
    if (res?.error || !user || user.id !== userId) return null
    const email = typeof user.email === 'string' ? user.email.trim() : ''
    const confirmed = Boolean(user.email_confirmed_at || user.confirmed_at)
    if (!email || !confirmed || !SIMPLE_EMAIL_RE.test(email)) return null
    return email
  } catch {
    return null
  }
}

export async function getUserNotificationSettings(
  db: GuardDb,
  userId: string,
  opts: { withAccountEmail?: boolean } = {}
): Promise<UserNotificationSettings> {
  const { data, error } = await db
    .from(NOTIFICATION_SETTINGS_TABLE)
    .select('*')
    .eq('user_id', userId)
    .maybeSingle()

  if (error) {
    if (isMissingTable(error)) return toSettingsView(userId, null, null, true)
    throw new NotificationPreferenceError(500, 'settings_lookup_failed', 'Gagal membaca pengaturan notifikasi')
  }
  const accountEmail = opts.withAccountEmail ? await getAccountEmail(db, userId) : null
  return toSettingsView(userId, data ?? null, accountEmail, false)
}

async function upsertNotificationRow(db: GuardDb, payload: Record<string, unknown>) {
  const tableApi = db.from(NOTIFICATION_SETTINGS_TABLE)
  if (typeof tableApi.upsert === 'function') {
    return tableApi.upsert(payload, { onConflict: 'user_id' })
  }
  const { data: existing } = await db.from(NOTIFICATION_SETTINGS_TABLE).select('user_id').eq('user_id', payload.user_id).maybeSingle()
  return existing
    ? db.from(NOTIFICATION_SETTINGS_TABLE).update(payload).eq('user_id', payload.user_id)
    : db.from(NOTIFICATION_SETTINGS_TABLE).insert(payload)
}

/**
 * Pembaruan preferensi. Alamat email dan chat Telegram dari klien sengaja tidak ada di sini: email selalu email akun
 * Auth, dan tidak ada chat Telegram per pengguna.
 */
export async function updateUserNotificationSettings(
  db: GuardDb,
  userId: string,
  patch: {
    whatsappEnabled?: boolean
    emailEnabled?: boolean
    notifyEvents?: Partial<Record<NotifyEventKey, boolean>>
  },
  now: Date = new Date()
): Promise<UserNotificationSettings> {
  const current = await getUserNotificationSettings(db, userId)
  if (current.migrationPending) {
    throw new NotificationPreferenceError(503, 'notification_tables_unavailable', 'Tabel notifikasi multi-kanal belum dimigrasi di database')
  }

  const nextWaEnabled =
    typeof patch.whatsappEnabled === 'boolean'
      ? patch.whatsappEnabled && current.whatsappVerified && Boolean(current.whatsappPhone)
      : current.whatsappEnabled
  if (patch.whatsappEnabled === true && (!current.whatsappVerified || !current.whatsappPhone)) {
    throw new NotificationPreferenceError(400, 'whatsapp_not_verified', 'Verifikasi nomor WhatsApp lewat OTP terlebih dahulu sebelum mengaktifkannya.')
  }

  if (patch.emailEnabled === true && !(await getAccountEmail(db, userId))) {
    throw new NotificationPreferenceError(
      400,
      'account_email_unavailable',
      'Email akun belum terkonfirmasi atau tidak tersedia, sehingga notifikasi email belum bisa diaktifkan.'
    )
  }
  const nextEmailEnabled = typeof patch.emailEnabled === 'boolean' ? patch.emailEnabled : current.emailEnabled

  const mergedEvents = sanitizeNotifyEvents({ ...current.notifyEvents, ...(patch.notifyEvents ?? {}) })

  const { error } = await upsertNotificationRow(db, {
    user_id: userId,
    whatsapp_phone: current.whatsappPhone,
    whatsapp_verified: current.whatsappVerified,
    whatsapp_enabled: nextWaEnabled,
    whatsapp_last_inbound_at: current.whatsappLastInboundAt,
    email_enabled: nextEmailEnabled,
    notify_events: mergedEvents,
    updated_at: now.toISOString(),
  })
  if (error) {
    if (isMissingTable(error)) {
      throw new NotificationPreferenceError(503, 'notification_tables_unavailable', 'Tabel notifikasi multi-kanal belum dimigrasi di database')
    }
    throw new NotificationPreferenceError(500, 'settings_save_failed', 'Gagal menyimpan preferensi notifikasi')
  }

  return getUserNotificationSettings(db, userId, { withAccountEmail: true })
}

/** Jumlah baris OTP untuk satu pengguna atau satu nomor sejak `sinceIso`. Galat atau hitungan hilang: gagal tertutup. */
async function countOtpRequests(db: GuardDb, column: 'user_id' | 'target', value: string, sinceIso: string): Promise<number> {
  const { count, error } = await db
    .from(NOTIFICATION_OTP_TABLE)
    .select('id', { count: 'exact', head: true })
    .eq(column, value)
    .gte('created_at', sinceIso)
  if (error) {
    if (isMissingTable(error)) throw tablesUnavailable()
    throw new NotificationPreferenceError(500, 'otp_lookup_failed', 'Gagal memeriksa riwayat OTP')
  }
  if (typeof count !== 'number') {
    throw new NotificationPreferenceError(500, 'otp_lookup_failed', 'Gagal memeriksa riwayat OTP')
  }
  return count
}

export async function requestWhatsappVerificationOtp(
  db: GuardDb,
  whatsapp: KapsoWhatsAppService,
  userId: string,
  rawPhone: string,
  now: Date = new Date(),
  env: Env = process.env
): Promise<{ sent: true; phone: string; mode?: string }> {
  const norm = normalizeWhatsAppPhone(rawPhone)
  if (!norm) {
    throw new NotificationPreferenceError(400, 'invalid_whatsapp_phone', 'Nomor WhatsApp tidak valid. Gunakan format +628... atau 08...')
  }
  if (!notificationsEnabled(env)) {
    throw new NotificationPreferenceError(503, 'notifications_disabled', 'Notifikasi sedang dinonaktifkan di server.')
  }
  if (!whatsapp.isConfigured()) {
    throw new NotificationPreferenceError(503, 'kapso_not_configured', 'Integrasi WhatsApp Kapso belum dikonfigurasi di server.')
  }
  otpPepper(env) // gagal tertutup sebelum menyimpan atau mengirim apa pun

  const { data: recent, error: recentErr } = await db
    .from(NOTIFICATION_OTP_TABLE)
    .select('created_at')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(1)

  if (recentErr) {
    if (isMissingTable(recentErr)) throw tablesUnavailable()
    throw new NotificationPreferenceError(500, 'otp_lookup_failed', 'Gagal memeriksa riwayat OTP')
  }

  const lastCreated = recent?.[0]?.created_at ? Date.parse(recent[0].created_at) : NaN
  if (Number.isFinite(lastCreated) && now.getTime() - lastCreated < OTP_COOLDOWN_MS) {
    throw new NotificationPreferenceError(429, 'otp_cooldown', 'Tunggu sebentar sebelum meminta kode OTP WhatsApp lagi.')
  }

  // Batas harian: per pengguna (menahan penyalahgunaan satu akun) dan per nomor (menahan banyak akun ke satu korban).
  const sinceIso = new Date(now.getTime() - OTP_DAILY_WINDOW_MS).toISOString()
  const [byUser, byPhone] = await Promise.all([
    countOtpRequests(db, 'user_id', userId, sinceIso),
    countOtpRequests(db, 'target', norm.e164, sinceIso),
  ])
  if (byUser >= OTP_DAILY_LIMIT_PER_USER || byPhone >= OTP_DAILY_LIMIT_PER_PHONE) {
    throw new NotificationPreferenceError(429, 'otp_daily_limit', 'Batas permintaan kode OTP hari ini sudah tercapai. Coba lagi besok.')
  }

  const code = String(crypto.randomInt(100000, 1000000))
  const codeHash = hashVerificationOtp(userId, norm.e164, code, env)
  const expiresAt = new Date(now.getTime() + OTP_TTL_MS).toISOString()

  const { error: insErr } = await db.from(NOTIFICATION_OTP_TABLE).insert({
    user_id: userId,
    channel: 'whatsapp',
    target: norm.e164,
    code_hash: codeHash,
    attempts: 0,
    expires_at: expiresAt,
    created_at: now.toISOString(),
  })
  if (insErr) {
    if (isMissingTable(insErr)) throw tablesUnavailable()
    throw new NotificationPreferenceError(500, 'otp_store_failed', 'Gagal membuat kode OTP')
  }

  const currentSettings = await getUserNotificationSettings(db, userId)
  const sendRes = await whatsapp.sendOtp({
    to: norm.e164,
    code,
    lastInboundAt: currentSettings.whatsappLastInboundAt,
    now,
  })
  if (!sendRes.ok) {
    // `sendRes.error` hanya kode generik dan masuk log server; klien menerima pesan tetap.
    console.warn(`[notifications] OTP WhatsApp gagal terkirim: ${sendRes.error ?? 'unknown'}`)
    throw new NotificationPreferenceError(
      502,
      'whatsapp_send_failed',
      'Gagal mengirim OTP ke WhatsApp. Pastikan nomor aktif dan sudah pernah chat ke nomor bot Applify, lalu coba lagi nanti.'
    )
  }

  return { sent: true, phone: norm.e164, mode: sendRes.mode }
}

/**
 * Naikkan penghitung percobaan secara atomik lewat RPC. Mengembalikan false bila batas percobaan sudah tercapai atau
 * kode sudah dipakai. Tanpa klien `rpc` atau fungsinya belum dimigrasi: lempar 503 (gagal tertutup, tidak ada fallback
 * baca-lalu-tulis yang bisa dibalap beberapa permintaan paralel).
 */
async function registerOtpAttempt(db: GuardDb, otpId: string): Promise<boolean> {
  const rpc = (db as any)?.rpc
  const unavailable = () =>
    new NotificationPreferenceError(503, 'otp_attempts_unavailable', 'Verifikasi OTP belum tersedia di server. Coba lagi nanti.')
  if (typeof rpc !== 'function') throw unavailable()
  let res: any
  try {
    res = await rpc.call(db, OTP_ATTEMPT_RPC, { p_id: otpId, p_max: MAX_OTP_ATTEMPTS })
  } catch {
    throw unavailable()
  }
  if (res?.error) throw unavailable()
  const value = Array.isArray(res?.data) ? res.data[0] : res?.data
  return typeof value === 'number'
}

export async function verifyWhatsappVerificationOtp(
  db: GuardDb,
  userId: string,
  rawPhone: string,
  rawCode: string,
  now: Date = new Date(),
  env: Env = process.env
): Promise<UserNotificationSettings> {
  const norm = normalizeWhatsAppPhone(rawPhone)
  if (!norm) throw new NotificationPreferenceError(400, 'invalid_whatsapp_phone', 'Nomor WhatsApp tidak valid')
  const code = String(rawCode ?? '').replace(/[\s-]/g, '')
  if (!/^\d{6}$/.test(code)) throw new NotificationPreferenceError(400, 'invalid_otp', 'Kode OTP harus 6 digit angka')
  otpPepper(env) // gagal tertutup bila pepper kosong

  const { data: rows, error } = await db
    .from(NOTIFICATION_OTP_TABLE)
    .select('id, target, code_hash, attempts, expires_at, consumed_at')
    .eq('user_id', userId)
    .eq('channel', 'whatsapp')
    .eq('target', norm.e164)
    .order('created_at', { ascending: false })
    .limit(1)

  if (error) {
    if (isMissingTable(error)) throw tablesUnavailable()
    throw new NotificationPreferenceError(500, 'otp_lookup_failed', 'Gagal memeriksa OTP')
  }

  const row = rows?.[0]
  if (!row || row.consumed_at) {
    throw new NotificationPreferenceError(400, 'otp_not_found', 'Belum ada kode OTP aktif untuk nomor ini. Minta kode baru.')
  }
  const expMs = Date.parse(String(row.expires_at ?? ''))
  if (!Number.isFinite(expMs) || expMs <= now.getTime()) {
    throw new NotificationPreferenceError(400, 'otp_expired', 'Kode OTP sudah kedaluwarsa. Minta kode baru.')
  }

  // Percobaan dihitung SEBELUM kode dibandingkan, dalam satu pernyataan SQL atomik. Banyak tebakan paralel tidak
  // bisa lolos dari batas karena hanya yang mendapat nomor percobaan <= MAX_OTP_ATTEMPTS yang dibandingkan.
  const allowed = await registerOtpAttempt(db, String(row.id))
  if (!allowed) {
    throw new NotificationPreferenceError(429, 'otp_too_many_attempts', 'Batas percobaan OTP tercapai atau kode sudah dipakai. Minta kode baru.')
  }

  const expectedHash = hashVerificationOtp(userId, norm.e164, code, env)
  const a = Buffer.from(String(row.code_hash ?? ''), 'utf8')
  const b = Buffer.from(expectedHash, 'utf8')
  const matched = a.length === b.length && crypto.timingSafeEqual(a, b)
  if (!matched) {
    throw new NotificationPreferenceError(400, 'otp_mismatch', 'Kode OTP salah')
  }

  // Tandai terpakai (bukan hapus) agar tetap dihitung di batas harian. Hanya satu permintaan yang bisa menandai.
  const { data: consumed, error: consumeErr } = await db
    .from(NOTIFICATION_OTP_TABLE)
    .update({ consumed_at: now.toISOString() })
    .eq('id', row.id)
    .is('consumed_at', null)
    .select('id')
  if (consumeErr) {
    throw new NotificationPreferenceError(500, 'otp_consume_failed', 'Gagal memverifikasi OTP')
  }
  if (!Array.isArray(consumed) || consumed.length === 0) {
    throw new NotificationPreferenceError(400, 'otp_not_found', 'Belum ada kode OTP aktif untuk nomor ini. Minta kode baru.')
  }

  const current = await getUserNotificationSettings(db, userId)
  const { error: upErr } = await upsertNotificationRow(db, {
    user_id: userId,
    whatsapp_phone: norm.e164,
    whatsapp_verified: true,
    whatsapp_enabled: true,
    whatsapp_last_inbound_at: current.whatsappLastInboundAt,
    email_enabled: current.emailEnabled,
    notify_events: current.notifyEvents,
    updated_at: now.toISOString(),
  })
  if (upErr) {
    throw new NotificationPreferenceError(500, 'settings_save_failed', 'Gagal mengaktifkan nomor WhatsApp terverifikasi')
  }

  return getUserNotificationSettings(db, userId, { withAccountEmail: true })
}

/** Perbarui timestamp pesan masuk terakhir dari webhook Kapso agar pengiriman teks 24 jam selalu akurat. */
export async function recordWhatsappInbound(
  db: GuardDb,
  rawFromPhone: string,
  now: Date = new Date()
): Promise<{ updated: number }> {
  const norm = normalizeWhatsAppPhone(rawFromPhone)
  if (!norm) return { updated: 0 }
  const { data, error } = await db
    .from(NOTIFICATION_SETTINGS_TABLE)
    .update({ whatsapp_last_inbound_at: now.toISOString(), updated_at: now.toISOString() })
    .eq('whatsapp_phone', norm.e164)
    .select('user_id')

  if (error) return { updated: 0 }
  return { updated: Array.isArray(data) ? data.length : 0 }
}

/**
 * Pengirim email transaksional terpisah (Resend API bila RESEND_API_KEY disetel) — sengaja TIDAK meminjam
 * token OAuth Gmail `email_apply` milik pelamar. Penerima ditentukan pemanggil (dispatcher memakai email akun Auth).
 */
export async function sendTransactionalEmailNotification(
  args: { to: string; subject: string; text: string },
  fetchImpl: typeof fetch = fetch,
  env: Env = process.env
): Promise<{ ok: boolean; error?: string }> {
  if (!notificationsEnabled(env)) return { ok: false, error: 'notifications_disabled' }
  const apiKey = (env.RESEND_API_KEY ?? '').trim()
  const from = (env.NOTIFY_FROM_EMAIL ?? '').trim()
  if (!apiKey || !from) return { ok: false, error: 'email_notifier_not_configured' }
  if (!SIMPLE_EMAIL_RE.test(args.to)) return { ok: false, error: 'invalid_email' }

  try {
    const resp = await fetchImpl('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from,
        to: [args.to],
        subject: args.subject.slice(0, 180),
        text: args.text.slice(0, 4000),
      }),
      signal: notifyTimeoutSignal(),
    })
    if (!resp.ok) return { ok: false, error: `resend_http_${resp.status}` }
    return { ok: true }
  } catch (err: unknown) {
    return { ok: false, error: networkErrorCode('resend', err) }
  }
}

export class NotificationDispatcherService {
  constructor(
    private readonly whatsapp: KapsoWhatsAppService = kapsoWhatsAppService,
    private readonly sendEmail: typeof sendTransactionalEmailNotification = sendTransactionalEmailNotification,
    private readonly env: Env = process.env
  ) {}

  async dispatchUserNotification(
    db: GuardDb,
    args: {
      userId: string
      event: NotifyEventKey
      title: string
      plainMessage: string
      now?: Date
    }
  ): Promise<{ deliveredChannels: string[] }> {
    if (!notificationsEnabled(this.env)) return { deliveredChannels: [] }

    const settings = await getUserNotificationSettings(db, args.userId)
    if (settings.migrationPending || settings.notifyEvents[args.event] === false) {
      return { deliveredChannels: [] }
    }

    const delivered: string[] = []
    if (settings.whatsappEnabled && settings.whatsappVerified && settings.whatsappPhone) {
      const wa = await this.whatsapp.sendMessage({
        to: settings.whatsappPhone,
        body: args.plainMessage,
        lastInboundAt: settings.whatsappLastInboundAt,
        now: args.now,
      })
      if (wa.ok) delivered.push('whatsapp')
    }

    if (settings.emailEnabled) {
      // Penerima selalu email akun Auth yang terkonfirmasi, dibaca server; tidak ada alamat dari tabel atau klien.
      const to = await getAccountEmail(db, args.userId)
      if (to) {
        const em = await this.sendEmail({ to, subject: args.title, text: args.plainMessage }, undefined, this.env)
        if (em.ok) delivered.push('email')
      }
    }

    return { deliveredChannels: delivered }
  }
}

export const notificationDispatcher = new NotificationDispatcherService()
