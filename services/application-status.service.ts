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

export function statusMessage(p: {
  status: ApplicationStatus
  title?: string | null
  company?: string | null
  followUpAt?: string | null
}): string {
  const lines = [
    `📌 <b>Applify</b> status lamaran: <b>${escapeHtml(HEADLINE[p.status])}</b>`,
    `Lowongan: ${escapeHtml(p.title ?? '?')} @ ${escapeHtml(p.company ?? '?')}`,
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
  | { sent: false; reason: 'not_found' | 'draft' | 'duplicate' | 'send_failed' | 'unknown_status'; detail?: string }

export interface UserChannelDispatcher {
  dispatchUserNotification(
    db: StatusDb,
    args: {
      userId: string
      event: 'ready' | 'submitted' | 'follow_up'
      title: string
      plainMessage: string
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
  opts?: { dispatcher?: UserChannelDispatcher }
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

  const htmlMsg = statusMessage({ status, title: job?.title, company: job?.company, followUpAt: app.follow_up_scheduled })
  const res = await notifier.sendTelegram(htmlMsg)

  let userChannels: string[] = []
  if (opts?.dispatcher && (status === 'ready' || status === 'submitted' || status === 'follow_up')) {
    const out = await opts.dispatcher
      .dispatchUserNotification(db, {
        userId: args.userId,
        event: status,
        title: `Applify: ${HEADLINE[status]}`,
        plainMessage: plainStatusText({ status, title: job?.title, company: job?.company, followUpAt: app.follow_up_scheduled }),
      })
      .catch(() => ({ deliveredChannels: [] }))
    userChannels = out.deliveredChannels
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
