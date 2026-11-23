/**
 * Rerun of an approved application (POST /api/approvals/:id/rerun).
 *
 * The worker stops without sending when a form has required questions the profile cannot answer. The user
 * answers them in the app and asks the agent to try again. A rerun queues the SAME approved apply job once
 * more, so the worker needs no new approval. Consent still has to be live and unused, and a user cannot
 * flood the queue, so every rule lives in decideRerun (pure, tested without a database) and the route only
 * fetches the facts (fetchRerunFacts) and enqueues.
 *
 * The worker repeats its own checks before it sends anything (worker/src/lib/approval.ts verifyApproval),
 * so this guard only keeps useless or abusive jobs out of the queue.
 */
import { clientErrorReply, type GuardDb } from './queue-guard.js'

/** One original run plus five reruns. */
export const MAX_RUNS_PER_APPROVAL = 6

export interface RerunApproval {
  status?: string | null
  expires_at?: string | null
  job_id?: string | null
}

export interface RerunFacts {
  /** The approval row of this user, or null when there is none. */
  approval: RerunApproval | null
  now: Date
  /** application_logs rows of this approval with status success or submit_unverified. */
  usedCount: number
  /** automation_queue apply rows of this approval that are pending or processing. */
  activeCount: number
  /** automation_queue apply rows of this approval in any status (original run and earlier reruns). */
  totalCount: number
}

export type RerunVerdict =
  | { ok: true }
  | { ok: false; status: 404 | 409 | 410 | 422 | 429; error: string }

/** First rule that fails wins, in the order of the HTTP statuses the route answers. */
export function decideRerun(facts: RerunFacts): RerunVerdict {
  const { approval, now, usedCount, activeCount, totalCount } = facts
  if (!approval) return { ok: false, status: 404, error: 'Approval request not found' }
  if (approval.status !== 'approved') return { ok: false, status: 409, error: 'Approval is not approved' }

  // Same rule as the worker: a missing or unparsable expiry counts as expired. The row is left as it is.
  const expires = approval.expires_at ? new Date(approval.expires_at).getTime() : NaN
  if (!Number.isFinite(expires) || expires <= now.getTime()) {
    return { ok: false, status: 410, error: 'Approval request has expired' }
  }

  if (!approval.job_id) {
    return { ok: false, status: 422, error: 'Approval request has no job_id; cannot queue submission' }
  }
  if (usedCount > 0) {
    return { ok: false, status: 409, error: 'Application was already sent for this approval' }
  }
  if (activeCount > 0) {
    return { ok: false, status: 409, error: 'Agent is already working on this application' }
  }
  if (totalCount >= MAX_RUNS_PER_APPROVAL) {
    return { ok: false, status: 429, error: 'Too many reruns for this approval' }
  }
  return { ok: true }
}

export type RerunDb = GuardDb

/** Read the facts decideRerun needs. Throws on a database error (the route answers 500). */
export async function fetchRerunFacts(
  db: RerunDb,
  userId: string,
  approvalId: string,
  now: Date = new Date()
): Promise<RerunFacts> {
  const { data: approval, error: approvalErr } = await db
    .from('approval_requests')
    .select('id, user_id, job_id, status, expires_at')
    .eq('id', approvalId)
    .eq('user_id', userId)
    .maybeSingle()
  if (approvalErr) throw new Error(`approval lookup failed: ${approvalErr.message}`)
  if (!approval) return { approval: null, now, usedCount: 0, activeCount: 0, totalCount: 0 }

  // Same filter as the worker's one-approval-one-submission check.
  const { data: used, error: usedErr } = await db
    .from('application_logs')
    .select('id')
    .eq('user_id', userId)
    .in('status', ['success', 'submit_unverified'])
    .contains('details', { approval_request_id: approvalId })
    .limit(1)
  if (usedErr) throw new Error(`application log lookup failed: ${usedErr.message}`)

  const { data: runs, error: runsErr } = await db
    .from('automation_queue')
    .select('id, status')
    .eq('user_id', userId)
    .eq('job_type', 'apply')
    .eq('payload->>approval_request_id', approvalId)
  if (runsErr) throw new Error(`queue lookup failed: ${runsErr.message}`)
  const rows: Array<{ status?: string }> = runs ?? []

  return {
    approval,
    now,
    usedCount: used?.length ?? 0,
    activeCount: rows.filter((r) => r.status === 'pending' || r.status === 'processing').length,
    totalCount: rows.length,
  }
}

export interface RerunQueue {
  addApprovedApplyJob(userId: string, approvalId: string): Promise<{ id: string }>
}

export interface RerunReply {
  status: number
  body: Record<string, unknown>
}

/** Whole rerun flow behind the route: facts, decision, enqueue. Returns the HTTP status and body to send. */
export async function rerunApproval(
  db: RerunDb,
  queue: RerunQueue,
  userId: string,
  approvalId: string,
  now: Date = new Date()
): Promise<RerunReply> {
  try {
    const verdict = decideRerun(await fetchRerunFacts(db, userId, approvalId, now))
    if ('error' in verdict) return { status: verdict.status, body: { error: verdict.error } }

    // addApprovedApplyJob re-reads the approval and writes `approved: true` itself, from the database.
    const queued = await queue.addApprovedApplyJob(userId, approvalId)
    return { status: 200, body: { success: true, queue_job_id: queued.id } }
  } catch (err: any) {
    // Consent that lapsed between the checks above and the enqueue is a client-side condition (403).
    const client = clientErrorReply(err)
    if (client) return { status: client.statusCode, body: client.body }
    return { status: 500, body: { error: `Failed to queue rerun: ${err?.message ?? 'unknown error'}` } }
  }
}
