import test from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import { approvalRoutes } from '../api/routes/approval.js'
import { ApprovalChannelConflictError } from '../services/queue-guard.js'
import { QueueService } from '../services/queue.service.js'
import { detectExtensionBlocker, ExtensionPlanner } from '../services/extension-planner.js'
import { rerunApproval } from '../services/rerun-guard.js'
import { claimNextExtensionJob, EXTENSION_LEASE_STALE_MS, heartbeatExtensionJob, releaseExtensionJob } from '../services/extension-queue.js'
import { buildApp, makeExtensionTestDb, OTHER_USER_ID, USER_ID } from './extension-test-db.js'

const NOW = new Date('2026-11-24T12:00:00Z')
const FUTURE = '2026-11-25T12:00:00Z'
const JOB_ID = '22222222-2222-4222-8222-222222222201'
const APPROVAL_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'
const QUEUE_ID_1 = 'qqqqqqqq-1111-4111-8111-111111111111'.replace(/q/g, 'a')
const QUEUE_ID_2 = 'bbbbbbbb-2222-4222-8222-222222222222'
const OTHER_QUEUE_ID = 'cccccccc-3333-4333-8333-333333333333'

function seedStore(over: Partial<Record<string, any[]>> = {}) {
  return makeExtensionTestDb({
    jobs: [
      {
        id: JOB_ID,
        title: 'Backend Engineer',
        company: 'Acme ID',
        platform_source: 'jobstreet',
        external_url: 'https://id.jobstreet.com/id/job/96011760',
        description: '',
      },
    ],
    approval_requests: [
      {
        id: APPROVAL_ID,
        user_id: USER_ID,
        job_id: JOB_ID,
        application_id: 'app-1',
        status: 'approved',
        apply_channel: 'extension',
        expires_at: FUTURE,
        cover_letter: 'Halo tim.',
      },
    ],
    automation_queue: [],
    approval_submit_claims: [],
    ...over,
  })
}

test('Paket A mutual exclusion: satu persetujuan tidak bisa masuk antrean worker dan ekstensi sekaligus', async () => {
  const store = seedStore()
  const qs = new QueueService(store.db as any)

  // Persetujuan berkanal extension ditolak masuk worker `apply`.
  await assert.rejects(qs.addApprovedApplyJob(USER_ID, APPROVAL_ID), ApprovalChannelConflictError)
  assert.equal(store.tables.automation_queue.length, 0)

  // Masuk kanal ekstensi berhasil sekali; percobaan kedua atau ke worker ditolak (409 conflict).
  const first = await qs.addApprovedExtensionApplyJob(USER_ID, APPROVAL_ID)
  assert.ok(first.id)
  assert.equal(store.tables.automation_queue[0].job_type, 'extension_apply')

  await assert.rejects(qs.addApprovedExtensionApplyJob(USER_ID, APPROVAL_ID), ApprovalChannelConflictError)
  await assert.rejects(qs.addApprovedApplyJob(USER_ID, APPROVAL_ID), ApprovalChannelConflictError)
})

test('Paket A mutual exclusion (balapan worker vs ekstensi): rerun dan authorize-submit menolak kanal lain', async () => {
  const store = seedStore({
    approval_requests: [
      {
        id: APPROVAL_ID,
        user_id: USER_ID,
        job_id: JOB_ID,
        application_id: 'app-1',
        status: 'approved',
        apply_channel: 'worker',
        expires_at: FUTURE,
      },
    ],
    automation_queue: [
      {
        id: QUEUE_ID_1,
        user_id: USER_ID,
        job_type: 'apply',
        status: 'processing',
        payload: { job_id: JOB_ID, approval_request_id: APPROVAL_ID, approved: true },
        created_at: NOW.toISOString(),
      },
    ],
  })

  // Rerun sementara aktif ditolak 409.
  const rerunRes = await rerunApproval(store.db as any, new QueueService(store.db as any), USER_ID, APPROVAL_ID, NOW)
  assert.equal(rerunRes.status, 409)

  // Ekstensi yang mencoba authorize-submit untuk persetujuan yang sedang dikerjakan worker ditolak 409 agent_working.
  const app = buildApp({ db: store.db, primaryUserId: USER_ID, now: () => NOW.getTime() })
  const { token } = (await app.inject({ method: 'POST', url: '/api/extension/token' })).json()
  const authRes = await app.inject({
    method: 'POST',
    url: '/api/extension/authorize-submit',
    headers: { authorization: `Bearer ${token}` },
    payload: {
      approvalId: APPROVAL_ID,
      jobId: JOB_ID,
      pageUrl: 'https://id.jobstreet.com/id/job/96011760/apply',
      missingRequiredCount: 0,
    },
  })
  assert.equal(authRes.statusCode, 409)
  assert.equal(authRes.json().code, 'agent_working')
  assert.equal(store.tables.approval_submit_claims.length, 0)
})

test('POST /api/extension/jobs/claim, heartbeat, dan release: 204 kosong, isolasi pemilik, dan reclaim > 5 menit', async () => {
  const store = seedStore({
    automation_queue: [
      {
        id: QUEUE_ID_1,
        user_id: USER_ID,
        job_type: 'extension_apply',
        status: 'pending',
        priority: 0,
        retry_count: 0,
        max_retries: 3,
        scheduled_at: '2026-11-24T11:59:00Z',
        payload: { job_id: JOB_ID, approval_request_id: APPROVAL_ID, approved: true },
      },
      {
        id: OTHER_QUEUE_ID,
        user_id: OTHER_USER_ID,
        job_type: 'extension_apply',
        status: 'pending',
        priority: 0,
        retry_count: 0,
        max_retries: 3,
        scheduled_at: '2026-11-24T11:58:00Z',
        payload: { job_id: JOB_ID, approval_request_id: APPROVAL_ID, approved: true },
      },
    ],
  })

  let fakeNowMs = NOW.getTime()
  const app = buildApp({ db: store.db, primaryUserId: USER_ID, now: () => fakeNowMs })
  const { token } = (await app.inject({ method: 'POST', url: '/api/extension/token' })).json()

  // 1. Claim mengambil hanya pekerjaan milik USER_ID.
  const claim1 = await app.inject({ method: 'POST', url: '/api/extension/jobs/claim', headers: { authorization: `Bearer ${token}` }, payload: { claimer: 'ext-a' } })
  assert.equal(claim1.statusCode, 200)
  const job = claim1.json().job
  assert.equal(job.queueJobId, QUEUE_ID_1)
  assert.equal(job.approvalId, APPROVAL_ID)
  assert.equal(job.applyUrl, 'https://id.jobstreet.com/id/job/96011760')
  assert.equal(store.tables.automation_queue[0].status, 'processing')

  // 2. Claim kedua saat masih processing + heartbeat segar -> 204 No Content.
  const claim2 = await app.inject({ method: 'POST', url: '/api/extension/jobs/claim', headers: { authorization: `Bearer ${token}` } })
  assert.equal(claim2.statusCode, 204)

  // 3. Pengguna tidak boleh mengirim heartbeat / release ke tugas milik pengguna lain (404).
  const crossHb = await app.inject({
    method: 'POST',
    url: `/api/extension/jobs/${OTHER_QUEUE_ID}/heartbeat`,
    headers: { authorization: `Bearer ${token}` },
  })
  assert.equal(crossHb.statusCode, 404)

  // 4. Heartbeat valid menjaga masa sewa hidup pada +4 menit.
  fakeNowMs += 4 * 60_000
  const hb = await app.inject({
    method: 'POST',
    url: `/api/extension/jobs/${QUEUE_ID_1}/heartbeat`,
    headers: { authorization: `Bearer ${token}` },
  })
  assert.equal(hb.statusCode, 200)
  const afterHbClaim = await app.inject({ method: 'POST', url: '/api/extension/jobs/claim', headers: { authorization: `Bearer ${token}` } })
  assert.equal(afterHbClaim.statusCode, 204, 'masih segar sesudah heartbeat, tidak diklaim ganda')

  // 5. Heartbeat putus > 5 menit -> otomatis dapat diklaim ulang oleh ekstensi lain.
  fakeNowMs += EXTENSION_LEASE_STALE_MS + 1000
  const reclaimed = await app.inject({
    method: 'POST',
    url: '/api/extension/jobs/claim',
    headers: { authorization: `Bearer ${token}` },
    payload: { claimer: 'ext-b' },
  })
  assert.equal(reclaimed.statusCode, 200)
  assert.equal(reclaimed.json().job.queueJobId, QUEUE_ID_1)
  assert.equal(reclaimed.json().job.attempt, 2)

  // 6. Release mengembalikan tugas ke pending (delay 0 -> siap diambil lagi atau failed setelah max_retries).
  const rel = await app.inject({
    method: 'POST',
    url: `/api/extension/jobs/${QUEUE_ID_1}/release`,
    headers: { authorization: `Bearer ${token}` },
    payload: { error: 'tab ditutup sebelum selesai', delaySeconds: 0 },
  })
  assert.equal(rel.statusCode, 200)
  assert.equal(rel.json().status, 'pending')
  assert.equal(rel.json().retryCount, 2)

  // Heartbeat ke job berstatus pending -> 409.
  const hbPending = await app.inject({
    method: 'POST',
    url: `/api/extension/jobs/${QUEUE_ID_1}/heartbeat`,
    headers: { authorization: `Bearer ${token}` },
  })
  assert.equal(hbPending.statusCode, 409)
})

test('extension-queue: batas max_retries memutus loop reklamasi heartbeat macet', async () => {
  const store = seedStore({
    automation_queue: [
      {
        id: QUEUE_ID_2,
        user_id: USER_ID,
        job_type: 'extension_apply',
        status: 'processing',
        retry_count: 3,
        max_retries: 3,
        heartbeat_at: '2026-11-24T11:40:00Z',
        processed_at: '2026-11-24T11:40:00Z',
        payload: { job_id: JOB_ID, approval_request_id: APPROVAL_ID },
      },
    ],
  })
  const got = await claimNextExtensionJob(store.db as any, USER_ID, { now: NOW })
  assert.equal(got, null)
  assert.equal(store.tables.automation_queue[0].status, 'failed')
})

test('Paket B planner & report-run: login.seek.com (tanpa password) terdeteksi auth_required tanpa AI, awaiting_login menjaga antrean tetap aktif', async () => {
  const blocker = detectExtensionBlocker({
    pageUrl: 'https://login.seek.com/login?protocol=oauth2&state=rahasia_xyz&redirect_uri=https://id.jobstreet.com/id/oauth/callback/',
    noticeText: 'Kirimkan saya kode masuk melalui email atau Masuk dengan Google',
    hasPasswordInput: false,
    controls: [{ controlId: 'c1', kind: 'text', label: 'Email address', groupLabel: '', name: 'email', placeholder: '', inputType: 'email', required: true, options: [], currentValue: '' }],
  })
  assert.equal(blocker?.reason, 'auth_required')

  let aiCalls = 0
  const planner = new ExtensionPlanner(async () => {
    aiCalls++
    return { model: 'm', text: '{"actions":[]}' }
  }, () => NOW.getTime())

  const store = seedStore({
    automation_queue: [
      {
        id: QUEUE_ID_1,
        user_id: USER_ID,
        job_type: 'extension_apply',
        status: 'processing',
        heartbeat_at: NOW.toISOString(),
        processed_at: NOW.toISOString(),
        payload: { job_id: JOB_ID, approval_request_id: APPROVAL_ID },
      },
    ],
  })

  const app = buildApp({ db: store.db, primaryUserId: USER_ID, planner, now: () => NOW.getTime() })
  const { token } = (await app.inject({ method: 'POST', url: '/api/extension/token' })).json()

  const planRes = await app.inject({
    method: 'POST',
    url: '/api/extension/plan-form',
    headers: { authorization: `Bearer ${token}` },
    payload: {
      approvalId: APPROVAL_ID,
      jobId: JOB_ID,
      pageUrl: 'https://login.seek.com/login?state=secret_token',
      noticeText: 'Kirimkan saya kode masuk melalui email',
      hasPasswordInput: false,
      controls: [{ controlId: 'c1', kind: 'text', label: 'Alamat email', inputType: 'email', required: true }],
    },
  })
  assert.equal(planRes.statusCode, 200)
  assert.equal(planRes.json().blocked, 'auth_required')
  assert.equal(aiCalls, 0)

  const repLogin = await app.inject({
    method: 'POST',
    url: '/api/extension/report-run',
    headers: { authorization: `Bearer ${token}` },
    payload: {
      approvalId: APPROVAL_ID,
      jobId: JOB_ID,
      queueJobId: QUEUE_ID_1,
      pageUrl: 'https://login.seek.com/login?state=secret_token&code=hidden',
      loginUrl: 'https://login.seek.com/login?state=secret_token#frag',
      outcome: 'awaiting_login',
      filledCount: 0,
    },
  })
  assert.equal(repLogin.statusCode, 200, repLogin.text)
  assert.equal(repLogin.json().logStatus, 'awaiting_login')
  assert.equal(store.tables.automation_queue[0].status, 'processing', 'antrean tetap processing selama menunggu user login')
  const logRow = store.tables.application_logs[0]
  assert.equal(logRow.status, 'awaiting_login')
  assert.equal(logRow.details.reason, 'awaiting_login')
  assert.equal(logRow.details.login_url, 'https://login.seek.com/login', 'query/hash OAuth tidak disimpan ke log')
  assert.equal(logRow.details.queue_job_id, QUEUE_ID_1)
  assert.equal(JSON.stringify(logRow).includes('secret_token'), false)

  // Sesudah user selesai login dan ekstensi mengisi form -> report ready menuntaskan baris antrean extension_apply.
  const repReady = await app.inject({
    method: 'POST',
    url: '/api/extension/report-run',
    headers: { authorization: `Bearer ${token}` },
    payload: {
      approvalId: APPROVAL_ID,
      jobId: JOB_ID,
      queueJobId: QUEUE_ID_1,
      pageUrl: 'https://id.jobstreet.com/id/job/96011760/apply',
      outcome: 'ready',
      filledCount: 4,
    },
  })
  assert.equal(repReady.statusCode, 200)
  assert.equal(store.tables.automation_queue[0].status, 'completed')

  await assert.rejects(heartbeatExtensionJob(store.db as any, USER_ID, QUEUE_ID_1, NOW), (err: any) => err?.code === 'job_not_processing')
  await assert.rejects(releaseExtensionJob(store.db as any, USER_ID, QUEUE_ID_1, {}, NOW), (err: any) => err?.code === 'job_already_finished')
})

test('POST /api/approvals/:id/approve merutekan kalibrr.id & jobstreet.com ke extension_apply vs greenhouse ke apply', async () => {
  const portalJobId = '22222222-2222-4222-8222-222222222211'
  const atsJobId = '22222222-2222-4222-8222-222222222212'
  const portalApprovalId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa11'
  const atsApprovalId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa12'
  const store = makeExtensionTestDb({
    jobs: [
      {
        id: portalJobId,
        title: 'Product Engineer',
        company: 'Kalibrr ID',
        platform_source: 'kalibrr',
        external_url: 'https://www.kalibrr.id/c/kalibrr/jobs/123/product-engineer',
        description: 'Masuk lewat portal',
      },
      {
        id: atsJobId,
        title: 'Platform Engineer',
        company: 'Acme ATS',
        platform_source: 'greenhouse',
        external_url: 'https://boards.greenhouse.io/acme/jobs/456',
        description: 'Formulir publik',
      },
    ],
    // Pengguna sudah memilih "selalu pakai ekstensi": persetujuan portal langsung diantrekan (tanpa meminta izin lagi).
    user_automation_settings: [{ id: 'set-1', user_id: USER_ID, extension_auto_use: true }],
    ai_applications: [
      { id: 'app-portal', user_id: USER_ID, job_id: portalJobId, status: 'pending_approval' },
      { id: 'app-ats', user_id: USER_ID, job_id: atsJobId, status: 'pending_approval' },
    ],
    approval_requests: [
      {
        id: portalApprovalId,
        user_id: USER_ID,
        job_id: portalJobId,
        application_id: 'app-portal',
        job_title: 'Product Engineer',
        company: 'Kalibrr ID',
        platform: 'kalibrr',
        status: 'pending',
        expires_at: FUTURE,
      },
      {
        id: atsApprovalId,
        user_id: USER_ID,
        job_id: atsJobId,
        application_id: 'app-ats',
        job_title: 'Platform Engineer',
        company: 'Acme ATS',
        platform: 'greenhouse',
        status: 'pending',
        expires_at: FUTURE,
      },
    ],
  })

  const app = Fastify()
  app.addHook('preHandler', async (req: any) => {
    req.user = { id: USER_ID }
  })
  await app.register(approvalRoutes, {
    prefix: '/api/approvals',
    db: store.db,
    guard: { checkActionRateLimit: async () => ({ allowed: true }) as any },
  })

  const portalRes = await app.inject({ method: 'POST', url: `/api/approvals/${portalApprovalId}/approve`, payload: {} })
  assert.equal(portalRes.statusCode, 200, portalRes.body)
  const portalQueue = store.tables.automation_queue.find((r) => r.payload?.approval_request_id === portalApprovalId)
  assert.equal(portalQueue?.job_type, 'extension_apply')
  assert.equal(portalRes.json().apply_channel, 'extension')
  assert.equal(store.tables.approval_requests.find((r) => r.id === portalApprovalId)?.apply_channel, 'extension')

  const atsRes = await app.inject({ method: 'POST', url: `/api/approvals/${atsApprovalId}/approve`, payload: {} })
  assert.equal(atsRes.statusCode, 200, atsRes.body)
  const atsQueue = store.tables.automation_queue.find((r) => r.payload?.approval_request_id === atsApprovalId)
  assert.equal(atsQueue?.job_type, 'apply')
  assert.equal(atsRes.json().apply_channel, 'worker')
  assert.equal(store.tables.approval_requests.find((r) => r.id === atsApprovalId)?.apply_channel, 'worker')
})
