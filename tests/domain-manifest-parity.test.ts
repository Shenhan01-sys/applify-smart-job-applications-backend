import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as backendManifest from '../services/domain-manifest.generated.js'
import { CORPORATE_COMPLEX_ATS_DOMAINS, classifyJobChannel, isTestPortalUrl, routesToExtension } from '../services/apply-channel.js'

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

test('BS-P2-04: salinan domainManifest.generated.ts di worker, frontend, dan ekstensi identik serta manifest ekstensi terjaga (J5-08)', () => {
  const backendSrc = readFileSync(path.join(ROOT, 'backend', 'services', 'domain-manifest.generated.ts'), 'utf8')
  const extRootCandidates = [path.join(ROOT, 'extension'), path.resolve(ROOT, '..', '..', 'extension')]
  const extRoot = extRootCandidates.find((p) => existsSync(path.join(p, 'src', 'lib', 'domainManifest.generated.ts')))

  const siblingPaths = [
    path.join(ROOT, 'worker', 'src', 'lib', 'domainManifest.generated.ts'),
    path.join(ROOT, 'applify-smart-job-applications', 'src', 'lib', 'domainManifest.generated.ts'),
    ...(extRoot ? [path.join(extRoot, 'src', 'lib', 'domainManifest.generated.ts')] : []),
  ]
  for (const p of siblingPaths) {
    if (!existsSync(p)) continue
    assert.equal(readFileSync(p, 'utf8'), backendSrc, `Salinan ${p} menyimpang dari backend/services/domain-manifest.generated.ts`)
  }

  // J5-08: verifikasi juga EXTERNAL_AUTH_PORTAL_MAP, pemisahan host auth eksternal, dan optional_host_permissions manifest ekstensi.
  const spec = JSON.parse(readFileSync(path.join(ROOT, 'shared', 'domains.json'), 'utf8'))
  assert.deepEqual(backendManifest.EXTERNAL_AUTH_PORTAL_MAP, spec.externalAuthPortalMap)
  const knownAts = new Set([...spec.publicAtsDomains, ...spec.extraKnownAtsDomains])
  const loginPortals = new Set<string>(spec.extensionLoginPortalDomains)
  for (const d of knownAts) {
    assert.equal(loginPortals.has(d), false, `Domain ${d} tidak boleh masuk ATS dan portal login sekaligus`)
  }
  const externalAuthHosts = Object.values(spec.externalAuthPortalMap).flat() as string[]
  for (const h of externalAuthHosts) {
    assert.equal(knownAts.has(h) || loginPortals.has(h), false, `Host auth eksternal ${h} tidak boleh masuk izin pengisian`)
  }
  if (extRoot && existsSync(path.join(extRoot, 'manifest.json'))) {
    const manifest = JSON.parse(readFileSync(path.join(extRoot, 'manifest.json'), 'utf8'))
    const expectedPerms: string[] = []
    for (const d of [...backendManifest.KNOWN_ATS_DOMAINS, ...backendManifest.EXTENSION_LOGIN_PORTAL_DOMAINS]) {
      expectedPerms.push(`https://${d}/*`, `https://*.${d}/*`)
    }
    // Ekstensi lama memakai optional_host_permissions, ekstensi sekarang memakai host_permissions (tanpa tanya izin per
    // situs). Tes menerima keduanya: setiap domain ATS dan portal login wajib terdaftar, dan satu-satunya tambahan yang
    // boleh ada hanya origin API (entri pertama host_permissions) dan Google Form publik berbasis path.
    const declared: string[] = [...(manifest.host_permissions ?? []), ...(manifest.optional_host_permissions ?? [])]
    const declaredSet = new Set(declared)
    const expectedSet = new Set(expectedPerms)
    for (const p of expectedSet) {
      assert.equal(declaredSet.has(p), true, `Manifest ekstensi tidak memuat izin host ${p}`)
    }
    const allowedExtras = new Set<string>(['https://docs.google.com/forms/*'])
    if (typeof manifest.host_permissions?.[0] === 'string') allowedExtras.add(manifest.host_permissions[0])
    for (const p of declaredSet) {
      if (expectedSet.has(p)) continue
      assert.equal(allowedExtras.has(p), true, `Manifest ekstensi memuat izin host di luar daftar ATS dan portal login: ${p}`)
    }
    for (const h of externalAuthHosts) {
      assert.equal(declaredSet.has(`https://${h}/*`) || declaredSet.has(`https://*.${h}/*`), false, `Host auth eksternal ${h} tidak boleh ada di manifest ekstensi`)
    }
  }
})

test('E2E-07: setiap domain tumpang tindih extraKnownAtsDomains & otherAuthPortalDomains ditandai eksperimental pada klasifikasi', () => {
  const spec = JSON.parse(readFileSync(path.join(ROOT, 'shared', 'domains.json'), 'utf8'))
  const otherAuth = new Set<string>(spec.otherAuthPortalDomains)
  const overlapped = (spec.extraKnownAtsDomains as string[]).filter((d) => otherAuth.has(d))
  assert.ok(overlapped.length > 0)
  for (const domain of overlapped) {
    assert.equal(
      (CORPORATE_COMPLEX_ATS_DOMAINS as readonly string[]).includes(domain),
      true,
      `Domain tumpang tindih ${domain} wajib masuk CORPORATE_COMPLEX_ATS_DOMAINS`,
    )
    const classified = classifyJobChannel({ external_url: `https://jobs.${domain}/career/123` })
    assert.equal(classified.extensionSupported, true)
    assert.equal(classified.experimentalExtension, true)
    assert.match(classified.reason, /eksperimental/i)
    assert.match(classified.reason, /manual/i)
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
