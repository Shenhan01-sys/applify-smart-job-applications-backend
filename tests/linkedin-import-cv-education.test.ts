import { test } from 'node:test'
import assert from 'node:assert/strict'
import { NOW } from './helpers/linkedinFixture.ts'
import { cleanPdfText, normalizeExtraction, parseWithRules, parseYearRange, splitSections } from '../services/linkedin-import.ts'

/**
 * Laporan produksi: pengguna mengunggah CV biasa (bukan PDF LinkedIn) dan profilnya terisi, kecuali Pendidikan.
 * Penyebab yang dibuktikan di sini, semuanya pada CV yang lazim di Indonesia dan luar negeri:
 *  1. Tahun tunggal ("Lulus 2023", angka 2023 dari model) membuat seluruh riwayat pendidikan dibuang.
 *  2. Tanda rentang "s/d", "s.d.", "08/2019 - 07/2023" dan minus Unicode tidak terbaca, tahun akhir kosong, item dibuang.
 *  3. Judul "Riwayat Pendidikan", "Pendidikan Formal", "Education Background" tidak dikenali, jadi tidak ada cadangan aturan.
 *  4. Parser aturan hanya mengenal format baris LinkedIn "gelar, bidang · (tahun)"; CV biasa menghasilkan nol.
 *  5. IPK / GPA tidak pernah dibawa ke pratinjau.
 * Semua teks SINTETIS (tokoh dan institusi fiktif). Tanpa jaringan.
 */

const norm = (raw: unknown, sourceText: string) => normalizeExtraction(raw, { sourceText, now: NOW })
const rows = (n: ReturnType<typeof norm>) => n.education.map((e) => [e.institution, e.degree, e.field_of_study, e.start_year, e.end_year, e.is_current])

// ───────────────────────────────────────────────────────────── tahun tunggal dan bentuk angka

test('normalizeExtraction: tahun lulus tunggal ("Lulus 2023") dan tahun berupa angka dari model tidak lagi membuang pendidikan', () => {
  const src = 'Universitas Fiktif Nusantara\nS1 Sistem Informasi\nLulus 2023\nSMA Fiktif 1 Yogyakarta\nIPA\n2020'
  const n = norm(
    {
      education: [
        { school: 'Universitas Fiktif Nusantara', degree: 'S1', field: 'Sistem Informasi', years: 'Lulus 2023' },
        { school: 'SMA Fiktif 1 Yogyakarta', degree: 'SMA', field: 'IPA', years: 2020 },
      ],
    },
    src,
  )
  assert.deepEqual(rows(n), [
    ['Universitas Fiktif Nusantara', 'S1', 'Sistem Informasi', 2023, 2023, false],
    ['SMA Fiktif 1 Yogyakarta', 'SMA', 'IPA', 2020, 2020, false],
  ])
  assert.equal(n.dropped.education, 0)
  assert.ok(n.education.every((e) => e.notes.some((t) => /satu tahun/i.test(t))), 'pengguna diberi tahu tahun masuk diisi dari tahun yang sama')
})

test('normalizeExtraction: tahun tunggal di masa depan (rencana lulus) tetap dibuang dan dihitung, bukan ditebak', () => {
  const src = 'Universitas Fiktif Nusantara\nS1 Sistem Informasi\nEstimasi lulus 2030'
  const n = norm({ education: [{ school: 'Universitas Fiktif Nusantara', degree: 'S1', field: 'Sistem Informasi', years: 'Estimasi lulus 2030' }] }, src)
  assert.equal(n.education.length, 0)
  assert.equal(n.dropped.education, 1)
})

test('normalizeExtraction: bentuk lain nama kunci dari model (educations, graduation_year, start_year/end_year) tetap terbaca', () => {
  const src = 'Politeknik Fiktif Pasundan\nD3 Manajemen Informatika 2018 2021\nUniversitas Fiktif Timur\nS2 Ilmu Komputer 2022'
  const n = norm(
    {
      educations: [
        { institution: 'Politeknik Fiktif Pasundan', degree: 'D3', field_of_study: 'Manajemen Informatika', start_year: 2018, end_year: 2021 },
        { school: 'Universitas Fiktif Timur', degree: 'S2', field: 'Ilmu Komputer', graduation_year: '2022' },
      ],
    },
    src,
  )
  assert.deepEqual(rows(n), [
    ['Universitas Fiktif Timur', 'S2', 'Ilmu Komputer', 2022, 2022, false],
    ['Politeknik Fiktif Pasundan', 'D3', 'Manajemen Informatika', 2018, 2021, false],
  ])
})

// ───────────────────────────────────────────────────────────── bentuk rentang tahun

test('parseYearRange: s/d, s.d., sd, until, nomor bulan, ISO, dan minus Unicode terbaca sebagai rentang', () => {
  const cases: Array<[string, unknown]> = [
    ['Juli 2019 s/d Juli 2023', { start: 2019, end: 2023 }],
    ['2019 s.d. 2023', { start: 2019, end: 2023 }],
    ['2019 s.d 2023', { start: 2019, end: 2023 }],
    ['2019 sd 2023', { start: 2019, end: 2023 }],
    ['Aug 2019 until Jul 2023', { start: 2019, end: 2023 }],
    ['08/2019 - 07/2023', { start: 2019, end: 2023 }],
    ['08/2019 – 07/2023', { start: 2019, end: 2023 }],
    ['2019-08 - 2023-07', { start: 2019, end: 2023 }],
    ['2019 − 2023', { start: 2019, end: 2023 }],
    ['2019 – 2023', { start: 2019, end: 2023 }],
    ['2019‑2023', { start: 2019, end: 2023 }],
    ['2021 s/d sekarang', { start: 2021, end: 'present' }],
    ['2021 - sampai sekarang', { start: 2021, end: 'present' }],
    ['2021 – now', { start: 2021, end: 'present' }],
    ['2021 - Kini', { start: 2021, end: 'present' }],
    ['2018', { start: 2018, end: null }],
  ]
  for (const [input, expected] of cases) assert.deepEqual(parseYearRange(input), expected, input)
})

test('normalizeExtraction: rentang tahun gaya CV Indonesia ("s/d", "08/2019 - 07/2023") masuk, "s/d Sekarang" = masih menempuh', () => {
  const src = [
    'Universitas Fiktif Barat', 'S1 Teknik Informatika', 'Agustus 2019 s/d Juli 2023',
    'Universitas Fiktif Timur', 'S2 Ilmu Komputer', '08/2023 - 07/2025',
    'Universitas Fiktif Utara', 'S3 Informatika', '2025 s/d Sekarang',
  ].join('\n')
  const n = norm(
    {
      education: [
        { school: 'Universitas Fiktif Barat', degree: 'S1', field: 'Teknik Informatika', years: 'Agustus 2019 s/d Juli 2023' },
        { school: 'Universitas Fiktif Timur', degree: 'S2', field: 'Ilmu Komputer', years: '08/2023 - 07/2025' },
        { school: 'Universitas Fiktif Utara', degree: 'S3', field: 'Informatika', years: '2025 s/d Sekarang' },
      ],
    },
    src,
  )
  assert.deepEqual(rows(n), [
    ['Universitas Fiktif Utara', 'S3', 'Informatika', 2025, null, true],
    ['Universitas Fiktif Timur', 'S2', 'Ilmu Komputer', 2023, 2025, false],
    ['Universitas Fiktif Barat', 'S1', 'Teknik Informatika', 2019, 2023, false],
  ])
  assert.equal(n.dropped.education, 0)
})

// ───────────────────────────────────────────────────────────── IPK / GPA

test('normalizeExtraction: IPK yang tercantum di CV ikut ke pratinjau (koma desimal, skala, "of")', () => {
  const src = 'Universitas Fiktif Barat S1 Teknik Informatika IPK 3,75 / 4,00 2019 - 2023\nFiktif Institute GPA: 3.40 of 4.00 Master of Science 2023 - 2025\nPoliteknik Fiktif D3 IP kumulatif 85.5/100 2016 - 2019'
  const n = norm(
    {
      education: [
        { school: 'Universitas Fiktif Barat', degree: 'S1', field: 'Teknik Informatika', years: '2019 - 2023', gpa: 'IPK 3,75 / 4,00' },
        { school: 'Fiktif Institute', degree: 'Master of Science', field: null, years: '2023 - 2025', gpa: '3.40' },
        { school: 'Politeknik Fiktif', degree: 'D3', field: null, years: '2016 - 2019', gpa: 85.5, max_gpa: 100 },
      ],
    },
    src,
  )
  const g = (inst: string) => n.education.find((e) => e.institution === inst)!
  assert.deepEqual([g('Universitas Fiktif Barat').gpa, g('Universitas Fiktif Barat').max_gpa], [3.75, 4])
  assert.deepEqual([g('Fiktif Institute').gpa, g('Fiktif Institute').max_gpa], [3.4, 4])
  assert.deepEqual([g('Politeknik Fiktif').gpa, g('Politeknik Fiktif').max_gpa], [85.5, 100])
})

test('normalizeExtraction: IPK karangan model (angka tidak ada di CV) atau melebihi skala dibuang, pendidikannya tetap masuk', () => {
  const src = 'Universitas Fiktif Barat\nS1 Teknik Informatika\n2019 - 2023\nIPK 3,10\nUniversitas Fiktif Timur\nS2 Ilmu Komputer\n2023 - 2025\nIPK 4,50/4,00'
  const n = norm(
    {
      education: [
        { school: 'Universitas Fiktif Barat', degree: 'S1', field: 'Teknik Informatika', years: '2019 - 2023', gpa: '3.95' },
        { school: 'Universitas Fiktif Timur', degree: 'S2', field: 'Ilmu Komputer', years: '2023 - 2025', gpa: '4,50/4,00' },
      ],
    },
    src,
  )
  assert.equal(n.education.length, 2)
  assert.deepEqual(n.education.map((e) => e.gpa), [null, null])
  const timur = n.education.find((e) => e.institution === 'Universitas Fiktif Timur')!
  assert.ok(timur.notes.some((t) => /IPK/.test(t)), 'IPK yang melebihi skala diberi catatan')
})

test('normalizeExtraction: tanpa IPK, gpa dan max_gpa null (bentuk lama tetap sah)', () => {
  const src = 'Universitas Fiktif Barat\nS1 Teknik Informatika\n2019 - 2023'
  const n = norm({ education: [{ school: 'Universitas Fiktif Barat', degree: 'S1', field: 'Teknik Informatika', years: '2019 - 2023' }] }, src)
  assert.deepEqual([n.education[0].gpa, n.education[0].max_gpa], [null, null])
})

// ───────────────────────────────────────────────────────────── judul seksi CV biasa

test('splitSections: judul Pendidikan versi CV biasa dikenali (kapital, bahasa Indonesia dan Inggris)', () => {
  for (const h of ['RIWAYAT PENDIDIKAN', 'Pendidikan Formal', 'Latar Belakang Pendidikan', 'PENDIDIKAN:', 'Education Background', 'EDUCATION & TRAINING', 'Education and Training', 'Academic Background', 'Educational Background', 'Pendidikan dan Pelatihan']) {
    const blocks = splitSections(`Nama Sintetis\n${h}\nUniversitas Fiktif Barat`)
    assert.deepEqual(blocks.map((b) => b.key), ['preamble', 'education'], h)
    assert.deepEqual(blocks[1].lines, ['Universitas Fiktif Barat'], h)
  }
})

test('splitSections: judul seksi CV biasa sesudah Pendidikan menutup bloknya (Keahlian tidak ikut terbaca sebagai pendidikan)', () => {
  const blocks = splitSections('RIWAYAT PENDIDIKAN\nUniversitas Fiktif Barat\nKEAHLIAN\nPython\nPENGALAMAN KERJA\nAnalis')
  assert.deepEqual(blocks.map((b) => [b.key, b.lines]), [
    ['preamble', []],
    ['education', ['Universitas Fiktif Barat']],
    ['skills', ['Python']],
    ['experience', ['Analis']],
  ])
})

// ───────────────────────────────────────────────────────────── parser aturan untuk CV biasa

const eduRules = (cv: string) => {
  const text = cleanPdfText([cv])
  return norm(parseWithRules(text), text)
}

test('aturan: CV Indonesia, institusi, jenjang + jurusan + IPK, lalu tahun di baris sendiri', () => {
  const n = eduRules(
    [
      'Dewi Lestari Sintetis', 'Analis Data', 'RIWAYAT PENDIDIKAN',
      'Universitas Fiktif Nusantara, Yogyakarta', 'S1 Sistem Informasi | IPK 3,75/4,00', '2022 - 2026',
      'SMA Negeri 1 Fiktif', 'Jurusan IPA', '2019 - 2022',
      'KEAHLIAN', 'Python', 'Excel',
    ].join('\n'),
  )
  assert.deepEqual(rows(n), [
    ['Universitas Fiktif Nusantara', 'S1', 'Sistem Informasi', 2022, 2026, false],
    ['SMA Negeri 1 Fiktif', 'SMA', 'IPA', 2019, 2022, false],
  ])
  assert.deepEqual([n.education[0].gpa, n.education[0].max_gpa], [3.75, 4])
  assert.equal(n.dropped.education, 0)
})

test('aturan: CV Indonesia, tahun di depan (tanggal, lalu institusi, lalu gelar) dan "s/d Sekarang"', () => {
  const n = eduRules(
    [
      'PENDIDIKAN FORMAL',
      '2023 s/d Sekarang', 'Universitas Fiktif Timur', 'Magister (S2) Ilmu Komputer',
      '2017 - 2021', 'Politeknik Fiktif Pasundan', 'Diploma Empat (D4) Teknik Informatika', 'IPK: 3,52',
    ].join('\n'),
  )
  assert.deepEqual(rows(n), [
    ['Universitas Fiktif Timur', 'S2', 'Ilmu Komputer', 2023, null, true],
    ['Politeknik Fiktif Pasundan', 'D4', 'Teknik Informatika', 2017, 2021, false],
  ])
  assert.equal(n.education[1].gpa, 3.52)
})

test('aturan: CV Inggris, satu baris per entri (tahun, institusi, gelar, GPA) dan tahun lulus saja', () => {
  const n = eduRules(
    [
      'EDUCATION',
      'Aug 2019 - Jul 2023 | Fiktif Institute of Technology - Bachelor of Computer Science, GPA 3.80/4.00',
      'Universitas Fiktif Barat, Master of Science in Data Science, 2025',
    ].join('\n'),
  )
  assert.deepEqual(rows(n), [
    ['Universitas Fiktif Barat', 'Master', 'Science in Data Science', 2025, 2025, false],
    ['Fiktif Institute of Technology', 'Bachelor', 'Computer Science', 2019, 2023, false],
  ])
  assert.equal(n.education[1].gpa, 3.8)
})

test('aturan: nama institusi yang memuat tahun ("Universitas 17 Agustus 1945") tidak dikira tanggal', () => {
  const n = eduRules(['Pendidikan', 'Universitas 17 Agustus 1945 Fiktif', 'S1 Hukum', '2018 - 2022'].join('\n'))
  assert.deepEqual(rows(n), [['Universitas 17 Agustus 1945 Fiktif', 'S1', 'Hukum', 2018, 2022, false]])
})

test('aturan: baris format LinkedIn tetap dibaca seperti sebelumnya (tidak tertimpa parser CV biasa)', () => {
  const n = eduRules(['Education', 'Universitas Fiktif Barat', "Bachelor's degree, Computer Science · (2019 - 2023)"].join('\n'))
  assert.deepEqual(rows(n), [['Universitas Fiktif Barat', "Bachelor's degree", 'Computer Science', 2019, 2023, false]])
})

test('aturan: entri tanpa jenjang atau tanpa tahun tidak ditebak, hanya dihitung sebagai dibuang', () => {
  const n = eduRules(['Pendidikan', 'Universitas Fiktif Barat', 'Teknik Informatika', '2019 - 2023', 'Universitas Fiktif Timur', 'S1 Akuntansi'].join('\n'))
  assert.deepEqual(rows(n), [])
  assert.equal(n.dropped.education, 2)
})
