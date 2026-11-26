import { createInAppNotification, defaultHrefForEvent } from './in-app-notifications.service.js'

/**
 * Telegram notice for application status changes made from the frontend (marked as sent manually, moved on
 * the board, follow-up marked as done). The worker announces the changes it makes itself
 * (worker/src/lib/applicationStatus.ts); this is the counterpart for changes that never pass the worker.
 *
 * The caller only says WHICH application changed. The status is read from the database (ai_applications,
 * owned by the user), never taken from the request, and an announcement is skipped when the last one for
 * that application already carried the same status.
 *
 * Real status enum: draft, ready, submitted, follow_up, responded, closed ('draft' is never announced).
 */

export const APPLICATION_STATUSES = ['draft', 'ready', 'submitted', 'follow_up', 'responded', 'closed'] as const
export type ApplicationStatus = (typeof APPLICATION_STATUSES)[number]

export interface StatusDb {
  from(table: string): any
}

export interface Notifier {
  sendTelegram(message: string): Promise<{ ok: boolean; error?: string }>
}

const HEADLINE: Record<ApplicationStatus, string> = {
  draft: 'Draf',
  ready: 'Siap: formulir terisi, belum dikirim',
  submitted: 'Terkirim',
  follow_up: 'Waktunya follow-up',
  responded: 'Ada respons dari perusahaan',
  closed: 'Ditutup',
}

/** Telegram messages use parse_mode HTML (notifications.service.ts). */
export const escapeHtml = (s: unknown): string =>
  String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/**
 * U5-P1-02: Satu `TELEGRAM_CHAT_ID` operator berisiko mengumpulkan judul/perusahaan lamaran lintas pengguna.
 * Di produksi, metadata lamaran pada pesan Telegram disamarkan secara default kecuali `TELEGRAM_INCLUDE_JOB_METADATA=true`,
 * atau bisa dipaksa samarkan di lingkungan mana pun dengan `TELEGRAM_REDACT_JOB_METADATA=true`.
 * Kanal pribadi pengguna (WhatsApp/Email terautentik) tetap menerima judul dan perusahaan lengkap.
 */
export function shouldRedactTelegramMetadata(env: Record<string, string | undefined> = process.env): boolean {
  const forceRedact = (env.TELEGRAM_REDACT_JOB_METADATA ?? '').trim().toLowerCase()
  if (forceRedact === 'true' || forceRedact === '1') return true
  if (forceRedact === 'false' || forceRedact === '0') return false
  const include = (env.TELEGRAM_INCLUDE_JOB_METADATA ?? '').trim().toLowerCase()
  if (include === 'true' || include === '1') return false
  return (env.NODE_ENV ?? '').trim().toLowerCase() === 'production'
}

export function statusMessage(p: {
  status: ApplicationStatus
  title?: string | null
  company?: string | null
  followUpAt?: string | null
  /** True menyamarkan judul lowongan & nama perusahaan pada chat Telegram operator bersama (U5-P1-02). */
  redactMetadata?: boolean
}): string {
  const lines = [
    `📌 <b>Applify</b> status lamaran: <b>${escapeHtml(HEADLINE[p.status])}</b>`,
    p.redactMetadata
      ? 'Lowongan: [disamarkan — lihat halaman Lamaran di Applify]'
      : `Lowongan: ${escapeHtml(p.title ?? '?')} @ ${escapeHtml(p.company ?? '?')}`,
  ]
  if (p.status === 'submitted' && p.followUpAt) {
    lines.push(`Pengingat follow-up: ${escapeHtml(p.followUpAt.slice(0, 10))} (follow-up dikirim manual oleh kamu)`)
  }
  if (p.status === 'follow_up') {
    lines.push('Kirim follow-up sendiri ke perusahaan, lalu tandai di halaman Applications.')
  }
  return lines.join('\n')
}

export type NotifyOutcome =
  | { sent: true; status: ApplicationStatus }
  | { sent: false; reason: 'not_found' | 'draft' | 'duplicate' | 'send_failed' | 'unknown_status' | 'no_user_channels'; detail?: string }

export interface UserChannelDispatcher {
  dispatchUserNotification(
    db: StatusDb,
    args: {
      userId: string
      event: 'ready' | 'submitted' | 'follow_up'
      title: string
      plainMessage: string
      skipInApp?: boolean
    }
  ): Promise<{ deliveredChannels: string[] }>
}

function plainStatusText(p: { status: ApplicationStatus; title?: string | null; company?: string | null; followUpAt?: string | null }): string {
  const headline = HEADLINE[p.status]
  const job = [p.title, p.company].filter(Boolean).join(' — ')
  const extra =
    p.status === 'submitted' && p.followUpAt
      ? `Pengingat follow-up dijadwalkan ${new Date(p.followUpAt).toLocaleDateString('id-ID')}.`
      : p.status === 'ready'
        ? 'Cek halaman Persetujuan di Applify untuk meninjau formulir.'
        : p.status === 'follow_up'
          ? 'Saatnya mengirim follow-up atau memeriksa balasan HR.'
          : ''
  return [`Applify: ${headline}`, job ? `Lowongan: ${job}` : '', extra].filter(Boolean).join('\n')
}

export async function notifyApplicationStatus(
  db: StatusDb,
  notifier: Notifier,
  args: { userId: string; applicationId: string },
  opts?: { dispatcher?: UserChannelDispatcher; skipTelegram?: boolean }
): Promise<NotifyOutcome> {
  const { data: app } = await db
    .from('ai_applications')
    .select('id, user_id, job_id, status, follow_up_scheduled')
    .eq('id', args.applicationId)
    .eq('user_id', args.userId)
    .maybeSingle()
  if (!app) return { sent: false, reason: 'not_found' }
  if (!(APPLICATION_STATUSES as readonly string[]).includes(app.status)) {
    return { sent: false, reason: 'unknown_status', detail: String(app.status) }
  }
  const status = app.status as ApplicationStatus
  if (status === 'draft') return { sent: false, reason: 'draft' }

  // Same status as the last announcement for this application: nothing new to say.
  const { data: last } = await db
    .from('application_logs')
    .select('status')
    .eq('user_id', args.userId)
    .eq('action', 'status_notify')
    .contains('details', { application_id: app.id })
    .order('created_at', { ascending: false })
    .limit(1)
  if (last && last[0]?.status === status) return { sent: false, reason: 'duplicate' }

  const { data: job } = app.job_id
    ? await db.from('jobs').select('title, company').eq('id', app.job_id).maybeSingle()
    : { data: null }

  const htmlMsg = statusMessage({
    status,
    title: job?.title,
    company: job?.company,
    followUpAt: app.follow_up_scheduled,
    redactMetadata: shouldRedactTelegramMetadata(),
  })
  const res = opts?.skipTelegram ? { ok: false, error: 'skipped' } : await notifier.sendTelegram(htmlMsg)

  const plainBody = plainStatusText({
    status,
    title: job?.title,
    company: job?.company,
    followUpAt: app.follow_up_scheduled,
  })
  await createInAppNotification(db as any, {
    userId: args.userId,
    event: status,
    title: `Applify: ${HEADLINE[status]}`,
    body: plainBody,
    href: defaultHrefForEvent(status),
    metadata: { application_id: app.id, status },
  })

  let userChannels: string[] = []
  if (opts?.dispatcher && (status === 'ready' || status === 'submitted' || status === 'follow_up')) {
    const out = await opts.dispatcher
      .dispatchUserNotification(db, {
        userId: args.userId,
        event: status,
        title: `Applify: ${HEADLINE[status]}`,
        plainMessage: plainBody,
        skipInApp: true,
      })
      .catch(() => ({ deliveredChannels: [] }))
    userChannels = out.deliveredChannels
  }

  if (opts?.skipTelegram && userChannels.length === 0) {
    return { sent: false, reason: 'no_user_channels' }
  }
  if (!res.ok && userChannels.length === 0) {
    return { sent: false, reason: 'send_failed', detail: res.error }
  }

  await db.from('application_logs').insert({
    user_id: args.userId,
    action: 'status_notify',
    platform: userChannels[0] ?? 'telegram',
    job_id: app.job_id ? String(app.job_id) : null,
    job_title: job?.title ?? null,
    company: job?.company ?? null,
    status,
    details: { application_id: app.id, ...(userChannels.length > 0 ? { channels: userChannels } : {}) },
  })
  return { sent: true, status }
}
