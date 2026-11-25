import test from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import { FakeDb } from './helpers/fakeDb.ts'
import { approvalRoutes } from '../api/routes/approval.js'
import {
  approvalDispatchTarget,
  classifyJobChannel,
  routesToExtension,
} from '../services/apply-channel.js'

/**
 * E2E-01 (audit 26 Nov 2026): POST /api/approvals/:id/approve tidak boleh mengantrekan
 * pekerjaan worker (`apply`) maupun ekstensi (`extension_apply`) untuk lowongan `email_direct`
 * atau `manualOnly` (LinkedIn), termasuk lowongan portal (mis. JobStreet) yang deskripsinya
 * memuat alamat email rekruter valid.
 */

const USER_ID = '11111111-1111-4111-8111-111111111111'
const JOB_ID = '22222222-2222-4222-8222-222222222222'
const APP_ID = '33333333-3333-4333-8333-333333333333'
const APPROVAL_ID = '44444444-4444-4444-8444-444444444444'
const FUTURE = new Date(Date.now() + 3_600_000).toISOString()

function buildHarness(jobRow: Record<string, any>) {
  const db = new FakeDb({
    jobs: [{ id: JOB_ID, title: 'Backend Engineer', company: 'PT Contoh', ...jobRow }],
    ai_applications: [{ id: APP_ID, user_id: USER_ID, job_id: JOB_ID, status: 'ready', cover_letter: 'Surat awal' }],
    approval_requests: [
      {
        id: APPROVAL_ID,
        user_id: USER_ID,
        job_id: JOB_ID,
        application_id: APP_ID,
        job_title: 'Backend Engineer',
        company: 'PT Contoh',
        platform: jobRow.platform_source ?? 'web',
        cover_letter: 'Surat awal',
        status: 'pending',
        expires_at: FUTURE,
      },
    ],
    user_automation_settings: [{ id: 's1', user_id: USER_ID, extension_auto_use: true }],
  })

  const queued: Array<{ kind: 'worker' | 'extension'; userId: string; approvalId: string }> = []
  const queue = {
    async addApprovedApplyJob(userId: string, approvalId: string) {
      queued.push({ kind: 'worker', userId, approvalId })
      return { id: 'q-worker-1' }
    },
    async addApprovedExtensionApplyJob(userId: string, approvalId: string) {
      queued.push({ kind: 'extension', userId, approvalId })
      return { id: 'q-ext-1' }
    },
  }

  return { db, queue, queued }
}

async function approveWith(jobRow: Record<string, any>, body: Record<string, any> = {}) {
  const { db, queue, queued } = buildHarness(jobRow)
  const app = Fastify()
  app.addHook('preHandler', async (req: any) => {
    req.user = { id: USER_ID }
  })
  await app.register(approvalRoutes, {
    prefix: '/api/approvals',
    db: db as any,
    queue: queue as any,
    guard: { checkActionRateLimit: async () => {} },
  })
  const res = await app.inject({
    method: 'POST',
    url: `/api/approvals/${APPROVAL_ID}/approve`,
    payload: body,
  })
  await app.close()
  return { res, body: res.json(), db, queued }
}

test('routesToExtension & approvalDispatchTarget: email_direct pada URL JobStreet tidak dirutekan ke ekstensi maupun worker', () => {
  const jobstreetWithEmail = classifyJobChannel({
    platform: 'jobstreet',
    external_url: 'https://id.jobstreet.com/id/job/999',
    description: 'Kirim lamaran dan CV ke rekrutmen@perusahaan.co.id sebelum Jumat.',
  })
  assert.equal(jobstreetWithEmail.channel, 'email_direct')
  assert.equal(routesToExtension(jobstreetWithEmail), false)
  assert.equal(approvalDispatchTarget(jobstreetWithEmail), 'email_direct')

  const linkedin = classifyJobChannel({
    platform: 'linkedin',
    external_url: 'https://www.linkedin.com/jobs/view/123456/',
  })
  assert.equal(linkedin.manualOnly, true)
  assert.equal(routesToExtension(linkedin), false)
  assert.equal(approvalDispatchTarget(linkedin), 'manual')

  const jobstreetPortal = classifyJobChannel({
    platform: 'jobstreet',
    external_url: 'https://id.jobstreet.com/id/job/999',
    description: 'Lamar langsung lewat tombol di portal.',
  })
  assert.equal(routesToExtension(jobstreetPortal), true)
  assert.equal(approvalDispatchTarget(jobstreetPortal), 'extension')

  const greenhouse = classifyJobChannel({
    platform: 'greenhouse',
    external_url: 'https://boards.greenhouse.io/acme/jobs/123',
  })
  assert.equal(approvalDispatchTarget(greenhouse), 'worker')
})

test('POST /:id/approve pada lowongan email_direct menyetujui persetujuan tanpa mengantrekan worker atau ekstensi', async () => {
  const { res, body, db, queued } = await approveWith(
    {
      platform_source: 'jobstreet',
      external_url: 'https://id.jobstreet.com/id/job/777',
      description: 'Silakan kirim CV ke hr@contoh.co.id',
    },
    { cover_letter: 'Surat yang disetujui untuk email' }
  )

  assert.equal(res.statusCode, 200)
  assert.equal(body.success, true)
  assert.equal(body.queue_job_id, null)
  assert.equal(body.apply_channel, 'email_direct')
  assert.equal(body.queued, false)
  assert.equal(queued.length, 0, 'worker dan ekstensi tidak boleh diantrekan untuk email_direct')

  const approval = db.rows('approval_requests')[0]
  assert.equal(approval.status, 'approved')
  assert.ok(approval.reviewed_at)
  assert.equal(approval.cover_letter, 'Surat yang disetujui untuk email')
  assert.equal(approval.apply_channel, undefined, 'tidak menulis nilai di luar CHECK constraint DB')
  assert.equal(db.rows('ai_applications')[0].cover_letter, 'Surat yang disetujui untuk email')
})

test('POST /:id/approve pada lowongan LinkedIn (manualOnly) menyetujui persetujuan tanpa mengantrekan worker atau ekstensi', async () => {
  const { res, body, db, queued } = await approveWith({
    platform_source: 'linkedin',
    external_url: 'https://www.linkedin.com/jobs/view/4012345678/',
    description: 'Apply on LinkedIn',
  })

  assert.equal(res.statusCode, 200)
  assert.equal(body.success, true)
  assert.equal(body.queue_job_id, null)
  assert.equal(body.apply_channel, 'manual')
  assert.equal(body.queued, false)
  assert.equal(body.manual_only, true)
  assert.equal(queued.length, 0, 'LinkedIn tidak boleh masuk antrean worker maupun ekstensi')

  const approval = db.rows('approval_requests')[0]
  assert.equal(approval.status, 'approved')
  assert.ok(approval.reviewed_at)
  assert.equal(approval.apply_channel, undefined)
})

test('POST /:id/approve pada ATS publik tetap mengantrekan worker dan portal login tetap ke ekstensi', async () => {
  const gh = await approveWith({
    platform_source: 'greenhouse',
    external_url: 'https://boards.greenhouse.io/acme/jobs/1',
    description: 'Apply via Greenhouse',
  })
  assert.equal(gh.res.statusCode, 200)
  assert.equal(gh.body.apply_channel, 'worker')
  assert.equal(gh.body.queue_job_id, 'q-worker-1')
  assert.deepEqual(gh.queued, [{ kind: 'worker', userId: USER_ID, approvalId: APPROVAL_ID }])

  const js = await approveWith({
    platform_source: 'jobstreet',
    external_url: 'https://id.jobstreet.com/id/job/888',
    description: 'Lamar di JobStreet tanpa email',
  })
  assert.equal(js.res.statusCode, 200)
  assert.equal(js.body.apply_channel, 'extension')
  assert.equal(js.body.queue_job_id, 'q-ext-1')
  assert.deepEqual(js.queued, [{ kind: 'extension', userId: USER_ID, approvalId: APPROVAL_ID }])
})
