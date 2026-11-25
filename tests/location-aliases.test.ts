import test from 'node:test'
import assert from 'node:assert/strict'
import { matchesLocation } from '../mcp/shared/utils.ts'
import { rankJobC1 } from '../services/job-ranking.service.ts'

/**
 * Audit 47.3 P1-08: singkatan kota Indonesia yang diketik pengguna harus cocok dengan lokasi lowongan,
 * selaras dengan LOCATION_ALIAS_GROUPS di frontend. Data uji sintetis.
 */

test('singkatan kota cocok dengan nama lengkap di lokasi lowongan', () => {
  const cases: Array<[string, string]> = [
    ['Yogyakarta, DI Yogyakarta', 'jogja'],
    ['Sleman, DIY', 'diy'],
    ['Jakarta Selatan', 'jaksel'],
    ['Jakarta Pusat, DKI Jakarta', 'jakpus'],
    ['Jakarta Barat', 'jakbar'],
    ['Jakarta Timur', 'jaktim'],
    ['Jakarta Utara', 'jakut'],
    ['South Jakarta', 'jaksel'],
    ['Surabaya, Jawa Timur', 'sby'],
    ['Bandung', 'bdg'],
    ['Semarang, Jawa Tengah', 'smg'],
    ['Surakarta, Jawa Tengah', 'solo'],
    ['Solo', 'surakarta'],
  ]
  for (const [loc, wanted] of cases) assert.equal(matchesLocation(loc, wanted), true, `${loc} <- ${wanted}`)
})

test('alias berlaku dua arah untuk singkatan dan lokasi lowongan yang menulis singkatan', () => {
  assert.equal(matchesLocation('Jaksel', 'jakarta selatan'), true)
  assert.equal(matchesLocation('Jaksel', 'Jakarta'), true)
  assert.equal(matchesLocation('Sby', 'surabaya'), true)
})

test('jabodetabek mencakup lima kota tetapi tidak berlaku sebaliknya', () => {
  for (const city of ['Jakarta Selatan', 'Bogor', 'Depok, Jawa Barat', 'Tangerang Selatan, Banten', 'Bekasi']) {
    assert.equal(matchesLocation(city, 'Jabodetabek'), true, city)
  }
  assert.equal(matchesLocation('Bandung', 'jabodetabek'), false)
  assert.equal(matchesLocation('Jakarta', 'bogor'), false)
})

test('alias tidak melebar ke kota lain dan kueri kosong tetap lolos', () => {
  assert.equal(matchesLocation('Surabaya', 'jaksel'), false)
  assert.equal(matchesLocation('Jakarta Selatan', 'jakpus'), false)
  assert.equal(matchesLocation('Bandung', 'sby'), false)
  assert.equal(matchesLocation('Singapore', 'jogja'), false)
  assert.equal(matchesLocation('Singapore', ''), true)
  assert.equal(matchesLocation(undefined, undefined), true)
})

test('kueri bernama properti bawaan Object tidak membuat pencocokan error', () => {
  for (const q of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
    assert.doesNotThrow(() => matchesLocation('Jakarta', q), q)
    assert.equal(matchesLocation('Jakarta', q), false, q)
  }
})

test('rankJobC1: lokasi singkatan pengguna tidak dihitung "di luar target" untuk lowongan di kota yang sama', () => {
  const job = {
    id: 'loc1',
    title: 'Backend Engineer',
    company: 'Acme',
    location: 'Jakarta Selatan',
    description: 'Node.js dan PostgreSQL',
    url: 'https://example.test/loc1',
  }
  const ctx = { keywords: 'backend engineer', skills: ['Node.js'], nowMs: Date.parse('2026-11-24T12:00:00Z') }
  const abbr = rankJobC1(job, { ...ctx, location: 'jaksel' })
  const full = rankJobC1(job, { ...ctx, location: 'Jakarta Selatan' })
  assert.equal(abbr.breakdown.locationFactor, 1)
  assert.equal(abbr.score, full.score)
})
