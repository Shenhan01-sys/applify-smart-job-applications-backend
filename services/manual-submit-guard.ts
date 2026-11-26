/**
 * Jalur resmi untuk hasil kirim yang tidak pasti. Pengguna memeriksa email atau portal lowongan sendiri, lalu
 * memilih satu dari tiga tindakan (keputusan Hans, 26 November 2026: tidak boleh ada status buntu):
 *
 *   1. "Sudah terkirim"            POST /api/approvals/:id/mark-sent  -> markApprovalSent
 *   2. "Belum terkirim, ulangi"    POST /api/approvals/:id/not-sent   -> reportNotSent
 *   3. "Tutup"                     POST /api/approvals/:id/close      -> closeApproval
 *
 * Browser tidak menulis ke approval_requests, application_logs, atau ai_applications (RLS). Semua tulisan ada di sini,
 * lewat endpoint yang hanya menerima pemilik: setiap bacaan dan tulisan difilter user_id dari token, dan id yang bukan
 * milik pengguna dijawab 404. Tidak ada yang dikirim ke situs atau orang mana pun.
 *
 * 1. "Sudah terkirim". Tulis satu baris application_logs (action 'apply', status 'success', details.manual = true,
 *    details.confirmed_by = 'user', details.confirmed_from = keadaan sebelumnya) dan pindahkan baris ai_applications
 *    pengguna ke 'submitted' (hanya maju). Log itu dibaca gerbang worker (worker/src/lib/approval.ts verifyApproval)
 *    dan penjaga rerun sebagai "persetujuan sudah dipakai", jadi agen tidak pernah mengirim ulang. confirmed_by 'user'
 *    membedakannya dari konfirmasi sistem (halaman konfirmasi yang dikenali agen), supaya data skripsi tetap jujur.
 *    Keadaan yang boleh dikonfirmasi: belum ada log, kirim belum terkonfirmasi (submit_unverified), kode keamanan tidak
 *    masuk (ready + code_timeout), klaim macet, dan persetujuan kedaluwarsa tanpa tugas agen. Yang ditolak: agen sudah
 *    mencatat success sendiri (409 already_sent), agen atau ekstensi masih bekerja (409 agent_working), dan persetujuan
 *    yang sudah diganti persetujuan baru (409 already_resolved).
 *
 * 2. "Belum terkirim, ulangi". Buat satu persetujuan baru (pending, 24 jam) untuk lowongan yang sama dengan id turunan
 *    dari id lama (dua permintaan paralel tidak bisa membuat dua), lalu tulis log 'incomplete' dengan reason
 *    'user_not_sent'. Persetujuan lama pindah ke Riwayat sebagai "Diganti persetujuan baru". Agen baru jalan setelah
 *    pengguna menyetujui yang baru, jadi tidak ada kirim ganda yang tidak disengaja.
 *
 * 3. "Tutup". Tulis log 'incomplete' dengan reason 'user_closed'. Persetujuan pindah ke Riwayat sebagai "Ditutup".
 *    Kartu lamaran tidak diubah.
 *
 * Kedaluwarsa sengaja tidak diperiksa: persetujuan yang masa berlakunya habis justru kasus utama. Setiap aturan ada di
 * fungsi murni (decideMarkSent, decideResolve) yang dites tanpa database; fungsi alur hanya membaca fakta dan menulis.
 *
 * Tidak ada baris approval_submit_claims yang ditulis: kolom channel-nya hanya mengizinkan 'worker' dan 'extension'.
 */
import { APPLICATION_STATUSES } from './application-status.service.js'
import { type GuardDb } from './queue-guard.js'
import {
  APPROVAL_TTL_MS,
  CONFIRMED_BY_USER,
  EXTENSION_CLAIM_STALE_MS,
  RESOLVED_UNSENT_REASONS,
  USER_CLOSED_REASON,
  USER_NOT_SENT_REASON,
  freshApprovalId,
} from './approval-shared.js'

/** Days between submission and the follow-up reminder. Same number as the worker (FOLLOW_UP_DAYS) and the extension. */
export const FOLLOW_UP_DAYS = 4

export const MANUAL_SUBMIT_REASON = 'manual_submit'
export const MANUAL_SUBMIT_NOTE = 'ditandai terkirim oleh pengguna; dikirim sendiri di situs lowongan'
/** Dipakai bila sebelumnya ada percobaan agen yang hasilnya tidak pasti: pengguna memeriksa, bukan mengirim sendiri. */
export const USER_CONFIRMED_NOTE = 'dikonfirmasi pengguna setelah memeriksa email atau portal; bukan konfirmasi sistem'

export interface MarkSentApproval {
  status?: string | null
  job_id?: string | null
  application_id?: string | null
  job_title?: string | null
  company?: string | null
  platform?: string | null
  cover_letter?: string | null
  answers?: unknown
  resume_url?: string | null
}

export interface MarkSentFacts {
  /** The approval row of this user, or null when there is none. */
  approval: MarkSentApproval | null
  /** application_logs rows of this approval with status success or submit_unverified. */
  usedCount: number
  /** Of those, the rows written by an earlier manual mark (details.manual === true). */
  manualCount: number
  /** approval_submit_claims rows of this approval: the agent (worker or extension) may have sent it. */
  claimCount: number
  /** automation_queue apply rows of this approval that are pending or processing. */
  activeCount: number
  /** Of usedCount, the rows with status submit_unverified (agent pressed Submit, no confirmation page). Default 0. */
  unverifiedCount?: number
  /** An extension claim younger than EXTENSION_CLAIM_STALE_MS: the extension may still be sending. Default false. */
  claimInProgress?: boolean
  /** Log 'incomplete' rows saying the user asked for a new approval (user_not_sent, abandoned_locked_claim). Default 0. */
  replacedCount?: number
  /** Log 'incomplete' rows saying the user closed this approval (user_closed). Default 0. */
  closedCount?: number
}

export type MarkSentCode = 'not_found' | 'not_approved' | 'no_job' | 'already_sent' | 'agent_working' | 'already_resolved'

export type MarkSentVerdict =
  | { ok: true; alreadyMarked?: boolean }
  | { ok: false; status: 404 | 409 | 422; code: MarkSentCode; error: string }

const fail = (status: 404 | 409 | 422, code: MarkSentCode, error: string): MarkSentVerdict => ({ ok: false, status, code, error })

/** Rules shared by the three resolutions: the row exists, belongs to the user, is approved, and the agent is not at work. */
function baseVerdict(facts: MarkSentFacts, needsJob: boolean): MarkSentVerdict | null {
  const { approval } = facts
  if (!approval) return fail(404, 'not_found', 'Approval request not found')
  if (approval.status !== 'approved') return fail(409, 'not_approved', 'Approval is not approved')
  if (needsJob && !approval.job_id) return fail(422, 'no_job', 'Approval request has no job_id; cannot resolve it')
  return null
}

/** Sent rows the agent or email wrote itself: success rows that are neither manual nor user confirmed. */
const agentSentCount = (f: MarkSentFacts) => Math.max(0, f.usedCount - f.manualCount - (f.unverifiedCount ?? 0))

/** First rule that fails wins, in the order of the HTTP statuses the route answers. */
export function decideMarkSent(facts: MarkSentFacts): MarkSentVerdict {
  const base = baseVerdict(facts, true)
  if (base) return base
  const { usedCount, manualCount, claimCount, activeCount } = facts

  if (usedCount > 0 || claimCount > 0) {
    // The agent or email recorded a success itself: the system already knows, nothing for the user to confirm.
    if (agentSentCount(facts) > 0) return fail(409, 'already_sent', 'Application was already sent for this approval')
    // An earlier confirmation of the user: harmless and idempotent (no second log row, the card update is repeated).
    if (manualCount > 0) return { ok: true, alreadyMarked: true }
    // Only submit_unverified rows and/or a claim left: the outcome is uncertain, and the user is the one who checked.
    // An extension claim that is still fresh means the extension may be sending right now.
    if (facts.claimInProgress) return fail(409, 'agent_working', 'Agent is already working on this application')
    if (claimCount > 0 && usedCount === 0 && facts.claimInProgress === undefined) {
      // Facts built without the claim age (older callers): refuse, as before.
      return fail(409, 'already_sent', 'Application was already sent for this approval')
    }
  }
  if (activeCount > 0) return fail(409, 'agent_working', 'Agent is already working on this application')
  // A new approval already replaced this one: confirming now would risk a second send by the new approval.
  if ((facts.replacedCount ?? 0) > 0) return fail(409, 'already_resolved', 'Approval was already replaced by a new approval')
  return { ok: true }
}

export type ResolveKind = 'not_sent' | 'close'

/** Rules for "Belum terkirim, ulangi" and "Tutup": like confirming, but a manual mark or an earlier resolution blocks. */
export function decideResolve(facts: MarkSentFacts, kind: ResolveKind): MarkSentVerdict {
  const base = baseVerdict(facts, kind === 'not_sent')
  if (base) return base
  if (agentSentCount(facts) > 0 || facts.manualCount > 0) {
    return fail(409, 'already_sent', 'Application was already sent for this approval')
  }
  if (facts.activeCount > 0 || facts.claimInProgress) return fail(409, 'agent_working', 'Agent is already working on this application')
  if ((facts.replacedCount ?? 0) > 0 || (facts.closedCount ?? 0) > 0) {
    return fail(409, 'already_resolved', 'Approval was already closed or replaced')
  }
  return { ok: true }
}

export type MarkSentDb = GuardDb

/** Read the facts the decisions need. Throws on a database error (the route answers 500, fail closed). */
export async function fetchMarkSentFacts(
  db: MarkSentDb,
  userId: string,
  approvalId: string,
  now: Date = new Date()
): Promise<MarkSentFacts> {
  const { data: approval, error: approvalErr } = await db
    .from('approval_requests')
    .select('id, user_id, job_id, application_id, job_title, company, platform, status, cover_letter, answers, resume_url')
    .eq('id', approvalId)
    .eq('user_id', userId)
    .maybeSingle()
  if (approvalErr) throw new Error(`approval lookup failed: ${approvalErr.message}`)
  if (!approval) return { approval: null, usedCount: 0, manualCount: 0, claimCount: 0, activeCount: 0 }

  // Same filter as the worker's one-approval-one-submission check.
  const { data: used, error: usedErr } = await db
    .from('application_logs')
    .select('id, status, details')
    .eq('user_id', userId)
    .in('status', ['success', 'submit_unverified'])
    .contains('details', { approval_request_id: approvalId })
  if (usedErr) throw new Error(`application log lookup failed: ${usedErr.message}`)
  const usedRows: Array<{ status?: string; details?: { manual?: unknown } | null }> = used ?? []

  // Earlier resolutions of the user (new approval asked, or closed). They are 'incomplete' rows, not "used" rows.
  const { data: resolved, error: resolvedErr } = await db
    .from('application_logs')
    .select('id, details')
    .eq('user_id', userId)
    .eq('status', 'incomplete')
    .contains('details', { approval_request_id: approvalId })
  if (resolvedErr) throw new Error(`resolution lookup failed: ${resolvedErr.message}`)
  const resolvedRows: Array<{ details?: { reason?: unknown } | null }> = resolved ?? []
  const reasonOf = (r: { details?: { reason?: unknown } | null }) => (typeof r.details?.reason === 'string' ? r.details.reason : '')

  const { data: claims, error: claimsErr } = await db
    .from('approval_submit_claims')
    .select('approval_request_id, channel, created_at')
    .eq('approval_request_id', approvalId)
    .eq('user_id', userId)
    .limit(1)
  if (claimsErr) throw new Error(`claim lookup failed: ${claimsErr.message}`)
  const claimRows: Array<{ channel?: string; created_at?: string }> = claims ?? []

  const { data: runs, error: runsErr } = await db
    .from('automation_queue')
    .select('id, status')
    .eq('user_id', userId)
    .in('job_type', ['apply', 'extension_apply'])
    .eq('payload->>approval_request_id', approvalId)
  if (runsErr) throw new Error(`queue lookup failed: ${runsErr.message}`)
  const runRows: Array<{ status?: string }> = runs ?? []

  // Same staleness rule as getClaimStatuses (approval-claim-recovery.ts): a worker claim is judged by the queue
  // (activeCount), an extension claim by its age.
  const claimInProgress = claimRows.some((c) => {
    if (c.channel !== 'extension') return false
    const claimedMs = c.created_at ? new Date(c.created_at).getTime() : 0
    return Number.isFinite(claimedMs) && now.getTime() - claimedMs < EXTENSION_CLAIM_STALE_MS
  })

  return {
    approval,
    usedCount: usedRows.length,
    manualCount: usedRows.filter((r) => r.details?.manual === true).length,
    unverifiedCount: usedRows.filter((r) => r.status === 'submit_unverified' && r.details?.manual !== true).length,
    claimCount: claimRows.length,
    claimInProgress,
    activeCount: runRows.filter((r) => r.status === 'pending' || r.status === 'processing').length,
    replacedCount: resolvedRows.filter((r) => RESOLVED_UNSENT_REASONS.has(reasonOf(r)) && reasonOf(r) !== USER_CLOSED_REASON).length,
    closedCount: resolvedRows.filter((r) => reasonOf(r) === USER_CLOSED_REASON).length,
  }
}

export interface MarkSentReply {
  status: number
  body: Record<string, unknown>
}

const RANK: Record<string, number> = Object.fromEntries(APPLICATION_STATUSES.map((s, i) => [s, i]))
const SUBMITTED_RANK = RANK.submitted

/**
 * Move the approval's ai_applications row to 'submitted' (forward only). The row is the approval's
 * application_id, or the newest application of the user for the job when the approval has none.
 * Returns the id of the row that changed, or null when there was nothing to change.
 */
async function markApplicationSubmitted(
  db: MarkSentDb,
  userId: string,
  approval: MarkSentApproval,
  now: Date
): Promise<string | null> {
  let sel = db.from('ai_applications').select('id, status, follow_up_scheduled').eq('user_id', userId)
  sel = approval.application_id
    ? sel.eq('id', approval.application_id)
    : sel.eq('job_id', approval.job_id).order('created_at', { ascending: false }).limit(1)
  const { data: rows, error } = await sel
  if (error) throw new Error(`application lookup failed: ${error.message}`)
  const row = (rows ?? [])[0]
  if (!row) return null

  // Already submitted or further along (for example dragged to "Terkirim" on the board): nothing to change.
  if ((RANK[row.status] ?? -1) >= SUBMITTED_RANK) return null

  const followUp = row.follow_up_scheduled ?? new Date(now.getTime() + FOLLOW_UP_DAYS * 24 * 60 * 60 * 1000).toISOString()
  const { data: updated, error: upErr } = await db
    .from('ai_applications')
    .update({
      status: 'submitted',
      submitted_at: now.toISOString(),
      follow_up_scheduled: followUp,
      follow_up_sent: false,
      updated_at: now.toISOString(),
    })
    .eq('id', row.id)
    .eq('user_id', userId)
    // Guarded on the status we read, so a concurrent change is not overwritten.
    .eq('status', row.status)
    .select('id')
  if (upErr) throw new Error(`application update failed: ${upErr.message}`)
  return updated && updated.length > 0 ? String(row.id) : null
}

/** Keadaan sebelum pengguna mengonfirmasi, untuk log (`details.confirmed_from`). */
function priorOutcomeOf(facts: MarkSentFacts): 'submit_unverified' | 'claim_unconfirmed' | 'no_agent_confirmation' {
  if ((facts.unverifiedCount ?? 0) > 0) return 'submit_unverified'
  if (facts.claimCount > 0) return 'claim_unconfirmed'
  return 'no_agent_confirmation'
}

/**
 * "Sudah terkirim": facts, decision, log row, card update. Returns the HTTP status and body.
 * `announce` (optional, best effort) is called with the application id after the card moved, so the route can
 * send the same status notice as the other paths. A failing announcement never changes the answer.
 */
export async function markApprovalSent(
  db: MarkSentDb,
  userId: string,
  approvalId: string,
  now: Date = new Date(),
  announce?: (applicationId: string) => Promise<unknown>
): Promise<MarkSentReply> {
  try {
    const facts = await fetchMarkSentFacts(db, userId, approvalId, now)
    const verdict = decideMarkSent(facts)
    if ('error' in verdict) return { status: verdict.status, body: { error: verdict.error, code: verdict.code } }
    const approval = facts.approval as MarkSentApproval

    if (!('alreadyMarked' in verdict && verdict.alreadyMarked)) {
      const { data: job, error: jobErr } = await db
        .from('jobs')
        .select('id, title, company, platform_source')
        .eq('id', approval.job_id)
        .maybeSingle()
      if (jobErr) throw new Error(`job lookup failed: ${jobErr.message}`)

      const prior = priorOutcomeOf(facts)
      // The log row is the "this approval is used" marker: it is written first, so a failure after it can only
      // leave the card behind (a retry repeats the card update), never allow a second send.
      const { error: logErr } = await db.from('application_logs').insert({
        user_id: userId,
        action: 'apply',
        platform: job?.platform_source ?? approval.platform ?? 'web',
        job_id: String(approval.job_id),
        job_title: job?.title ?? approval.job_title ?? null,
        company: job?.company ?? approval.company ?? null,
        status: 'success',
        details: {
          approval_request_id: approvalId,
          manual: true,
          reason: MANUAL_SUBMIT_REASON,
          note: prior === 'no_agent_confirmation' ? MANUAL_SUBMIT_NOTE : USER_CONFIRMED_NOTE,
          // Konfirmasi pengguna, bukan konfirmasi sistem: data skripsi membedakannya dari success yang dicatat agen.
          confirmed_by: CONFIRMED_BY_USER,
          confirmed_from: prior,
        },
      })
      if (logErr) throw new Error(`log insert failed: ${logErr.message}`)
    }

    const changed = await markApplicationSubmitted(db, userId, approval, now)
    if (changed && announce) {
      try {
        await announce(changed)
      } catch {
        // Best effort: the mark itself is done.
      }
    }

    return {
      status: 200,
      body: 'alreadyMarked' in verdict && verdict.alreadyMarked ? { success: true, already_marked: true } : { success: true },
    }
  } catch (err: any) {
    // The database message goes to the server log only, never to the client.
    console.error('[mark-sent] failed to mark as sent:', String(err?.message ?? err))
    return { status: 500, body: { error: 'Failed to mark as sent', code: 'mark_failed' } }
  }
}

/** Log 'incomplete' that records what the user decided; read back by getClaimStatuses so the card moves to Riwayat. */
async function writeResolutionLog(
  db: MarkSentDb,
  userId: string,
  approvalId: string,
  approval: MarkSentApproval,
  reason: string,
  extra: Record<string, unknown>
): Promise<void> {
  const { error } = await db.from('application_logs').insert({
    user_id: userId,
    action: 'apply',
    platform: String(approval.platform ?? 'web'),
    job_id: approval.job_id ?? null,
    job_title: approval.job_title ?? null,
    company: approval.company ?? null,
    status: 'incomplete',
    details: { approval_request_id: approvalId, reason, resolved_by: CONFIRMED_BY_USER, ...extra },
  })
  if (error) throw new Error(`resolution log insert failed: ${error.message}`)
}

/**
 * "Belum terkirim, ulangi": a new pending approval for the same job, then a log that moves the old one to Riwayat.
 * The new approval is written first. When the log then fails, the old approval stays where it is and a retry finds
 * the new approval already there (same derived id) and only writes the log.
 */
export async function reportNotSent(
  db: MarkSentDb,
  userId: string,
  approvalId: string,
  now: Date = new Date()
): Promise<MarkSentReply> {
  try {
    const facts = await fetchMarkSentFacts(db, userId, approvalId, now)
    const verdict = decideResolve(facts, 'not_sent')
    if ('error' in verdict) return { status: verdict.status, body: { error: verdict.error, code: verdict.code } }
    const approval = facts.approval as MarkSentApproval

    const newId = freshApprovalId(approvalId)
    const { error: insErr } = await db
      .from('approval_requests')
      .insert({
        id: newId,
        user_id: userId,
        job_id: approval.job_id,
        application_id: approval.application_id ?? null,
        job_title: approval.job_title ?? null,
        company: approval.company ?? null,
        platform: approval.platform ?? null,
        cover_letter: approval.cover_letter ?? null,
        answers: Array.isArray(approval.answers) ? approval.answers : [],
        resume_url: approval.resume_url ?? null,
        status: 'pending',
        expires_at: new Date(now.getTime() + APPROVAL_TTL_MS).toISOString(),
      })
      .select('id')
    if (insErr) {
      if (insErr.code !== '23505') throw new Error(`fresh approval insert failed: ${insErr.message}`)
      // The derived id is taken (an earlier try got that far) or another pending approval of this job exists.
      const { data: existing, error: existErr } = await db
        .from('approval_requests')
        .select('id')
        .eq('id', newId)
        .eq('user_id', userId)
        .maybeSingle()
      if (existErr) throw new Error(`fresh approval lookup failed: ${existErr.message}`)
      if (!existing) {
        return {
          status: 409,
          body: { error: 'There is already a pending approval for this job', code: 'pending_exists' },
        }
      }
    }

    await writeResolutionLog(db, userId, approvalId, approval, USER_NOT_SENT_REASON, {
      fresh_approval_id: newId,
      previous_outcome: priorOutcomeOf(facts),
    })
    return { status: 200, body: { success: true, new_approval_id: newId } }
  } catch (err: any) {
    console.error('[not-sent] failed to create a new approval:', String(err?.message ?? err))
    return { status: 500, body: { error: 'Failed to create a new approval', code: 'not_sent_failed' } }
  }
}

/** "Tutup": one log row. The application card is left as it is. Idempotent answers come as 409 already_resolved. */
export async function closeApproval(db: MarkSentDb, userId: string, approvalId: string, now: Date = new Date()): Promise<MarkSentReply> {
  try {
    const facts = await fetchMarkSentFacts(db, userId, approvalId, now)
    const verdict = decideResolve(facts, 'close')
    if ('error' in verdict) return { status: verdict.status, body: { error: verdict.error, code: verdict.code } }
    await writeResolutionLog(db, userId, approvalId, facts.approval as MarkSentApproval, USER_CLOSED_REASON, {
      previous_outcome: priorOutcomeOf(facts),
    })
    return { status: 200, body: { success: true } }
  } catch (err: any) {
    console.error('[close] failed to close the approval:', String(err?.message ?? err))
    return { status: 500, body: { error: 'Failed to close the approval', code: 'close_failed' } }
  }
}
