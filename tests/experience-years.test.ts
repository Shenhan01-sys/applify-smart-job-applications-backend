import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { FakeDb } from './helpers/fakeDb.ts'
import { aiPipelineService } from '../services/ai-pipeline.service.ts'
import { formAutofillService } from '../services/form-autofill.service.ts'
import { deriveExperienceYears } from '../services/experience-years.ts'
import { buildApprovalAnswers, confidenceLevel, mergeProfileIntoSettings, prepareApprovalAnswers } from '../services/approval-answers.service.ts'

/**
 * Tahun pengalaman kerja: dihitung dari work_experiences bila Pengaturan Otomasi dan profil tidak mengisinya,
 * dan tidak pernah dijawab 0 dengan yakin padahal ada riwayat kerja (uji klik produksi 20 November 2026: 0 dengan
 * keyakinan 95% untuk profil dengan enam pengalaman). Data SINTETIS, tanpa jaringan.
 */
const NOW = new Date('2026-11-20T10:00:00.000Z')
const blockRealAI = async () => {
  throw new Error('real AI call blocked in tests')
}
;(aiPipelineService as any).generateAnswer = blockRealAI
afterEach(() => {
  ;(aiPipelineService as any).generateAnswer = blockRealAI
})

const job = { title: 'Backend Engineer', company: 'Contoh PT', description: 'Bangun API.' }
const role = (start: string, end: string | null, is_current = false) => ({ start_date: start, end_date: end, is_current })
const years = (rows: Array<Record<string, any>>, settings: Record<string, any> = {}, profileRow: Record<string, any> | null = null) =>
  buildApprovalAnswers({ settings, profileRow, workExperiences: rows, profile: {}, job, now: NOW }).then((a) => a.find((x) => x.question.includes('Total pengalaman'))!)

// ───────────────────────────────────────────────────────────── deriveExperienceYears

test('deriveExperienceYears: satu peran selesai, bulan mulai dan selesai ikut dihitung, dibulatkan ke bawah', () => {
  assert.deepEqual(deriveExperienceYears([role('2020-01-01', '2021-12-01')], NOW), { months: 24, years: 2, used: 1, skipped: 0 })
  assert.equal(deriveExperienceYears([role('2020-01-01', '2021-11-01')], NOW)!.years, 1, '23 bulan = 1 tahun')
  assert.equal(deriveExperienceYears([role('2020-01-15', '2020-06-30')], NOW)!.months, 6)
})

test('deriveExperienceYears: peran berjalan dihitung sampai bulan ini (is_current atau tanpa tanggal selesai)', () => {
  assert.equal(deriveExperienceYears([role('2024-11-01', null, true)], NOW)!.months, 25)
  assert.equal(deriveExperienceYears([role('2024-11-01', null)], NOW)!.months, 25)
  assert.equal(deriveExperienceYears([{ start_date: '2024-11-01', end_date: '2023-01-01', is_current: true }], NOW)!.months, 25, 'is_current menang atas tanggal selesai')
})

test('deriveExperienceYears: periode tumpang tindih digabung, bukan dijumlah', () => {
  // dua peran paralel Jan 2020 - Des 2021 dan Jul 2021 - Jun 2022: gabungan Jan 2020 - Jun 2022 = 30 bulan
  const r = deriveExperienceYears([role('2020-01-01', '2021-12-01'), role('2021-07-01', '2022-06-01')], NOW)!
  assert.equal(r.months, 30)
  assert.equal(r.years, 2)
  // peran yang seluruhnya berada di dalam peran lain tidak menambah
  assert.equal(deriveExperienceYears([role('2019-01-01', '2022-12-01'), role('2020-03-01', '2020-09-01')], NOW)!.months, 48)
  // bersambung langsung (Jun lalu Jul) = satu periode, tanpa celah
  assert.equal(deriveExperienceYears([role('2020-01-01', '2020-06-01'), role('2020-07-01', '2020-12-01')], NOW)!.months, 12)
  // ada celah: celahnya tidak dihitung (Jan-Mar 2020 = 3, Jan-Mar 2022 = 3)
  assert.equal(deriveExperienceYears([role('2020-01-01', '2020-03-01'), role('2022-01-01', '2022-03-01')], NOW)!.months, 6)
  // urutan masukan tidak berpengaruh
  assert.equal(deriveExperienceYears([role('2022-01-01', '2022-03-01'), role('2020-01-01', '2020-03-01')], NOW)!.months, 6)
})

test('deriveExperienceYears: tanggal tidak sah dilewati dan dihitung; kosong atau bukan daftar = null', () => {
  const r = deriveExperienceYears(
    [role('2020-01-01', '2020-12-01'), role('bukan tanggal', '2021-01-01'), role('2030-01-01', null), role('2022-05-01', '2021-01-01'), null as any, {}],
    NOW,
  )!
  assert.deepEqual(r, { months: 12, years: 1, used: 1, skipped: 5 })
  assert.equal(deriveExperienceYears([], NOW), null)
  assert.equal(deriveExperienceYears(null, NOW), null)
  assert.equal(deriveExperienceYears('x', NOW), null)
  // tanggal selesai di masa depan dipotong ke bulan ini
  assert.equal(deriveExperienceYears([role('2026-01-01', '2027-06-01')], NOW)!.months, 11)
})

// ───────────────────────────────────────────────────────────── jawaban formulir

const SIX = [
  role('2024-03-01', null, true),
  role('2022-06-01', '2024-02-01'),
  role('2021-01-01', '2022-05-01'),
  role('2019-09-01', '2020-12-01'),
  role('2018-01-01', '2019-08-01'),
  role('2017-02-01', '2017-12-01'),
]

test('tahun pengalaman kosong dengan enam pengalaman: dihitung dari tanggal, sumber profile, keyakinan sedang, wajib dicek', async () => {
  const a = await years(SIX, {}, { experience_years: null })
  // Feb 2017 - Nov 2026 tanpa celah besar: Feb-Des 2017 (11) + Jan 2018 - Nov 2026 (107) = 118 bulan = 9 tahun
  assert.equal(a.answer, '9')
  assert.equal(a.source, 'profile')
  assert.equal(a.confidence, 0.7)
  assert.equal(a.needs_review, true)
  assert.equal(confidenceLevel(a.confidence), 'medium')
})

test('nilai bawaan "0" di Pengaturan Otomasi dengan riwayat kerja: dihitung, bukan 0 dengan keyakinan 95%', async () => {
  const a = await years(SIX, { years_of_experience: '0' }, { experience_years: 0 })
  assert.equal(a.answer, '9')
  assert.ok(a.confidence < 0.8)
  assert.equal(a.needs_review, true)
  assert.notEqual(a.source, 'rule')
})

test('isian pengguna menang: Pengaturan Otomasi > 0 dan profil > 0 tidak ditimpa hitungan, keyakinan tinggi tetap', async () => {
  const fromSettings = await years(SIX, { years_of_experience: '4' }, { experience_years: 7 })
  assert.deepEqual([fromSettings.answer, fromSettings.source, fromSettings.needs_review], ['4', 'rule', false])
  const fromProfile = await years(SIX, {}, { experience_years: 7 })
  assert.deepEqual([fromProfile.answer, fromProfile.source, fromProfile.confidence], ['7', 'profile', 0.85])
})

test('riwayat kerja kurang dari setahun: jawaban 0 tetap ada tetapi rendah dan wajib dicek, bukan tinggi', async () => {
  const a = await years([role('2026-05-01', null, true)], { years_of_experience: '0' }, null)
  assert.equal(a.answer, '0')
  assert.equal(a.confidence, 0.4)
  assert.equal(confidenceLevel(a.confidence), 'low')
  assert.equal(a.needs_review, true)
  assert.equal(a.source, 'default')
})

test('riwayat kerja semuanya tidak terbaca dan nilai "0": tidak pernah 0 dengan keyakinan tinggi', async () => {
  const a = await years([role('rusak', 'rusak')], { years_of_experience: '0' }, null)
  assert.equal(a.answer, '0')
  assert.equal(a.confidence, 0.4)
  assert.equal(a.needs_review, true)
})

test('tanpa riwayat kerja sama sekali: perilaku lama (nilai "0" dari pengguna tetap jawaban, kosong tetap kosong dan dicek)', async () => {
  const zero = await years([], { years_of_experience: '0' }, null)
  assert.deepEqual([zero.answer, zero.confidence, zero.needs_review], ['0', 0.95, false])
  const blank = await years([], {}, { experience_years: 0 })
  assert.deepEqual([blank.answer, blank.confidence, blank.needs_review], ['', 0, true])
})

test('mergeProfileIntoSettings: derived hanya terisi untuk tahun pengalaman yang dihitung', () => {
  const m = mergeProfileIntoSettings({}, { experience_years: 0, full_name: 'Budi Uji' }, SIX, NOW)
  assert.equal(m.settings.years_of_experience, '9')
  assert.deepEqual([...m.derived], ['years_of_experience'])
  assert.ok(m.fromProfile.has('years_of_experience') && m.fromProfile.has('first_name'))
  const fromCol = mergeProfileIntoSettings({}, { experience_years: 3 }, SIX, NOW)
  assert.equal(fromCol.settings.years_of_experience, '3')
  assert.equal(fromCol.derived.size, 0)
  // tanpa baris profil pun hitungan tetap jalan
  assert.equal(mergeProfileIntoSettings({}, null, SIX, NOW).settings.years_of_experience, '9')
})

test('prepareApprovalAnswers membaca work_experiences; gagal membaca = jawaban tetap dibuat tanpa hitungan', async () => {
  const db = new FakeDb({
    profiles: [{ id: 'u1', full_name: 'Budi Uji', location: 'Bandung, Indonesia', experience_years: 0 }],
    user_automation_settings: [{ user_id: 'u1', years_of_experience: '0' }],
    work_experiences: [
      { user_id: 'u1', start_date: '2015-01-01', end_date: '2018-12-01', is_current: false },
      { user_id: 'u1', start_date: '2019-02-01', end_date: null, is_current: true },
      { user_id: 'u2', start_date: '2000-01-01', end_date: '2001-01-01', is_current: false },
    ],
  })
  const rows = await prepareApprovalAnswers(db, { userId: 'u1', email: 'budi@contoh.test', jobTitle: 'BE', company: 'C' })
  const a = rows.find((r) => r.question.includes('Total pengalaman'))!
  // 2015-01..2018-12 = 48 bulan, 2019-02..sekarang: jam asli, jadi hanya dipastikan di atas 7 tahun dan bukan 0 yakin
  assert.ok(Number(a.answer) >= 7, `jawaban ${a.answer}`)
  assert.equal(a.needs_review, true)
  assert.equal(a.source, 'profile')

  db.failOn('work_experiences', 'select')
  const without = await prepareApprovalAnswers(db, { userId: 'u1', jobTitle: 'BE', company: 'C' })
  assert.equal(without.length, 11)
  const b = without.find((r) => r.question.includes('Total pengalaman'))!
  assert.equal(b.answer, '0', 'tanpa riwayat terbaca: perilaku lama, tidak ada hitungan')
})

// ───────────────────────────────────────────────────────────── jalur isian formulir umum

test('FormAutofillService: pertanyaan tahun pengalaman tanpa data = kosong dan keyakinan 0, bukan "0" dengan 0,95', async () => {
  for (const label of ['Total years of experience', 'How many years of experience do you have?', 'Total experience']) {
    const blank = await formAutofillService.fillField({ type: 'text', label }, { jobTitle: 'T', company: 'C', jobDescription: '', userSettings: {}, userProfile: {} } as any)
    assert.equal(blank.value, '', label)
    assert.equal(blank.confidence, 0, label)
    const filled = await formAutofillService.fillField({ type: 'text', label }, { jobTitle: 'T', company: 'C', jobDescription: '', userSettings: { years_of_experience: '5' }, userProfile: {} } as any)
    assert.equal(filled.value, '5', label)
    assert.equal(filled.confidence, 0.95, label)
  }
})
