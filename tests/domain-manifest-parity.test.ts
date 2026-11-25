import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as backendManifest from '../services/domain-manifest.generated.js'
import { classifyJobChannel, isTestPortalUrl, routesToExtension } from '../services/apply-channel.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..', '..')

/**
 * BS-P2-04 & J5-06 (audit 26 Nov 2026):
 *   - Kelima daftar domain di domain-manifest.generated.ts harus sama persis dengan shared/domains.json.
 *   - Salinan di worker dan frontend (bila hadir di pohon kerja) harus identik dengan shared/domains.json.
 *   - Klasifikasi /uji-portal dan host luar EXTENSION_HOST_DOMAINS konsisten antara backend dan frontend.
 */

test('BS-P2-04: domain-manifest.generated.ts backend sama persis dengan shared/domains.json', () => {
  const sharedPath = path.join(ROOT, 'shared', 'domains.json')
  assert.equal(existsSync(sharedPath), true, `shared/domains.json harus ada di ${sharedPath}`)
  const spec = JSON.parse(readFileSync(sharedPath, 'utf8'))

  const expectedKnownAts = [...spec.publicAtsDomains, ...spec.extraKnownAtsDomains]
  assert.deepEqual([...backendManifest.PUBLIC_ATS_DOMAINS], spec.publicAtsDomains)
  assert.deepEqual([...backendManifest.KNOWN_ATS_DOMAINS], expectedKnownAts)
  assert.deepEqual([...backendManifest.EXTENSION_LOGIN_PORTAL_DOMAINS], spec.extensionLoginPortalDomains)
  assert.deepEqual([...backendManifest.OTHER_AUTH_PORTAL_DOMAINS], spec.otherAuthPortalDomains)
  assert.deepEqual(backendManifest.LOGIN_PORTAL_FAMILIES, spec.loginPortalFamilies)
})

test('BS-P2-04: salinan domainManifest.generated.ts di worker dan frontend identik dengan backend', () => {
  const backendSrc = readFileSync(path.join(ROOT, 'backend', 'services', 'domain-manifest.generated.ts'), 'utf8')
  const siblingPaths = [
    path.join(ROOT, 'worker', 'src', 'lib', 'domainManifest.generated.ts'),
    path.join(ROOT, 'applify-smart-job-applications', 'src', 'lib', 'domainManifest.generated.ts'),
  ]
  for (const p of siblingPaths) {
    if (!existsSync(p)) continue
    assert.equal(readFileSync(p, 'utf8'), backendSrc, `Salinan ${p} menyimpang dari backend/services/domain-manifest.generated.ts`)
  }
})

test('J5-06 & J5-02: /uji-portal diklasifikasikan worker non-ekstensi dan situs luar tidak extensionSupported', () => {
  const ujiUrl = 'https://applify-smart-job-applications.vercel.app/uji-portal'
  assert.equal(isTestPortalUrl(ujiUrl), true)
  assert.equal(isTestPortalUrl('https://applify-smart-job-applications.vercel.app/jobs'), false)
  const uji = classifyJobChannel({ platform_source: 'uji', external_url: ujiUrl })
  assert.equal(uji.channel, 'external_web')
  assert.equal(uji.autoWorkerSupported, true)
  assert.equal(uji.extensionSupported, false)
  assert.equal(routesToExtension(uji), false)

  const unknown = classifyJobChannel({ platform_source: 'other', external_url: 'https://karir.perusahaan-lokal.id/loker/1' })
  assert.equal(unknown.channel, 'external_web')
  assert.equal(unknown.extensionSupported, false)
  assert.equal(routesToExtension(unknown), false)

  const teamtailor = classifyJobChannel({ platform_source: 'other', external_url: 'https://acme.teamtailor.com/jobs/123' })
  assert.equal(teamtailor.channel, 'external_web')
  assert.equal(teamtailor.extensionSupported, true)
  assert.equal(routesToExtension(teamtailor), true)
})
