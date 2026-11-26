import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { isExtensionOriginAllowed } from '../services/extension-token.js'
import { shouldEnableApiDocs } from '../services/deploy-config.js'

test('U2B-11 CORS backend: menolak wildcard ekstensi pada staging/preview/Railway bila EXTENSION_ORIGINS kosong', () => {
  const origin = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop'
  assert.equal(isExtensionOriginAllowed(origin, { NODE_ENV: 'staging' }), false)
  assert.equal(isExtensionOriginAllowed(origin, { NODE_ENV: 'preview' }), false)
  assert.equal(isExtensionOriginAllowed(origin, { NODE_ENV: 'development', RAILWAY_ENVIRONMENT: 'staging' }), false)
  assert.equal(isExtensionOriginAllowed(origin, { RAILWAY_SERVICE_ID: 'svc-123' }), false)
  assert.equal(isExtensionOriginAllowed(origin, { VERCEL_ENV: 'preview' }), false)
  // Eksplisit opt-in untuk dev lokal
  assert.equal(isExtensionOriginAllowed(origin, { NODE_ENV: 'staging', ALLOW_DEV_EXTENSION_ORIGINS: 'true' }), true)
  // Daftar eksplisit tetap menang di lingkungan mana pun
  assert.equal(
    isExtensionOriginAllowed(origin, { NODE_ENV: 'staging', RAILWAY_ENVIRONMENT: 'staging', EXTENSION_ORIGINS: origin }),
    true
  )
})

test('BS-08 gating /docs: nonaktif di produksi secara bawaan, aktif hanya bila ENABLE_API_DOCS=true atau non-produksi', () => {
  assert.equal(shouldEnableApiDocs({ NODE_ENV: 'production' }), false)
  assert.equal(shouldEnableApiDocs({ NODE_ENV: 'production', ENABLE_API_DOCS: 'true' }), true)
  assert.equal(shouldEnableApiDocs({ NODE_ENV: 'development' }), true)
  assert.equal(shouldEnableApiDocs({ NODE_ENV: 'development', ENABLE_API_DOCS: 'false' }), false)

  const indexSrc = readFileSync(new URL('../api/index.ts', import.meta.url), 'utf8')
  assert.match(indexSrc, /shouldEnableApiDocs\(process\.env\)/)
})
