import test from 'node:test'
import assert from 'node:assert/strict'
import { shouldRedactTelegramMetadata, statusMessage } from '../services/application-status.service.js'

test('U5-P1-02: shouldRedactTelegramMetadata menyamarkan metadata di produksi secara default dan mendukung opt-in/opt-out', () => {
  assert.equal(shouldRedactTelegramMetadata({ NODE_ENV: 'production' }), true)
  assert.equal(shouldRedactTelegramMetadata({ NODE_ENV: 'production', TELEGRAM_INCLUDE_JOB_METADATA: 'true' }), false)
  assert.equal(shouldRedactTelegramMetadata({ NODE_ENV: 'development' }), false)
  assert.equal(shouldRedactTelegramMetadata({ NODE_ENV: 'development', TELEGRAM_REDACT_JOB_METADATA: 'true' }), true)
})

test('U5-P1-02: statusMessage dengan redactMetadata: true tidak membocorkan judul atau perusahaan', () => {
  const msg = statusMessage({
    status: 'submitted',
    title: 'Senior Security Engineer',
    company: 'PT Rahasia Nusantara',
    followUpAt: '2026-11-30T00:00:00.000Z',
    redactMetadata: true,
  })
  assert.match(msg, /disamarkan/)
  assert.doesNotMatch(msg, /Senior Security Engineer/)
  assert.doesNotMatch(msg, /PT Rahasia Nusantara/)
  assert.match(msg, /2026-11-30/)
})
