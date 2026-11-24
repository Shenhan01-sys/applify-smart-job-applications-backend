import { test } from 'node:test'
import assert from 'node:assert/strict'
import { NOW } from './helpers/linkedinFixture.ts'
import { cleanPdfText, normalizeExtraction, parseWithRules } from '../services/linkedin-import.ts'

/**
 * Parser aturan untuk pendidikan: tidak boleh bergantung pada satu tata letak CV. Judul seksi Indonesia dan Inggris,
 * entri satu baris atau tersebar di 2 sampai 4 baris dengan urutan institusi, gelar, tanggal yang bebas, tanggal
 * kiri atau kanan, gelar Indonesia (SD sampai S3, S.Kom., M.T., ...) dan Inggris (High School, Associate, BSc, MBA, PhD),
 * serta sekolah tanpa kode gelar (jenjang = nama sekolah). Semua teks SINTETIS. Tanpa jaringan. NOW = 2026-11-20.
 */

type Row = [string, string, string | null, number, number | null, boolean]

const cv = (heading: string, lines: string[], after: string[] = ['SKILLS', 'Python, SQL']) => cleanPdfText([['Rina Contoh', 'Mahasiswa', 'Bandung', heading, ...lines, ...after].join('\n')])
const rowsOf = (text: string): { rows: Row[]; dropped: number } => {
  const n = normalizeExtraction(parseWithRules(text), { sourceText: text, now: NOW })
  return { rows: n.education.map((e) => [e.institution, e.degree, e.field_of_study, e.start_year, e.end_year, e.is_current]), dropped: n.dropped.education }
}
const read = (lines: string[], heading = 'EDUCATION') => rowsOf(cv(heading, lines))

const I1 = 'Universitas Contoh Nusantara'
const D1 = 'S1 Sistem Informasi'
const T1 = 'Agustus 2019 - Juli 2023'
const E1: Row = [I1, 'S1', 'Sistem Informasi', 2019, 2023, false]
const I2 = 'Politeknik Contoh Pasundan'
const D2 = 'D3 Manajemen Informatika'
const T2 = '2015 - 2018'
const E2: Row = [I2, 'D3', 'Manajemen Informatika', 2015, 2018, false]

test('judul seksi pendidikan Indonesia dan Inggris, huruf besar dan judul', () => {
  for (const heading of [
    'PENDIDIKAN', 'Pendidikan', 'RIWAYAT PENDIDIKAN', 'Riwayat Pendidikan', 'Pendidikan Formal', 'PENDIDIKAN FORMAL', 'Pendidikan Terakhir',
    'Latar Belakang Pendidikan', 'Pendidikan dan Pelatihan', 'EDUCATION', 'Education', 'Education Background', 'Educational Background',
    'Academic Background', 'EDUCATION & TRAINING', 'Education and Training', 'Educational Qualifications', 'Academic Qualifications', 'Pendidikan:',
  ]) {
    assert.deepEqual(read([I1, D1, T1], heading).rows, [E1], heading)
  }
})

const SINGLE_LAYOUTS: Array<[string, string[]]> = [
  ['institusi, gelar, tanggal', [I1, D1, T1]],
  ['tanggal, institusi, gelar', [T1, I1, D1]],
  ['gelar, institusi, tanggal', [D1, I1, T1]],
  ['institusi, tanggal, gelar', [I1, T1, D1]],
  ['gelar, tanggal, institusi', [D1, T1, I1]],
  ['tanggal, gelar, institusi', [T1, D1, I1]],
  ['satu baris: institusi | gelar | tanggal', [`${I1} | ${D1} | ${T1}`]],
  ['satu baris: gelar | institusi | tanggal', [`${D1} | ${I1} | ${T1}`]],
  ['satu baris: tanggal | institusi | gelar', [`${T1} | ${I1} | ${D1}`]],
  ['satu baris: institusi, kota | gelar tanggal', [`${I1}, Bandung | ${D1} ${T1}`]],
  ['satu baris: institusi - gelar (tanggal)', [`${I1} - ${D1} (${T1})`]],
  ['satu baris: institusi – gelar – tanggal (en dash)', [`${I1} – ${D1} – ${T1}`]],
  ['dua baris: institusi, lalu "gelar (tanggal)"', [I1, `${D1} (${T1})`]],
  ['dua baris: institusi (tanggal), lalu gelar', [`${I1} (${T1})`, D1]],
  ['dua baris: "institusi tanggal", lalu gelar', [`${I1} | ${T1}`, D1]],
  ['empat baris: institusi, gelar, bidang, tanggal', [I1, 'S1', 'Sistem Informasi', T1]],
]

test('satu entri dalam semua urutan baris dan penempatan tanggal', () => {
  for (const [name, lines] of SINGLE_LAYOUTS) assert.deepEqual(read(lines).rows, [E1], name)
})

const DOUBLE_LAYOUTS: Array<[string, string[]]> = [
  ['institusi, gelar, tanggal', [I1, D1, T1, I2, D2, T2]],
  ['tanggal, institusi, gelar', [T1, I1, D1, T2, I2, D2]],
  ['gelar, institusi, tanggal', [D1, I1, T1, D2, I2, T2]],
  ['institusi, tanggal, gelar', [I1, T1, D1, I2, T2, D2]],
  ['gelar, tanggal, institusi', [D1, T1, I1, D2, T2, I2]],
  ['satu baris institusi | gelar | tanggal', [`${I1} | ${D1} | ${T1}`, `${I2} | ${D2} | ${T2}`]],
  ['satu baris gelar | institusi | tanggal', [`${D1} | ${I1} | ${T1}`, `${D2} | ${I2} | ${T2}`]],
  ['satu baris tanggal | institusi | gelar', [`${T1} | ${I1} | ${D1}`, `${T2} | ${I2} | ${D2}`]],
]

test('dua entri berurutan tidak saling bertukar gelar atau tanggal dalam semua urutan baris', () => {
  for (const [name, lines] of DOUBLE_LAYOUTS) assert.deepEqual(read(lines), { rows: [E1, E2], dropped: 0 }, name)
})

const DEGREES: Array<[string, string, string | null]> = [
  // Indonesia
  ['S1 Sistem Informasi', 'S1', 'Sistem Informasi'],
  ['S2 Ilmu Komputer', 'S2', 'Ilmu Komputer'],
  ['S3 Ilmu Komputer', 'S3', 'Ilmu Komputer'],
  ['D3 Manajemen Informatika', 'D3', 'Manajemen Informatika'],
  ['D4 Teknik Informatika', 'D4', 'Teknik Informatika'],
  ['D-IV Teknik Informatika', 'D-IV', 'Teknik Informatika'],
  ['Sarjana Teknik Informatika', 'Sarjana', 'Teknik Informatika'],
  ['Diploma III Akuntansi', 'Diploma III', 'Akuntansi'],
  ['S.Kom. Sistem Informasi', 'S.Kom.', 'Sistem Informasi'],
  ['S.T. Teknik Sipil', 'S.T.', 'Teknik Sipil'],
  ['S.E. Akuntansi', 'S.E.', 'Akuntansi'],
  ['S.Si Matematika', 'S.Si', 'Matematika'],
  ['S.Pd Pendidikan Matematika', 'S.Pd', 'Pendidikan Matematika'],
  ['M.Kom. Ilmu Komputer', 'M.Kom.', 'Ilmu Komputer'],
  ['M.T. Teknik Elektro', 'M.T.', 'Teknik Elektro'],
  ['M.M. Manajemen Keuangan', 'M.M.', 'Manajemen Keuangan'],
  // Inggris
  ['Bachelor of Science in Computer Science', 'Bachelor of Science', 'Computer Science'],
  ['Bachelor of Engineering in Civil Engineering', 'Bachelor of Engineering', 'Civil Engineering'],
  ["Bachelor's degree in Accounting", "Bachelor's degree", 'Accounting'],
  ['BSc Computer Science', 'BSc', 'Computer Science'],
  ['B.A. English Literature', 'B.A.', 'English Literature'],
  ['B.Eng. Electrical Engineering', 'B.Eng.', 'Electrical Engineering'],
  ['Master of Science in Data Science', 'Master of Science', 'Data Science'],
  ['MSc Data Science', 'MSc', 'Data Science'],
  ['MBA Finance', 'MBA', 'Finance'],
  ['M.Eng. Mechatronics', 'M.Eng.', 'Mechatronics'],
  ['PhD Computer Science', 'PhD', 'Computer Science'],
  ['Associate Degree in Accounting', 'Associate Degree', 'Accounting'],
]

test('gelar Indonesia dan Inggris (kode, kata, singkatan bergelar) terbaca dengan bidangnya, di tata letak banyak baris dan satu baris', () => {
  for (const [degreeText, degree, field] of DEGREES) {
    const want: Row = [I1, degree, field, 2019, 2023, false]
    assert.deepEqual(read([I1, degreeText, '2019 - 2023']).rows, [want], `banyak baris: ${degreeText}`)
    assert.deepEqual(read([`${I1}, Bandung | ${degreeText} 2019 - 2023`]).rows, [want], `satu baris: ${degreeText}`)
    assert.deepEqual(read([`${degreeText} | ${I1} | 2019 - 2023`]).rows, [want], `gelar di depan: ${degreeText}`)
  }
})

const SCHOOLS: Array<[string[], string, string | null]> = [
  [['SMA Negeri 1 Contoh', 'Jurusan IPA', '2016 - 2019'], 'SMA', 'IPA'],
  [['SMA Negeri 1 Contoh', '2016 - 2019'], 'SMA', null],
  [['SMAN 1 Contoh', 'IPS', '2016 - 2019'], 'SMAN', 'IPS'],
  [['SMK Negeri 2 Contoh', 'Teknik Komputer dan Jaringan', '2016 - 2019'], 'SMK', 'Teknik Komputer dan Jaringan'],
  [['SMP Negeri 3 Contoh', '2013 - 2016'], 'SMP', null],
  [['SD Negeri 5 Contoh', '2007 - 2013'], 'SD', null],
  [['Madrasah Aliyah Negeri 1 Contoh', '2016 - 2019'], 'Madrasah Aliyah', null],
  [['Contoh High School', '2012 - 2016'], 'High School', null],
  [['Contoh Senior High School', 'Science Track', '2012 - 2016'], 'Senior High School', 'Science Track'],
  [['SMA Negeri 1 Contoh | IPA | 2016 - 2019'], 'SMA', 'IPA'],
  [['SMA Negeri 1 Contoh, Bandung | 2016 - 2019'], 'SMA', null],
  [['SMA Negeri 1 Contoh, Bandung', '2016 - 2019'], 'SMA', null],
  [['2016 - 2019 | SMA Negeri 1 Contoh | IPA'], 'SMA', 'IPA'],
]

test('sekolah tanpa kode gelar tetap dipertahankan dengan jenjang dari nama sekolah sebagai gelar', () => {
  for (const [lines, degree, field] of SCHOOLS) {
    const text = cv('EDUCATION', lines)
    const { rows, dropped } = rowsOf(text)
    assert.equal(dropped, 0, lines.join(' / '))
    assert.equal(rows.length, 1, lines.join(' / '))
    assert.deepEqual([rows[0][1], rows[0][2]], [degree, field], lines.join(' / '))
    assert.equal(rows[0][3] < rows[0][4]!, true, lines.join(' / '))
  }
})

test('kuliah dan SMA dalam satu seksi: keduanya terbaca dalam urutan sumber', () => {
  assert.deepEqual(read([I1, D1, T1, 'SMA Negeri 1 Contoh', 'Jurusan IPA', '2016 - 2019']).rows, [
    E1,
    ['SMA Negeri 1 Contoh', 'SMA', 'IPA', 2016, 2019, false],
  ])
  assert.deepEqual(read([`${I1} | ${D1} | ${T1}`, 'SMA Negeri 1 Contoh | IPA | 2016 - 2019']).rows, [E1, ['SMA Negeri 1 Contoh', 'SMA', 'IPA', 2016, 2019, false]])
})

const DATES: Array<[string, number, number | null, boolean]> = [
  ['2019 - 2023', 2019, 2023, false],
  ['2019-2023', 2019, 2023, false],
  ['2019 – 2023', 2019, 2023, false],
  ['2019 — 2023', 2019, 2023, false],
  ['2019 s/d 2023', 2019, 2023, false],
  ['2019 s.d. 2023', 2019, 2023, false],
  ['2019 sampai 2023', 2019, 2023, false],
  ['2019 sampai dengan 2023', 2019, 2023, false],
  ['2019 hingga 2023', 2019, 2023, false],
  ['2019 to 2023', 2019, 2023, false],
  ['08/2019 - 07/2023', 2019, 2023, false],
  ['Agustus 2019 - Juli 2023', 2019, 2023, false],
  ['Agu 2019 - Jul 2023', 2019, 2023, false],
  ['Aug 2019 – Jul 2023', 2019, 2023, false],
  ['September 2019 to June 2023', 2019, 2023, false],
  ['2022 - Present', 2022, null, true],
  ['2022 - Now', 2022, null, true],
  ['2022 - Current', 2022, null, true],
  ['2022 - Sekarang', 2022, null, true],
  ['2022 - Saat ini', 2022, null, true],
  ['2022 - Hingga kini', 2022, null, true],
  ['2022 s/d Sekarang', 2022, null, true],
  ['Sep 2023 - Expected Mar 2027', 2023, 2027, true],
  ['Sep 2023 - Perkiraan Mar 2027', 2023, 2027, true],
  ['2023 - 2027 (expected)', 2023, 2027, true],
  ['2023 - 2027', 2023, 2027, true],
]

test('format tanggal pendidikan: rentang, nama bulan Indonesia dan Inggris, pemisah, penanda masih berjalan atau perkiraan', () => {
  for (const [dates, start, end, current] of DATES) {
    for (const lines of [[I1, D1, dates], [`${I1} | ${D1} | ${dates}`], [dates, I1, D1], [`${dates} | ${I1} | ${D1}`]]) {
      const { rows, dropped } = read(lines)
      assert.deepEqual(rows, [[I1, 'S1', 'Sistem Informasi', start, end, current]], `${dates} / ${lines.length} baris`)
      assert.equal(dropped, 0)
    }
  }
})

test('tahun tunggal (tahun lulus) dipakai sebagai tahun masuk dan lulus; perkiraan yang sudah lewat ditandai masih menempuh', () => {
  assert.deepEqual(read([`Bachelor of Science in Ilmu Komputer | ${I1} | 2016`]).rows, [[I1, 'Bachelor of Science', 'Ilmu Komputer', 2016, 2016, false]])
  assert.deepEqual(read([`Bachelor of Science in Manajemen | ${I1} | 2025 (expected)`]).rows, [[I1, 'Bachelor of Science', 'Manajemen', 2025, 2025, true]])
  assert.deepEqual(read([`Bachelor of Science in Manajemen | ${I1} | 2030 (expected)`]), { rows: [], dropped: 1 }) // masa depan: tahun masuk tidak diketahui
})

test('"Gelar in Bidang | Institusi | tahun" dan "Bidang | Institusi | rentang" tanpa kode gelar', () => {
  assert.deepEqual(read([`Manajemen in Manajemen | Universitas Contoh Barat | 2010-2014`]).rows, [['Universitas Contoh Barat', 'Manajemen', null, 2010, 2014, false]])
  assert.deepEqual(read([`Manajemen / Komputer in Manajemen / Komputer | Universitas Contoh Barat | 2020-2024`]).rows, [['Universitas Contoh Barat', 'Manajemen / Komputer', null, 2020, 2024, false]])
  assert.deepEqual(read([`Manajemen Pemasaran | Institut Contoh Bandung | 2014-2018`]).rows, [['Institut Contoh Bandung', 'Manajemen Pemasaran', null, 2014, 2018, false]])
})

test('baris kontak, tautan, dan penanda dokumen di dalam seksi tidak mengubah hasil', () => {
  const noise = ['+62-812-3456-7890 | rina@example.com | Bandung | https://linkedin.com/in/rina-contoh', 'Generated by Contoh Pipeline | 2026-08-11 | Tailored for Analyst']
  assert.deepEqual(read([...noise, I1, D1, T1, ...noise]), { rows: [E1], dropped: 0 })
})

test('seksi gabungan sesudah Pendidikan ("Certifications & Achievements") tidak ikut terbaca sebagai pendidikan', () => {
  const after = ['CERTIFICATIONS & ACHIEVEMENTS', '• Certified Contoh Developer – Contoh Institute (2022)', '• Winner, Contoh University Hackathon (2021)', 'SKILLS', 'Python']
  assert.deepEqual(read([`${I1} | ${D1} | ${T1}`], 'EDUCATION').rows, [E1])
  assert.deepEqual(rowsOf(cv('EDUCATION', [`${I1} | ${D1} | ${T1}`], after)), { rows: [E1], dropped: 0 })
})

test('baris yang bukan pendidikan di dalam seksi: penghargaan, bootcamp, inkubator, kursus, daftar nilai', () => {
  const lines = [
    `${I1}, Bandung | B.Sc. Computer Science ${T1}`,
    'GPA 3.80/4.00. Grade A: Algorithms, Databases, Capstone Project',
    '2nd Place, University-Level Contoh Student Award 2025; Regional delegate.',
    'Contoh Growth Incubator, cohort 4 | Contoh Academy Accepted Jun 2026',
    'Contoh International Bootcamp | Pulau Labs Mar 2026',
    'Coursework: University Physics, Linear Algebra',
  ]
  const text = cv('EDUCATION', lines)
  const n = normalizeExtraction(parseWithRules(text), { sourceText: text, now: NOW })
  assert.deepEqual(n.education.map((e) => [e.institution, e.degree, e.field_of_study, e.gpa]), [[I1, 'B.Sc.', 'Computer Science', 3.8]])
  assert.equal(n.dropped.education, 0)
})

test('tata letak LinkedIn "Gelar Bidang (tanggal)" tanpa koma memisahkan kode gelar dari bidangnya', () => {
  assert.deepEqual(read([I1, `${D1} (${T1})`]).rows, [E1])
  assert.deepEqual(read([I1, `Bachelor of Science in Computer Science (2019 - 2023)`]).rows, [[I1, 'Bachelor of Science', 'Computer Science', 2019, 2023, false]])
})
