/**
 * Guard for rows that clients put into automation_queue.
 *
 * Whoever calls the queue API controls the payload, so a client-sent `approved: true` must never count as
 * consent. A job that can send an application (job_type 'apply' with an approval, or 'email_apply') only
 * gets `approved: true` from the server, and only after it has read an approval_requests row of the same
 * user with status 'approved' that has not expired. The worker repeats the check before it sends anything
 * (worker/src/lib/approval.ts); this guard keeps forged payloads out of the queue in the first place.
 * The same guard checks the shape of the recipient address of an email_apply job (header injection).
 */
import { isValidApplyEmail } from './email-address.js'

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

/** Konflik kanal atau eksklusi mutual: persetujuan sedang aktif di antrean lain atau sudah diklaim. */
export class ApprovalChannelConflictError extends Error {
  readonly statusCode = 409
  readonly code = 'channel_conflict'
  constructor(message: string) {
    super(message)
    this.name = 'ApprovalChannelConflictError'
  }
}

/** GAP-10: pengiriman email tanpa CV harus dikonfirmasi eksplisit (`allow_without_cv: true`). */
export class MissingCvUnconfirmedError extends Error {
  readonly statusCode = 409
  readonly code = 'missing_cv_unconfirmed'
  constructor(message = 'CV belum tersedia pada persetujuan ini dan pengiriman tanpa CV belum dikonfirmasi.') {
    super(message)
    this.name = 'MissingCvUnconfirmedError'
  }
}

/** Batas per jam untuk satu platform sudah tercapai (HTTP 429): lamaran tidak dimasukkan ke antrean. */
export class PlatformLimitReachedError extends Error {
  readonly statusCode = 429
  readonly code = 'platform_limit_reached'
  readonly platform: string
  readonly resetAt: Date | null
  constructor(platform: string, resetAt: Date | null = null) {
    super(`Batas lamaran ke ${platform} sudah tercapai untuk saat ini. Coba lagi nanti atau lamar ke platform lain.`)
    this.name = 'PlatformLimitReachedError'
    this.platform = platform
    this.resetAt = resetAt
  }
}

/** The client sent a payload the queue will not accept (HTTP 400), as opposed to a missing consent (403). */
export class InvalidPayloadError extends Error {
  readonly statusCode = 400
  readonly code: string
  constructor(message: string, code = 'invalid_payload') {
    super(message)
    this.name = 'InvalidPayloadError'
    this.code = code
  }
}

/**
 * HTTP reply for an error the client caused (forged or stale approval: 403, channel conflict: 409,
 * malformed payload: 400), or null for anything else (the caller then answers 500).
 */
export function clientErrorReply(error: unknown): { statusCode: number; body: { error: string; code: string } } | null {
  if (
    error instanceof ApprovalRequiredError ||
    error instanceof ApprovalChannelConflictError ||
    error instanceof MissingCvUnconfirmedError ||
    error instanceof InvalidPayloadError ||
    error instanceof PlatformLimitReachedError
  ) {
    return { statusCode: error.statusCode, body: { error: error.message, code: error.code } }
  }
  return null
}

export interface ApprovedRow {
  id: string
  user_id: string
  job_id: string | null
  application_id: string | null
  status: string
  expires_at: string
  apply_channel?: string | null
  resume_url?: string | null
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
  let res = await db
    .from('approval_requests')
    .select('id, user_id, job_id, application_id, status, expires_at, apply_channel, resume_url')
    .eq('id', approvalId)
    .eq('user_id', userId)
    .maybeSingle()
  if (res.error && (res.error.code === '42703' || res.error.code === 'PGRST204' || /apply_channel|resume_url/i.test(String(res.error.message ?? '')))) {
    res = await db
      .from('approval_requests')
      .select('id, user_id, job_id, application_id, status, expires_at')
      .eq('id', approvalId)
      .eq('user_id', userId)
      .maybeSingle()
  }
  const { data: row, error } = res
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
 * - 'email_apply': approval_request_id is mandatory and verified, and apply_email must be exactly one plain
 *   address (isValidApplyEmail: no CR/LF or other control characters, no list, no display name; at most 254
 *   characters), else InvalidPayloadError (400). The value is stored as sent; it is never trimmed or repaired.
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
  // The worker writes this string into the To: header, so a malformed value is refused before it is queued.
  if (needsApproval && !isValidApplyEmail(payload.apply_email)) {
    throw new InvalidPayloadError(
      'apply_email must be exactly one plain email address (max 254 characters; no spaces, line breaks, ' +
        'commas, semicolons, angle brackets or display name)',
      'invalid_apply_email'
    )
  }
  // GAP-10: tolak cepat email_apply tanpa CV kecuali klien menyertakan allow_without_cv === true secara eksplisit.
  if (needsApproval) {
    const hasCv = typeof row.resume_url === 'string' && row.resume_url.trim().length > 0
    const allowWithoutCv = payload.allow_without_cv === true
    if (!allowWithoutCv) delete payload.allow_without_cv
    if (!hasCv && !allowWithoutCv) {
      throw new MissingCvUnconfirmedError()
    }
  }
  if (row.job_id) payload.job_id = row.job_id
  if (row.application_id && !payload.application_id) payload.application_id = row.application_id
  payload.approved = true
  return payload
}
