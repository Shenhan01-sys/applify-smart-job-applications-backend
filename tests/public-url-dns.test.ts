import test from 'node:test'
import assert from 'node:assert/strict'
import { isPrivateOrReservedIp, verifyPublicUrlDns } from '../services/public-url-dns.service.js'
import { fetchJobDetailResult } from '../services/job-detail.service.js'
import { publicUrlsNoDnsRebind } from '../services/job-ingest.service.js'

test('P1-06 / BS-P3-09: isPrivateOrReservedIp mengenali seluruh rentang IP privat, loopback, metadata, dan IPv6-mapped', () => {
  for (const priv of [
    '127.0.0.1',
    '10.0.0.5',
    '172.16.0.1',
    '172.31.255.254',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '224.0.0.1',
    '::1',
    '::',
    'fc00::1',
    'fd12:3456::1',
    'fe80::1',
    '::ffff:127.0.0.1',
    '::ffff:169.254.169.254',
    '::ffff:7f00:1',
  ]) {
    assert.equal(isPrivateOrReservedIp(priv), true, `${priv} harus ditolak`)
  }

  for (const pub of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '2606:2800:220:1:248:1893:25c8:1946']) {
    assert.equal(isPrivateOrReservedIp(pub), false, `${pub} harus diterima sebagai publik`)
  }
})

test('P1-06 / BS-P3-09: verifyPublicUrlDns menolak domain publik yang beresolusi ke IP privat (DNS rebinding)', async () => {
  const rebindLookup = async () => [{ address: '93.184.216.34' }, { address: '169.254.169.254' }]
  const bad = await verifyPublicUrlDns('https://careers.rebind.example/job/1', { lookup: rebindLookup })
  assert.equal(bad.ok, false)
  assert.equal(bad.reason, 'private_ip_resolved')

  const goodLookup = async () => [{ address: '93.184.216.34' }]
  const good = await verifyPublicUrlDns('https://careers.example.com/job/1', { lookup: goodLookup })
  assert.equal(good.ok, true)

  // Integrasi ke fetchJobDetailResult: blokir sebelum fetch dijalankan bila DNS mengarah ke 127.0.0.1
  let fetched = false
  const res = await fetchJobDetailResult(
    'jobstreet',
    'https://id.jobstreet.com/id/job/123456',
    (async () => {
      fetched = true
      return new Response('<html></html>', { status: 200 })
    }) as typeof fetch,
    { dnsLookup: async () => [{ address: '127.0.0.1' }] }
  )
  assert.equal(res.ok, false)
  assert.equal(res.reason, 'unsupported')
  assert.equal(fetched, false, 'fetch tidak boleh dipanggil saat DNS rebinding terdeteksi')

  // Integrasi ke publicUrlsNoDnsRebind di ingesti
  const kept = await publicUrlsNoDnsRebind(
    { id: '1', title: 'Dev', company: 'PT', location: 'Jakarta', url: 'https://evil.rebind.example/job', platform: 'web' } as any,
    { lookup: async () => [{ address: '10.0.0.8' }] }
  )
  assert.equal(kept, null)
})
