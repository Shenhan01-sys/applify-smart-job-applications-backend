import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { aiPipelineService } from '../services/ai-pipeline.service.ts'
import { cityFromLocation, countryFromLocation } from '../services/applicant-fallbacks.ts'
import { buildApprovalAnswers, confidenceLevel, mergeProfileIntoSettings } from '../services/approval-answers.service.ts'

// Semua data di berkas ini sintetis. AI selalu diganti: tidak ada permintaan jaringan.
;(aiPipelineService as any).generateAnswer = async () => 'Jawaban AI uji.'
afterEach(() => {
  ;(aiPipelineService as any).generateAnswer = async () => 'Jawaban AI uji.'
})

const job = { title: 'Backend Engineer', company: 'Contoh PT', description: 'Bangun API.' }
const profile = { email: 'budi@contoh.test', skills: ['TypeScript'] }
const row = (rows: Awaited<ReturnType<typeof buildApprovalAnswers>>, part: string) => {
  const r = rows.find((x) => x.question.includes(part))
  assert.ok(r, `pertanyaan "${part}" tidak ditemukan`)
  return r!
}

// ───────────────────────────────────────────────────────────── temuan 14: negara dan telepon dari Profil

test('countryFromLocation: nama negara di bagian terakhir; tanpa nama negara, provinsi atau kota Indonesia yang dikenal; sisanya tidak ditebak', () => {
  assert.equal(countryFromLocation('Yogyakarta, Indonesia'), 'Indonesia')
  assert.equal(countryFromLocation('Greater Jakarta Area, Jakarta Raya, Indonesia'), 'Indonesia')
  assert.equal(countryFromLocation('  indonesia '), 'Indonesia')
  assert.equal(countryFromLocation('Indonesia'), 'Indonesia')
  assert.equal(countryFromLocation('Austin, Texas, United States'), 'United States')
  // nama lain dan bahasa Indonesia dipetakan ke nama kanonik bahasa Inggris
  assert.equal(countryFromLocation('Kuala Lumpur, Malaysia'), 'Malaysia')
  assert.equal(countryFromLocation('Surabaya, Amerika Serikat'), 'United States')
  assert.equal(countryFromLocation('Tokyo, Jepang'), 'Japan')
  assert.equal(countryFromLocation('Berlin, Deutschland'), 'Germany')
  assert.equal(countryFromLocation('Istanbul, Türkiye'), 'Turkey')
  // nama negara yang tertulis jelas menang atas nama provinsi atau kota Indonesia
  assert.equal(countryFromLocation('Jakarta, Singapore'), 'Singapore')
  assert.equal(countryFromLocation('Surabaya, Malaysia'), 'Malaysia')
  // tanpa nama negara: provinsi atau kota Indonesia yang dikenal menjadi "Indonesia"
  assert.equal(countryFromLocation('Daerah Istimewa Yogyakarta'), 'Indonesia')
  assert.equal(countryFromLocation('Yogyakarta'), 'Indonesia')
  assert.equal(countryFromLocation('Sleman, Yogyakarta'), 'Indonesia')
  assert.equal(countryFromLocation('Bandung, Jawa Barat'), 'Indonesia')
  assert.equal(countryFromLocation('Jakarta, DKI Jakarta'), 'Indonesia')
  assert.equal(countryFromLocation('Remote, Jakarta'), 'Indonesia', 'salah satu bagian cukup')
  for (const place of [
    'DI Yogyakarta', 'D.I. Yogyakarta', 'DIY', 'Special Region of Yogyakarta', 'Jogja', 'DKI Jakarta', 'Jakarta',
    'Jawa Barat', 'West Java', 'Bali', 'Surabaya', 'Bandung', 'Medan', 'Semarang', 'Makassar', 'Malang', 'Solo', 'Surakarta',
    'Denpasar', 'Palembang', 'Batam', 'Bekasi', 'Tangerang', 'Depok', 'Bogor', 'Sleman', 'Bantul', 'Papua Barat Daya',
    'Kalimantan Utara', 'North Sumatra', 'East Nusa Tenggara', 'NTT', 'Kota Bandung', 'Kab. Sleman', 'Greater Jakarta Area',
    'Yogyakarta City', 'jawa timur', 'JAWA TENGAH',
  ]) {
    assert.equal(countryFromLocation(place), 'Indonesia', place)
  }
  // bukan Indonesia atau tidak dikenal: tidak ada tebakan
  assert.equal(countryFromLocation('Atlanta, Georgia'), null, '"Georgia" sengaja tidak dikenal: bisa negara bagian AS')
  assert.equal(countryFromLocation('Austin, Texas'), null)
  assert.equal(countryFromLocation('Kota Kinabalu'), null, 'awalan "Kota" dibuang, sisanya bukan tempat Indonesia')
  assert.equal(countryFromLocation('Timur'), null)
  assert.equal(countryFromLocation('Sumatera'), null, 'nama pulau tidak ada di daftar')
  assert.equal(countryFromLocation('Indonesia, Remote'), null, 'negara bukan di bagian terakhir')
  assert.equal(countryFromLocation(''), null)
  assert.equal(countryFromLocation(null), null)
  assert.equal(countryFromLocation(undefined), null)
  assert.equal(countryFromLocation(42), null)
  assert.equal(countryFromLocation(' , , '), null)
})

test('cityFromLocation: bagian sebelum koma pertama; lokasi yang hanya nama negara tidak menjadi kota', () => {
  assert.equal(cityFromLocation('Yogyakarta, Indonesia'), 'Yogyakarta')
  assert.equal(cityFromLocation('Yogyakarta'), 'Yogyakarta')
  assert.equal(cityFromLocation('Sleman, Yogyakarta'), 'Sleman')
  assert.equal(cityFromLocation('Daerah Istimewa Yogyakarta'), 'Daerah Istimewa Yogyakarta', 'lokasi satu bagian dipakai apa adanya')
  assert.equal(cityFromLocation('Indonesia'), null)
  assert.equal(cityFromLocation(''), null)
  assert.equal(cityFromLocation(null), null)
})

test('mergeProfileIntoSettings: negara dari lokasi Profil hanya bila terbaca; Pengaturan yang terisi menang', () => {
  const ok = mergeProfileIntoSettings({}, { location: 'Yogyakarta, Indonesia' })
  assert.equal(ok.settings.country, 'Indonesia')
  assert.ok(ok.fromProfile.has('country'))
  assert.equal(ok.settings.current_city, 'Yogyakarta')

  const noCountry = mergeProfileIntoSettings({}, { location: 'Atlanta, Georgia' })
  assert.equal(noCountry.settings.country, undefined)
  assert.ok(!noCountry.fromProfile.has('country'))
  assert.equal(noCountry.settings.current_city, 'Atlanta')

  // Provinsi atau kota Indonesia tanpa kata "Indonesia": negara tetap terisi (data produksi, 20 November 2026).
  const province = mergeProfileIntoSettings({}, { location: 'Daerah Istimewa Yogyakarta' })
  assert.equal(province.settings.country, 'Indonesia')
  assert.ok(province.fromProfile.has('country'))
  assert.equal(province.settings.current_city, 'Daerah Istimewa Yogyakarta')
  const cityProvince = mergeProfileIntoSettings({}, { location: 'Sleman, Yogyakarta' })
  assert.equal(cityProvince.settings.country, 'Indonesia')
  assert.equal(cityProvince.settings.current_city, 'Sleman')

  const onlyCountry = mergeProfileIntoSettings({}, { location: 'Indonesia' })
  assert.equal(onlyCountry.settings.country, 'Indonesia')
  assert.equal(onlyCountry.settings.current_city, undefined, 'nama negara bukan kota')

  const own = mergeProfileIntoSettings({ country: 'Singapore' }, { location: 'Yogyakarta, Indonesia' })
  assert.equal(own.settings.country, 'Singapore')
  assert.ok(!own.fromProfile.has('country'))

  const blank = mergeProfileIntoSettings({ country: '  ', phone_number: '' }, { location: 'Bandung, Indonesia', phone: '+6281200000001' })
  assert.equal(blank.settings.country, 'Indonesia', 'string kosong di Pengaturan dianggap belum diisi')
  assert.equal(blank.settings.phone_number, '+6281200000001')
})

test('jawaban "Negara": dari Profil bersumber profile, keyakinan sedang, wajib dicek; dari Pengaturan tinggi', async () => {
  const fromProfile = await buildApprovalAnswers({ settings: {}, profileRow: { location: 'Yogyakarta, Indonesia' }, profile, job })
  const c = row(fromProfile, 'Negara')
  assert.equal(c.answer, 'Indonesia')
  assert.equal(c.source, 'profile')
  assert.equal(c.confidence, 0.7)
  assert.equal(confidenceLevel(c.confidence), 'medium')
  assert.equal(c.needs_review, true)

  const own = await buildApprovalAnswers({ settings: { country: 'Indonesia' }, profileRow: { location: 'Yogyakarta, Indonesia' }, profile, job })
  const o = row(own, 'Negara')
  assert.deepEqual([o.answer, o.source, o.needs_review], ['Indonesia', 'rule', false])
  assert.ok(o.confidence > 0.8)

  // lokasi provinsi Indonesia tanpa kata "Indonesia": negara terisi, tetap "sedang" dan wajib dicek, bukan yakin
  const province = await buildApprovalAnswers({ settings: {}, profileRow: { location: 'Daerah Istimewa Yogyakarta' }, profile, job })
  const p = row(province, 'Negara')
  assert.deepEqual([p.answer, p.source, p.confidence, p.needs_review], ['Indonesia', 'profile', 0.7, true])
  assert.equal(confidenceLevel(p.confidence), 'medium')

  // lokasi kota yang tidak dikenal: negara tidak ditebak, kosong dan wajib dicek
  const guess = await buildApprovalAnswers({ settings: {}, profileRow: { location: 'Atlanta, Georgia' }, profile, job })
  const g = row(guess, 'Negara')
  assert.deepEqual([g.answer, g.confidence, g.needs_review, g.source], ['', 0, true, 'default'])
})

test('jawaban nomor telepon: kolom telepon Pengaturan yang kosong atau spasi diisi dari Profil, bersumber profile', async () => {
  for (const blank of [undefined, null, '', '   ']) {
    const rows = await buildApprovalAnswers({ settings: { phone_number: blank }, profileRow: { phone: '+6281200000001' }, profile, job })
    const p = row(rows, 'Nomor telepon')
    assert.equal(p.answer, '+6281200000001', JSON.stringify(blank))
    assert.equal(p.source, 'profile')
  }
  const none = await buildApprovalAnswers({ settings: {}, profileRow: { phone: '' }, profile, job })
  assert.deepEqual([row(none, 'Nomor telepon').answer, row(none, 'Nomor telepon').needs_review], ['', true])
})
