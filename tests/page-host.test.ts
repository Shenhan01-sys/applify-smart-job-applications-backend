import test from 'node:test'
import assert from 'node:assert/strict'
import { PUBLIC_ATS_DOMAINS } from '../services/apply-channel.js'
import { isKnownAtsHostname, KNOWN_ATS_DOMAINS, pageMatchesJob, registrableDomain } from '../services/page-host.js'

test('registrableDomain: dua label, ccTLD tingkat dua, hosting bersama, IP', () => {
  assert.equal(registrableDomain('careers.acme.com'), 'acme.com')
  assert.equal(registrableDomain('WWW.Acme.com.'), 'acme.com')
  assert.equal(registrableDomain('apply.acme.co.id'), 'acme.co.id')
  assert.equal(registrableDomain('acme.co.id'), 'acme.co.id')
  assert.equal(registrableDomain('acme.vercel.app'), 'acme.vercel.app')
  assert.equal(registrableDomain('www.acme.vercel.app'), 'acme.vercel.app')
  assert.equal(registrableDomain('evil.vercel.app'), 'evil.vercel.app')
  assert.equal(registrableDomain('127.0.0.1'), '127.0.0.1')
  assert.equal(registrableDomain('localhost'), 'localhost')
})

test('KNOWN_ATS_DOMAINS memuat semua PUBLIC_ATS_DOMAINS dan daftar worker (pageGuard KNOWN_ATS_HOSTS)', () => {
  for (const d of PUBLIC_ATS_DOMAINS) assert.ok(KNOWN_ATS_DOMAINS.includes(d), d)
  for (const d of ['greenhouse.io', 'lever.co', 'ashbyhq.com', 'myworkdayjobs.com', 'jobvite.com', 'icims.com', 'freshteam.com']) {
    assert.ok(KNOWN_ATS_DOMAINS.includes(d), d)
  }
  assert.equal(isKnownAtsHostname('boards.greenhouse.io'), true)
  assert.equal(isKnownAtsHostname('greenhouse.io.evil.example'), false)
  assert.equal(isKnownAtsHostname('notgreenhouse.io'), false)
})

const job = (external_url: string | null, extra: Record<string, unknown> = {}) => ({ id: 'j', platform_source: 'web', external_url, ...extra })

test('pageMatchesJob: host sama persis (abaikan www), domain terdaftar sama, dan host berbeda', () => {
  const j = job('https://careers.acme.com/jobs/1')
  assert.deepEqual(pageMatchesJob('https://careers.acme.com/jobs/1/apply', j), { ok: true, rule: 'same_host' })
  assert.deepEqual(pageMatchesJob('https://www.careers.acme.com/x', j), { ok: true, rule: 'same_host' })
  assert.deepEqual(pageMatchesJob('https://apply.acme.com/form', j), { ok: true, rule: 'same_site' })
  assert.equal(pageMatchesJob('https://acme.com.evil.example/', j).ok, false)
  assert.equal(pageMatchesJob('https://evilacme.com/', j).ok, false)
  assert.equal(pageMatchesJob('https://other.com/', j).ok, false)
  assert.equal(pageMatchesJob('ftp://careers.acme.com/', j).ok, false)
  assert.equal(pageMatchesJob('javascript:alert(1)', j).ok, false)
})

test('pageMatchesJob: hosting bersama tidak dianggap satu situs', () => {
  const j = job('https://acme.vercel.app/jobs/1')
  assert.equal(pageMatchesJob('https://acme.vercel.app/apply', j).ok, true)
  assert.equal(pageMatchesJob('https://evil.vercel.app/apply', j).ok, false)
})

test('pageMatchesJob: lowongan non-ATS boleh menuju host ATS yang dikenal', () => {
  const agg = job('https://www.kalibrr.com/c/acme/jobs/1')
  assert.deepEqual(pageMatchesJob('https://boards.greenhouse.io/acme/jobs/1', agg), { ok: true, rule: 'known_ats' })
  assert.deepEqual(pageMatchesJob('https://acme.wd5.myworkdayjobs.com/en-US/careers/job/1', agg), { ok: true, rule: 'known_ats' })
  assert.equal(pageMatchesJob('https://greenhouse.io.evil.example/x', agg).ok, false)
})

test('pageMatchesJob: lowongan di ATS hanya boleh pindah dalam vendor yang sama, bukan ke vendor lain', () => {
  const gh = job('https://boards.greenhouse.io/acme/jobs/1')
  assert.deepEqual(pageMatchesJob('https://job-boards.greenhouse.io/acme/jobs/1', gh), { ok: true, rule: 'same_site' })
  assert.equal(pageMatchesJob('https://jobs.lever.co/acme/1', gh).ok, false)
})

test('pageMatchesJob: ATS multi-tenant per subdomain butuh host yang sama persis', () => {
  const wd = job('https://acme.wd5.myworkdayjobs.com/en-US/careers/job/1')
  assert.equal(pageMatchesJob('https://acme.wd5.myworkdayjobs.com/en-US/careers/apply', wd).ok, true)
  assert.equal(pageMatchesJob('https://rival.wd5.myworkdayjobs.com/en-US/careers/apply', wd).ok, false)
  const bamboo = job('https://acme.bamboohr.com/careers/1')
  assert.equal(pageMatchesJob('https://rival.bamboohr.com/careers/2', bamboo).ok, false)
})

test('pageMatchesJob: tautan ATS dari deskripsi (resolved apply url) ikut menjadi host lowongan', () => {
  const j = job('https://www.jobstreet.co.id/id/job/1', { description: 'Lamar di https://jobs.lever.co/acme/abc-123 sekarang' })
  assert.equal(pageMatchesJob('https://jobs.lever.co/acme/abc-123/apply', j).ok, true)
  // Lowongan non-ATS: host ATS lain yang dikenal juga boleh (aturan ke-3), tetapi situs asing tetap tidak
  assert.equal(pageMatchesJob('https://evil.example/apply', j).ok, false)
})

test('pageMatchesJob: tanpa URL lowongan atau tanpa baris lowongan ditolak', () => {
  assert.deepEqual(pageMatchesJob('https://boards.greenhouse.io/x', job(null)), { ok: false, rule: 'no_job_url' })
  assert.deepEqual(pageMatchesJob('https://boards.greenhouse.io/x', null), { ok: false, rule: 'no_job_url' })
  assert.deepEqual(pageMatchesJob('not a url', job('https://a.com')), { ok: false, rule: 'invalid_page_url' })
})
