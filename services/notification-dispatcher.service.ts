import crypto from 'crypto'
import type { GuardDb } from './queue-guard.js'
import { KapsoWhatsAppService, kapsoWhatsAppService, normalizeWhatsAppPhone } from './kapso-whatsapp.service.js'

/**
 * Dispatcher notifikasi multi-kanal per-user (WhatsApp via Kapso, Email transaksional, Telegram).
 *
 * Prasyarat skema:
 *   - Tabel `user_notification_settings` & `notification_verification_codes`
 *     (lihat database/migrations/DRAFT_2026-11-23_user_notification_channels.sql).
 *   - Jika migrasi belum dijalankan (`42P01` / `PGRST205`), getter mengembalikan status default
 *     `migrationPending: true`, sedangkan mutasi mengembalikan 503 `notification_tables_unavailable`.
 */

export const NOTIFICATION_SETTINGS_TABLE = 'user_notification_settings'
export const NOTIFICATION_OTP_TABLE = 'notification_verification_codes'
export const OTP_TTL_MS = 10 * 60 * 1000
export const OTP_COOLDOWN_MS = 60 * 1000
export const MAX_OTP_ATTEMPTS = 5

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
  emailAddress: string | null
  emailEnabled: boolean
  telegramChatId: string | null
  telegramEnabled: boolean
  notifyEvents: Record<NotifyEventKey, boolean>
  migrationPending?: boolean
}

const isMissingTable = (err: { code?: string } | null | undefined): boolean =>
  err?.code === '42P01' || err?.code === 'PGRST205'

function otpPepper(env: Record<string, string | undefined> = process.env): string {
  return (env.SESSION_ENCRYPTION_KEY || env.KAPSO_API_KEY || 'applify-wa-otp-dev-pepper').trim()
}

export function hashVerificationOtp(userId: string, targetE164: string, code: string, env?: Record<string, string | undefined>): string {
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

function toSettingsView(userId: string, row: Record<string, any> | null, migrationPending = false): UserNotificationSettings {
  return {
    userId,
    whatsappPhone: typeof row?.whatsapp_phone === 'string' ? row.whatsapp_phone : null,
    whatsappVerified: Boolean(row?.whatsapp_verified),
    whatsappEnabled: Boolean(row?.whatsapp_enabled),
    whatsappLastInboundAt: typeof row?.whatsapp_last_inbound_at === 'string' ? row.whatsapp_last_inbound_at : null,
    emailAddress: typeof row?.email_address === 'string' ? row.email_address : null,
    emailEnabled: Boolean(row?.email_enabled),
    telegramChatId: typeof row?.telegram_chat_id === 'string' ? row.telegram_chat_id : null,
    telegramEnabled: Boolean(row?.telegram_enabled),
    notifyEvents: sanitizeNotifyEvents(row?.notify_events),
    ...(migrationPending ? { migrationPending: true } : {}),
  }
}

const SIMPLE_EMAIL_RE = /^[^\s@<>(),;"']+@[^\s@<>(),;"']+\.[A-Za-z]{2,63}$/

export async function getUserNotificationSettings(db: GuardDb, userId: string): Promise<UserNotificationSettings> {
  const { data, error } = await db
    .from(NOTIFICATION_SETTINGS_TABLE)
    .select('*')
    .eq('user_id', userId)
    .maybeSingle()

  if (error) {
    if (isMissingTable(error)) return toSettingsView(userId, null, true)
    throw new NotificationPreferenceError(500, 'settings_lookup_failed', 'Gagal membaca pengaturan notifikasi')
  }
  return toSettingsView(userId, data ?? null, false)
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

export async function updateUserNotificationSettings(
  db: GuardDb,
  userId: string,
  patch: {
    whatsappEnabled?: boolean
    emailEnabled?: boolean
    emailAddress?: string | null
    telegramEnabled?: boolean
    telegramChatId?: string | null
    notifyEvents?: Partial<Record<NotifyEventKey, boolean>>
  },
  now: Date = new Date()
): Promise<UserNotificationSettings> {
  const current = await getUserNotificationSettings(db, userId)
  if (current.migrationPending) {
    throw new NotificationPreferenceError(503, 'notification_tables_unavailable', 'Tabel notifikasi multi-kanal belum dimigrasi di database')
  }

  let emailAddress = current.emailAddress
  if (patch.emailAddress !== undefined) {
    if (patch.emailAddress === null || String(patch.emailAddress).trim() === '') {
      emailAddress = null
    } else {
      const cleaned = String(patch.emailAddress).trim()
      if (!SIMPLE_EMAIL_RE.test(cleaned)) {
        throw new NotificationPreferenceError(400, 'invalid_email', 'Alamat email notifikasi tidak valid')
      }
      emailAddress = cleaned
    }
  }

  const nextWaEnabled =
    typeof patch.whatsappEnabled === 'boolean'
      ? patch.whatsappEnabled && current.whatsappVerified && Boolean(current.whatsappPhone)
      : current.whatsappEnabled
  if (patch.whatsappEnabled === true && (!current.whatsappVerified || !current.whatsappPhone)) {
    throw new NotificationPreferenceError(400, 'whatsapp_not_verified', 'Verifikasi nomor WhatsApp lewat OTP terlebih dahulu sebelum mengaktifkannya.')
  }

  const nextEmailEnabled = typeof patch.emailEnabled === 'boolean' ? patch.emailEnabled : current.emailEnabled
  const nextTelegramChatId =
    patch.telegramChatId !== undefined
      ? (String(patch.telegramChatId ?? '').trim().replace(/[^\d-]/g, '').slice(0, 32) || null)
      : current.telegramChatId
  const nextTelegramEnabled =
    typeof patch.telegramEnabled === 'boolean' ? patch.telegramEnabled && Boolean(nextTelegramChatId) : current.telegramEnabled

  const mergedEvents = sanitizeNotifyEvents({ ...current.notifyEvents, ...(patch.notifyEvents ?? {}) })

  const { error } = await upsertNotificationRow(db, {
    user_id: userId,
    whatsapp_phone: current.whatsappPhone,
    whatsapp_verified: current.whatsappVerified,
    whatsapp_enabled: nextWaEnabled,
    whatsapp_last_inbound_at: current.whatsappLastInboundAt,
    email_address: emailAddress,
    email_enabled: nextEmailEnabled,
    telegram_chat_id: nextTelegramChatId,
    telegram_enabled: nextTelegramEnabled,
    notify_events: mergedEvents,
    updated_at: now.toISOString(),
  })
  if (error) {
    if (isMissingTable(error)) {
      throw new NotificationPreferenceError(503, 'notification_tables_unavailable', 'Tabel notifikasi multi-kanal belum dimigrasi di database')
    }
    throw new NotificationPreferenceError(500, 'settings_save_failed', 'Gagal menyimpan preferensi notifikasi')
  }

  return getUserNotificationSettings(db, userId)
}

export async function requestWhatsappVerificationOtp(
  db: GuardDb,
  whatsapp: KapsoWhatsAppService,
  userId: string,
  rawPhone: string,
  now: Date = new Date()
): Promise<{ sent: true; phone: string; mode?: string }> {
  const norm = normalizeWhatsAppPhone(rawPhone)
  if (!norm) {
    throw new NotificationPreferenceError(400, 'invalid_whatsapp_phone', 'Nomor WhatsApp tidak valid. Gunakan format +628... atau 08...')
  }
  if (!whatsapp.isConfigured()) {
    throw new NotificationPreferenceError(503, 'kapso_not_configured', 'Integrasi WhatsApp Kapso belum dikonfigurasi di server.')
  }

  const { data: recent, error: recentErr } = await db
    .from(NOTIFICATION_OTP_TABLE)
    .select('created_at')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(1)

  if (recentErr) {
    if (isMissingTable(recentErr)) {
      throw new NotificationPreferenceError(503, 'notification_tables_unavailable', 'Tabel verifikasi OTP WhatsApp belum dimigrasi.')
    }
    throw new NotificationPreferenceError(500, 'otp_lookup_failed', 'Gagal memeriksa riwayat OTP')
  }

  const lastCreated = recent?.[0]?.created_at ? Date.parse(recent[0].created_at) : NaN
  if (Number.isFinite(lastCreated) && now.getTime() - lastCreated < OTP_COOLDOWN_MS) {
    throw new NotificationPreferenceError(429, 'otp_cooldown', 'Tunggu sebentar sebelum meminta kode OTP WhatsApp lagi.')
  }

  const code = String(crypto.randomInt(100000, 1000000))
  const codeHash = hashVerificationOtp(userId, norm.e164, code)
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
    if (isMissingTable(insErr)) {
      throw new NotificationPreferenceError(503, 'notification_tables_unavailable', 'Tabel verifikasi OTP WhatsApp belum dimigrasi.')
    }
    throw new NotificationPreferenceError(500, 'otp_store_failed', 'Gagal membuat kode OTP')
  }

  const currentSettings = await getUserNotificationSettings(db, userId)
  const sendRes = await whatsapp.sendMessage({
    to: norm.e164,
    body: `Kode verifikasi Applify Anda: ${code} (berlaku 10 menit). Jangan bagikan kode ini kepada siapa pun.`,
    lastInboundAt: currentSettings.whatsappLastInboundAt,
    now,
  })
  if (!sendRes.ok) {
    throw new NotificationPreferenceError(502, 'whatsapp_send_failed', `Gagal mengirim OTP ke WhatsApp (${sendRes.error ?? 'unknown'}). Pastikan sudah chat sandbox/bot atau template aktif.`)
  }

  return { sent: true, phone: norm.e164, mode: sendRes.mode }
}

export async function verifyWhatsappVerificationOtp(
  db: GuardDb,
  userId: string,
  rawPhone: string,
  rawCode: string,
  now: Date = new Date()
): Promise<UserNotificationSettings> {
  const norm = normalizeWhatsAppPhone(rawPhone)
  if (!norm) throw new NotificationPreferenceError(400, 'invalid_whatsapp_phone', 'Nomor WhatsApp tidak valid')
  const code = String(rawCode ?? '').replace(/[\s-]/g, '')
  if (!/^\d{6}$/.test(code)) throw new NotificationPreferenceError(400, 'invalid_otp', 'Kode OTP harus 6 digit angka')

  const { data: rows, error } = await db
    .from(NOTIFICATION_OTP_TABLE)
    .select('id, target, code_hash, attempts, expires_at')
    .eq('user_id', userId)
    .eq('channel', 'whatsapp')
    .eq('target', norm.e164)
    .order('created_at', { ascending: false })
    .limit(1)

  if (error) {
    if (isMissingTable(error)) {
      throw new NotificationPreferenceError(503, 'notification_tables_unavailable', 'Tabel verifikasi OTP WhatsApp belum dimigrasi.')
    }
    throw new NotificationPreferenceError(500, 'otp_lookup_failed', 'Gagal memeriksa OTP')
  }

  const row = rows?.[0]
  if (!row) throw new NotificationPreferenceError(400, 'otp_not_found', 'Belum ada kode OTP untuk nomor ini. Minta kode baru.')
  if (Number(row.attempts ?? 0) >= MAX_OTP_ATTEMPTS) {
    throw new NotificationPreferenceError(429, 'otp_too_many_attempts', 'Terlalu banyak percobaan OTP salah. Minta kode baru.')
  }
  const expMs = Date.parse(String(row.expires_at ?? ''))
  if (!Number.isFinite(expMs) || expMs <= now.getTime()) {
    throw new NotificationPreferenceError(400, 'otp_expired', 'Kode OTP sudah kedaluwarsa. Minta kode baru.')
  }

  const expectedHash = hashVerificationOtp(userId, norm.e164, code)
  const a = Buffer.from(String(row.code_hash ?? ''), 'utf8')
  const b = Buffer.from(expectedHash, 'utf8')
  const matched = a.length === b.length && crypto.timingSafeEqual(a, b)
  if (!matched) {
    await db
      .from(NOTIFICATION_OTP_TABLE)
      .update({ attempts: Number(row.attempts ?? 0) + 1 })
      .eq('id', row.id)
    throw new NotificationPreferenceError(400, 'otp_mismatch', 'Kode OTP salah')
  }

  await db.from(NOTIFICATION_OTP_TABLE).delete().eq('id', row.id)

  const current = await getUserNotificationSettings(db, userId)
  const { error: upErr } = await upsertNotificationRow(db, {
    user_id: userId,
    whatsapp_phone: norm.e164,
    whatsapp_verified: true,
    whatsapp_enabled: true,
    whatsapp_last_inbound_at: current.whatsappLastInboundAt,
    email_address: current.emailAddress,
    email_enabled: current.emailEnabled,
    telegram_chat_id: current.telegramChatId,
    telegram_enabled: current.telegramEnabled,
    notify_events: current.notifyEvents,
    updated_at: now.toISOString(),
  })
  if (upErr) {
    throw new NotificationPreferenceError(500, 'settings_save_failed', 'Gagal mengaktifkan nomor WhatsApp terverifikasi')
  }

  return getUserNotificationSettings(db, userId)
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
 * token OAuth Gmail `email_apply` milik pelamar.
 */
export async function sendTransactionalEmailNotification(
  args: { to: string; subject: string; text: string },
  fetchImpl: typeof fetch = fetch,
  env: Record<string, string | undefined> = process.env
): Promise<{ ok: boolean; error?: string }> {
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
    })
    if (!resp.ok) return { ok: false, error: `resend_${resp.status}` }
    return { ok: true }
  } catch (err: any) {
    return { ok: false, error: String(err?.message ?? err) }
  }
}

export class NotificationDispatcherService {
  constructor(
    private readonly whatsapp: KapsoWhatsAppService = kapsoWhatsAppService,
    private readonly sendEmail: typeof sendTransactionalEmailNotification = sendTransactionalEmailNotification
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

    if (settings.emailEnabled && settings.emailAddress) {
      const em = await this.sendEmail({
        to: settings.emailAddress,
        subject: args.title,
        text: args.plainMessage,
      })
      if (em.ok) delivered.push('email')
    }

    return { deliveredChannels: delivered }
  }
}

export const notificationDispatcher = new NotificationDispatcherService()
