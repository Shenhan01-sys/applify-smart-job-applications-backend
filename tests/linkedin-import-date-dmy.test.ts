import { test } from 'node:test'
import assert from 'node:assert/strict'
import { NOW } from './helpers/linkedinFixture.ts'
import { explainDateRange, normalizeExtraction, parseDateRange, parseWithRules, parseYearRange } from '../services/linkedin-import.ts'

/**
 * Tanggal lengkap hari/bulan/tahun di CV Indonesia: DD/MM/YYYY dan D/M/YYYY (hari dulu). Sebelumnya rentang seperti
 * "01/03/2023 - 30/06/2024" tidak terbaca (pengalaman dibuang) dan pada pendidikan tahun akhirnya hilang diam-diam
 * (2018 - 2022 menjadi 2018 - 2018). NOW = 2026-11-20. Semua teks SINTETIS.
 */

const DAY_MONTH_NOTE = /urutan hari\/bulan\/tahun/

const view = (raw: string) => {
  const r = parseDateRange(raw, NOW)
  return r ? { start: r.start, end: r.end, current: r.is_current, dayMonthNote: r.notes.some((n) => DAY_MONTH_NOTE.test(n)) } : null
}

test('DD/MM/YYYY dan D/M/YYYY terbaca sebagai hari/bulan/tahun; hari diabaikan, hasilnya YYYY-MM-01', () => {
  // hari lebih dari 12: pasti hari, tidak ada yang perlu diperiksa pengguna
  assert.deepEqual(view('15/08/2023 - 20/12/2024'), { start: '2023-08-01', end: '2024-12-01', current: false, dayMonthNote: false })
  assert.deepEqual(view('31/01/2022 – 28/02/2023'), { start: '2022-01-01', end: '2023-02-01', current: false, dayMonthNote: false })
  assert.deepEqual(view('15/08/2023 - sekarang'), { start: '2023-08-01', end: null, current: true, dayMonthNote: false })
  assert.deepEqual(view('15/08/2023 s/d Present'), { start: '2023-08-01', end: null, current: true, dayMonthNote: false })
  // pemisah titik dan strip, tanpa nol di depan
  assert.deepEqual(view('15.08.2023 s/d 20.12.2024'), { start: '2023-08-01', end: '2024-12-01', current: false, dayMonthNote: false })
  assert.deepEqual(view('15-08-2023 - 20-12-2024'), { start: '2023-08-01', end: '2024-12-01', current: false, dayMonthNote: false })
  assert.deepEqual(view('13/8/2023 - 14/9/2024'), { start: '2023-08-01', end: '2024-09-01', current: false, dayMonthNote: false })
  // hari sama dengan bulan: dibaca cara apa pun hasilnya sama, jadi bukan tebakan
  assert.deepEqual(view('05/05/2023 - 06/2024'), { start: '2023-05-01', end: '2024-06-01', current: false, dayMonthNote: false })
})

test('DD/MM ambigu (dua angka depan <= 12): dibaca hari dulu, urutan Indonesia, dan pengguna diberi catatan', () => {
  // 03/04/2023 = 3 April 2023 (bukan 4 Maret). 05/06/2024 = 5 Juni 2024 (bukan 6 Mei).
  assert.deepEqual(view('03/04/2023 - 05/06/2024'), { start: '2023-04-01', end: '2024-06-01', current: false, dayMonthNote: true })
  assert.deepEqual(view('1/3/2023 - 5/6/2024'), { start: '2023-03-01', end: '2024-06-01', current: false, dayMonthNote: true })
  // satu sisi ambigu cukup untuk catatan
  assert.deepEqual(view('01/03/2023 - 30/06/2024'), { start: '2023-03-01', end: '2024-06-01', current: false, dayMonthNote: true })
  assert.deepEqual(view('10/02/2023 - sekarang'), { start: '2023-02-01', end: null, current: true, dayMonthNote: true })
})

test('urutan bulan/hari (MM/DD/YYYY) tidak ditukar diam-diam: bulan di luar 1-12 atau hari yang tidak ada berarti tidak terbaca', () => {
  for (const raw of [
    '03/15/2023 - 04/2024', // gaya Amerika: bulan 15 tidak ada
    '12/31/2022 - Present',
    '31/02/2023 - 04/2024', // 31 Februari tidak ada
    '29/02/2023 - 04/2024', // 2023 bukan tahun kabisat
    '00/05/2023 - 06/2024',
    '15/00/2023 - 06/2024',
  ]) {
    assert.equal(parseDateRange(raw, NOW), null, raw)
    const r = explainDateRange(raw, NOW)
    assert.equal(r.ok ? 'ok' : r.reason, 'unreadable', raw)
  }
  assert.deepEqual(view('29/02/2024 - 03/2025'), { start: '2024-02-01', end: '2025-03-01', current: false, dayMonthNote: false }) // 2024 kabisat
})

test('tanggal dengan nama bulan: "15 Agustus 2023" dan "1 Jan 2024" terbaca', () => {
  assert.deepEqual(view('15 Agustus 2023 - 20 Desember 2024'), { start: '2023-08-01', end: '2024-12-01', current: false, dayMonthNote: false })
  assert.deepEqual(view('1 Jan 2024 - Present'), { start: '2024-01-01', end: null, current: true, dayMonthNote: false })
  assert.equal(parseDateRange('31 Februari 2023 - Present', NOW), null)
})

test('bentuk lama tidak rusak: MM/YYYY, "Jan 2024", "Januari 2024", "2024 - sekarang", "2024 - present"', () => {
  assert.deepEqual(view('03/2019 - 06/2021'), { start: '2019-03-01', end: '2021-06-01', current: false, dayMonthNote: false })
  assert.deepEqual(view('3/2019 - 6/2021'), { start: '2019-03-01', end: '2021-06-01', current: false, dayMonthNote: false })
  assert.deepEqual(view('03.2019 - 06.2021'), { start: '2019-03-01', end: '2021-06-01', current: false, dayMonthNote: false })
  assert.deepEqual(view('Jan 2024 - Present'), { start: '2024-01-01', end: null, current: true, dayMonthNote: false })
  assert.deepEqual(view('Januari 2024 - Sekarang'), { start: '2024-01-01', end: null, current: true, dayMonthNote: false })
  assert.deepEqual(view('Januari 2024 - Maret 2025'), { start: '2024-01-01', end: '2025-03-01', current: false, dayMonthNote: false })
  assert.deepEqual(view('2024 - sekarang'), { start: '2024-01-01', end: null, current: true, dayMonthNote: false })
  assert.deepEqual(view('2024 - present'), { start: '2024-01-01', end: null, current: true, dayMonthNote: false })
  assert.deepEqual(view('2022-01 - 2023-05'), { start: '2022-01-01', end: '2023-05-01', current: false, dayMonthNote: false })
  assert.deepEqual(view('2020-01-01 - 2021-12-31'), { start: '2020-01-01', end: '2021-12-01', current: false, dayMonthNote: false })
  // MM/YYYY tetap bulan/tahun, bukan hari/bulan
  assert.deepEqual(view('12/2023 - Present'), { start: '2023-12-01', end: null, current: true, dayMonthNote: false })
})

test('pendidikan (parseYearRange): tahun akhir tidak hilang pada tanggal lengkap', () => {
  const years = (raw: string) => {
    const r = parseYearRange(raw)
    return r ? [r.start, r.end] : null
  }
  assert.deepEqual(years('01/08/2018 - 30/07/2022'), [2018, 2022])
  assert.deepEqual(years('1/8/2018 s/d 30/7/2022'), [2018, 2022])
  assert.deepEqual(years('15.08.2018 - 20.07.2022'), [2018, 2022])
  assert.deepEqual(years('15 Agustus 2018 - 20 Juli 2022'), [2018, 2022])
  assert.deepEqual(years('01/08/2018 - sekarang'), [2018, 'present'])
  // bentuk lama
  assert.deepEqual(years('08/2018 - 07/2022'), [2018, 2022])
  assert.deepEqual(years('Agustus 2018 s/d Juli 2022'), [2018, 2022])
  assert.deepEqual(years('2018 - sekarang'), [2018, 'present'])
  assert.deepEqual(years('2018 - 2022'), [2018, 2022])
})

const CV_DMY = [
  'Dewi Lestari Sintetis',
  'PENGALAMAN KERJA',
  'Analis Data',
  'Studio Fiktif Cahaya',
  '15/08/2023 - sekarang',
  'Membuat laporan mingguan untuk tim.',
  'Analis Data',
  'Koperasi Fiktif Sejahtera',
  '01/03/2021 - 30/06/2023',
  'Menyusun rekap bulanan.',
  'RIWAYAT PENDIDIKAN',
  'Universitas Fiktif Nusantara',
  'S1 Sistem Informasi',
  '01/08/2017 - 30/07/2021',
].join('\n')

test('parser aturan: pengalaman dan pendidikan bertanggal DD/MM/YYYY terbaca, tebakan hari/bulan diberi catatan', () => {
  const n = normalizeExtraction(parseWithRules(CV_DMY), { sourceText: CV_DMY, now: NOW })
  assert.equal(n.dropped.experiences, 0)
  assert.deepEqual(
    n.experiences.map((e) => [e.start_date, e.end_date, e.is_current]),
    [
      ['2023-08-01', null, true],
      ['2021-03-01', '2023-06-01', false],
    ],
  )
  // 15/08 tidak ambigu; 01/03/2021 - 30/06/2023 ambigu pada tanggal mulai
  assert.deepEqual(n.experiences.map((e) => e.notes.some((t) => DAY_MONTH_NOTE.test(t))), [false, true])
  assert.deepEqual(n.education.map((e) => [e.institution, e.start_year, e.end_year]), [['Universitas Fiktif Nusantara', 2017, 2021]])
})

test('normalizeExtraction: tanggal DD/MM/YYYY dari jawaban model tidak membuang pengalaman', () => {
  const src = 'Studio Fiktif Cahaya | Analis Data | Bandung'
  const n = normalizeExtraction({ experiences: [{ company: 'Studio Fiktif Cahaya', title: 'Analis Data', date_range: '01/03/2023 - 30/06/2024' }] }, { sourceText: src, now: NOW })
  assert.equal(n.dropped.experiences, 0)
  assert.deepEqual(n.experiences.map((e) => [e.start_date, e.end_date, e.is_current]), [['2023-03-01', '2024-06-01', false]])
  assert.ok(n.experiences[0].notes.some((t) => DAY_MONTH_NOTE.test(t)))
  // urutan Amerika tetap dibuang dengan alasan jelas, tidak ditukar
  const us = normalizeExtraction({ experiences: [{ company: 'Studio Fiktif Cahaya', title: 'Analis Data', date_range: '03/15/2023 - 06/2024' }] }, { sourceText: src, now: NOW })
  assert.equal(us.experiences.length, 0)
  assert.equal(us.dropReasons.experiences.date_unreadable, 1)
})
