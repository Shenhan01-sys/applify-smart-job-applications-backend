import { test } from 'node:test'
import assert from 'node:assert/strict'
import { NOW } from './helpers/linkedinFixture.ts'
import { cleanPdfText, normalizeExtraction, parseWithRules, parseYearRange } from '../services/linkedin-import.ts'

/**
 * Tahun lulus berupa perkiraan ("Sep 2023 - Expected Mar 2027") pada CV mahasiswa tingkat akhir. Sebelumnya kata
 * "Expected" membuat tahun akhir tidak terbaca, sehingga seluruh entri pendidikan terbuang. NOW = 2026-11-20.
 * Semua teks SINTETIS. Tanpa jaringan.
 */

const SRC = 'Universitas Contoh Nusantara (UCN), Bandung | B.Sc. Computer Science Sep 2023 - Expected Mar 2027'
const norm = (raw: unknown, sourceText = SRC) => normalizeExtraction(raw, { sourceText, now: NOW })
const row = (e: { institution: string; degree: string; field_of_study: string | null; start_year: number; end_year: number | null; is_current: boolean }) => [
  e.institution,
  e.degree,
  e.field_of_study,
  e.start_year,
  e.end_year,
  e.is_current,
]
const edu = (extra: Record<string, unknown>) => ({
  education: [{ school: 'Universitas Contoh Nusantara (UCN)', degree: 'B.Sc.', field: 'Computer Science', ...extra }],
})
const EXPECTED_ROW = ['Universitas Contoh Nusantara (UCN)', 'B.Sc.', 'Computer Science', 2023, 2027, true]

test('parseYearRange: kata perkiraan dibuang dan ditandai expected', () => {
  for (const text of [
    'Sep 2023 - Expected Mar 2027',
    'Sep 2023 - Expected graduation Mar 2027',
    'Sep 2023 - Expected: Mar 2027',
    'Sep 2023 - Exp. Mar 2027',
    'Sep 2023 - Anticipated Mar 2027',
    'Sep 2023 - Est. Mar 2027',
    'Sep 2023 - Estimated Mar 2027',
    'Sep 2023 - Perkiraan Mar 2027',
    'Sep 2023 - Rencana lulus Mar 2027',
    'Sep 2023 - Mar 2027 (expected)',
    '2023 - 2027 (Expected)',
    '(2023 - Expected 2027)',
  ]) {
    assert.deepEqual(parseYearRange(text), { start: 2023, end: 2027, expected: true }, text)
  }
})

test('parseYearRange: rentang biasa tidak diberi penanda expected, kata "experience" bukan penanda', () => {
  assert.deepEqual(parseYearRange('2019 - 2023'), { start: 2019, end: 2023 })
  assert.deepEqual(parseYearRange('Sep 2023 - Present'), { start: 2023, end: 'present' })
  assert.deepEqual(parseYearRange('Experience 2019 - 2023'), { start: 2019, end: 2023 })
})

test('normalizeExtraction: "Sep 2023 - Expected Mar 2027" menjadi is_current true dengan end_year 2027 dan catatan', () => {
  const n = norm(edu({ years: 'Sep 2023 - Expected Mar 2027' }))
  assert.deepEqual(n.education.map(row), [EXPECTED_ROW])
  assert.equal(n.dropped.education, 0)
  assert.ok(n.education[0].notes.some((t) => /perkiraan/i.test(t)), 'pengguna diberi tahu tahun lulus masih perkiraan')
})

test('normalizeExtraction: semua penulisan perkiraan dibaca sama', () => {
  for (const years of ['Sep 2023 - Exp. Mar 2027', 'Sep 2023 - Anticipated Mar 2027', 'Sep 2023 - Est. Mar 2027', 'Sep 2023 - Perkiraan Mar 2027', 'Sep 2023 - Rencana lulus Mar 2027', 'Sep 2023 - Mar 2027 (expected)', 'Sep 2023 - Expected graduation Mar 2027']) {
    assert.deepEqual(norm(edu({ years })).education.map(row), [EXPECTED_ROW], years)
  }
})

test('normalizeExtraction: tahun akhir di masa depan tanpa kata perkiraan juga is_current, tahun akhir yang sudah lewat tidak', () => {
  assert.deepEqual(norm(edu({ years: '2023 - 2027' })).education.map(row), [EXPECTED_ROW])
  assert.deepEqual(norm(edu({ years: '2019 - 2023' })).education.map(row), [['Universitas Contoh Nusantara (UCN)', 'B.Sc.', 'Computer Science', 2019, 2023, false]])
  assert.deepEqual(norm(edu({ years: '2022 - Present' })).education.map(row), [['Universitas Contoh Nusantara (UCN)', 'B.Sc.', 'Computer Science', 2022, null, true]])
})

test('normalizeExtraction: bentuk lain jawaban model (bidang awal-akhir terpisah, bendera, bidang perkiraan) tetap terbaca', () => {
  for (const extra of [
    { start_year: 'Sep 2023', end_year: 'Expected Mar 2027' },
    { start_year: 2023, end_year: 2027, expected: true },
    { start_year: 2023, end_year: 2027, is_expected: true },
    { start_year: 2023, end_year: 2027, expected_graduation: true },
    { start_year: 2023, expected_graduation: 'Mar 2027' },
    { start_year: 2023, expected_end_year: 2027 },
    { years: 'Sep 2023', expected_graduation_date: 'Mar 2027' },
    { years: '2023 - 2027', expected: true },
    { start: 'Sep 2023', end: 'Mar 2027', is_current: true },
  ]) {
    assert.deepEqual(norm(edu(extra)).education.map(row), [EXPECTED_ROW], JSON.stringify(extra))
  }
})

test('normalizeExtraction: perkiraan yang jauh, atau perkiraan tanpa tahun masuk, tetap dibuang dan dihitung', () => {
  const far = norm(edu({ years: 'Sep 2023 - Expected 2040' }))
  assert.equal(far.education.length, 0)
  assert.equal(far.dropped.education, 1)
  const onlyExpected = norm(edu({ years: 'Expected Mar 2027' }))
  assert.equal(onlyExpected.education.length, 0, 'tahun masuk tidak diketahui, tidak ditebak')
  assert.equal(onlyExpected.dropped.education, 1)
})

test('parser aturan, tata letak CV biasa: "Sep 2023 - Expected Mar 2027" terbaca sebagai rentang', () => {
  const text = cleanPdfText(['Rina Contoh\nPENDIDIKAN\nUniversitas Contoh Nusantara\nS1 Teknik Informatika | Sep 2023 - Expected Mar 2027\nIPK 3,75/4,00\n\nKEAHLIAN\nPython'])
  const n = norm(parseWithRules(text), text)
  assert.deepEqual(n.education.map(row), [['Universitas Contoh Nusantara', 'S1', 'Teknik Informatika', 2023, 2027, true]])
  assert.equal(n.education[0].gpa, 3.75)
})
