import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import { FakeDb } from './helpers/fakeDb.ts'
import { decrypt } from '../services/token-crypto.ts'
import {
  CODE_TTL_MS,
  MAX_CODES_PER_JOB,
  decideAgentWaiting,
  decideCodeQuota,
  isMissingTable,
  isUuid,
  normaliseCode,
  submitSecurityCode,
  validateSecurityCodeInput,
  type WaitingFacts,
} from '../services/security-code-guard.ts'
import { agentCodeRoutes } from '../api/routes/agent-code.ts'

/**
 * POST /api/agent/security-code: every rule is a pure function (tested without a database), the flow around
 * them runs against a fake database, and the HTTP layer is checked for what it writes to its log.
 * The key below is a dummy, only for this process. Nothing is sent and no network is used.
 */

const savedKey = process.env.OAUTH_TOKEN_ENCRYPTION_KEY
const savedSessionKey = process.env.SESSION_ENCRYPTION_KEY
before(() => {
  process.env.OAUTH_TOKEN_ENCRYPTION_KEY = 'dummy-test-key-only-for-security-code-tests'
})
after(() => {
  if (savedKey === undefined) delete process.env.OAUTH_TOKEN_ENCRYPTION_KEY
  else process.env.OAUTH_TOKEN_ENCRYPTION_KEY = savedKey
  if (savedSessionKey === undefined) delete process.env.SESSION_ENCRYPTION_KEY
  else process.env.SESSION_ENCRYPTION_KEY = savedSessionKey
})

const NOW = new Date('2026-11-23T10:00:00.000Z')
const LATER = '2026-11-23T10:08:00.000Z'
const EARLIER = '2026-11-23T09:59:00.000Z'
const JOB = '11111111-1111-4111-8111-111111111111'
const OTHER_JOB = '22222222-2222-4222-8222-222222222222'
const CODE = 'Zx81QQ73pK'

// ---------------------------------------------------------------- pure: input

test('normaliseCode: trim, spaces and dashes removed, case kept', () => {
  assert.equal(normaliseCode('  ab12 cd34  '), 'ab12cd34')
  assert.equal(normaliseCode('AB12-CD34'), 'AB12CD34')
  assert.equal(normaliseCode('Ab 1-2 c'), 'Ab12c')
  assert.equal(normaliseCode('1234'), '1234')
  assert.equal(normaliseCode('123456789012'), '123456789012')
})

test('normaliseCode: wrong length, other characters or non-strings give null', () => {
  for (const bad of ['', '   ', '123', '1234567890123', 'ab_12', 'ab.12', 'ab!cd', 'ábcd12', '12​34', '1234\n5678x9012']) {
    assert.equal(normaliseCode(bad), null, JSON.stringify(bad))
  }
  for (const bad of [undefined, null, 123456, {}, [], true]) assert.equal(normaliseCode(bad as any), null)
})

test('isUuid accepts a UUID and rejects the rest', () => {
  assert.equal(isUuid(JOB), true)
  assert.equal(isUuid(JOB.toUpperCase()), true)
  for (const bad of ['', 'abc', JOB + 'x', JOB.slice(1), 123, null, undefined, {}]) assert.equal(isUuid(bad as any), false)
})

test('validateSecurityCodeInput: good body returns the normalised code', () => {
  assert.deepEqual(validateSecurityCodeInput({ queue_job_id: JOB, code: ' ab12-cd34 ' }), {
    ok: true,
    queueJobId: JOB,
    code: 'ab12cd34',
  })
})

test('validateSecurityCodeInput: bad or missing code is invalid_code', () => {
  for (const body of [undefined, null, 'text', 42, [], {}, { queue_job_id: JOB }, { queue_job_id: JOB, code: 123456 }, { queue_job_id: JOB, code: '12' }, { queue_job_id: JOB, code: 'a b' }]) {
    assert.deepEqual(validateSecurityCodeInput(body), { ok: false, status: 400, error: 'invalid_code' }, JSON.stringify(body))
  }
})

test('validateSecurityCodeInput: bad queue_job_id is invalid_job, and the code is checked first', () => {
  for (const id of [undefined, '', 'not-a-uuid', 42, null]) {
    assert.deepEqual(validateSecurityCodeInput({ queue_job_id: id, code: CODE }), { ok: false, status: 400, error: 'invalid_job' })
  }
  assert.deepEqual(validateSecurityCodeInput({ queue_job_id: 'x', code: '1' }), { ok: false, status: 400, error: 'invalid_code' })
})

// ---------------------------------------------------------------- pure: waiting and quota

const waiting = (over: Partial<WaitingFacts> = {}): WaitingFacts => ({
  queueJob: { status: 'processing' },
  latestLog: { status: 'awaiting_code', details: { awaiting_until: LATER } },
  now: NOW,
  ...over,
})

test('decideAgentWaiting: processing job with a live awaiting_code log is ok', () => {
  assert.deepEqual(decideAgentWaiting(waiting()), { ok: true })
})

test('decideAgentWaiting: no queue row is 404', () => {
  assert.deepEqual(decideAgentWaiting(waiting({ queueJob: null })), { ok: false, status: 404, error: 'job_not_found' })
})

test('decideAgentWaiting: job not processing is 409 agent_not_waiting', () => {
  for (const status of ['pending', 'completed', 'failed', 'cancelled', null, undefined]) {
    assert.deepEqual(
      decideAgentWaiting(waiting({ queueJob: { status } })),
      { ok: false, status: 409, error: 'agent_not_waiting' },
      String(status)
    )
  }
})

test('decideAgentWaiting: no log, or newest log not awaiting_code, is 409', () => {
  const notWaiting = { ok: false, status: 409, error: 'agent_not_waiting' }
  assert.deepEqual(decideAgentWaiting(waiting({ latestLog: null })), notWaiting)
  for (const status of ['success', 'failed', 'processing', 'submit_unverified', null, undefined]) {
    assert.deepEqual(decideAgentWaiting(waiting({ latestLog: { status, details: { awaiting_until: LATER } } })), notWaiting, String(status))
  }
})

test('decideAgentWaiting: awaiting_until past, equal to now, missing or unparsable is 409', () => {
  const notWaiting = { ok: false, status: 409, error: 'agent_not_waiting' }
  for (const awaiting_until of [EARLIER, NOW.toISOString(), undefined, null, '', 'tomorrow-ish', {}, []]) {
    assert.deepEqual(
      decideAgentWaiting(waiting({ latestLog: { status: 'awaiting_code', details: { awaiting_until } } })),
      notWaiting,
      JSON.stringify(awaiting_until)
    )
  }
  assert.deepEqual(decideAgentWaiting(waiting({ latestLog: { status: 'awaiting_code', details: null } })), notWaiting)
  assert.deepEqual(decideAgentWaiting(waiting({ latestLog: { status: 'awaiting_code' } })), notWaiting)
})

test('decideCodeQuota: below the cap ok, at or above is 429 too_many_codes', () => {
  assert.equal(MAX_CODES_PER_JOB, 3)
  for (const n of [0, 1, 2]) assert.deepEqual(decideCodeQuota(n), { ok: true })
  for (const n of [3, 4, 50]) assert.deepEqual(decideCodeQuota(n), { ok: false, status: 429, error: 'too_many_codes' })
})

test('isMissingTable: 42P01 and PGRST205 only', () => {
  assert.equal(isMissingTable({ code: '42P01' }), true)
  assert.equal(isMissingTable({ code: 'PGRST205' }), true)
  for (const e of [{ code: '23503' }, { code: 'PGRST116' }, {}, null, undefined]) assert.equal(isMissingTable(e as any), false)
})

// ---------------------------------------------------------------- flow with a fake database

function makeDb(seed: Record<string, any[]> = {}): FakeDb {
  return new FakeDb({
    automation_queue: [{ id: JOB, user_id: 'u1', job_type: 'apply', status: 'processing' }],
    application_logs: [
      {
        user_id: 'u1',
        action: 'apply',
        status: 'awaiting_code',
        details: { queue_job_id: JOB, awaiting_until: LATER },
        created_at: '2026-11-23T09:58:00.000Z',
      },
    ],
    agent_security_codes: [],
    ...seed,
  })
}

const send = (db: FakeDb, body: unknown = { queue_job_id: JOB, code: CODE }, userId: string | null = 'u1') =>
  submitSecurityCode(db, userId, body, NOW)

const noWrites = (db: FakeDb) => assert.equal(db.writes.length, 0, 'nothing may be written')

test('flow: 202, stores one encrypted row that decrypts to the normalised code', async () => {
  const db = makeDb()
  const res = await send(db, { queue_job_id: JOB, code: ' zx81-QQ73 pK ' })
  assert.deepEqual(res, { status: 202, body: { accepted: true } })

  const rows = db.rows('agent_security_codes')
  assert.equal(rows.length, 1)
  assert.equal(rows[0].user_id, 'u1')
  assert.equal(rows[0].queue_job_id, JOB)
  assert.equal(decrypt(rows[0].code_encrypted), 'zx81QQ73pK')
  assert.equal(rows[0].expires_at, new Date(NOW.getTime() + CODE_TTL_MS).toISOString())
  assert.equal(rows[0].used_at, undefined)
  assert.equal(CODE_TTL_MS, 15 * 60 * 1000)
})

test('flow: the plain code appears in no inserted row, no write and no reply', async () => {
  const db = makeDb()
  const res = await send(db)
  const everything = JSON.stringify([db.writes, db.rows('agent_security_codes'), res])
  assert.equal(everything.includes(CODE), false)
  assert.equal(everything.includes('Zx81QQ73'), false)
  // Two encryptions of the same code differ (random iv), so an equal ciphertext cannot be used as a guess oracle.
  const db2 = makeDb()
  await send(db2)
  assert.notEqual(db.rows('agent_security_codes')[0].code_encrypted, db2.rows('agent_security_codes')[0].code_encrypted)
})

test('flow: 401 without a user, before any other check', async () => {
  const db = makeDb()
  for (const userId of [null, undefined, '']) {
    const res = await submitSecurityCode(db, userId as any, { queue_job_id: 'bad', code: '1' }, NOW)
    assert.deepEqual(res, { status: 401, body: { error: 'Unauthorized' } })
  }
  noWrites(db)
})

test('flow: 400 invalid_code and invalid_job, nothing written', async () => {
  const db = makeDb()
  assert.deepEqual(await send(db, { queue_job_id: JOB, code: 'no' }), { status: 400, body: { error: 'invalid_code' } })
  assert.deepEqual(await send(db, { queue_job_id: JOB }), { status: 400, body: { error: 'invalid_code' } })
  assert.deepEqual(await send(db, { queue_job_id: 'abc', code: CODE }), { status: 400, body: { error: 'invalid_job' } })
  assert.deepEqual(await send(db, null), { status: 400, body: { error: 'invalid_code' } })
  noWrites(db)
})

test('flow: 404 for an unknown job, a job of another user or a job that is not an apply job', async () => {
  const db = makeDb({
    automation_queue: [
      { id: JOB, user_id: 'u2', job_type: 'apply', status: 'processing' },
      { id: OTHER_JOB, user_id: 'u1', job_type: 'email_apply', status: 'processing' },
    ],
  })
  for (const id of [JOB, OTHER_JOB, '33333333-3333-4333-8333-333333333333']) {
    assert.deepEqual(await send(db, { queue_job_id: id, code: CODE }), { status: 404, body: { error: 'job_not_found' } }, id)
  }
  noWrites(db)
})

test('flow: 409 when the queue job is not processing', async () => {
  for (const status of ['pending', 'completed', 'failed']) {
    const db = makeDb({ automation_queue: [{ id: JOB, user_id: 'u1', job_type: 'apply', status }] })
    assert.deepEqual(await send(db), { status: 409, body: { error: 'agent_not_waiting' } }, status)
    noWrites(db)
  }
})

test('flow: 409 without any log, with a past deadline, or when the newest log is not awaiting_code', async () => {
  const log = (status: string, created_at: string, until = LATER, queue_job_id = JOB, user_id = 'u1') => ({
    user_id,
    action: 'apply',
    status,
    details: { queue_job_id, awaiting_until: until },
    created_at,
  })
  const cases: Record<string, any[]> = {
    'no log': [],
    'deadline passed': [log('awaiting_code', '2026-11-23T09:50:00.000Z', EARLIER)],
    'newer success log': [log('awaiting_code', '2026-11-23T09:50:00.000Z'), log('success', '2026-11-23T09:59:00.000Z')],
    'only other user log': [log('awaiting_code', '2026-11-23T09:50:00.000Z', LATER, JOB, 'u2')],
    'only other job log': [log('awaiting_code', '2026-11-23T09:50:00.000Z', LATER, OTHER_JOB)],
  }
  for (const [name, application_logs] of Object.entries(cases)) {
    const db = makeDb({ application_logs })
    assert.deepEqual(await send(db), { status: 409, body: { error: 'agent_not_waiting' } }, name)
    noWrites(db)
  }
})

test('flow: only the newest log counts, so an older non-waiting log does not block', async () => {
  const db = makeDb({
    application_logs: [
      { user_id: 'u1', action: 'apply', status: 'failed', details: { queue_job_id: JOB }, created_at: '2026-11-23T09:40:00.000Z' },
      { user_id: 'u1', action: 'apply', status: 'awaiting_code', details: { queue_job_id: JOB, awaiting_until: LATER }, created_at: '2026-11-23T09:58:00.000Z' },
    ],
  })
  assert.equal((await send(db)).status, 202)
})

test('flow: 429 from the third stored code on, whatever the state of the earlier ones', async () => {
  const stored = (extra: Record<string, any> = {}) => ({ user_id: 'u1', queue_job_id: JOB, code_encrypted: 'x', ...extra })
  const two = makeDb({ agent_security_codes: [stored(), stored({ used_at: EARLIER })] })
  assert.equal((await send(two)).status, 202)
  assert.equal(two.rows('agent_security_codes').length, 3)
  assert.deepEqual(await send(two), { status: 429, body: { error: 'too_many_codes' } })
  assert.equal(two.rows('agent_security_codes').length, 3)

  const expired = makeDb({
    agent_security_codes: [stored({ used_at: EARLIER }), stored({ expires_at: EARLIER }), stored({ used_at: EARLIER })],
  })
  assert.deepEqual(await send(expired), { status: 429, body: { error: 'too_many_codes' } })
  noWrites(expired)
})

test('flow: codes of another queue job do not count toward the cap', async () => {
  const other = { user_id: 'u1', queue_job_id: OTHER_JOB, code_encrypted: 'x' }
  const db = makeDb({ agent_security_codes: [other, other, other, other] })
  assert.equal((await send(db)).status, 202)
})

test('flow: first failure wins in the documented order', async () => {
  const full = Array.from({ length: 3 }, () => ({ user_id: 'u1', queue_job_id: JOB, code_encrypted: 'x' }))
  // 404 beats 409 and 429
  let db = makeDb({ automation_queue: [], agent_security_codes: full })
  assert.equal((await send(db)).status, 404)
  // 409 beats 429
  db = makeDb({ automation_queue: [{ id: JOB, user_id: 'u1', job_type: 'apply', status: 'pending' }], agent_security_codes: full })
  assert.equal((await send(db)).status, 409)
  // 400 beats 404
  db = makeDb({ automation_queue: [] })
  assert.equal((await send(db, { queue_job_id: JOB, code: '1' })).status, 400)
})

test('flow: 503 feature_unavailable when the table is missing (count or insert, 42P01 or PGRST205)', async () => {
  for (const [op, code] of [['select', '42P01'], ['select', 'PGRST205'], ['insert', '42P01'], ['insert', 'PGRST205']] as const) {
    const db = makeDb()
    db.failOn('agent_security_codes', op, `relation "agent_security_codes" does not exist ${CODE}`, code)
    const res = await send(db)
    assert.deepEqual({ status: res.status, body: res.body }, { status: 503, body: { error: 'feature_unavailable' } }, `${op} ${code}`)
    assert.equal(JSON.stringify(res).includes(CODE), false)
  }
})

test('flow: a missing table does not hide a 404 or 409 (the count runs last)', async () => {
  const db = makeDb({ automation_queue: [] })
  db.failOn('agent_security_codes', 'select', 'missing', '42P01')
  assert.equal((await send(db)).status, 404)
})

test('flow: 500 with a generic body when the database fails, and no secret reaches body or log note', async () => {
  const cases: Array<[string, 'select' | 'insert']> = [
    ['automation_queue', 'select'],
    ['application_logs', 'select'],
    ['agent_security_codes', 'select'],
    ['agent_security_codes', 'insert'],
  ]
  for (const [table, op] of cases) {
    const db = makeDb()
    db.failOn(table, op, `Failing row contains (${CODE}, secret-ciphertext)`, '23503')
    const res = await send(db)
    assert.equal(res.status, 500, `${table}.${op}`)
    assert.deepEqual(res.body, { error: 'internal_error' })
    const seen = JSON.stringify(res)
    assert.equal(seen.includes(CODE), false)
    assert.equal(seen.includes('secret-ciphertext'), false)
    assert.match(res.logNote ?? '', /db code 23503/)
    assert.equal(db.rows('agent_security_codes').length, 0)
  }
})

test('flow: 500 when encryption is not possible (no key), message not forwarded', async () => {
  const keep = process.env.OAUTH_TOKEN_ENCRYPTION_KEY
  const keepSession = process.env.SESSION_ENCRYPTION_KEY
  delete process.env.OAUTH_TOKEN_ENCRYPTION_KEY
  delete process.env.SESSION_ENCRYPTION_KEY
  try {
    const db = makeDb()
    const res = await send(db)
    assert.equal(res.status, 500)
    assert.deepEqual(res.body, { error: 'internal_error' })
    assert.match(res.logNote ?? '', /encrypt failed/)
    assert.equal(db.rows('agent_security_codes').length, 0)
  } finally {
    process.env.OAUTH_TOKEN_ENCRYPTION_KEY = keep
    if (keepSession !== undefined) process.env.SESSION_ENCRYPTION_KEY = keepSession
  }
})

// ---------------------------------------------------------------- HTTP layer and logging

// The HTTP layer reads the real clock, so its waiting log has a deadline far in the future.
const httpDb = (seed: Record<string, any[]> = {}) =>
  makeDb({
    application_logs: [
      { user_id: 'u1', action: 'apply', status: 'awaiting_code', details: { queue_job_id: JOB, awaiting_until: '2999-01-01T00:00:00.000Z' }, created_at: '2026-11-23T09:58:00.000Z' },
    ],
    ...seed,
  })

async function buildApp(db: FakeDb, user: { id: string } | null = { id: 'u1' }) {
  const lines: string[] = []
  const app = Fastify({ logger: { level: 'trace', stream: { write: (s: string) => void lines.push(s) } } })
  // Same position as the real auth middleware: a preHandler hook of the parent scope.
  app.addHook('preHandler', async (req) => {
    if (user) (req as any).user = user
  })
  await app.register(agentCodeRoutes, { prefix: '/api/agent', db })
  return { app, logs: () => lines.join('') }
}

const post = (app: Awaited<ReturnType<typeof buildApp>>['app'], payload: string | object, headers: Record<string, string> = {}) =>
  app.inject({
    method: 'POST',
    url: '/api/agent/security-code',
    payload: payload as any,
    headers: typeof payload === 'string' ? { 'content-type': 'application/json', ...headers } : headers,
  })

test('http: 202 { accepted: true }, row stored, and nothing about the code in the log', async () => {
  const db = httpDb()
  const { app, logs } = await buildApp(db)
  const res = await post(app, { queue_job_id: JOB, code: CODE })
  assert.equal(res.statusCode, 202)
  assert.deepEqual(res.json(), { accepted: true })
  assert.equal(decrypt(db.rows('agent_security_codes')[0].code_encrypted), CODE)
  const text = logs()
  assert.ok(text.length > 0, 'the logger was active')
  assert.equal(text.includes(CODE), false)
  assert.equal(text.includes(db.rows('agent_security_codes')[0].code_encrypted), false)
  await app.close()
})

test('http: 401 without a user', async () => {
  const db = httpDb()
  const { app } = await buildApp(db, null)
  const res = await post(app, { queue_job_id: JOB, code: CODE })
  assert.equal(res.statusCode, 401)
  assert.deepEqual(res.json(), { error: 'Unauthorized' })
  noWrites(db)
  await app.close()
})

test('http: status codes of the flow come through (400, 404, 409, 429)', async () => {
  const stored = { user_id: 'u1', queue_job_id: JOB, code_encrypted: 'x' }
  const cases: Array<[Record<string, any[]>, object, number, string]> = [
    [{}, { queue_job_id: JOB, code: 'x' }, 400, 'invalid_code'],
    [{}, { queue_job_id: 'x', code: CODE }, 400, 'invalid_job'],
    [{ automation_queue: [] }, { queue_job_id: JOB, code: CODE }, 404, 'job_not_found'],
    [{ application_logs: [] }, { queue_job_id: JOB, code: CODE }, 409, 'agent_not_waiting'],
    [{ agent_security_codes: [stored, stored, stored] }, { queue_job_id: JOB, code: CODE }, 429, 'too_many_codes'],
  ]
  for (const [seed, body, status, error] of cases) {
    const { app } = await buildApp(httpDb(seed))
    const res = await post(app, body)
    assert.equal(res.statusCode, status, error)
    assert.deepEqual(res.json(), { error })
    await app.close()
  }
})

test('http: a body that is not valid JSON gets a fixed 400 and the log does not quote the code', async () => {
  const db = httpDb()
  const { app, logs } = await buildApp(db)
  const res = await post(app, `{"queue_job_id":"${JOB}","code":"${CODE}"`)
  assert.equal(res.statusCode, 400)
  assert.deepEqual(res.json(), { error: 'invalid_request' })
  assert.equal(res.body.includes(CODE), false)
  assert.equal(logs().includes(CODE), false)
  assert.ok(logs().includes('security-code request rejected'))
  noWrites(db)
  await app.close()
})

test('http: an oversized body is refused (413 handled as 4xx) without echoing it', async () => {
  const db = httpDb()
  const { app, logs } = await buildApp(db)
  const res = await post(app, { queue_job_id: JOB, code: CODE, padding: 'x'.repeat(5000) })
  assert.equal(res.statusCode, 413)
  assert.deepEqual(res.json(), { error: 'invalid_request' })
  assert.equal(logs().includes(CODE), false)
  noWrites(db)
  await app.close()
})

test('http: a failing insert is 500 { error: internal_error } and the log holds no code and no ciphertext', async () => {
  const db = httpDb()
  db.failOn('agent_security_codes', 'insert', `Failing row contains (${CODE})`, '23503')
  const { app, logs } = await buildApp(db)
  const res = await post(app, { queue_job_id: JOB, code: CODE })
  assert.equal(res.statusCode, 500)
  assert.deepEqual(res.json(), { error: 'internal_error' })
  assert.equal(logs().includes(CODE), false)
  assert.ok(logs().includes('db code 23503'))
  await app.close()
})

test('http: missing table is 503 feature_unavailable', async () => {
  const db = httpDb()
  db.failOn('agent_security_codes', 'select', 'does not exist', 'PGRST205')
  const { app } = await buildApp(db)
  const res = await post(app, { queue_job_id: JOB, code: CODE })
  assert.equal(res.statusCode, 503)
  assert.deepEqual(res.json(), { error: 'feature_unavailable' })
  await app.close()
})
