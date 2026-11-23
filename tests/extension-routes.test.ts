import test from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import { extensionRoutes } from '../api/routes/extension.js'
import { ExtensionPlanner } from '../services/extension-planner.js'

const VALID_PNG_BASE64 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]).toString('base64')
const USER_ID = '11111111-2222-3333-4444-555555555555'
const OTHER_USER_ID = '99999999-2222-3333-4444-555555555555'
const ENV = { SESSION_ENCRYPTION_KEY: 'super_secret_session_key_minimum_32_characters_long' }

function makeExtensionTestDb(seed?: Partial<Record<string, any[]>>) {
  const tables: Record<string, any[]> = {
    approval_requests: [],
    jobs: [],
    profiles: [],
    user_automation_settings: [],
    user_skills: [],
    work_experiences: [],
    achievements: [],
    user_form_answers: [],
    application_logs: [],
    ai_applications: [],
    subscriptions: [],
    ...seed,
  }
  const uploads: Array<{ bucket: string; path: string; contentType: string; size: number }> = []

  const matchesContains = (obj: any, needle: Record<string, unknown>) => {
    if (!obj || typeof obj !== 'object') return false
    return Object.entries(needle).every(([k, v]) => obj[k] === v)
  }

  class QueryBuilder {
    private filters: Array<(row: any) => boolean> = []
    private limitN: number | null = null
    private orderCol: string | null = null
    private orderAsc = true
    private countHead = false
    private pendingInsert: any[] | null = null
    private pendingUpdate: Record<string, unknown> | null = null

    constructor(private readonly table: string) {}

    select(_cols?: string, opts?: { count?: string; head?: boolean }) {
      if (opts?.head) this.countHead = true
      return this
    }
    eq(col: string, val: unknown) {
      this.filters.push((r) => r?.[col] === val)
      return this
    }
    in(col: string, vals: unknown[]) {
      this.filters.push((r) => vals.includes(r?.[col]))
      return this
    }
    gt(col: string, val: string) {
      this.filters.push((r) => String(r?.[col] ?? '') > val)
      return this
    }
    gte(col: string, val: string) {
      this.filters.push((r) => String(r?.[col] ?? '') >= val)
      return this
    }
    contains(col: string, needle: Record<string, unknown>) {
      this.filters.push((r) => matchesContains(r?.[col], needle))
      return this
    }
    order(col: string, opts?: { ascending?: boolean }) {
      this.orderCol = col
      this.orderAsc = opts?.ascending !== false
      return this
    }
    limit(n: number) {
      this.limitN = n
      return this
    }
    insert(rows: any) {
      this.pendingInsert = Array.isArray(rows) ? rows : [rows]
      return this
    }
    update(patch: Record<string, unknown>) {
      this.pendingUpdate = patch
      return this
    }

    private run() {
      const list = tables[this.table] ?? (tables[this.table] = [])
      if (this.pendingInsert) {
        for (const r of this.pendingInsert) {
          list.push({ id: r.id ?? `log-${list.length + 1}`, created_at: r.created_at ?? new Date().toISOString(), ...r })
        }
        return { data: this.pendingInsert, error: null, count: null }
      }
      let rows = list.filter((r) => this.filters.every((f) => f(r)))
      if (this.pendingUpdate) {
        for (const r of rows) Object.assign(r, this.pendingUpdate)
        return { data: rows, error: null, count: rows.length }
      }
      if (this.orderCol) {
        const c = this.orderCol
        rows = [...rows].sort((a, b) => (String(a?.[c] ?? '') < String(b?.[c] ?? '') ? (this.orderAsc ? -1 : 1) : this.orderAsc ? 1 : -1))
      }
      const total = rows.length
      if (this.limitN !== null) rows = rows.slice(0, this.limitN)
      if (this.countHead) return { data: null, error: null, count: total }
      return { data: rows, error: null, count: total }
    }

    async maybeSingle() {
      const res = this.run()
      return { data: Array.isArray(res.data) ? res.data[0] ?? null : null, error: null }
    }

    then<TResult1 = any, TResult2 = never>(
      onfulfilled?: ((value: any) => TResult1 | PromiseLike<TResult1>) | null,
      onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | null
    ) {
      return Promise.resolve(this.run()).then(onfulfilled, onrejected)
    }
  }

  return {
    tables,
    uploads,
    db: {
      from: (table: string) => new QueryBuilder(table),
      storage: {
        from(bucket: string) {
          return {
            async upload(path: string, buf: Buffer, opts: { contentType: string }) {
              uploads.push({ bucket, path, contentType: opts.contentType, size: buf.length })
              return { error: null }
            },
          }
        },
      },
    } as any,
  }
}

function buildApp(opts: {
  db: any
  primaryUserId?: string | null
  planner?: ExtensionPlanner
  now?: () => number
}) {
  const app = Fastify()
  app.register(extensionRoutes, {
    prefix: '/api/extension',
    db: opts.db,
    env: ENV,
    now: opts.now,
    planner: opts.planner,
    authenticatePrimary: async (req: any, reply: any) => {
      if (!opts.primaryUserId) return reply.status(401).send({ error: 'Unauthorized' })
      req.user = { id: opts.primaryUserId }
    },
  })
  return app
}

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
      { id: 'job-kalibrr', title: 'Backend Engineer', company: 'Acme', platform: 'kalibrr', external_url: 'https://www.kalibrr.com/c/acme/jobs/1', description: '' },
      { id: 'job-linkedin', title: 'Staff Dev', company: 'Beta', platform: 'linkedin', external_url: 'https://www.linkedin.com/jobs/view/123', description: '' },
      { id: 'job-used', title: 'QA', company: 'Gamma', platform: 'glints', external_url: 'https://glints.com/id/opportunities/jobs/1', description: '' },
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

test('POST /api/extension/plan-form: menolak LinkedIn, memblokir ai_prohibited tanpa memanggil AI, dan merencanakan radio+saved+AI', async () => {
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

  // 2. Canonical / larangan AI berhenti tanpa mengisi atau memanggil AI.
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
  assert.equal(noAiRes.json().blocked, 'ai_prohibited')
  assert.equal(noAiRes.json().actions.length, 0)
  assert.equal(aiCalls, 0)

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
  assert.equal(planned.pendingQuestions.length, 1)
  assert.equal(planned.pendingQuestions[0].key, 'describe a distributed system project')
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
    jobs: [{ id: 'job-1', platform: 'kalibrr', title: 'BE', company: 'Acme' }],
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

  // File bukan PNG asli ditolak (400)
  const badPngRes = await app.inject({
    method: 'POST',
    url: '/api/extension/report-run',
    headers: { authorization: `Bearer ${token}` },
    payload: {
      approvalId,
      jobId: 'job-1',
      pageUrl: 'https://www.kalibrr.com/apply',
      outcome: 'submitted',
      filledCount: 5,
      filledScreenshot: Buffer.from('<script>alert(1)</script>').toString('base64'),
    },
  })
  assert.equal(badPngRes.statusCode, 400)
  assert.equal(badPngRes.json().code, 'invalid_screenshot_png')

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
