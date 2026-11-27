import test from 'node:test'
import assert from 'node:assert/strict'
import { ExtensionPlanner } from '../services/extension-planner.js'
import { buildApp, makeExtensionTestDb, OTHER_USER_ID, USER_ID, VALID_PNG_BASE64 } from './extension-test-db.js'

test('POST /api/extension/token & GET /pending-approvals: mengeluarkan token scoped dan memfilter LinkedIn/yang terpakai', async () => {
  const now = new Date('2026-11-23T12:00:00Z')
  const future = new Date('2026-11-24T12:00:00Z').toISOString()
  const store = makeExtensionTestDb({
    approval_requests: [
      { id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1', user_id: USER_ID, job_id: 'job-kalibrr', application_id: 'app-1', status: 'approved', expires_at: future, cover_letter: 'Halo tim' },
      { id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2', user_id: USER_ID, job_id: 'job-linkedin', application_id: 'app-2', status: 'approved', expires_at: future },
      { id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa3', user_id: USER_ID, job_id: 'job-used', application_id: 'app-3', status: 'approved', expires_at: future },
    ],
    jobs: [
      { id: 'job-kalibrr', title: 'Backend Engineer', company: 'Acme', platform_source: 'kalibrr', external_url: 'https://www.kalibrr.com/c/acme/jobs/1', description: '' },
      { id: 'job-linkedin', title: 'Staff Dev', company: 'Beta', platform_source: 'linkedin', external_url: 'https://www.linkedin.com/jobs/view/123', description: '' },
      { id: 'job-used', title: 'QA', company: 'Gamma', platform_source: 'glints', external_url: 'https://glints.com/id/opportunities/jobs/1', description: '' },
    ],
    application_logs: [
      { user_id: USER_ID, job_id: 'job-used', action: 'apply', status: 'success', details: { approval_request_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa3' } },
    ],
  })

  const noAuthApp = buildApp({ db: store.db, primaryUserId: null, now: () => now.getTime() })
  const unauthRes = await noAuthApp.inject({ method: 'POST', url: '/api/extension/token' })
  assert.equal(unauthRes.statusCode, 401)

  const app = buildApp({ db: store.db, primaryUserId: USER_ID, now: () => now.getTime() })
  const tokRes = await app.inject({ method: 'POST', url: '/api/extension/token' })
  assert.equal(tokRes.statusCode, 200)
  const { token } = tokRes.json()

  const listRes = await app.inject({
    method: 'GET',
    url: '/api/extension/pending-approvals',
    headers: { authorization: `Bearer ${token}` },
  })
  assert.equal(listRes.statusCode, 200)
  const { items } = listRes.json()
  assert.equal(items.length, 1)
  assert.equal(items[0].approvalId, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1')
  assert.equal(items[0].channel, 'auth_portal')
})

test('POST /api/extension/plan-form: menolak LinkedIn, tetap merencanakan formulir walau ada teks larangan AI, dan merencanakan radio+saved+AI', async () => {
  const now = new Date('2026-11-23T12:00:00Z')
  const future = new Date('2026-11-24T12:00:00Z').toISOString()
  const approvalId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1'
  let aiCalls = 0
  let capturedPrompt = ''

  const planner = new ExtensionPlanner(
    async (req) => {
      aiCalls++
      capturedPrompt = req.user
      assert.match(req.system, /<untrusted_form_controls>/)
      return {
        model: 'mock-model',
        text: JSON.stringify({
          actions: [
            { controlId: 'c-city', value: '{{city}}' },
            { controlId: 'c-secret', value: 'hack' },
          ],
        }),
      }
    },
    () => now.getTime()
  )

  const store = makeExtensionTestDb({
    approval_requests: [
      { id: approvalId, user_id: USER_ID, job_id: 'job-1', application_id: 'app-1', status: 'approved', expires_at: future, cover_letter: 'Surat' },
    ],
    jobs: [{ id: 'job-1', title: 'Backend', company: 'Acme', description: 'Node.js role' }],
    profiles: [{ id: USER_ID, full_name: 'Budi Santoso', location: 'Jakarta Selatan, Indonesia', phone: '0812345' }],
    user_automation_settings: [{ user_id: USER_ID, email: 'budi@example.id', require_visa: 'No', use_ai: true }],
    user_form_answers: [{ user_id: USER_ID, question_key: 'are you willing to relocate', question_label: 'Are you willing to relocate?', answer: 'Yes' }],
  })

  const app = buildApp({ db: store.db, primaryUserId: USER_ID, planner, now: () => now.getTime() })
  const { token } = (await app.inject({ method: 'POST', url: '/api/extension/token' })).json()

  // 1. LinkedIn ditolak keras (403).
  const liRes = await app.inject({
    method: 'POST',
    url: '/api/extension/plan-form',
    headers: { authorization: `Bearer ${token}` },
    payload: { approvalId, pageUrl: 'https://www.linkedin.com/jobs/view/1', controls: [] },
  })
  assert.equal(liRes.statusCode, 403)
  assert.equal(liRes.json().code, 'linkedin_manual_only')
  assert.equal(aiCalls, 0)

  // 2. Formulir bertema larangan AI (Canonical) tidak lagi diblokir agar pengujian E2E tetap berjalan.
  const noAiRes = await app.inject({
    method: 'POST',
    url: '/api/extension/plan-form',
    headers: { authorization: `Bearer ${token}` },
    payload: {
      approvalId,
      pageUrl: 'https://jobs.canonical.com/apply/1',
      noticeText: 'Please confirm your application is written in your own words without artificial intelligence.',
      controls: [{ controlId: 'c1', kind: 'textarea', label: 'Why Canonical?', required: true }],
    },
  })
  assert.equal(noAiRes.statusCode, 200)
  assert.equal(noAiRes.json().blocked, null)
  assert.equal(aiCalls, 1)
  aiCalls = 0

  // 3. Perencanaan normal: password/secret dibuang, radio memakai jawaban tersimpan, token disubstitusi, pertanyaan wajib sisa dicatat.
  const okRes = await app.inject({
    method: 'POST',
    url: '/api/extension/plan-form',
    headers: { authorization: `Bearer ${token}` },
    payload: {
      approvalId,
      pageUrl: 'https://www.kalibrr.com/c/acme/jobs/1/apply',
      controls: [
        { controlId: 'c-pass', kind: 'text', inputType: 'password', label: 'Password', required: true },
        { controlId: 'c-secret', kind: 'text', label: 'Account OTP Code', required: false },
        { controlId: 'c-name', kind: 'text', label: 'Full Name', required: true },
        { controlId: 'c-reloc', kind: 'radio', groupLabel: 'Are you willing to relocate?', label: 'Yes / No', options: ['Yes', 'No'], required: true },
        { controlId: 'c-city', kind: 'text', label: 'Current City', required: true },
        { controlId: 'c-custom', kind: 'textarea', label: 'Describe a distributed system project', required: true },
      ],
    },
  })
  assert.equal(okRes.statusCode, 200)
  const planned = okRes.json()
  assert.equal(planned.blocked, null)
  assert.equal(aiCalls, 1)
  assert.match(capturedPrompt, /<untrusted_form_controls>/)
  assert.ok(!capturedPrompt.includes('c-pass'))
  assert.ok(!planned.actions.some((a: any) => a.controlId === 'c-pass' || a.controlId === 'c-secret'))
  assert.deepEqual(planned.actions.find((a: any) => a.controlId === 'c-name'), { controlId: 'c-name', kind: 'text', value: 'Budi Santoso', source: 'fact' })
  assert.deepEqual(planned.actions.find((a: any) => a.controlId === 'c-reloc'), { controlId: 'c-reloc', kind: 'radio', value: 'Yes', source: 'saved' })
  assert.deepEqual(planned.actions.find((a: any) => a.controlId === 'c-city'), { controlId: 'c-city', kind: 'text', value: 'Jakarta Selatan', source: 'ai' })
  // Kolom wajib yang tersisa lebih dulu, lalu kontrol rahasia opsional sebagai `secret_skip` (tidak diisi, tidak ke AI).
  assert.deepEqual(planned.pendingQuestions, [
    { key: 'describe a distributed system project', label: 'Describe a distributed system project', kind: 'textarea', required: true },
    { key: 'account otp code', label: 'Account OTP Code', kind: 'secret_skip', required: false },
  ])
  assert.deepEqual(planned.fileTargets, [])
  assert.equal(planned.aiError, null)
})

test('authorize-submit & report-run: 1 approval = 1 submission, validasi PNG magic bytes, upload ke folder userId, majukan ai_applications', async () => {
  const now = new Date('2026-11-23T12:00:00Z')
  const future = new Date('2026-11-24T12:00:00Z').toISOString()
  const approvalId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1'

  const store = makeExtensionTestDb({
    approval_requests: [
      { id: approvalId, user_id: USER_ID, job_id: 'job-1', application_id: 'app-1', status: 'approved', expires_at: future },
      { id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb2', user_id: OTHER_USER_ID, job_id: 'job-2', application_id: 'app-2', status: 'approved', expires_at: future },
    ],
    jobs: [{ id: 'job-1', platform_source: 'kalibrr', title: 'BE', company: 'Acme', external_url: 'https://www.kalibrr.com/c/acme/jobs/1' }],
    ai_applications: [{ id: 'app-1', user_id: USER_ID, job_id: 'job-1', status: 'draft' }],
    subscriptions: [{ user_id: USER_ID, ai_model_tier: 'free' }],
  })

  const app = buildApp({ db: store.db, primaryUserId: USER_ID, now: () => now.getTime() })
  const { token } = (await app.inject({ method: 'POST', url: '/api/extension/token' })).json()

  // Kolom wajib masih ada -> 409
  const incompleteAuth = await app.inject({
    method: 'POST',
    url: '/api/extension/authorize-submit',
    headers: { authorization: `Bearer ${token}` },
    payload: { approvalId, jobId: 'job-1', pageUrl: 'https://www.kalibrr.com/apply', missingRequiredCount: 2 },
  })
  assert.equal(incompleteAuth.statusCode, 409)

  // Otorisasi sah -> 200
  const okAuth = await app.inject({
    method: 'POST',
    url: '/api/extension/authorize-submit',
    headers: { authorization: `Bearer ${token}` },
    payload: { approvalId, jobId: 'job-1', pageUrl: 'https://www.kalibrr.com/apply', missingRequiredCount: 0 },
  })
  assert.equal(okAuth.statusCode, 200)
  assert.equal(okAuth.json().authorized, true)

  // Laporan non-kirim dengan file bukan PNG asli ditolak (400) dan tidak menulis log.
  const badPngRes = await app.inject({
    method: 'POST',
    url: '/api/extension/report-run',
    headers: { authorization: `Bearer ${token}` },
    payload: {
      approvalId,
      jobId: 'job-1',
      pageUrl: 'https://www.kalibrr.com/apply',
      outcome: 'ready',
      filledCount: 5,
      filledScreenshot: Buffer.from('<script>alert(1)</script>').toString('base64'),
    },
  })
  assert.equal(badPngRes.statusCode, 400)
  assert.equal(badPngRes.json().code, 'invalid_screenshot_png')
  assert.equal(store.tables.application_logs.length, 0)

  // Pelaporan submitted pertama berhasil + upload ke `${USER_ID}/ext-...` + status app maju ke `submitted`
  const firstReport = await app.inject({
    method: 'POST',
    url: '/api/extension/report-run',
    headers: { authorization: `Bearer ${token}` },
    payload: {
      approvalId,
      jobId: 'job-1',
      pageUrl: 'https://www.kalibrr.com/c/acme/jobs/1/submitted?secret=query',
      outcome: 'submitted',
      filledCount: 6,
      remainingRequired: 0,
      filledScreenshot: `data:image/png;base64,${VALID_PNG_BASE64}`,
      afterScreenshot: VALID_PNG_BASE64,
    },
  })
  assert.equal(firstReport.statusCode, 200)
  const reportBody = firstReport.json()
  assert.equal(reportBody.logStatus, 'success')
  assert.equal(reportBody.applicationStatus, 'submitted')
  assert.ok(reportBody.screenshots.filledPath?.startsWith(`${USER_ID}/ext-`))
  assert.ok(reportBody.screenshots.afterPath?.startsWith(`${USER_ID}/ext-`))
  assert.equal(store.uploads.length, 2)
  assert.equal(store.uploads[0].bucket, 'agent-screenshots')
  assert.equal(store.uploads[0].contentType, 'image/png')
  assert.equal(store.tables.ai_applications[0].status, 'submitted')
  // Pastikan query string yang sensitif dibuang dari final_url di log
  assert.equal(store.tables.application_logs[0].details.final_url, 'https://www.kalibrr.com/c/acme/jobs/1/submitted')

  // Approval yang sama dipakai lagi -> ditolak (409 approval_already_used)!
  const replayAuth = await app.inject({
    method: 'POST',
    url: '/api/extension/authorize-submit',
    headers: { authorization: `Bearer ${token}` },
    payload: { approvalId, jobId: 'job-1', pageUrl: 'https://www.kalibrr.com/apply', missingRequiredCount: 0 },
  })
  assert.equal(replayAuth.statusCode, 409)
  assert.equal(replayAuth.json().code, 'approval_already_used')

  const replayReport = await app.inject({
    method: 'POST',
    url: '/api/extension/report-run',
    headers: { authorization: `Bearer ${token}` },
    payload: { approvalId, jobId: 'job-1', pageUrl: 'https://www.kalibrr.com/apply', outcome: 'submitted', filledCount: 6 },
  })
  assert.equal(replayReport.statusCode, 409)
})
