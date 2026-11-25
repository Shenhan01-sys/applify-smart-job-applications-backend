import test from 'node:test'
import assert from 'node:assert/strict'
import { KapsoWhatsAppService, normalizeWhatsAppPhone } from '../services/kapso-whatsapp.service.js'
import { requestWhatsappVerificationOtp, verifyWhatsappVerificationOtp } from '../services/notification-dispatcher.service.js'
import { makeExtensionTestDb, USER_ID } from './extension-test-db.js'

/** BS-05 (audit 48.3): nomor ketikan pengguna tanpa penanda negara tidak boleh ditebak. Nomor sintetis, tanpa jaringan. */

const ON = { NOTIFICATIONS_ENABLED: 'true', NOTIFY_OTP_PEPPER: 'test-otp-pepper-xyz' }
const STRICT = { requireCountryPrefix: true }

test('normalisasi nomor ketikan: awalan 0, 62, +, dan 00 diterima; digit polos tanpa penanda ditolak', () => {
  assert.equal(normalizeWhatsAppPhone('0812-3456-7890', STRICT)?.e164, '+6281234567890')
  assert.equal(normalizeWhatsAppPhone('6281234567890', STRICT)?.e164, '+6281234567890')
  assert.equal(normalizeWhatsAppPhone('+62 812 3456 7890', STRICT)?.e164, '+6281234567890')
  assert.equal(normalizeWhatsAppPhone('+44 7911 123456', STRICT)?.e164, '+447911123456')
  assert.equal(normalizeWhatsAppPhone('0044 7911 123456', STRICT)?.e164, '+447911123456')
  // 81234567890: nomor Indonesia tanpa 0, atau nomor Jepang (+81)? Tidak ditebak.
  assert.equal(normalizeWhatsAppPhone('81234567890', STRICT), null)
  assert.equal(normalizeWhatsAppPhone('447911123456', STRICT), null)
  assert.equal(normalizeWhatsAppPhone('abc', STRICT), null)
  assert.equal(normalizeWhatsAppPhone(undefined, STRICT), null)
})

test('normalisasi tanpa opsi (format webhook, E.164 tanpa +) tidak berubah', () => {
  assert.equal(normalizeWhatsAppPhone('447911123456')?.e164, '+447911123456')
  assert.equal(normalizeWhatsAppPhone('6281234567890')?.e164, '+6281234567890')
  assert.equal(normalizeWhatsAppPhone('081234567890')?.waDigits, '6281234567890')
})

test('normalisasi: angka 0 sisa setelah kode negara Indonesia dibuang (+62 0812 menjadi +62 812)', () => {
  assert.equal(normalizeWhatsAppPhone('+62 0812-3456-7890', STRICT)?.e164, '+6281234567890')
  assert.equal(normalizeWhatsAppPhone('620812-3456-7890', STRICT)?.e164, '+6281234567890')
  assert.equal(normalizeWhatsAppPhone('+620812345678')?.e164, '+62812345678')
})

test('permintaan OTP dengan digit polos ditolak 400 sebelum ada baris OTP atau pesan WhatsApp', async () => {
  let fetchCalls = 0
  const fakeFetch: typeof fetch = (async () => {
    fetchCalls++
    return new Response(JSON.stringify({ messages: [{ id: 'wamid.x' }] }), { status: 200 })
  }) as typeof fetch
  const kapso = new KapsoWhatsAppService(fakeFetch, { ...ON, KAPSO_API_KEY: 'k', KAPSO_PHONE_NUMBER_ID: 'pn-1' })
  const store = makeExtensionTestDb({ user_notification_settings: [], notification_verification_codes: [] })

  await assert.rejects(
    () => requestWhatsappVerificationOtp(store.db, kapso, USER_ID, '81234567890', new Date('2026-11-26T02:00:00Z'), ON),
    (e: any) => e.statusCode === 400 && e.code === 'invalid_whatsapp_phone'
  )
  assert.equal(fetchCalls, 0)
  assert.equal(store.tables.notification_verification_codes.length, 0)
})

test('verifikasi OTP dengan digit polos ditolak 400 dan tidak menyentuh pengaturan', async () => {
  const store = makeExtensionTestDb({ user_notification_settings: [], notification_verification_codes: [] })
  await assert.rejects(
    () => verifyWhatsappVerificationOtp(store.db, USER_ID, '81234567890', '123456', new Date('2026-11-26T02:00:00Z'), ON),
    (e: any) => e.statusCode === 400 && e.code === 'invalid_whatsapp_phone'
  )
  assert.equal(store.tables.user_notification_settings.length, 0)
})
