import type { GuardDb } from './queue-guard.js'
import { isUuid } from './uuid.js'

/**
 * Pusat notifikasi in-app (`public.user_notifications`, audit 47.5 U5-P1-01).
 *
 * Penulisan dan penandaan dibaca hanya dilakukan dari backend (`service_role`), sehingga RLS tetap
 * SELECT-only untuk pemilik. Bila tabel `user_notifications` belum ada di DB (migrasi DRAFT belum
 * dijalankan), seluruh fungsi turun dengan bersih (`migrationPending: true`) tanpa mengganggu alur utama.
 */

export const USER_NOTIFICATIONS_TABLE = 'user_notifications'
const MAX_TITLE_CHARS = 160
const MAX_BODY_CHARS = 500
const MAX_LIST_LIMIT = 50

export interface InAppNotificationItem {
  id: string
  event: string
  title: string
  body: string
  href: string | null
  read_at: string | null
  created_at: string
}

export interface InAppNotificationListResult {
  items: InAppNotificationItem[]
  unreadCount: number
  migrationPending: boolean
}

export function isNotificationsTableMissing(error: unknown): boolean {
  const err = error as { code?: string; message?: string } | null | undefined
  if (!err) return false
  const code = String(err.code ?? '')
  if (code === '42P01' || code === 'PGRST205') return true
  const msg = String(err.message ?? '')
  return /user_notifications/i.test(msg) && /(does not exist|could not find|schema cache|not found)/i.test(msg)
}

/** Hanya mengizinkan path internal aplikasi (mis. `/approvals`, `/applications`) untuk tautan klik. */
export function sanitizeInternalHref(href: unknown): string | null {
  if (typeof href !== 'string') return null
  const trimmed = href.trim()
  if (!trimmed.startsWith('/') || trimmed.startsWith('//')) return null
  return trimmed.slice(0, 120)
}

export function defaultHrefForEvent(event: string): string {
  if (event === 'ready' || event === 'extension_questions' || event === 'security_code') return '/approvals'
  if (event === 'submitted' || event === 'follow_up' || event === 'responded' || event === 'closed') return '/applications'
  return '/dashboard'
}

export async function createInAppNotification(
  db: GuardDb,
  args: {
    userId: string
    event: string
    title: string
    body: string
    href?: string | null
    metadata?: Record<string, unknown>
    now?: Date
  }
): Promise<{ ok: boolean; migrationPending?: boolean }> {
  const title = String(args.title ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE_CHARS)
  const body = String(args.body ?? '').trim().slice(0, MAX_BODY_CHARS)
  if (!args.userId || !title || !body) return { ok: false }

  try {
    const { error } = await db.from(USER_NOTIFICATIONS_TABLE).insert({
      user_id: args.userId,
      event: String(args.event || 'info').slice(0, 64),
      title,
      body,
      href: sanitizeInternalHref(args.href) ?? defaultHrefForEvent(args.event),
      metadata: args.metadata && typeof args.metadata === 'object' ? args.metadata : {},
      created_at: (args.now ?? new Date()).toISOString(),
    })
    if (error) {
      if (isNotificationsTableMissing(error)) return { ok: false, migrationPending: true }
      return { ok: false }
    }
    return { ok: true }
  } catch (err) {
    if (isNotificationsTableMissing(err)) return { ok: false, migrationPending: true }
    return { ok: false }
  }
}

export async function listInAppNotifications(
  db: GuardDb,
  userId: string,
  rawLimit = 20
): Promise<InAppNotificationListResult> {
  const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(MAX_LIST_LIMIT, Math.floor(rawLimit))) : 20
  try {
    const [listRes, countRes] = await Promise.all([
      db
        .from(USER_NOTIFICATIONS_TABLE)
        .select('id, event, title, body, href, read_at, created_at')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(limit),
      db
        .from(USER_NOTIFICATIONS_TABLE)
        .select('id', { count: 'exact', head: true })
        .eq('user_id', userId)
        .is('read_at', null),
    ])

    if (listRes.error) {
      if (isNotificationsTableMissing(listRes.error)) {
        return { items: [], unreadCount: 0, migrationPending: true }
      }
      throw new Error(listRes.error.message ?? 'failed to list notifications')
    }
    if (countRes.error && !isNotificationsTableMissing(countRes.error)) {
      throw new Error(countRes.error.message ?? 'failed to count unread notifications')
    }

    const items = (Array.isArray(listRes.data) ? listRes.data : []) as InAppNotificationItem[]
    const unreadCount = typeof countRes.count === 'number'
      ? countRes.count
      : items.filter((item) => !item.read_at).length

    return { items, unreadCount, migrationPending: false }
  } catch (err) {
    if (isNotificationsTableMissing(err)) {
      return { items: [], unreadCount: 0, migrationPending: true }
    }
    throw err
  }
}

export async function markInAppNotificationsRead(
  db: GuardDb,
  userId: string,
  opts: { ids?: unknown[]; all?: boolean },
  now: Date = new Date()
): Promise<{ updated: number; migrationPending: boolean }> {
  const readAt = now.toISOString()
  const ids = Array.isArray(opts.ids)
    ? opts.ids.filter((id): id is string => typeof id === 'string' && isUuid(id)).slice(0, MAX_LIST_LIMIT)
    : []

  if (!opts.all && ids.length === 0) {
    return { updated: 0, migrationPending: false }
  }

  try {
    let query = db
      .from(USER_NOTIFICATIONS_TABLE)
      .update({ read_at: readAt })
      .eq('user_id', userId)
      .is('read_at', null)

    if (!opts.all) {
      query = query.in('id', ids)
    }

    const { data, error } = await query.select('id')
    if (error) {
      if (isNotificationsTableMissing(error)) {
        return { updated: 0, migrationPending: true }
      }
      throw new Error(error.message ?? 'failed to mark notifications read')
    }
    return { updated: Array.isArray(data) ? data.length : 0, migrationPending: false }
  } catch (err) {
    if (isNotificationsTableMissing(err)) {
      return { updated: 0, migrationPending: true }
    }
    throw err
  }
}
