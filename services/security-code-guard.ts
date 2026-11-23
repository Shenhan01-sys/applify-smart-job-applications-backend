/**
 * One-time security code for a job form (POST /api/agent/security-code).
 *
 * Some forms (Greenhouse) email a code to the applicant after Submit. The worker keeps the form open for up to
 * 10 minutes, writes an application_logs row (action 'apply', status 'awaiting_code', details.queue_job_id and
 * details.awaiting_until) and polls agent_security_codes. The user types the code in the web app. This file
 * checks that the agent really waits for it, encrypts the code (AES-256-GCM, same format as token-crypto.ts,
 * which the worker decrypts) and stores it. The worker claims the row, types the code and deletes the row.
 *
 * The code is a credential: it is never logged, never put in an error message, never returned, and never sent to
 * a model. The reply carries only `{ accepted: true }`. Every rule lives in pure functions (validateSecurityCodeInput,
 * decideAgentWaiting, decideCodeQuota) tested without a database, like rerun-guard.ts; submitSecurityCode only
 * fetches the facts and inserts.
 */
import { encrypt } from './token-crypto.js'
import type { GuardDb } from './queue-guard.js'

export const SECURITY_CODE_TABLE = 'agent_security_codes'

/** A user can type a wrong code twice and still have one try left; more than that is abuse. */
export const MAX_CODES_PER_JOB = 3
/** The worker waits at most 10 minutes; a stored code stays valid a little longer than that. */
export const CODE_TTL_MS = 15 * 60 * 1000

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const CODE_RE = /^[A-Za-z0-9]{4,12}$/

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value)
}

/**
 * Trim, drop spaces and dashes ("ab12 cd34" and "AB12-CD34" are how the emails print a code), then accept only
 * 4 to 12 letters or digits. Returns null for anything else. Case is kept: some forms are case sensitive.
 */
export function normaliseCode(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const cleaned = raw.trim().replace(/[\s-]/g, '')
  return CODE_RE.test(cleaned) ? cleaned : null
}

export type InputVerdict =
  | { ok: true; queueJobId: string; code: string }
  | { ok: false; status: 400; error: 'invalid_code' | 'invalid_job' }

/** Shape of the request body. The code is checked first, then the job id. */
export function validateSecurityCodeInput(body: unknown): InputVerdict {
  const obj = body && typeof body === 'object' ? (body as Record<string, unknown>) : {}
  const code = normaliseCode(obj.code)
  if (code === null) return { ok: false, status: 400, error: 'invalid_code' }
  if (!isUuid(obj.queue_job_id)) return { ok: false, status: 400, error: 'invalid_job' }
  return { ok: true, queueJobId: obj.queue_job_id, code }
}

export interface WaitingFacts {
  /** automation_queue row of this user, job_type 'apply', with the requested id; null when there is none. */
  queueJob: { status?: string | null } | null
  /** Newest application_logs row of this user for this queue job (details->>queue_job_id); null when none. */
  latestLog: { status?: string | null; details?: { awaiting_until?: unknown } | null } | null
  now: Date
}

export type Verdict =
  | { ok: true }
  | { ok: false; status: 404 | 409 | 429; error: string }

/** 404 unknown job, 409 when the agent does not wait for a code right now. */
export function decideAgentWaiting(facts: WaitingFacts): Verdict {
  const { queueJob, latestLog, now } = facts
  if (!queueJob) return { ok: false, status: 404, error: 'job_not_found' }

  const notWaiting: Verdict = { ok: false, status: 409, error: 'agent_not_waiting' }
  if (queueJob.status !== 'processing') return notWaiting
  if (!latestLog || latestLog.status !== 'awaiting_code') return notWaiting

  // A missing or unparsable deadline counts as passed, the same way approval expiry is read.
  const raw = latestLog.details?.awaiting_until
  const until = typeof raw === 'string' || typeof raw === 'number' ? new Date(raw).getTime() : NaN
  if (!Number.isFinite(until) || until <= now.getTime()) return notWaiting
  return { ok: true }
}

/** 429 when this job already has MAX_CODES_PER_JOB stored codes, whatever their state. */
export function decideCodeQuota(existingCount: number): Verdict {
  if (existingCount >= MAX_CODES_PER_JOB) return { ok: false, status: 429, error: 'too_many_codes' }
  return { ok: true }
}

/** The table is not there yet (migration not applied): Postgres 42P01 or PostgREST PGRST205. */
export function isMissingTable(err: { code?: string } | null | undefined): boolean {
  return err?.code === '42P01' || err?.code === 'PGRST205'
}

/**
 * A database or crypto failure. The message names only the stage: never the database message (a failing insert
 * echoes the row) and never the code.
 */
export class SecurityCodeStoreError extends Error {
  constructor(readonly stage: string, readonly dbCode?: string) {
    super(`security code ${stage} failed`)
    this.name = 'SecurityCodeStoreError'
  }
}

export class FeatureUnavailableError extends Error {
  constructor() {
    super('agent_security_codes table is not available')
    this.name = 'FeatureUnavailableError'
  }
}

export type SecurityCodeDb = GuardDb

export async function fetchWaitingFacts(
  db: SecurityCodeDb,
  userId: string,
  queueJobId: string,
  now: Date
): Promise<WaitingFacts> {
  const { data: queueJob, error: jobErr } = await db
    .from('automation_queue')
    .select('id, status')
    .eq('id', queueJobId)
    .eq('user_id', userId)
    .eq('job_type', 'apply')
    .maybeSingle()
  if (jobErr) throw new SecurityCodeStoreError('queue lookup', jobErr.code)
  if (!queueJob) return { queueJob: null, latestLog: null, now }

  const { data: logs, error: logErr } = await db
    .from('application_logs')
    .select('status, details, created_at')
    .eq('user_id', userId)
    .eq('details->>queue_job_id', queueJobId)
    .order('created_at', { ascending: false })
    .limit(1)
  if (logErr) throw new SecurityCodeStoreError('log lookup', logErr.code)
  return { queueJob, latestLog: logs?.[0] ?? null, now }
}

/** Stored codes of this queue job in any state (used, expired or open). */
export async function countStoredCodes(db: SecurityCodeDb, queueJobId: string): Promise<number> {
  const { count, error } = await db
    .from(SECURITY_CODE_TABLE)
    .select('id', { count: 'exact', head: true })
    .eq('queue_job_id', queueJobId)
  if (error) {
    if (isMissingTable(error)) throw new FeatureUnavailableError()
    throw new SecurityCodeStoreError('count', error.code)
  }
  return count ?? 0
}

export interface SecurityCodeReply {
  status: number
  body: Record<string, unknown>
  /** Safe text for the server log when the reply is a failure (stage and database code only). */
  logNote?: string
}

/**
 * Whole flow behind the route: input check, facts, decisions, encrypt, insert. First failure wins:
 * 401, 400 (code, then job id), 404, 409, 429, then 202. Database trouble answers 500 with a generic body, or
 * 503 when the table does not exist yet.
 */
export async function submitSecurityCode(
  db: SecurityCodeDb,
  userId: string | undefined | null,
  body: unknown,
  now: Date = new Date()
): Promise<SecurityCodeReply> {
  if (!userId) return { status: 401, body: { error: 'Unauthorized' } }

  const input = validateSecurityCodeInput(body)
  // `'error' in` narrows the union; tsconfig is not strict, so `!input.ok` would not.
  if ('error' in input) return { status: input.status, body: { error: input.error } }

  try {
    const waiting = decideAgentWaiting(await fetchWaitingFacts(db, userId, input.queueJobId, now))
    if ('error' in waiting) return { status: waiting.status, body: { error: waiting.error } }

    const quota = decideCodeQuota(await countStoredCodes(db, input.queueJobId))
    if ('error' in quota) return { status: quota.status, body: { error: quota.error } }

    let codeEncrypted: string
    try {
      codeEncrypted = encrypt(input.code)
    } catch {
      // Usually a missing OAUTH_TOKEN_ENCRYPTION_KEY. The original message is dropped on purpose.
      throw new SecurityCodeStoreError('encrypt')
    }

    const { error } = await db.from(SECURITY_CODE_TABLE).insert({
      user_id: userId,
      queue_job_id: input.queueJobId,
      code_encrypted: codeEncrypted,
      expires_at: new Date(now.getTime() + CODE_TTL_MS).toISOString(),
    })
    if (error) {
      if (isMissingTable(error)) throw new FeatureUnavailableError()
      throw new SecurityCodeStoreError('insert', error.code)
    }
    return { status: 202, body: { accepted: true } }
  } catch (err) {
    if (err instanceof FeatureUnavailableError) {
      return { status: 503, body: { error: 'feature_unavailable' }, logNote: 'agent_security_codes table is missing' }
    }
    const note =
      err instanceof SecurityCodeStoreError
        ? `${err.message}${err.dbCode ? ` (db code ${err.dbCode})` : ''}`
        : 'security code request failed unexpectedly'
    return { status: 500, body: { error: 'internal_error' }, logNote: note }
  }
}
