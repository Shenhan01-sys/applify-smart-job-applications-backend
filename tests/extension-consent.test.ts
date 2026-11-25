import test from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import { approvalRoutes } from '../api/routes/approval.js'
import { classifyJobChannel, EXTENSION_HOST_DOMAINS, isExtensionUrl, routesToExtension } from '../services/apply-channel.js'
import { decideExtensionConsent } from '../services/extension-consent.js'
import { makeExtensionTestDb, OTHER_USER_ID, USER_ID } from './extension-test-db.js'

/**
 * Routing ke ekstensi hanya untuk host yang bisa dibuka ekstensi, dan persetujuan portal butuh izin pengguna
 * (extension_auto_use atau POST /api/approvals/:id/extension-consent). Tanpa jaringan, DB tiruan.
 */

const FUTURE = new Date(Date.now() + 3600_000).toISOString()
const PAST = new Date(Date.now() - 3600_000).toISOString()

const JOB_PORTAL = '22222222-2222-4222-8222-222222222301'
const JOB_ATS = '22222222-2222-4222-8222-222222222302'
const JOB_UNKNOWN = '22222222-2222-4222-8222-222222222303'
const JOB_LINKEDIN = '22222222-2222-4222-8222-222222222304'
const JOB_EMAIL = '22222222-2222-4222-8222-222222222305'

const APPROVAL = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa0001'

const jobs = [
  { id: JOB_PORTAL, title: 'Backend Engineer', company: 'Acme', platform_source: 'jobstreet', external_url: 'https://id.jobstreet.com/id/job/1', description: '' },
  { id: JOB_ATS, title: 'Platform Engineer', company: 'Acme', platform_source: 'greenhouse', external_url: 'https://boards.greenhouse.io/acme/jobs/2', description: '' },
  { id: JOB_UNKNOWN, title: 'Analyst', company: 'Acme', platform_source: 'web', external_url: 'https://karir.acme.test/lowongan/3', description: '' },
  { id: JOB_LINKEDIN, title: 'PM', company: 'Acme', platform_source: 'linkedin', external_url: 'https://www.linkedin.com/jobs/view/4', description: '' },
  { id: JOB_EMAIL, title: 'Admin', company: 'Acme', platform_source: 'web', external_url: 'https://karir.acme.test/lowongan/5', description: 'Kirim CV ke hrd@acme.co.id' },
]

const approval = (over: Record<string, any> = {}) => ({
  id: APPROVAL,
  user_id: USER_ID,
  job_id: JOB_PORTAL,
  application_id: 'app-1',
  job_title: 'Backend Engineer',
  company: 'Acme',
  platform: 'jobstreet',
  status: 'pending',
  expires_at: FUTURE,
  ...over,
})

async function build(seed: Record<string, any[]> = {}, options: Parameters<typeof makeExtensionTestDb>[1] = {}, userId: string | null = USER_ID) {
  const store = makeExtensionTestDb(
    { jobs, ai_applications: [{ id: 'app-1', user_id: USER_ID, status: 'pending_approval' }], ...seed },
    options
  )
  const app = Fastify()
  app.addHook('preHandler', async (req: any) => {
    if (userId) req.user = { id: userId }
  })
  await app.register(approvalRoutes, {
    prefix: '/api/approvals',
    db: store.db,
    guard: { checkActionRateLimit: async () => ({ allowed: true }) as any },
  })
  return { store, app }
}

const approve = (app: any, id = APPROVAL) => app.inject({ method: 'POST', url: `/api/approvals/${id}/approve`, payload: {} })
const consent = (app: any, payload: unknown = {}, id = APPROVAL) =>
  app.inject({ method: 'POST', url: `/api/approvals/${id}/extension-consent`, payload })
const queueOf = (store: any) => store.tables.automation_queue.filter((r: any) => r.payload?.approval_request_id === APPROVAL)

// ---- Routing berdasarkan host -------------------------------------------------------------------------

test('EXTENSION_HOST_DOMAINS memuat portal login dan ATS dikenal, bukan LinkedIn atau situs acak', () => {
  for (const d of ['jobstreet.co.id', 'glints.com', 'kalibrr.id', 'dealls.com', 'greenhouse.io', 'myworkdayjobs.com', 'keka.com']) {
    assert.ok(EXTENSION_HOST_DOMAINS.includes(d), d)
  }
  assert.equal(isExtensionUrl('https://www.linkedin.com/jobs/view/1'), false)
  assert.equal(isExtensionUrl('https://karir.acme.test/x'), false)
  assert.equal(isExtensionUrl('https://evil-jobstreet.com/x'), false)
  assert.equal(isExtensionUrl('https://id.jobstreet.com/x'), true)
  assert.equal(isExtensionUrl('javascript:alert(1)'), false)
  assert.equal(isExtensionUrl(null), false)
})

test('routesToExtension: false untuk situs eksternal tak dikenal, email langsung di host asing, LinkedIn; true untuk portal login', () => {
  assert.equal(routesToExtension(classifyJobChannel({ external_url: 'https://karir.acme.test/lowongan/3' })), false)
  assert.equal(routesToExtension(classifyJobChannel({ external_url: 'https://karir.acme.test/x', description: 'Kirim ke hrd@acme.co.id' })), false)
  assert.equal(routesToExtension(classifyJobChannel({ external_url: 'https://www.linkedin.com/jobs/view/1' })), false)
  assert.equal(routesToExtension(classifyJobChannel({ external_url: 'https://id.jobstreet.com/id/job/1' })), true)
  assert.equal(routesToExtension(classifyJobChannel({ external_url: 'https://acme.myworkdayjobs.com/en/careers/job/1' })), true)
  // ATS publik diisi worker, bukan ekstensi.
  assert.equal(routesToExtension(classifyJobChannel({ external_url: 'https://boards.greenhouse.io/acme/jobs/2' })), false)
  assert.equal(routesToExtension(null), false)
})

test('approve: situs eksternal tak dikenal tetap ke worker (apply), bukan extension_apply', async () => {
  const { store, app } = await build({ approval_requests: [approval({ job_id: JOB_UNKNOWN })] })
  const res = await approve(app)
  assert.equal(res.statusCode, 200, res.body)
  assert.equal(res.json().apply_channel, 'worker')
  assert.equal(res.json().extension_consent_required, undefined)
  assert.equal(queueOf(store)[0].job_type, 'apply')
  assert.equal(store.tables.approval_requests[0].apply_channel, 'worker')
})

test('approve: email langsung tidak diantrekan ke worker/ekstensi (E2E-01)', async () => {
  const { store, app } = await build({ approval_requests: [approval({ job_id: JOB_EMAIL })] })
  const res = await approve(app)
  assert.equal(res.statusCode, 200, res.body)
  assert.equal(res.json().apply_channel, 'email_direct')
  assert.equal(res.json().extension_consent_required, undefined)
  assert.equal(res.json().queue_job_id, null)
  assert.equal(queueOf(store).length, 0)
})

test('approve: ATS publik ke worker; LinkedIn tidak diantrekan ke worker (manual, E2E-01), tanpa permintaan izin', async () => {
  const ats = await build({ approval_requests: [approval({ job_id: JOB_ATS })] })
  const resAts = await approve(ats.app)
  assert.equal(resAts.statusCode, 200, resAts.body)
  assert.equal(resAts.json().apply_channel, 'worker', JOB_ATS)
  assert.equal(resAts.json().extension_consent_required, undefined, JOB_ATS)
  assert.equal(queueOf(ats.store)[0].job_type, 'apply', JOB_ATS)

  const li = await build({ approval_requests: [approval({ job_id: JOB_LINKEDIN })] })
  const resLi = await approve(li.app)
  assert.equal(resLi.statusCode, 200, resLi.body)
  assert.equal(resLi.json().apply_channel, 'manual', JOB_LINKEDIN)
  assert.equal(resLi.json().extension_consent_required, undefined, JOB_LINKEDIN)
  assert.equal(resLi.json().queue_job_id, null, JOB_LINKEDIN)
  assert.equal(queueOf(li.store).length, 0, JOB_LINKEDIN)
})

// ---- Izin pengguna saat approve -----------------------------------------------------------------------

test('approve portal login tanpa extension_auto_use: tidak diantrekan, balasan meminta izin', async () => {
  const { store, app } = await build({ approval_requests: [approval()] })
  const res = await approve(app)
  assert.equal(res.statusCode, 200, res.body)
  const body = res.json()
  assert.equal(body.success, true)
  assert.equal(body.apply_channel, 'extension')
  assert.equal(body.extension_consent_required, true)
  assert.equal(body.queue_job_id, null)
  assert.equal(queueOf(store).length, 0)
  assert.equal(store.tables.approval_requests[0].status, 'approved')
  assert.equal(store.tables.approval_requests[0].apply_channel, 'extension')
})

test('approve portal login dengan extension_auto_use=false eksplisit: tetap meminta izin', async () => {
  const { store, app } = await build({
    approval_requests: [approval()],
    user_automation_settings: [{ id: 's1', user_id: USER_ID, extension_auto_use: false }],
  })
  const res = await approve(app)
  assert.equal(res.json().extension_consent_required, true)
  assert.equal(queueOf(store).length, 0)
})

test('approve portal login dengan extension_auto_use=true: langsung extension_apply', async () => {
  const { store, app } = await build({
    approval_requests: [approval()],
    user_automation_settings: [{ id: 's1', user_id: USER_ID, extension_auto_use: true }],
  })
  const res = await approve(app)
  assert.equal(res.statusCode, 200, res.body)
  assert.equal(res.json().apply_channel, 'extension')
  assert.equal(res.json().extension_consent_required, undefined)
  assert.ok(res.json().queue_job_id)
  assert.equal(queueOf(store)[0].job_type, 'extension_apply')
})

test('approve: extension_auto_use milik pengguna lain tidak berlaku', async () => {
  const { store, app } = await build({
    approval_requests: [approval()],
    user_automation_settings: [{ id: 's1', user_id: OTHER_USER_ID, extension_auto_use: true }],
  })
  const res = await approve(app)
  assert.equal(res.json().extension_consent_required, true)
  assert.equal(queueOf(store).length, 0)
})

test('approve sebelum migrasi (kolom extension_auto_use dan apply_channel belum ada): dianggap false, minta izin', async () => {
  const { store, app } = await build(
    { approval_requests: [approval()] },
    { missingColumns: { user_automation_settings: ['extension_auto_use'], approval_requests: ['apply_channel'] } }
  )
  const res = await approve(app)
  assert.equal(res.statusCode, 200, res.body)
  assert.equal(res.json().extension_consent_required, true)
  assert.equal(queueOf(store).length, 0)
  assert.equal(store.tables.approval_requests[0].status, 'approved')

  // Izin lalu diberikan: antre extension_apply tetap berjalan tanpa kolom baru.
  const ok = await consent(app, { always: true })
  assert.equal(ok.statusCode, 200, ok.body)
  assert.equal(queueOf(store)[0].job_type, 'extension_apply')
  assert.equal(ok.json().extension_auto_use, false)
})

// ---- POST /:id/extension-consent ----------------------------------------------------------------------

test('extension-consent: persetujuan portal yang menunggu izin diantrekan, payload sama dengan approve', async () => {
  const { store, app } = await build({ approval_requests: [approval()] })
  await approve(app)
  const res = await consent(app, {})
  assert.equal(res.statusCode, 200, res.body)
  const body = res.json()
  assert.equal(body.queued, true)
  assert.ok(body.queue_job_id)
  const rows = queueOf(store)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].job_type, 'extension_apply')
  assert.equal(rows[0].status, 'pending')
  assert.equal(rows[0].user_id, USER_ID)
  assert.deepEqual(rows[0].payload, { job_id: JOB_PORTAL, application_id: 'app-1', approval_request_id: APPROVAL, approved: true })
  // Tanpa always: pilihan permanen tidak disimpan.
  assert.equal(store.tables.user_automation_settings.length, 0)
  assert.equal('extension_auto_use' in body, false)
})

test('extension-consent always:true menyimpan extension_auto_use, persetujuan berikutnya langsung diantrekan', async () => {
  const { store, app } = await build({ approval_requests: [approval()] })
  await approve(app)
  const res = await consent(app, { always: true })
  assert.equal(res.statusCode, 200, res.body)
  assert.equal(res.json().extension_auto_use, true)
  assert.equal(store.tables.user_automation_settings[0].user_id, USER_ID)
  assert.equal(store.tables.user_automation_settings[0].extension_auto_use, true)

  // Persetujuan kedua (lowongan sama tetapi baris lain) langsung diantrekan tanpa meminta izin.
  const second = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa0002'
  store.tables.approval_requests.push(approval({ id: second }))
  const res2 = await approve(app, second)
  assert.equal(res2.json().extension_consent_required, undefined)
  assert.ok(res2.json().queue_job_id)
})

test('extension-consent always:true memperbarui baris pengaturan yang sudah ada', async () => {
  const { store, app } = await build({
    approval_requests: [approval()],
    user_automation_settings: [{ id: 's1', user_id: USER_ID, first_name: 'Budi', extension_auto_use: false }],
  })
  await approve(app)
  const res = await consent(app, { always: true })
  assert.equal(res.statusCode, 200, res.body)
  assert.equal(store.tables.user_automation_settings.length, 1)
  assert.equal(store.tables.user_automation_settings[0].extension_auto_use, true)
  assert.equal(store.tables.user_automation_settings[0].first_name, 'Budi')
})

test('extension-consent: 409 bila sudah ada tugas apply atau extension_apply aktif', async () => {
  for (const job_type of ['apply', 'extension_apply']) {
    for (const status of ['pending', 'processing']) {
      const { store, app } = await build({
        approval_requests: [approval({ status: 'approved', apply_channel: job_type === 'apply' ? 'worker' : 'extension' })],
        automation_queue: [{ id: 'q1', user_id: USER_ID, job_type, status, payload: { approval_request_id: APPROVAL } }],
      })
      const res = await consent(app, { always: true })
      assert.equal(res.statusCode, 409, `${job_type}/${status}`)
      assert.equal(res.json().code, 'already_active')
      assert.equal(store.tables.automation_queue.length, 1)
      assert.equal(store.tables.user_automation_settings.length, 0, 'pilihan permanen tidak disimpan bila gagal')
    }
  }
})

test('extension-consent: dua panggilan beruntun, yang kedua 409 dan antrean tetap satu', async () => {
  const { store, app } = await build({ approval_requests: [approval()] })
  await approve(app)
  const a = await consent(app, {})
  const b = await consent(app, {})
  assert.equal(a.statusCode, 200)
  assert.equal(b.statusCode, 409)
  assert.equal(queueOf(store).length, 1)
})

test('extension-consent: dua permintaan bersamaan, tepat satu yang masuk antrean', async () => {
  const { store, app } = await build({ approval_requests: [approval({ status: 'approved', apply_channel: 'extension' })] })
  const [a, b] = await Promise.all([consent(app, {}), consent(app, {})])
  assert.deepEqual([a.statusCode, b.statusCode].sort(), [200, 409])
  assert.equal(queueOf(store).length, 1)
})

test('extension-consent: 409 sesudah lamaran terkirim (log success) atau klaim kirim terpakai', async () => {
  const sent = await build({
    approval_requests: [approval({ status: 'approved' })],
    application_logs: [{ id: 'l1', user_id: USER_ID, status: 'success', details: { approval_request_id: APPROVAL } }],
  })
  const r1 = await consent(sent.app, {})
  assert.equal(r1.statusCode, 409)
  assert.equal(r1.json().code, 'already_submitted')
  assert.equal(queueOf(sent.store).length, 0)

  const claimed = await build({
    approval_requests: [approval({ status: 'approved' })],
    approval_submit_claims: [{ approval_request_id: APPROVAL, status: 'claimed' }],
  })
  const r2 = await consent(claimed.app, {})
  assert.equal(r2.statusCode, 409)
  assert.equal(queueOf(claimed.store).length, 0)
})

test('extension-consent: kedaluwarsa 410, belum disetujui 409, bukan milik pengguna 404, tanpa login 401, id rusak 400', async () => {
  const expired = await build({ approval_requests: [approval({ status: 'approved', expires_at: PAST })] })
  assert.equal((await consent(expired.app, {})).statusCode, 410)
  assert.equal(queueOf(expired.store).length, 0)

  const pending = await build({ approval_requests: [approval({ status: 'pending' })] })
  const rp = await consent(pending.app, {})
  assert.equal(rp.statusCode, 409)
  assert.equal(rp.json().code, 'not_approved')

  const rejected = await build({ approval_requests: [approval({ status: 'rejected' })] })
  assert.equal((await consent(rejected.app, {})).statusCode, 409)

  const foreign = await build({ approval_requests: [approval({ status: 'approved', user_id: OTHER_USER_ID })] })
  const rf = await consent(foreign.app, {})
  assert.equal(rf.statusCode, 404)
  assert.equal(queueOf(foreign.store).length, 0)

  const anon = await build({ approval_requests: [approval({ status: 'approved' })] }, {}, null)
  assert.equal((await consent(anon.app, {})).statusCode, 401)

  const bad = await build({ approval_requests: [approval({ status: 'approved' })] })
  assert.equal((await consent(bad.app, {}, 'bukan-uuid')).statusCode, 400)
})

test('extension-consent: LinkedIn (manual saja) ditolak 409 manual_only', async () => {
  const { store, app } = await build({ approval_requests: [approval({ status: 'approved', job_id: JOB_LINKEDIN, apply_channel: 'worker' })] })
  const res = await consent(app, {})
  assert.equal(res.statusCode, 409)
  assert.equal(res.json().code, 'manual_only')
  assert.equal(queueOf(store).length, 0)
})

test('extension-consent: worker sudah selesai dengan auth_required, belum terkirim: dialihkan ke ekstensi', async () => {
  const { store, app } = await build({
    approval_requests: [approval({ status: 'approved', job_id: JOB_UNKNOWN, apply_channel: 'worker' })],
    automation_queue: [
      {
        id: 'q-old', user_id: USER_ID, job_type: 'apply', status: 'completed',
        payload: { approval_request_id: APPROVAL, job_id: JOB_UNKNOWN },
        result: { status: 'blocked', reason: 'auth_required' },
      },
    ],
    application_logs: [{ id: 'l1', user_id: USER_ID, status: 'blocked', details: { approval_request_id: APPROVAL, reason: 'auth_required' } }],
  })
  const res = await consent(app, { always: false })
  assert.equal(res.statusCode, 200, res.body)
  const ext = store.tables.automation_queue.find((r: any) => r.job_type === 'extension_apply')
  assert.ok(ext)
  assert.equal(ext.status, 'pending')
  assert.equal(store.tables.approval_requests[0].apply_channel, 'extension')
})

test('extension-consent: kanal approval dikembalikan bila antre gagal (tidak terkunci di kanal ekstensi)', async () => {
  const { store, app } = await build(
    { approval_requests: [approval({ status: 'approved', job_id: JOB_UNKNOWN, apply_channel: 'worker' })] },
    { failTables: { automation_queue: { code: 'XX000', message: 'boom' } } }
  )
  const res = await consent(app, {})
  assert.equal(res.statusCode, 500)
  assert.equal(res.json().code, 'consent_failed')
  assert.doesNotMatch(res.body, /boom/)
  assert.equal(store.tables.approval_requests[0].apply_channel, 'worker')
})

test('decideExtensionConsent: urutan aturan', () => {
  const now = new Date('2026-11-24T10:00:00Z')
  const base = { approval: { status: 'approved', expires_at: '2026-11-25T10:00:00Z', job_id: 'j' }, now, usedCount: 0, activeCount: 0, totalCount: 0 }
  assert.deepEqual(decideExtensionConsent(base), { ok: true })
  assert.equal((decideExtensionConsent({ ...base, approval: null }) as any).status, 404)
  assert.equal((decideExtensionConsent({ ...base, usedCount: 1, activeCount: 1 }) as any).code, 'already_submitted')
  assert.equal((decideExtensionConsent({ ...base, activeCount: 1 }) as any).code, 'already_active')
  assert.equal((decideExtensionConsent({ ...base, totalCount: 6 }) as any).status, 429)
})
