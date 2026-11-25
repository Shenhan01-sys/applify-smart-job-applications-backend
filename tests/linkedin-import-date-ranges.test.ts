import { test } from 'node:test'
import assert from 'node:assert/strict'
import { NOW } from './helpers/linkedinFixture.ts'
import { explainDateRange, isDateRangeText, normalizeExtraction, parseDateRange, parseYearRange } from '../services/linkedin-import.ts'

/**
 * Rentang tanggal pengalaman dalam semua bentuk lazim: bulan tanpa tahun di awal ("Aug - Dec 2025"), nama bulan
 * Indonesia dan Inggris, pemisah strip / en dash / em dash / to / s/d / sampai / hingga, penanda "sekarang", MM/YYYY,
 * ISO, dan garis miring sisa ekstraksi PDF ("Mar /2016 /- /Present"). NOW = 2026-11-20. Semua teks SINTETIS.
 */

const range = (raw: string) => {
  const r = parseDateRange(raw, NOW)
  return r ? [r.start, r.end, r.is_current] : null
}

const OK: Array<[string, string, string | null, boolean]> = [
  // bulan tanpa tahun di awal meminjam tahun dari akhir
  ['Aug - Dec 2025', '2025-08-01', '2025-12-01', false],
  ['Aug – Dec 2025', '2025-08-01', '2025-12-01', false],
  ['Aug—Dec 2025', '2025-08-01', '2025-12-01', false],
  ['Aug-Dec 2025', '2025-08-01', '2025-12-01', false],
  ['Aug to Dec 2025', '2025-08-01', '2025-12-01', false],
  ['Agu - Des 2025', '2025-08-01', '2025-12-01', false],
  ['Agustus s/d Desember 2025', '2025-08-01', '2025-12-01', false],
  ['Jan - Mar 2026', '2026-01-01', '2026-03-01', false],
  ['Nov - Feb 2026', '2025-11-01', '2026-02-01', false],
  ['Feb - Feb 2026', '2026-02-01', '2026-02-01', false],
  // dua tahun lengkap
  ['Mar 2019 - Jun 2021', '2019-03-01', '2021-06-01', false],
  ['March 2019 - June 2021', '2019-03-01', '2021-06-01', false],
  ['Maret 2019 - Juni 2021', '2019-03-01', '2021-06-01', false],
  ['Mei 2019 - Juli 2021', '2019-05-01', '2021-07-01', false],
  ['Okt 2019 - Nov 2021', '2019-10-01', '2021-11-01', false],
  ['Sept 2019 - Dec 2021', '2019-09-01', '2021-12-01', false],
  ['Mar 2019 sampai Jun 2021', '2019-03-01', '2021-06-01', false],
  ['Mar 2019 sampai dengan Jun 2021', '2019-03-01', '2021-06-01', false],
  ['Mar 2019 hingga Jun 2021', '2019-03-01', '2021-06-01', false],
  ['Mar 2019 s/d Jun 2021', '2019-03-01', '2021-06-01', false],
  ['Mar 2019 s.d. Jun 2021', '2019-03-01', '2021-06-01', false],
  ['Mar 2019 until Jun 2021', '2019-03-01', '2021-06-01', false],
  ['03/2019 - 06/2021', '2019-03-01', '2021-06-01', false],
  ['03/2019–06/2021', '2019-03-01', '2021-06-01', false],
  ['2019-03 - 2021-06', '2019-03-01', '2021-06-01', false],
  ['2020-01-01 - 2021-12-31', '2020-01-01', '2021-12-01', false],
  ['2019 - 2021', '2019-01-01', '2021-12-01', false],
  ['2019-2021', '2019-01-01', '2021-12-01', false],
  ['2019 – 2021', '2019-01-01', '2021-12-01', false],
  ['2019 s/d 2021', '2019-01-01', '2021-12-01', false],
  // garis miring sisa ekstraksi PDF
  ['Mar /2016 /– /Dec /2018', '2016-03-01', '2018-12-01', false],
  ['Jan /2021 /– /Dec /2022', '2021-01-01', '2022-12-01', false],
  ['Mar /2016 – Dec /2018', '2016-03-01', '2018-12-01', false],
  // masih berjalan
  ['Sep 2023 - Present', '2023-09-01', null, true],
  ['Sep 2023 - Now', '2023-09-01', null, true],
  ['Sep 2023 - Current', '2023-09-01', null, true],
  ['Sep 2023 - Currently', '2023-09-01', null, true],
  ['Sep 2023 - to date', '2023-09-01', null, true],
  ['Sep 2023 - Sekarang', '2023-09-01', null, true],
  ['Mei 2024 - Skrg', '2024-05-01', null, true],
  ['Mei 2024 - skrg.', '2024-05-01', null, true],
  ['Jan 2023 s/d Skrg', '2023-01-01', null, true],
  ['Sep 2023 - Saat ini', '2023-09-01', null, true],
  ['Sep 2023 - Hingga kini', '2023-09-01', null, true],
  ['Sep 2023 - Sampai sekarang', '2023-09-01', null, true],
  ['Sep 2023 s/d Sekarang', '2023-09-01', null, true],
  ['2024 - Sekarang', '2024-01-01', null, true],
  ['2024 – Present', '2024-01-01', null, true],
  ['Dec /2017 /– /Present', '2017-12-01', null, true],
  ['Mar /2016 – Present', '2016-03-01', null, true],
  ['2020-05-01 - present', '2020-05-01', null, true],
  ['Januari 2022 - Sekarang (2 tahun 10 bulan)', '2022-01-01', null, true],
]

test('parseDateRange: semua bentuk rentang tanggal lazim terbaca', () => {
  for (const [raw, start, end, current] of OK) assert.deepEqual(range(raw), [start, end, current], raw)
})

test('parseDateRange: tahun yang dipinjam dari akhir diberi catatan untuk pengguna', () => {
  const r = parseDateRange('Aug - Dec 2025', NOW)
  assert.ok(r?.notes.some((t) => /tahun mulai/i.test(t)))
})

test('parseDateRange: bentuk yang tidak boleh ditebak tetap null', () => {
  for (const raw of [
    'Aug - Present', // bulan mulai tanpa tahun dan tanpa tahun akhir
    'Aug - Dec', // tidak ada tahun sama sekali
    'Oct 2026', // satu tanggal, bukan rentang
    'Jan 2027 - Present', // mulai di masa depan
    'Jan 2026 - Dec 2027', // selesai di masa depan
    'Dec 2025 - Aug 2025', // selesai sebelum mulai
    'Software Engineer - Present',
    '',
    'foo bar',
  ]) {
    assert.equal(parseDateRange(raw, NOW), null, raw)
  }
})

test('explainDateRange: kode alasan gagal', () => {
  const why = (raw: string) => {
    const r = explainDateRange(raw, NOW)
    return r.ok ? 'ok' : r.reason
  }
  assert.equal(why('Aug - Dec 2025'), 'ok')
  assert.equal(why('Oct 2026'), 'unreadable')
  assert.equal(why('Jan 2027 - Present'), 'start_in_future')
  assert.equal(why('Jan 2026 - Dec 2027'), 'end_in_future')
  assert.equal(why('Dec 2025 - Aug 2025'), 'end_before_start')
})

test('isDateRangeText: hanya teks yang seluruhnya rentang tanggal', () => {
  assert.equal(isDateRangeText('Mar /2016 – Present'), true)
  assert.equal(isDateRangeText('Januari 2022 - Sekarang (2 tahun)'), true)
  assert.equal(isDateRangeText('Lead Engineer, Contoh Labs Feb - May 2026'), false)
  assert.equal(isDateRangeText('Led a team of 5 in 2019'), false)
})

test('parseYearRange (pendidikan): bentuk rentang tahun dan penanda masih berjalan yang lazim', () => {
  const ranges: Array<[string, number, number | 'present' | null]> = [
    ['2019 - 2023', 2019, 2023],
    ['2019-2023', 2019, 2023],
    ['2019 – 2023', 2019, 2023],
    ['2019 to 2023', 2019, 2023],
    ['2019 sampai 2023', 2019, 2023],
    ['2019 s/d 2023', 2019, 2023],
    ['Agustus 2019 s/d Juli 2023', 2019, 2023],
    ['Agu 2019 - Jul 2023', 2019, 2023],
    ['08/2019 - 07/2023', 2019, 2023],
    ['2019-08 - 2023-07', 2019, 2023],
    ['2022 - Present', 2022, 'present'],
    ['2022 - Currently', 2022, 'present'],
    ['2022 - Hingga kini', 2022, 'present'],
    ['2022 - Sampai saat ini', 2022, 'present'],
    ['2022 - to date', 2022, 'present'],
    ['2022 s/d Sekarang', 2022, 'present'],
    ['2023', 2023, null],
  ]
  for (const [raw, start, end] of ranges) {
    const got = parseYearRange(raw)
    assert.deepEqual([got?.start, got?.end], [start, end], raw)
  }
})

const src = 'Contoh Digital | Lead Engineer | Bandung'
const norm = (experiences: unknown[]) => normalizeExtraction({ experiences }, { sourceText: src, now: NOW })

test('normalizeExtraction: "Feb - May 2026" dari model tidak lagi membuang pengalaman', () => {
  const n = norm([{ company: 'Contoh Digital', title: 'Lead Engineer', date_range: 'Feb - May 2026' }])
  assert.deepEqual(n.experiences.map((e) => [e.start_date, e.end_date, e.is_current]), [['2026-02-01', '2026-05-01', false]])
  assert.equal(n.dropped.experiences, 0)
})

test('normalizeExtraction: jabatan sama di perusahaan sama pada dua periode keduanya dipertahankan, duplikat persis dibuang', () => {
  const n = norm([
    { company: 'Contoh Digital', title: 'Lead Engineer', date_range: 'Feb 2019 - Dec 2021' },
    { company: 'Contoh Digital', title: 'Lead Engineer', date_range: 'May 2024 - Present' },
    { company: 'Contoh Digital', title: 'Lead Engineer', date_range: 'May 2024 - Present' },
  ])
  assert.equal(n.experiences.length, 2)
  assert.equal(n.dropped.experiences, 1)
})

test('tahun akhir singkatan Skrg berarti masih berjalan', () => {
  const r = parseYearRange('2022 - Skrg')
  assert.ok(r)
  assert.equal(r!.start, 2022)
  assert.equal(r!.end, 'present')
})
