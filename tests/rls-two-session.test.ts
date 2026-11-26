import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'

/**
 * Audit 48.5 H-03 + 47.6 DB-02/03/08/11/18/19:
 * 1. Memastikan draf SQL hardening bersifat idempoten dan non-destruktif serta mencakup seluruh kebijakan kritis.
 * 2. Menyediakan evaluator & runner verifikasi RLS dua-sesi nyata (pengguna A vs pengguna B, tanpa false-pass)
 *    yang aktif bila env uji langsung tersedia (`UAT_RLS_LIVE_VERIFY=1`).
 */

const sqlPath = path.resolve(import.meta.dirname, '../../database/migrations/DRAFT_2026-11-26_db_hardening_and_rls_sync.sql')

const executableSql = (raw: string): string =>
  raw
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')

export interface RlsProbeStep {
  name: string
  passed: boolean
  reason?: string
}

export interface TwoSessionProbeInput {
  userASelectOwnCount: number
  userASelectUserBCount: number
  userAUpdateSubscriptionsOk: boolean
  userAInsertQueueOk: boolean
  userAInsertApprovalOk: boolean
  userADeleteLogsOk: boolean
  userACallClaimRpcOk: boolean
  userAReadPlatformSessionsCount: number
}

/**
 * Evaluator ketat RLS dua sesi (menutup celah H-04 agar hasil kosong/anonim tidak pernah dianggap LULUS).
 */
export function evaluateTwoSessionRls(input: TwoSessionProbeInput): { valid: boolean; steps: RlsProbeStep[] } {
  const steps: RlsProbeStep[] = [
    {
      name: 'user_a_can_select_own_row',
      passed: input.userASelectOwnCount >= 1,
      reason: input.userASelectOwnCount >= 1 ? undefined : 'must read at least 1 own row to prove authenticated session',
    },
    {
      name: 'cross_user_select_blocked',
      passed: input.userASelectUserBCount === 0,
      reason: input.userASelectUserBCount === 0 ? undefined : `leaked ${input.userASelectUserBCount} rows of user B`,
    },
    {
      name: 'subscriptions_escalation_blocked',
      passed: !input.userAUpdateSubscriptionsOk,
      reason: !input.userAUpdateSubscriptionsOk ? undefined : 'authenticated user updated own subscriptions row',
    },
    {
      name: 'automation_queue_direct_insert_blocked',
      passed: !input.userAInsertQueueOk,
      reason: !input.userAInsertQueueOk ? undefined : 'authenticated user inserted directly into automation_queue',
    },
    {
      name: 'approval_requests_direct_insert_blocked',
      passed: !input.userAInsertApprovalOk,
      reason: !input.userAInsertApprovalOk ? undefined : 'authenticated user inserted directly into approval_requests',
    },
    {
      name: 'application_logs_delete_blocked',
      passed: !input.userADeleteLogsOk,
      reason: !input.userADeleteLogsOk ? undefined : 'authenticated user deleted application_logs row',
    },
    {
      name: 'claim_automation_jobs_rpc_revoked',
      passed: !input.userACallClaimRpcOk,
      reason: !input.userACallClaimRpcOk ? undefined : 'authenticated user executed claim_automation_jobs',
    },
    {
      name: 'platform_sessions_client_access_revoked',
      passed: input.userAReadPlatformSessionsCount === 0,
      reason: input.userAReadPlatformSessionsCount === 0 ? undefined : 'authenticated user read platform_sessions directly',
    },
  ]
  return { valid: steps.every((s) => s.passed), steps }
}

test('DRAFT_2026-11-26_db_hardening_and_rls_sync.sql non-destruktif, idempoten, dan menutup DB-02..21', () => {
  const sql = readFileSync(sqlPath, 'utf8')
  assert.match(sql.split('\n')[0], /BELUM DITERAPKAN KE PRODUCTION/)
  const run = executableSql(sql)

  assert.doesNotMatch(run, /\b(drop\s+table|drop\s+column|truncate|delete\s+from)\b/i)
  assert.match(run, /CREATE POLICY "subscriptions select own"[\s\S]*?FOR SELECT TO authenticated/i)
  assert.match(run, /CREATE POLICY "application_logs select own"[\s\S]*?FOR SELECT TO authenticated/i)
  assert.match(run, /CREATE POLICY "automation_queue select own"[\s\S]*?FOR SELECT TO authenticated/i)
  assert.match(run, /CREATE POLICY "approval_requests select own"[\s\S]*?FOR SELECT TO authenticated/i)
  assert.match(run, /REVOKE ALL ON TABLE public\.platform_sessions FROM PUBLIC, anon, authenticated/i)
  for (const internalTable of [
    'public.approval_submit_claims',
    'public.agent_security_codes',
    'public.user_extension_revocations',
    'public.notification_verification_codes',
    'public.security_replay_tokens',
  ]) {
    assert.ok(run.includes(internalTable), `harus mengunci ${internalTable}`)
  }
  assert.match(run, /UPDATE storage\.buckets[\s\S]*?SET public = false[\s\S]*?agent-screenshots/i)
  assert.match(run, /SELECT[\s\S]*?FROM pg_policies[\s\S]*?subscriptions[\s\S]*?approval_requests[\s\S]*?DROP POLICY/i)
  assert.match(run, /claim_automation_jobs/i)
  assert.match(run, /consume_monthly_apply\(uuid\)/i)
  assert.match(run, /consume_ai_rate_slot\(uuid,text,integer,integer,text\)/i)
  assert.match(run, /check_daily_apply_quota_atomic\(uuid,timestamptz\)/i)
  assert.match(run, /register_notification_otp_attempt\(uuid,integer\)/i)
})

test('evaluateTwoSessionRls: menolak hasil kosong tanpa baris sendiri, kebocoran lintas pengguna, dan eskalasi RLS', () => {
  const safe = evaluateTwoSessionRls({
    userASelectOwnCount: 1,
    userASelectUserBCount: 0,
    userAUpdateSubscriptionsOk: false,
    userAInsertQueueOk: false,
    userAInsertApprovalOk: false,
    userADeleteLogsOk: false,
    userACallClaimRpcOk: false,
    userAReadPlatformSessionsCount: 0,
  })
  assert.equal(safe.valid, true)

  // Skenario palsu (0 baris sendiri tidak boleh dianggap aman)
  const vacuous = evaluateTwoSessionRls({
    userASelectOwnCount: 0,
    userASelectUserBCount: 0,
    userAUpdateSubscriptionsOk: false,
    userAInsertQueueOk: false,
    userAInsertApprovalOk: false,
    userADeleteLogsOk: false,
    userACallClaimRpcOk: false,
    userAReadPlatformSessionsCount: 0,
  })
  assert.equal(vacuous.valid, false)

  // Skenario bocor lintas pengguna atau eskalasi tier
  const leaked = evaluateTwoSessionRls({
    userASelectOwnCount: 1,
    userASelectUserBCount: 2,
    userAUpdateSubscriptionsOk: true,
    userAInsertQueueOk: true,
    userAInsertApprovalOk: false,
    userADeleteLogsOk: false,
    userACallClaimRpcOk: false,
    userAReadPlatformSessionsCount: 1,
  })
  assert.equal(leaked.valid, false)
  assert.deepEqual(
    leaked.steps.filter((s) => !s.passed).map((s) => s.name),
    [
      'cross_user_select_blocked',
      'subscriptions_escalation_blocked',
      'automation_queue_direct_insert_blocked',
      'platform_sessions_client_access_revoked',
    ]
  )
})

test(
  'live two-session RLS check (berjalan hanya bila UAT_RLS_LIVE_VERIFY=1 & kredensial uji disetel)',
  { skip: process.env.UAT_RLS_LIVE_VERIFY !== '1' },
  async () => {
    const url = process.env.SUPABASE_URL
    const anonKey = process.env.SUPABASE_ANON_KEY
    const jwtA = process.env.UAT_USER_A_JWT
    const userBId = process.env.UAT_USER_B_ID
    assert.ok(url && anonKey && jwtA && userBId, 'SUPABASE_URL, SUPABASE_ANON_KEY, UAT_USER_A_JWT, UAT_USER_B_ID wajib diisi')

    const headers = { apikey: anonKey, Authorization: `Bearer ${jwtA}`, 'Content-Type': 'application/json' }
    const getOwnSubs = await fetch(`${url}/rest/v1/subscriptions?select=id`, { headers })
    const ownSubs = (await getOwnSubs.json()) as unknown[]
    const getOtherSubs = await fetch(`${url}/rest/v1/subscriptions?select=id&user_id=eq.${encodeURIComponent(userBId)}`, { headers })
    const otherSubs = (await getOtherSubs.json()) as unknown[]
    const escSub = await fetch(`${url}/rest/v1/subscriptions`, {
      method: 'PATCH',
      headers: { ...headers, Prefer: 'return=representation' },
      body: JSON.stringify({ ai_model_tier: 'pro' }),
    })
    const escQueue = await fetch(`${url}/rest/v1/automation_queue`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ job_type: 'apply', payload: {} }),
    })
    const escApproval = await fetch(`${url}/rest/v1/approval_requests`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ job_title: 'test', company: 'test', platform: 'greenhouse' }),
    })
    const escLogs = await fetch(`${url}/rest/v1/application_logs?action=eq.ai_draft`, { method: 'DELETE', headers })
    const rpcClaim = await fetch(`${url}/rest/v1/rpc/claim_automation_jobs`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ worker_id: 'probe', max_jobs: 1 }),
    })
    const readSess = await fetch(`${url}/rest/v1/platform_sessions?select=id`, { headers })
    const sessRows = readSess.ok ? ((await readSess.json()) as unknown[]) : []

    const verdict = evaluateTwoSessionRls({
      userASelectOwnCount: Array.isArray(ownSubs) ? ownSubs.length : 0,
      userASelectUserBCount: Array.isArray(otherSubs) ? otherSubs.length : 0,
      userAUpdateSubscriptionsOk: escSub.ok,
      userAInsertQueueOk: escQueue.ok,
      userAInsertApprovalOk: escApproval.ok,
      userADeleteLogsOk: escLogs.ok,
      userACallClaimRpcOk: rpcClaim.ok,
      userAReadPlatformSessionsCount: Array.isArray(sessRows) ? sessRows.length : 0,
    })
    assert.equal(verdict.valid, true, JSON.stringify(verdict.steps))
  }
)
