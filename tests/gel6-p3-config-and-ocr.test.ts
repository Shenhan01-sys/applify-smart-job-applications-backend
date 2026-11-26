import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { deployConfigWarnings } from '../services/deploy-config.js'
import { positiveEnvMs } from '../services/ai-providers.js'
import { LinkedInImportService } from '../services/linkedin-import.service.js'
import { LinkedInImportError, OCR_NOT_CONFIGURED_MESSAGE, OCR_UNAVAILABLE_MESSAGE } from '../services/linkedin-pdf.js'

test('48.5 J5-04: backend .env.example mendokumentasikan INTERNAL_NOTIFY_SECRET dan deployConfigWarnings memperingatkan bila kosong saat aktif', () => {
  const envExample = readFileSync(new URL('../.env.example', import.meta.url), 'utf8')
  assert.match(envExample, /INTERNAL_NOTIFY_SECRET=/)
  assert.match(envExample, /BACKEND_URL/)
  assert.match(envExample, /OAUTH_TOKEN_ENCRYPTION_KEY_PREVIOUS=/)

  const warn = deployConfigWarnings({
    NODE_ENV: 'production',
    FRONTEND_URL: 'https://app.example',
    NOTIFICATIONS_ENABLED: 'true',
  })
  assert.ok(warn.some((w) => w.includes('INTERNAL_NOTIFY_SECRET')))

  const ok = deployConfigWarnings({
    NODE_ENV: 'production',
    FRONTEND_URL: 'https://app.example',
    NOTIFICATIONS_ENABLED: 'true',
    INTERNAL_NOTIFY_SECRET: 'secret-panjang-123',
  })
  assert.deepEqual(ok, [])
})

test('48.5 J5-16: positiveEnvMs menolak NaN, nol, dan negatif ke nilai cadangan', () => {
  assert.equal(positiveEnvMs(undefined, 25_000), 25_000)
  assert.equal(positiveEnvMs('', 25_000), 25_000)
  assert.equal(positiveEnvMs('abc', 25_000), 25_000)
  assert.equal(positiveEnvMs('0', 25_000), 25_000)
  assert.equal(positiveEnvMs('-500', 25_000), 25_000)
  assert.equal(positiveEnvMs('15000', 25_000), 15_000)
})

test('47.1 P3-4: pesan ocr_unavailable membedakan GEMINI_API_KEY kosong vs layanan gagal sementara', async () => {
  const prev = process.env.GEMINI_API_KEY
  delete process.env.GEMINI_API_KEY
  try {
    const svcNoKey = new LinkedInImportService({
      extractPages: async () => {
        throw new LinkedInImportError(422, 'pdf_no_text', 'no text')
      },
    })
    await assert.rejects(
      () => svcNoKey.importFromPdf(Buffer.from('%PDF-1.4\nbody')),
      (e: unknown) => e instanceof LinkedInImportError && e.code === 'ocr_unavailable' && e.message === OCR_NOT_CONFIGURED_MESSAGE
    )

    const svcFailed = new LinkedInImportService({
      extractPages: async () => {
        throw new LinkedInImportError(422, 'pdf_no_text', 'no text')
      },
      ocrPages: async () => null,
    })
    await assert.rejects(
      () => svcFailed.importFromPdf(Buffer.from('%PDF-1.4\nbody')),
      (e: unknown) => e instanceof LinkedInImportError && e.code === 'ocr_unavailable' && e.message === OCR_UNAVAILABLE_MESSAGE
    )
  } finally {
    if (prev !== undefined) process.env.GEMINI_API_KEY = prev
  }
})
