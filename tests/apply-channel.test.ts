import test from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import {
  AUTH_PORTAL_DOMAINS,
  EXTENSION_LOGIN_PORTAL_DOMAINS,
  PUBLIC_ATS_DOMAINS,
  classifyJobChannel,
  extractApplyEmail,
  extractPublicAtsUrl,
  isLoginPortalHost,
} from '../services/apply-channel.js'
import { KNOWN_ATS_DOMAINS } from '../services/page-host.js'
import { jobRoutes } from '../api/routes/jobs.js'

test('classifyJobChannel: Greenhouse / Lever URL diklasifikasikan sebagai public_ats dan mendukung worker', () => {
  const gh = classifyJobChannel({
    platform: 'greenhouse',
    external_url: 'https://boards.greenhouse.io/acme/jobs/12345',
  })
  assert.equal(gh.channel, 'public_ats')
  assert.equal(gh.autoWorkerSupported, true)
  assert.equal(gh.extensionSupported, true)
  assert.equal(gh.manualOnly, false)

  const lever = classifyJobChannel({
    platform: 'career',
    external_url: 'https://jobs.lever.co/acme/ab12-cd34',
  })
  assert.equal(lever.channel, 'public_ats')
  assert.equal(lever.autoWorkerSupported, true)
})

test('classifyJobChannel: lowongan portal dengan tautan ATS publik di deskripsi ditingkatkan menjadi public_ats', () => {
  const res = classifyJobChannel({
    platform: 'jobstreet',
    external_url: 'https://id.jobstreet.com/job/999999',
    description: 'Please apply via our ATS at https://jobs.ashbyhq.com/acme/backend-engineer.',
  })
  assert.equal(res.channel, 'public_ats')
  assert.equal(res.resolvedApplyUrl, 'https://jobs.ashbyhq.com/acme/backend-engineer')
  assert.equal(res.applyUrl, 'https://jobs.ashbyhq.com/acme/backend-engineer')
  assert.equal(res.autoWorkerSupported, true)
})

test('classifyJobChannel: lowongan LinkedIn selalu manualOnly dan menonaktifkan worker maupun ekstensi', () => {
  const li = classifyJobChannel({
    platform: 'linkedin',
    external_url: 'https://www.linkedin.com/jobs/view/4012345678/',
    description: 'Kirim lamaran atau kontak jobs@acme.io',
  })
  assert.equal(li.manualOnly, true)
  assert.equal(li.autoWorkerSupported, false)
  assert.equal(li.extensionSupported, false)
  assert.equal(li.channel, 'auth_portal')
})

test('classifyJobChannel: JobStreet/Glints/Kalibrr tanpa ATS/email diklasifikasikan sebagai auth_portal (pakai ekstensi)', () => {
  for (const url of [
    'https://id.jobstreet.com/id/job/123',
    'https://www.kalibrr.com/c/acme/jobs/123',
    'https://glints.com/id/opportunities/jobs/abc/123',
    'https://acme.wd5.myworkdayjobs.com/en-US/Careers/job/SWE_1',
  ]) {
    const res = classifyJobChannel({ external_url: url })
    assert.equal(res.channel, 'auth_portal')
    assert.equal(res.autoWorkerSupported, false)
    assert.equal(res.extensionSupported, true)
    assert.equal(res.manualOnly, false)
  }
})

test('classifyJobChannel: email rekruter valid di deskripsi diklasifikasikan sebagai email_direct dan mengabaikan noreply/example', () => {
  assert.equal(
    extractApplyEmail('No-reply: noreply@company.com or privacy@company.com. Send CV to talent@acme.co.id!'),
    'talent@acme.co.id'
  )
  assert.equal(extractApplyEmail('Test sample@example.com or sentry@sentry.io'), null)

  const res = classifyJobChannel({
    platform: 'dealls',
    external_url: 'https://dealls.com/loker/backend',
    description: 'Kirim CV dan portofolio ke hiring@startup.id sebelum Jumat.',
  })
  assert.equal(res.channel, 'email_direct')
  assert.equal(res.applyEmail, 'hiring@startup.id')
  assert.equal(res.emailApplySupported, true)
  assert.equal(res.autoWorkerSupported, false)
})

test('extractPublicAtsUrl: menolak skema non-http(s) seperti javascript:', () => {
  assert.equal(extractPublicAtsUrl('javascript:alert(1) https://apply.workable.com/j/ABC123'), 'https://apply.workable.com/j/ABC123')
  assert.equal(classifyJobChannel({ external_url: 'javascript:alert(1)' }).applyUrl, null)
})

test('GET /api/jobs/:id/channel: butuh auth, validasi id, kembalikan 404 atau klasifikasi kanal', async () => {
  const app = Fastify()
  const selectedColumns: string[] = []
  const fakeDb: any = {
    from() {
      return {
        select(cols: string) {
          // jobs tidak punya kolom `platform` (kolomnya `platform_source`): memilihnya membuat PostgREST menolak kueri.
          selectedColumns.push(cols)
          return this
        },
        eq(_col: string, val: string) {
          this._id = val
          return this
        },
        async maybeSingle() {
          if (this._id === 'job-1') {
            return {
              data: {
                id: 'job-1',
                platform: 'kalibrr',
                external_url: 'https://www.kalibrr.com/c/acme/jobs/1',
                description: 'Apply online',
              },
              error: null,
            }
          }
          return { data: null, error: null }
        },
      }
    },
  }

  let currentUser: string | null = 'user-1'
  app.addHook('preHandler', async (req: any) => {
    if (currentUser) req.user = { id: currentUser }
  })
  await app.register(jobRoutes, { prefix: '/api/jobs', db: fakeDb })

  currentUser = null
  const r401 = await app.inject({ method: 'GET', url: '/api/jobs/job-1/channel' })
  assert.equal(r401.statusCode, 401)

  currentUser = 'user-1'
  const rBadId = await app.inject({ method: 'GET', url: '/api/jobs/bad%20id!/channel' })
  assert.equal(rBadId.statusCode, 404)

  const rMissing = await app.inject({ method: 'GET', url: '/api/jobs/unknown/channel' })
  assert.equal(rMissing.statusCode, 404)

  const rOk = await app.inject({ method: 'GET', url: '/api/jobs/job-1/channel' })
  assert.equal(rOk.statusCode, 200)
  const body = rOk.json()
  assert.equal(body.channel, 'auth_portal')
  assert.equal(body.extensionSupported, true)
  assert.equal(body.manualOnly, false)
  assert.ok(selectedColumns.length > 0)
  for (const cols of selectedColumns) {
    assert.ok(cols.split(',').map((c) => c.trim()).includes('platform_source'), cols)
    assert.ok(!cols.split(',').map((c) => c.trim()).includes('platform'), cols)
  }
})

// ---- Portal login yang diisi ekstensi: JobStreet, Glints, Kalibrr, Dealls ------------------------------------------

test('EXTENSION_LOGIN_PORTAL_DOMAINS: enam domain portal, termasuk di AUTH_PORTAL_DOMAINS, tidak pernah di daftar ATS publik', () => {
  assert.deepEqual([...EXTENSION_LOGIN_PORTAL_DOMAINS].sort(), [
    'dealls.com',
    'glints.com',
    'jobstreet.co.id',
    'jobstreet.com',
    'kalibrr.com',
    'kalibrr.id',
  ])
  for (const d of EXTENSION_LOGIN_PORTAL_DOMAINS) {
    assert.ok((AUTH_PORTAL_DOMAINS as readonly string[]).includes(d), `${d} harus ada di AUTH_PORTAL_DOMAINS`)
    assert.equal((PUBLIC_ATS_DOMAINS as readonly string[]).includes(d), false, `${d} tidak boleh jadi ATS publik (jalur worker)`)
    assert.equal(KNOWN_ATS_DOMAINS.includes(d), false, `${d} tidak boleh jadi KNOWN_ATS_DOMAINS (daftar ATS yang dikenal worker)`)
  }
  // Tidak ada domain portal login yang diam-diam menumpang di daftar ATS atau sebaliknya.
  for (const d of KNOWN_ATS_DOMAINS) assert.equal(isLoginPortalHost(d), false, d)
})

test('isLoginPortalHost: domain, subdomain, dan www cocok; host mirip dan awalan menempel ditolak', () => {
  for (const host of [
    'id.jobstreet.com',
    'www.jobstreet.com',
    'jobstreet.com',
    'jobstreet.co.id',
    'www.jobstreet.co.id',
    'glints.com',
    'www.glints.com',
    'kalibrr.com',
    'www.kalibrr.com',
    'kalibrr.id',
    'dealls.com',
    'api.dealls.com',
    'ID.JobStreet.COM',
  ]) {
    assert.equal(isLoginPortalHost(host), true, host)
  }
  for (const host of [
    'glints.com.evil.test',
    'notdealls.com',
    'evil-glints.com',
    'jobstreet.com.evil.test',
    'jobstreet.co.id.evil.test',
    'kalibrr.id.evil.test',
    'kalibrr.net',
    'dealls.co',
    'linkedin.com',
    '',
  ]) {
    assert.equal(isLoginPortalHost(host), false, host)
  }
})

test('classifyJobChannel: tiap portal login (termasuk id.jobstreet.com, jobstreet.co.id, kalibrr.id) menuju ekstensi, bukan worker', () => {
  for (const url of [
    'https://id.jobstreet.com/id/job/123',
    'https://www.jobstreet.co.id/id/job/123',
    'https://glints.com/id/opportunities/jobs/abc/123',
    'https://www.kalibrr.com/c/acme/jobs/123',
    'https://www.kalibrr.id/c/acme/jobs/123',
    'https://dealls.com/loker/backend-engineer~acme',
  ]) {
    const res = classifyJobChannel({ external_url: url })
    assert.equal(res.channel, 'auth_portal', url)
    assert.equal(res.autoWorkerSupported, false, `${url}: worker tidak boleh mengisi/mengirim di portal login`)
    assert.equal(res.emailApplySupported, false, url)
    assert.equal(res.extensionSupported, true, url)
    assert.equal(res.manualOnly, false, url)
    assert.equal(res.applyUrl, url)
  }
})

test('classifyJobChannel: label platform ATS pada URL portal login tidak mengirim lowongan ke worker', () => {
  for (const platform of ['greenhouse', 'lever', 'workable', 'bamboohr']) {
    const res = classifyJobChannel({ platform, external_url: 'https://id.jobstreet.com/id/job/123' })
    assert.equal(res.channel, 'auth_portal', platform)
    assert.equal(res.autoWorkerSupported, false, platform)
    assert.equal(res.extensionSupported, true, platform)
  }
  // Kontrol: label ATS pada URL ATS tetap ke worker.
  const ok = classifyJobChannel({ platform: 'greenhouse', external_url: 'https://boards.greenhouse.io/acme/jobs/1' })
  assert.equal(ok.channel, 'public_ats')
  assert.equal(ok.autoWorkerSupported, true)
})

test('classifyJobChannel: host mirip portal login bukan auth_portal dan tidak pernah mendukung worker', () => {
  for (const url of [
    'https://glints.com.evil.test/id/opportunities/jobs/abc',
    'https://notdealls.com/loker/x',
    'https://jobstreet.com.evil.test/job/1',
    'https://kalibrr.id.evil.test/c/acme/jobs/1',
  ]) {
    const res = classifyJobChannel({ external_url: url })
    assert.equal(res.channel, 'external_web', url)
    assert.equal(res.autoWorkerSupported, false, url)
  }
})
