/**
 * "Saya sudah mengirimnya sendiri" (POST /api/approvals/:id/mark-sent).
 *
 * The agent often stops with the form filled but Submit untouched (submit_blocked 'not_allowed': the site is
 * not on the auto-send allowlist yet, or ALLOW_REAL_SUBMIT is off). Its browser session is gone by then, so
 * the user opens the posting, sends the application there and tells Applify that it is done. This module
 * records that, and only that: nothing is sent to any site or person.
 *
 * What a mark does:
 *   1. writes one application_logs row (action 'apply', status 'success', details.manual = true). Both the
 *      worker gate (worker/src/lib/approval.ts verifyApproval) and the rerun guard read a 'success' row of the
 *      approval as "already used", so the agent can never send the same application a second time;
 *   2. moves the user's ai_applications row to 'submitted' (forward only, like the worker and the extension),
 *      with submitted_at now and the follow-up reminder FOLLOW_UP_DAYS later.
 *
 * No approval_submit_claims row is written: its channel column only allows 'worker' and 'extension', and a
 * claim row of the agent means the agent may have sent the application, which is exactly what this mark must
 * refuse to overwrite (409 already_sent).
 *
 * Expiry is deliberately not checked: the user sent the application themselves, so consent for the agent no
 * longer matters. Every rule lives in decideMarkSent (pure, tested without a database); markApprovalSent only
 * fetches the facts and writes. The route adds the auth check and the user_id filter on every read.
 */
import { APPLICATION_STATUSES } from './application-status.service.js'
import { type GuardDb } from './queue-guard.js'

/** Days between submission and the follow-up reminder. Same number as the worker (FOLLOW_UP_DAYS) and the extension. */
export const FOLLOW_UP_DAYS = 4

export const MANUAL_SUBMIT_REASON = 'manual_submit'
export const MANUAL_SUBMIT_NOTE = 'ditandai terkirim oleh pengguna; dikirim sendiri di situs lowongan'

export interface MarkSentApproval {
  status?: string | null
  job_id?: string | null
  application_id?: string | null
  job_title?: string | null
  company?: string | null
  platform?: string | null
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
}

export type MarkSentCode = 'not_found' | 'not_approved' | 'no_job' | 'already_sent' | 'agent_working'

export type MarkSentVerdict =
  | { ok: true; alreadyMarked?: boolean }
  | { ok: false; status: 404 | 409 | 422; code: MarkSentCode; error: string }

/** First rule that fails wins, in the order of the HTTP statuses the route answers. */
export function decideMarkSent(facts: MarkSentFacts): MarkSentVerdict {
  const { approval, usedCount, manualCount, claimCount, activeCount } = facts
  if (!approval) return { ok: false, status: 404, code: 'not_found', error: 'Approval request not found' }
  if (approval.status !== 'approved') {
    return { ok: false, status: 409, code: 'not_approved', error: 'Approval is not approved' }
  }
  if (!approval.job_id) {
    return { ok: false, status: 422, code: 'no_job', error: 'Approval request has no job_id; cannot mark as sent' }
  }

  if (usedCount > 0 || claimCount > 0) {
    // Only earlier manual marks and no claim of the agent: the user (or a retry after a failed card update)
    // marks it again. That is harmless and idempotent: no second log row, the card update is repeated.
    if (claimCount === 0 && manualCount === usedCount) return { ok: true, alreadyMarked: true }
    return { ok: false, status: 409, code: 'already_sent', error: 'Application was already sent for this approval' }
  }
  if (activeCount > 0) {
    return { ok: false, status: 409, code: 'agent_working', error: 'Agent is already working on this application' }
  }
  return { ok: true }
}

export type MarkSentDb = GuardDb

/** Read the facts decideMarkSent needs. Throws on a database error (the route answers 500, fail closed). */
export async function fetchMarkSentFacts(db: MarkSentDb, userId: string, approvalId: string): Promise<MarkSentFacts> {
  const { data: approval, error: approvalErr } = await db
    .from('approval_requests')
    .select('id, user_id, job_id, application_id, job_title, company, platform, status')
    .eq('id', approvalId)
    .eq('user_id', userId)
    .maybeSingle()
  if (approvalErr) throw new Error(`approval lookup failed: ${approvalErr.message}`)
  if (!approval) return { approval: null, usedCount: 0, manualCount: 0, claimCount: 0, activeCount: 0 }

  // Same filter as the worker's one-approval-one-submission check.
  const { data: used, error: usedErr } = await db
    .from('application_logs')
    .select('id, details')
    .eq('user_id', userId)
    .in('status', ['success', 'submit_unverified'])
    .contains('details', { approval_request_id: approvalId })
  if (usedErr) throw new Error(`application log lookup failed: ${usedErr.message}`)
  const usedRows: Array<{ details?: { manual?: unknown } | null }> = used ?? []

  const { data: claims, error: claimsErr } = await db
    .from('approval_submit_claims')
    .select('approval_request_id')
    .eq('approval_request_id', approvalId)
    .eq('user_id', userId)
    .limit(1)
  if (claimsErr) throw new Error(`claim lookup failed: ${claimsErr.message}`)

  const { data: runs, error: runsErr } = await db
    .from('automation_queue')
    .select('id, status')
    .eq('user_id', userId)
    .eq('job_type', 'apply')
    .eq('payload->>approval_request_id', approvalId)
  if (runsErr) throw new Error(`queue lookup failed: ${runsErr.message}`)
  const runRows: Array<{ status?: string }> = runs ?? []

  return {
    approval,
    usedCount: usedRows.length,
    manualCount: usedRows.filter((r) => r.details?.manual === true).length,
    claimCount: (claims ?? []).length,
    activeCount: runRows.filter((r) => r.status === 'pending' || r.status === 'processing').length,
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

/**
 * Whole flow behind the route: facts, decision, log row, card update. Returns the HTTP status and body.
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
    const facts = await fetchMarkSentFacts(db, userId, approvalId)
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
          note: MANUAL_SUBMIT_NOTE,
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
