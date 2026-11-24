import { test } from 'node:test'
import assert from 'node:assert/strict'
import { NOW } from './helpers/linkedinFixture.ts'
import { cleanPdfText, normalizeExtraction, parseWithRules } from '../services/linkedin-import.ts'
import { LinkedInImportService } from '../services/linkedin-import.service.ts'

/**
 * Pendidikan satu baris pada CV modern: "Institusi (SINGKATAN), Kota | Gelar Bidang Tanggal", dengan IPK di baris
 * berikutnya dan baris penghargaan, bootcamp, inkubator, serta daftar nilai di bawahnya yang BUKAN pendidikan.
 * Parser aturan sebelumnya menghasilkan tiga entri palsu (institusi dari baris penghargaan dan bootcamp) tanpa gelar,
 * lalu semuanya terbuang. Semua teks SINTETIS. Tanpa jaringan. NOW = 2026-11-20.
 */

const wrap = (education: string[]) => cleanPdfText([['Rina Contoh', 'Mahasiswa Sistem Informasi', 'Bandung', 'EDUCATION', ...education, 'EXPERIENCE', 'Asisten Lab, Universitas Contoh Nusantara 2025'].join('\n')])
const read = (education: string[]) => {
  const text = wrap(education)
  return normalizeExtraction(parseWithRules(text), { sourceText: text, now: NOW })
}
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

const UCN = 'Universitas Contoh Nusantara (UCN), Bandung | B.Sc. Computer Science Sep 2023 - Expected Mar 2027'
const NOISE = [
  'GPA 3.62/4.00. Grade A: Basis Data, Statistika, Pemrograman Web, Jaringan Komputer, Struktur Data',
  'Structures. 2nd Place, University-Level Outstanding Student Award (PILCONTOH) 2025 and 2026; Regional Region V official delegate.',
  'Program Inkubasi Contoh, angkatan 3 | Akademi Contoh dan Yayasan Contoh Accepted Jun 2026',
  'Contoh International Bootcamp | Pulau Labs Mar 2026',
]

test('satu baris + IPK + penghargaan, inkubator, bootcamp: tepat satu entri pendidikan lengkap', () => {
  const n = read([UCN, ...NOISE])
  assert.deepEqual(n.education.map(row), [['Universitas Contoh Nusantara (UCN)', 'B.Sc.', 'Computer Science', 2023, 2027, true, 3.62, 4]])
  assert.equal(n.dropped.education, 0, 'tidak ada entri palsu yang terbuang')
})

test('baris penghargaan, bootcamp, inkubator, dan daftar nilai sendirian bukan pendidikan', () => {
  const n = read(NOISE)
  assert.equal(n.education.length, 0)
  assert.equal(n.dropped.education, 0, 'tidak dibuka sebagai entri, jadi tidak dihitung terbuang')
})

test('kata institusi umum (Academy, College, School) tanpa gelar di baris yang sama bukan sekolah; dengan gelar, sekolah', () => {
  assert.equal(read(['Contoh Digital Academy | Backend Bootcamp Jan 2026', 'Contoh Creative College | Online Short Course 2025']).education.length, 0)
  assert.deepEqual(
    read(['Contoh Design Academy, Jakarta | Diploma Desain Grafis 2019 - 2021']).education.map(row),
    [['Contoh Design Academy', 'Diploma', 'Desain Grafis', 2019, 2021, false, null, null]],
  )
})

test('daftar nilai yang memuat kata institusi tidak membuka entri baru', () => {
  const n = read([UCN, 'Coursework: University Physics, Calculus II, Linear Algebra', 'Grade B: University Chemistry, Statistics'])
  assert.deepEqual(n.education.map(row), [['Universitas Contoh Nusantara (UCN)', 'B.Sc.', 'Computer Science', 2023, 2027, true, null, null]])
})

test('beberapa entri satu baris: tahun selesai, gelar bernama lengkap, singkatan Indonesia, pemisah en dash, IPK koma', () => {
  const n = read([
    'Institut Contoh Teknologi, Surabaya | Bachelor of Science in Data Science Aug 2018 - Jul 2022',
    'IPK 3,60',
    'Politeknik Contoh Pasundan | S.Kom. Teknik Informatika 2014 - 2017',
    'Universitas Contoh Barat – M.Sc. Information Systems 2022 - Present',
  ])
  assert.deepEqual(n.education.map(row), [
    ['Universitas Contoh Barat', 'M.Sc.', 'Information Systems', 2022, null, true, null, null],
    ['Institut Contoh Teknologi', 'Bachelor of Science', 'Data Science', 2018, 2022, false, 3.6, 4],
    ['Politeknik Contoh Pasundan', 'S.Kom.', 'Teknik Informatika', 2014, 2017, false, null, null],
  ])
  assert.equal(n.dropped.education, 0)
})

test('singkatan gelar juga dikenali pada tata letak banyak baris', () => {
  const n = read(['Universitas Contoh Nusantara', 'B.Sc. Computer Science | 2019 - 2023', 'IPK 3.40/4.00'])
  assert.deepEqual(n.education.map(row), [['Universitas Contoh Nusantara', 'B.Sc.', 'Computer Science', 2019, 2023, false, 3.4, 4]])
})

test('entri SMA di bawah entri kuliah tetap terbaca dan baris tanpa institusi di kiri tidak diubah menjadi entri', () => {
  const n = read([UCN, 'SMA Negeri 1 Contoh', 'IPA | 2017 - 2020'])
  assert.deepEqual(n.education.map(row), [
    ['Universitas Contoh Nusantara (UCN)', 'B.Sc.', 'Computer Science', 2023, 2027, true, null, null],
    ['SMA Negeri 1 Contoh', 'SMA', 'IPA', 2017, 2020, false, null, null],
  ])
})

test('layanan, jalur AI: gelar "Bachelor of Science" dan tahun "Expected" dari model lolos meski PDF menulis "B.Sc."', async () => {
  const text = wrap([UCN, ...NOISE])
  const svc = new LinkedInImportService({
    now: () => NOW,
    log: () => {},
    extractPages: async () => [text],
    llm: async () => ({
      text: JSON.stringify({
        full_name: 'Rina Contoh',
        education: [
          { school: 'Universitas Contoh Nusantara (UCN)', degree: 'Bachelor of Science', field: 'Computer Science', years: 'Sep 2023 - Expected Mar 2027', gpa: '3.62/4.00' },
        ],
      }),
      model: 'tiruan',
    }),
  })
  const preview = await svc.importFromPdf(Buffer.from('%PDF-1.4 tiruan'))
  assert.equal(preview.meta.method, 'ai')
  assert.deepEqual(preview.education.map(row), [['Universitas Contoh Nusantara (UCN)', 'Bachelor of Science', 'Computer Science', 2023, 2027, true, 3.62, 4]])
  assert.equal(preview.meta.dropped.education, 0)
})
