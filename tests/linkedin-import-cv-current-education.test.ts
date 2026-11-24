import { test } from 'node:test'
import assert from 'node:assert/strict'
import { NOW } from './helpers/linkedinFixture.ts'
import { makePdf } from './helpers/makePdf.ts'
import { cleanPdfText, normalizeExtraction, parseWithRules, parseYearRange } from '../services/linkedin-import.ts'
import { LinkedInImportService } from '../services/linkedin-import.service.ts'

/**
 * Pendidikan yang masih berjalan pada CV mahasiswa Indonesia ("2022 - Sekarang"): is_current = true, end_year = null.
 * Tabel `education` tidak punya batasan CHECK; kolom end_year boleh null, dan validator frontend (validateEducation)
 * menerima is_current tanpa tahun lulus. Semua teks SINTETIS. Tanpa jaringan.
 */

const norm = (raw: unknown, sourceText: string) => normalizeExtraction(raw, { sourceText, now: NOW })
const row = (e: { institution: string; degree: string; field_of_study: string | null; start_year: number; end_year: number | null; is_current: boolean; gpa: number | null; max_gpa: number | null }) => [
  e.institution,
  e.degree,
  e.field_of_study,
  e.start_year,
  e.end_year,
  e.is_current,
  e.gpa,
  e.max_gpa,
]

const CV = (dates: string) => cleanPdfText([`Dewi Anggraini Sintetis\nYogyakarta\nPENDIDIKAN\nUniversitas Kristen Duta Wacana\nS1 Sistem Informasi | ${dates}\nIPK 3.75/4.00\n\nKEAHLIAN\nPython, SQL`])

test('CV mahasiswa: "S1 Sistem Informasi | 2022 - Sekarang" + IPK terbaca sebagai is_current, end_year null, IPK 3,75 dari 4', () => {
  const text = CV('2022 - Sekarang')
  const n = norm(parseWithRules(text), text)
  assert.deepEqual(n.education.map(row), [['Universitas Kristen Duta Wacana', 'S1', 'Sistem Informasi', 2022, null, true, 3.75, 4]])
  assert.equal(n.dropped.education, 0)
})

test('penanda "masih berjalan" yang lazim di CV Indonesia dan Inggris: Present, Saat ini, s/d Sekarang, Ongoing, Sedang menempuh', () => {
  for (const dates of [
    '2022 - Present',
    '2022 - present',
    '2022 \u2013 Saat ini',
    '2022 - Sekarang',
    '2022 s/d Sekarang',
    '2022 s.d. Sekarang',
    '2022 sampai sekarang',
    '2022 - Hingga Sekarang',
    '2022 - Current',
    '2022 - Ongoing',
    '2022 - Sedang menempuh',
    '2022 - Masih kuliah',
    '2022 - Berlangsung',
  ]) {
    const text = CV(dates)
    const n = norm(parseWithRules(text), text)
    assert.deepEqual(n.education.map(row), [['Universitas Kristen Duta Wacana', 'S1', 'Sistem Informasi', 2022, null, true, 3.75, 4]], dates)
    assert.deepEqual(parseYearRange(dates), { start: 2022, end: 'present' }, dates)
  }
})

test('CV mahasiswa dengan SMA sebelumnya: yang berjalan is_current, yang selesai punya end_year', () => {
  const text = cleanPdfText(['PENDIDIKAN\nUniversitas Kristen Duta Wacana\nS1 Sistem Informasi | 2022 - Sekarang\nIPK 3.75/4.00\nSMA Kristen 1 Yogyakarta\nIPA | 2019 - 2022'])
  const n = norm(parseWithRules(text), text)
  assert.deepEqual(n.education.map((e) => [e.institution, e.start_year, e.end_year, e.is_current]), [
    ['Universitas Kristen Duta Wacana', 2022, null, true],
    ['SMA Kristen 1 Yogyakarta', 2019, 2022, false],
  ])
})

test('hasil model: is_current true dengan hanya tahun masuk ("2022") tetap berjalan, bukan tahun lulus 2022', () => {
  const text = CV('2022 - Sekarang')
  const base = { school: 'Universitas Kristen Duta Wacana', degree: 'S1', field: 'Sistem Informasi' }
  for (const shape of [
    { years: '2022', is_current: true },
    { years: 2022, is_current: true },
    { start_year: 2022, end_year: null, is_current: true },
    { start_year: 2022, end_year: 'Sekarang' },
    { years: '2022 - Sekarang' },
    { years: '2022 - Present', is_current: true },
  ]) {
    const n = norm({ education: [{ ...base, ...shape }] }, text)
    assert.deepEqual(n.education.map((e) => [e.start_year, e.end_year, e.is_current]), [[2022, null, true]], JSON.stringify(shape))
    assert.deepEqual(n.education[0].notes, [], 'tidak ada catatan "hanya satu tahun" untuk pendidikan yang berjalan')
  }
  // tanpa is_current, satu tahun tetap dibaca sebagai tahun lulus (perilaku lama)
  const graduated = norm({ education: [{ ...base, years: '2022' }] }, text)
  assert.deepEqual(graduated.education.map((e) => [e.start_year, e.end_year, e.is_current]), [[2022, 2022, false]])
})

test('layanan, jalur aturan dan jalur AI: pratinjau memuat is_current true dan end_year null, dan JSON-nya tetap bulat', async () => {
  const text = 'Dewi Anggraini Sintetis\nYogyakarta\nPENDIDIKAN\nUniversitas Kristen Duta Wacana\nS1 Sistem Informasi | 2022 - Sekarang\nIPK 3.75/4.00'
  const pdf = makePdf([text.split('\n')])
  const mk = (llm: unknown) => new LinkedInImportService({ llm: llm as never, now: () => NOW, log: () => {} })

  const byRules = await mk(async () => {
    throw new Error('AI mati')
  }).importFromPdf(pdf, { userId: 'u1' })
  const byAi = await mk(async () => ({
    text: JSON.stringify({ full_name: 'Dewi Anggraini Sintetis', education: [{ school: 'Universitas Kristen Duta Wacana', degree: 'S1', field: 'Sistem Informasi', years: '2022', is_current: true, gpa: '3.75/4.00' }] }),
    model: 'm',
  })).importFromPdf(pdf, { userId: 'u1' })

  for (const preview of [byRules, byAi]) {
    const [e] = JSON.parse(JSON.stringify(preview)).education
    assert.deepEqual([e.institution, e.degree, e.field_of_study, e.start_year, e.end_year, e.is_current, e.gpa, e.max_gpa], ['Universitas Kristen Duta Wacana', 'S1', 'Sistem Informasi', 2022, null, true, 3.75, 4])
  }
  assert.equal(byRules.meta.method, 'rules')
  assert.equal(byAi.meta.method, 'ai')
})
