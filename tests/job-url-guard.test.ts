import test from 'node:test'
import assert from 'node:assert/strict'
import { isPublicHttpUrl } from '../services/apply-channel.ts'
import { ingestJobs, publicUrlsOnly } from '../services/job-ingest.service.ts'
import type { RankedJob } from '../services/job-aggregation.service.ts'

/**
 * Audit 48.4 BS-P1-02 dan 47.3 P1-06: URL lowongan dari scraper tidak boleh menyimpan skema berbahaya,
 * IP literal, localhost, atau host jaringan internal ke `jobs.external_url`. Data uji sintetis.
 */

test('isPublicHttpUrl: menerima URL http(s) berhost domain publik', () => {
  for (const ok of [
    'https://example.test/jobs/1',
    'http://karier.contoh.co.id/lowongan?id=7#lamar',
    'https://boards.greenhouse.io/acme/jobs/123',
    'https://EXAMPLE.test./jobs',
    'https://xn--80ak6aa92e.xn--p1ai/jobs',
  ]) {
    assert.equal(isPublicHttpUrl(ok), true, ok)
  }
})

test('isPublicHttpUrl: menolak skema bukan http(s) dan nilai bukan string', () => {
  for (const bad of ['javascript:alert(1)', 'data:text/html,<b>x</b>', 'file:///etc/passwd', 'ftp://example.test/x', '', '   ', 'bukan url', null, undefined, 42]) {
    assert.equal(isPublicHttpUrl(bad), false, String(bad))
  }
})

test('isPublicHttpUrl: menolak IP literal, localhost, dan host jaringan internal (anti-SSRF)', () => {
  for (const bad of [
    'http://127.0.0.1/admin',
    'http://127.0.0.1:8080/x',
    'http://169.254.169.254/latest/meta-data/',
    'http://10.0.0.5/x',
    'http://192.168.1.1/',
    'http://8.8.8.8/',
    'http://2130706433/',
    'http://0x7f.1/',
    'http://[::1]/x',
    'http://[fd00::1]/x',
    'http://localhost:3000/x',
    'http://localhost./x',
    'https://app.localhost/x',
    'http://metadata/x',
    'http://printer.local/x',
    'http://db.internal/x',
    'http://router.home.arpa/x',
    'http://intranet.corp/x',
  ]) {
    assert.equal(isPublicHttpUrl(bad), false, bad)
  }
})

test('isPublicHttpUrl: menolak kredensial di URL yang menyamarkan host tujuan', () => {
  assert.equal(isPublicHttpUrl('https://career.acme.test@evil.example/apply'), false)
  assert.equal(isPublicHttpUrl('https://user:pass@example.test/x'), false)
})

type Row = Record<string, unknown>

function fakeSupabase() {
  const rows: Row[] = []
  const client = {
    from(table: string) {
      assert.equal(table, 'jobs')
      return {
        select() {
          return { eq: () => ({ limit: async () => ({ data: [], error: null }) }) }
        },
        async insert(row: Row) {
          rows.push(row)
          return { error: null }
        },
      }
    },
  }
  return { client: client as any, rows }
}

const rj = (p: Partial<RankedJob> & { id: string }): RankedJob => ({
  title: 'Data Analyst',
  company: 'PT Uji',
  location: 'Jakarta',
  description: 'desc',
  url: `https://example.test/${p.id}`,
  platform: 'kalibrr',
  relevance: 50,
  match_score: 50,
  matchedKeywords: [],
  matchedSkills: [],
  ...p,
})

test('publicUrlsOnly: buang apply_url berbahaya tetapi pertahankan url publik, teks URL tidak diubah', () => {
  const kept = publicUrlsOnly(rj({ id: 'a', url: 'https://Example.test', apply_url: 'javascript:alert(1)' }))
  assert.ok(kept)
  assert.equal(kept.apply_url, undefined)
  assert.equal(kept.url, 'https://Example.test')

  const unchanged = publicUrlsOnly(rj({ id: 'b', apply_url: 'https://example.test/b/apply' }))
  assert.equal(unchanged?.apply_url, 'https://example.test/b/apply')
  assert.equal(unchanged?.url, 'https://example.test/b')
})

test('publicUrlsOnly: null bila semua URL ditolak, lolos bila sumber memang tanpa URL', () => {
  assert.equal(publicUrlsOnly(rj({ id: 'c', url: 'http://169.254.169.254/x', apply_url: 'http://127.0.0.1/y' })), null)
  const noUrl = publicUrlsOnly(rj({ id: 'd', url: '' }))
  assert.ok(noUrl)
  assert.equal(noUrl.url, '')
})

test('ingestJobs: URL berbahaya tidak pernah disimpan, dihitung gagal dengan pesan jelas', async () => {
  const { client, rows } = fakeSupabase()
  const s = await ingestJobs(client, [
    rj({ id: 'ok' }),
    rj({ id: 'xss', url: 'javascript:alert(1)' }),
    rj({ id: 'meta', url: 'http://169.254.169.254/latest', apply_url: 'http://localhost:9/apply' }),
    rj({ id: 'mixed', url: 'https://example.test/mixed', apply_url: 'http://10.1.2.3/apply' }),
  ])
  assert.equal(s.attempted, 4)
  assert.equal(s.inserted, 2)
  assert.equal(s.failed, 2)
  assert.equal(s.byPlatform.kalibrr.failed, 2)
  assert.ok(s.errors.every((e) => /URL lowongan ditolak/.test(e)), JSON.stringify(s.errors))
  assert.deepEqual(
    rows.map((r) => r.external_url),
    ['https://example.test/ok', 'https://example.test/mixed'],
  )
})
