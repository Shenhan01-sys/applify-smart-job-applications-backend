/**
 * Guard for rows that clients put into automation_queue.
 *
 * Whoever calls the queue API controls the payload, so a client-sent `approved: true` must never count as
 * consent. A job that can send an application (job_type 'apply' with an approval, or 'email_apply') only
 * gets `approved: true` from the server, and only after it has read an approval_requests row of the same
 * user with status 'approved' that has not expired. The worker repeats the check before it sends anything
 * (worker/src/lib/approval.ts); this guard keeps forged payloads out of the queue in the first place.
 */

/** Minimal shape of the Supabase client used here (a fake is passed in tests). */
export interface GuardDb {
  from(table: string): any
}

export class ApprovalRequiredError extends Error {
  readonly statusCode = 403
  readonly code = 'approval_required'
  constructor(message: string) {
    super(message)
    this.name = 'ApprovalRequiredError'
  }
}

export interface ApprovedRow {
  id: string
  user_id: string
  job_id: string | null
  application_id: string | null
  status: string
  expires_at: string
}

/** Load an approval row and make sure it is a usable consent. Throws ApprovalRequiredError otherwise. */
export async function requireApprovedRow(
  db: GuardDb,
  userId: string,
  approvalId: unknown,
  now: Date = new Date()
): Promise<ApprovedRow> {
  if (typeof approvalId !== 'string' || !approvalId) {
    throw new ApprovalRequiredError('approval_request_id is required')
  }
  const { data: row, error } = await db
    .from('approval_requests')
    .select('id, user_id, job_id, application_id, status, expires_at')
    .eq('id', approvalId)
    .eq('user_id', userId)
    .maybeSingle()
  if (error) throw new Error(`approval lookup failed: ${error.message}`)
  if (!row) throw new ApprovalRequiredError('approval request not found')
  if (row.status !== 'approved') {
    throw new ApprovalRequiredError(`approval request is ${row.status}, not approved`)
  }
  const expires = row.expires_at ? new Date(row.expires_at).getTime() : NaN
  if (!Number.isFinite(expires) || expires <= now.getTime()) {
    throw new ApprovalRequiredError('approval request has expired')
  }
  return row as ApprovedRow
}

/**
 * Return the payload that may be stored for `jobType`, built from untrusted client input.
 * - `approved` from the client is always discarded.
 * - 'apply' with approval_request_id: verified; payload.job_id must match the approval (or is filled in);
 *   the server then sets approved: true.
 * - 'apply' without approval_request_id: allowed as a fill-only run (the worker never submits it).
 * - 'email_apply': approval_request_id is mandatory and verified.
 * - any other type: approval keys are dropped.
 */
export async function guardQueuePayload(
  db: GuardDb,
  userId: string,
  jobType: string,
  clientPayload: unknown,
  now: Date = new Date()
): Promise<Record<string, any>> {
  const payload: Record<string, any> =
    clientPayload && typeof clientPayload === 'object' && !Array.isArray(clientPayload)
      ? { ...(clientPayload as Record<string, any>) }
      : {}
  delete payload.approved

  const needsApproval = jobType === 'email_apply'
  const mayCarryApproval = jobType === 'apply' || needsApproval

  if (!mayCarryApproval) {
    delete payload.approval_request_id
    return payload
  }

  if (payload.approval_request_id == null && !needsApproval) {
    delete payload.approval_request_id
    return payload
  }

  const row = await requireApprovedRow(db, userId, payload.approval_request_id, now)
  if (payload.job_id && row.job_id && payload.job_id !== row.job_id) {
    throw new ApprovalRequiredError('approval request belongs to a different job')
  }
  if (row.job_id) payload.job_id = row.job_id
  if (row.application_id && !payload.application_id) payload.application_id = row.application_id
  payload.approved = true
  return payload
}
