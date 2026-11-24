import { test } from 'node:test'
import assert from 'node:assert/strict'
import { NOW } from './helpers/linkedinFixture.ts'
import { cleanPdfText, normalizeExtraction, parseWithRules } from '../services/linkedin-import.ts'

/**
 * Pengalaman pada CV biasa: satu baris judul memuat jabatan, perusahaan, dan tanggal, diikuti poin uraian. Parser aturan
 * sebelumnya hanya mengenal format PDF LinkedIn (baris tanggal sendiri) sehingga CV biasa menghasilkan nol pengalaman.
 * Bentuk yang diuji: "Jabatan | Perusahaan | Kota | Tanggal", "Jabatan, Perusahaan | Konteks Tanggal", "Jabatan at
 * Perusahaan (Tanggal)", urutan terbalik, tanggal dengan bulan tanpa tahun, ISO, garis miring sisa PDF, penebalan
 * markdown, dan baris proyek yang bukan pengalaman. Semua teks SINTETIS. Tanpa jaringan. NOW = 2026-11-20.
 */

type Row = [string, string, string, string | null, boolean]

const cv = (lines: string[], heading = 'PROFESSIONAL EXPERIENCE', after: string[] = ['EDUCATION', 'Universitas Contoh Nusantara | S1 Sistem Informasi | 2015 - 2019']) =>
  cleanPdfText([['Rina Contoh', 'Software Engineer', 'Bandung', heading, ...lines, ...after].join('\n')])
const read = (lines: string[], heading?: string, after?: string[]) => {
  const text = cv(lines, heading, after)
  const n = normalizeExtraction(parseWithRules(text), { sourceText: text, now: NOW })
  return { rows: n.experiences.map((e): Row => [e.company_name, e.role_title, e.start_date, e.end_date, e.is_current]), dropped: n.dropped.experiences, n }
}

const BULLETS = ['• Built a reporting dashboard used by 40 analysts.', '• Reduced nightly job time from 3 hours to 40 minutes.']

const FORMS: Array<[string, string, Row]> = [
  ['pipa: jabatan | perusahaan | kota | rentang', 'Senior Frontend Engineer | Contoh Teknologi A | Jakarta | Mar 2016 – Present', ['Contoh Teknologi A', 'Senior Frontend Engineer', '2016-03-01', null, true]],
  ['pipa dengan garis miring sisa PDF', 'Senior Frontend Engineer | Contoh Teknologi A | Jakarta | Mar /2016 – Present', ['Contoh Teknologi A', 'Senior Frontend Engineer', '2016-03-01', null, true]],
  ['pipa dengan garis miring di sekitar strip', 'Data Analyst | Contoh Data B | Semarang | Dec /2017 /– /Dec /2019', ['Contoh Data B', 'Data Analyst', '2017-12-01', '2019-12-01', false]],
  ['pipa, ISO penuh', 'Data Analyst | Contoh Data B | Semarang | 2020-01-01 - 2021-12-31', ['Contoh Data B', 'Data Analyst', '2020-01-01', '2021-12-01', false]],
  ['pipa, ISO sampai present', 'Data Analyst | Contoh Data B | Semarang | 2020-05-01 - present', ['Contoh Data B', 'Data Analyst', '2020-05-01', null, true]],
  ['pipa, penebalan markdown', '**Nutritionist (Ahli Gizi)** | Contoh Kesehatan A | Balikpapan | 2025-03-01 - present', ['Contoh Kesehatan A', 'Nutritionist (Ahli Gizi)', '2025-03-01', null, true]],
  ['pipa tanpa kota', 'Product Manager | Contoh Digital | Jan 2019 - Dec 2021', ['Contoh Digital', 'Product Manager', '2019-01-01', '2021-12-01', false]],
  ['pipa, jabatan tanpa kata jabatan umum (urutan baku)', 'Barista | Kopi Contoh | Bandung | Jan 2019 - Dec 2019', ['Kopi Contoh', 'Barista', '2019-01-01', '2019-12-01', false]],
  ['pipa, perusahaan lebih dulu', 'Contoh Labs | Software Engineer | Jan 2020 - Dec 2021', ['Contoh Labs', 'Software Engineer', '2020-01-01', '2021-12-01', false]],
  ['pipa Indonesia, nama bulan panjang', 'Staf Administrasi | PT Contoh Maju | Surabaya | Januari 2019 - Desember 2021', ['PT Contoh Maju', 'Staf Administrasi', '2019-01-01', '2021-12-01', false]],
  ['pipa Indonesia, s/d Sekarang', 'Asisten Dosen | Universitas Contoh | Agu 2020 s/d Sekarang', ['Universitas Contoh', 'Asisten Dosen', '2020-08-01', null, true]],
  ['pipa, tahun saja', 'Sales Executive | Contoh Penjualan | Medan | 2018 - 2020', ['Contoh Penjualan', 'Sales Executive', '2018-01-01', '2020-12-01', false]],
  ['pipa, bulan awal tanpa tahun', 'Backend Engineer | Contoh Platform | Bandung | Aug - Dec 2025', ['Contoh Platform', 'Backend Engineer', '2025-08-01', '2025-12-01', false]],
  ['koma + konteks: jabatan, perusahaan | konteks bulan - bulan tahun', 'Project Manager and Lead Developer, SmartDev Contoh LMS | Software Engineering Course Aug - Dec 2025', ['SmartDev Contoh LMS', 'Project Manager and Lead Developer', '2025-08-01', '2025-12-01', false]],
  ['koma + konteks berisi kurung', 'Lead Engineer, Contoh Program ERP | Contoh Mitra (national internship program) Feb - May 2026', ['Contoh Program ERP', 'Lead Engineer', '2026-02-01', '2026-05-01', false]],
  ['koma tanpa pipa, rentang dengan dua tahun', 'Teaching Assistant, Department of Contoh Systems, UCN Aug 2025 - Present', ['Department of Contoh Systems, UCN', 'Teaching Assistant', '2025-08-01', null, true]],
  ['koma, perusahaan berkurung, bulan awal tanpa tahun', 'Web3 Developer Intern, Contoh Apps (E-Signature) Feb - Aug 2026', ['Contoh Apps (E-Signature)', 'Web3 Developer Intern', '2026-02-01', '2026-08-01', false]],
  ['"jabatan at perusahaan (rentang)"', 'Software Engineer at Contoh Labs (Jan 2020 - Present)', ['Contoh Labs', 'Software Engineer', '2020-01-01', null, true]],
  ['"jabatan di perusahaan, rentang"', 'Analis Data di PT Contoh Analitika, Mar 2018 – Jun 2020', ['PT Contoh Analitika', 'Analis Data', '2018-03-01', '2020-06-01', false]],
]

test('baris judul pengalaman CV biasa dalam semua bentuk lazim', () => {
  for (const [name, header, want] of FORMS) {
    const { rows, dropped } = read([header, ...BULLETS])
    assert.deepEqual(rows, [want], name)
    assert.equal(dropped, 0, name)
  }
})

test('beberapa pengalaman: urutan terbaru lebih dulu, uraian milik judulnya sendiri, jabatan sama di dua periode tidak dianggap duplikat', () => {
  const { n } = read([
    'Mobile Developer | Contoh Aplikasi A | Medan | May 2024 – Present',
    '• Built the payments flow for the Android app.',
    'Junior Mobile Developer | Contoh Aplikasi B | Medan | Jan 2022 – Dec 2023',
    '• Fixed crash reports on older devices.',
    'Mobile Developer | Contoh Aplikasi A | Medan | Feb 2019 – Dec 2021',
    '• Shipped the first release of the iOS app.',
  ])
  assert.deepEqual(
    n.experiences.map((e) => [e.company_name, e.role_title, e.start_date, e.description]),
    [
      ['Contoh Aplikasi A', 'Mobile Developer', '2024-05-01', '• Built the payments flow for the Android app.'],
      ['Contoh Aplikasi B', 'Junior Mobile Developer', '2022-01-01', '• Fixed crash reports on older devices.'],
      ['Contoh Aplikasi A', 'Mobile Developer', '2019-02-01', '• Shipped the first release of the iOS app.'],
    ],
  )
  assert.equal(n.dropped.experiences, 0)
})

test('uraian berhenti di judul seksi berikutnya (proyek, sertifikat) dan di baris judul berikutnya', () => {
  const { n } = read(
    ['Backend Engineer | Contoh Platform | Bandung | Jan 2022 – Present', ...BULLETS],
    'PROFESSIONAL EXPERIENCE',
    ['KEY PROJECTS', 'Contoh Project Alpha: Smart Reporting Oct 2026', 'CERTIFICATIONS & ACHIEVEMENTS', '• Certified Contoh Developer (2022)', 'EDUCATION', 'Universitas Contoh Nusantara | S1 Sistem Informasi | 2015 - 2019'],
  )
  assert.equal(n.experiences.length, 1)
  const d = n.experiences[0].description ?? ''
  assert.match(d, /reporting dashboard/)
  assert.doesNotMatch(d, /Alpha|Certified/)
})

test('baris proyek, kalimat, dan poin yang memuat tanggal bukan judul pengalaman', () => {
  const { rows } = read([
    'Contoh Project Alpha: Smart Reporting for Analysts Feb - May 2026',
    'Contoh Hackathon Sep - Oct 2026',
    '• Led the migration to the new platform, Jan 2020 - Mar 2021',
    'Worked on several internal tools during 2019 - 2021 for various teams.',
    'Backend Engineer | Contoh Platform | Bandung | Jan 2022 – Present',
  ])
  assert.deepEqual(rows, [['Contoh Platform', 'Backend Engineer', '2022-01-01', null, true]])
})

test('judul seksi pengalaman Indonesia dan Inggris', () => {
  for (const heading of ['PENGALAMAN KERJA', 'Pengalaman Kerja', 'Riwayat Pekerjaan', 'Pengalaman Profesional', 'Work Experience', 'WORK EXPERIENCE', 'Experience', 'Employment History', 'Work History', 'Professional Experience', 'Riwayat Kerja', 'Pengalaman Magang']) {
    assert.equal(read(['Backend Engineer | Contoh Platform | Bandung | Jan 2022 – Present'], heading).rows.length, 1, heading)
  }
})

test('format PDF LinkedIn (baris tanggal sendiri) tidak terganggu oleh parser baris judul', () => {
  const text = cleanPdfText(['Experience\nContoh Platform\nSenior Engineer\nJanuary 2022 - Present (4 years 10 months)\nBandung, Indonesia\nEducation\nUniversitas Contoh Nusantara\nS1 Sistem Informasi · (2015 - 2019)'])
  const n = normalizeExtraction(parseWithRules(text), { sourceText: text, now: NOW })
  assert.deepEqual(n.experiences.map((e) => [e.company_name, e.role_title, e.start_date, e.is_current]), [['Contoh Platform', 'Senior Engineer', '2022-01-01', true]])
})

test('perusahaan atau jabatan yang tidak ada di PDF tetap dibuang (grounding) pada jalur AI, bentuk tanggal apa pun', () => {
  const text = cv(['Backend Engineer | Contoh Platform | Bandung | Aug - Dec 2025'])
  const n = normalizeExtraction(
    {
      experiences: [
        { company: 'Contoh Platform', title: 'Backend Engineer', date_range: 'Aug - Dec 2025' },
        { company: 'Perusahaan Karangan', title: 'Backend Engineer', date_range: 'Aug - Dec 2025' },
        { company: 'Contoh Platform', title: 'Chief Imagination Officer', date_range: 'Aug - Dec 2025' },
      ],
    },
    { sourceText: text, now: NOW },
  )
  assert.equal(n.experiences.length, 1)
  assert.equal(n.dropped.experiences, 2)
})
