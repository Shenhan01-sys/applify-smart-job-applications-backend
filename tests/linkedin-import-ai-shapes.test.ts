import { test } from 'node:test'
import assert from 'node:assert/strict'
import { NOW } from './helpers/linkedinFixture.ts'
import { normalizeExtraction } from '../services/linkedin-import.ts'

/**
 * Model yang berbeda menjawab dengan nama bidang dan bentuk tanggal yang berbeda: camelCase, nama sinonim ("employer",
 * "qualification"), awal dan akhir terpisah, angka, objek {year, month}, larik, dan jawaban yang dibungkus
 * ({"data": {...}}). Semuanya harus terbaca sama, sedangkan grounding (perusahaan, jabatan, sekolah harus ada di
 * teks sumber) tetap berlaku. Semua teks SINTETIS. Tanpa jaringan. NOW = 2026-11-20.
 */

const SRC = [
  'Rina Contoh', 'Bandung',
  'EXPERIENCE', 'Backend Engineer | Contoh Labs | Mar 2016 - Present',
  'EDUCATION', 'Universitas Contoh Nusantara | S1 Sistem Informasi | B.Sc. Information Systems | IPK 3,75/4,00 | 2019 - 2023',
  'SMA Negeri 1 Contoh | IPA | 2016 - 2019',
].join('\n')
const norm = (raw: unknown, sourceText = SRC) => normalizeExtraction(raw, { sourceText, now: NOW })

type ExpRow = [string, string, string, string | null, boolean]
const expRows = (n: ReturnType<typeof norm>): ExpRow[] => n.experiences.map((e) => [e.company_name, e.role_title, e.start_date, e.end_date, e.is_current])
const CO = 'Contoh Labs'
const RO = 'Backend Engineer'

const EXPERIENCE_SHAPES: Array<[string, Record<string, unknown>, string, string | null, boolean]> = [
  ['date_range teks', { company: CO, title: RO, date_range: 'Mar 2016 - Present' }, '2016-03-01', null, true],
  ['company_name, role_title, dates', { company_name: CO, role_title: RO, dates: 'Mar 2016 - Dec 2021' }, '2016-03-01', '2021-12-01', false],
  ['employer, position, period', { employer: CO, position: RO, period: 'Mar 2016 - Dec 2021' }, '2016-03-01', '2021-12-01', false],
  ['organization, job_title, duration', { organization: CO, job_title: RO, duration: 'March 2016 - December 2021' }, '2016-03-01', '2021-12-01', false],
  ['camelCase dengan isCurrent', { companyName: CO, jobTitle: RO, startDate: '2016-03', endDate: null, isCurrent: true }, '2016-03-01', null, true],
  ['camelCase awal akhir', { companyName: CO, roleTitle: RO, startDate: '2016-03-01', endDate: '2021-12-31' }, '2016-03-01', '2021-12-01', false],
  ['start dan end teks', { company: CO, role: RO, start: 'March 2016', end: 'Present' }, '2016-03-01', null, true],
  ['start_date dan end_date ISO', { company: CO, title: RO, start_date: '2016-03-01', end_date: '2021-12-31' }, '2016-03-01', '2021-12-01', false],
  ['start dan end berupa objek {year, month}', { company: CO, title: RO, start: { year: 2016, month: 3 }, end: { year: 2021, month: 12 } }, '2016-03-01', '2021-12-01', false],
  ['objek dengan nama bulan', { company: CO, title: RO, start: { year: 2016, month: 'March' }, end: { year: 2021, month: 'December' } }, '2016-03-01', '2021-12-01', false],
  ['date_range berupa larik', { company: CO, title: RO, date_range: ['Mar 2016', 'Dec 2021'] }, '2016-03-01', '2021-12-01', false],
  ['date_range berupa objek {start, end}', { company: CO, title: RO, date_range: { start: '2016-03', end: 'present' } }, '2016-03-01', null, true],
  ['start_year dan end_year angka', { company: CO, title: RO, start_year: 2016, end_year: 2021 }, '2016-01-01', '2021-12-01', false],
  ['satu tanggal mulai + is_current', { company: CO, title: RO, date_range: 'Mar 2016', is_current: true }, '2016-03-01', null, true],
  ['bulan awal tanpa tahun', { company: CO, title: RO, date_range: 'Aug - Dec 2025' }, '2025-08-01', '2025-12-01', false],
  ['ISO penuh dengan strip', { company: CO, title: RO, date_range: '2020-01-01 - 2021-12-31' }, '2020-01-01', '2021-12-01', false],
  ['garis miring sisa PDF', { company: CO, title: RO, date_range: 'Mar /2016 /– /Dec /2021' }, '2016-03-01', '2021-12-01', false],
  ['s/d dan nama bulan Indonesia', { company: CO, title: RO, date_range: 'Maret 2016 s/d Desember 2021' }, '2016-03-01', '2021-12-01', false],
  ['hingga kini', { company: CO, title: RO, date_range: 'Mar 2016 - Hingga kini' }, '2016-03-01', null, true],
  ['bidang berhuruf besar-kecil campur', { Company: CO, Title: RO, DateRange: 'Mar 2016 - Present' }, '2016-03-01', null, true],
]

test('pengalaman: semua bentuk jawaban model terbaca sama', () => {
  for (const [name, item, start, end, current] of EXPERIENCE_SHAPES) {
    const n = norm({ experiences: [item] })
    assert.deepEqual(expRows(n), [[CO, RO, start, end, current]], name)
    assert.equal(n.dropped.experiences, 0, name)
  }
})

test('pengalaman: nama kunci daftar dan jawaban yang dibungkus', () => {
  const item = { company: CO, title: RO, date_range: 'Mar 2016 - Present' }
  for (const raw of [
    { experience: [item] },
    { work_experience: [item] },
    { workExperience: [item] },
    { employment_history: [item] },
    { jobs: [item] },
    { data: { experiences: [item] } },
    { profile: { work_experience: [item] } },
    { result: { experiences: [item] } },
  ]) {
    assert.deepEqual(expRows(norm(raw)), [[CO, RO, '2016-03-01', null, true]], JSON.stringify(Object.keys(raw)))
  }
})

test('pengalaman: deskripsi berupa larik digabung per baris, dan deskripsi karangan dibuang', () => {
  const n = norm({ experiences: [{ company: CO, title: RO, date_range: 'Mar 2016 - Present', responsibilities: ['Backend Engineer at Contoh Labs', 'Mar 2016 Present Contoh'] }] })
  assert.equal(n.experiences[0].description, 'Backend Engineer at Contoh Labs\nMar 2016 Present Contoh')
  const fake = norm({ experiences: [{ company: CO, title: RO, date_range: 'Mar 2016 - Present', description: 'Pioneered quantum blockchain synergy across fictional galaxies' }] })
  assert.equal(fake.experiences[0].description, null)
})

test('pengalaman: grounding tetap berlaku untuk semua bentuk (perusahaan atau jabatan karangan dibuang)', () => {
  for (const [name, item] of EXPERIENCE_SHAPES) {
    const fakeCompany = JSON.parse(JSON.stringify(item).replace(CO, 'Perusahaan Karangan'))
    const fakeTitle = JSON.parse(JSON.stringify(item).replace(RO, 'Chief Imagination Officer'))
    const n = norm({ experiences: [fakeCompany, fakeTitle] })
    assert.equal(n.experiences.length, 0, name)
    assert.equal(n.dropped.experiences, 2, name)
  }
})

type EduRow = [string, string, string | null, number, number | null, boolean]
const eduRows = (n: ReturnType<typeof norm>): EduRow[] => n.education.map((e) => [e.institution, e.degree, e.field_of_study, e.start_year, e.end_year, e.is_current])
const UNI = 'Universitas Contoh Nusantara'

const EDUCATION_SHAPES: Array<[string, Record<string, unknown>, number, number | null, boolean]> = [
  ['years teks', { school: UNI, degree: 'S1', field: 'Sistem Informasi', years: '2019 - 2023' }, 2019, 2023, false],
  ['institution_name, qualification, major, period', { institution_name: UNI, qualification: 'S1', major: 'Sistem Informasi', period: '2019 - 2023' }, 2019, 2023, false],
  ['university, degree_name, study_program, start_year, end_year', { university: UNI, degree_name: 'S1', study_program: 'Sistem Informasi', start_year: 2019, end_year: 2023 }, 2019, 2023, false],
  ['camelCase', { schoolName: UNI, degreeName: 'S1', fieldOfStudy: 'Sistem Informasi', startYear: 2019, endYear: 2023 }, 2019, 2023, false],
  ['start dan end berupa objek {year, month}', { school: UNI, degree: 'S1', field: 'Sistem Informasi', start: { year: 2019, month: 8 }, end: { year: 2023, month: 7 } }, 2019, 2023, false],
  ['years berupa larik', { school: UNI, degree: 'S1', field: 'Sistem Informasi', years: [2019, 2023] }, 2019, 2023, false],
  ['years berupa objek {start, end} sampai present', { school: UNI, degree: 'S1', field: 'Sistem Informasi', years: { start: 2019, end: 'present' } }, 2019, null, true],
  ['start_date dan end_date ISO', { school: UNI, degree: 'S1', field: 'Sistem Informasi', start_date: '2019-08-01', end_date: '2023-07-31' }, 2019, 2023, false],
  ['hanya tahun lulus', { school: UNI, degree: 'S1', field: 'Sistem Informasi', graduation_year: 2023 }, 2023, 2023, false],
  ['is_current tanpa tahun akhir', { school: UNI, degree: 'S1', field: 'Sistem Informasi', start_year: 2022, end_year: null, is_current: true }, 2022, null, true],
  ['tahun akhir di masa depan', { school: UNI, degree: 'S1', field: 'Sistem Informasi', years: '2023 - 2027' }, 2023, 2027, true],
  ['expected sebagai bendera', { school: UNI, degree: 'S1', field: 'Sistem Informasi', start_year: 2023, end_year: 2027, expected: true }, 2023, 2027, true],
  ['expected_graduation bernilai', { school: UNI, degree: 'S1', field: 'Sistem Informasi', start_year: 2023, expected_graduation: 'Mar 2027' }, 2023, 2027, true],
  ['gelar singkatan lain dari PDF (B.Sc. = Bachelor of Science)', { school: UNI, degree: 'Bachelor of Science', field: 'Information Systems', years: '2019 - 2023' }, 2019, 2023, false],
]

test('pendidikan: semua bentuk jawaban model terbaca sama', () => {
  for (const [name, item, start, end, current] of EDUCATION_SHAPES) {
    const n = norm({ education: [item] })
    assert.equal(n.education.length, 1, name)
    assert.equal(n.dropped.education, 0, name)
    const [inst, , , s, e, c] = eduRows(n)[0]
    assert.deepEqual([inst, s, e, c], [UNI, start, end, current], name)
    assert.ok(eduRows(n)[0][1].length > 0, `${name}: gelar tidak kosong`)
  }
})

test('pendidikan: gelar singkatan hasil model tetap gelar, bukan bidang yang naik jadi gelar', () => {
  const n = norm({ education: [{ school: UNI, degree: 'Bachelor of Science', field: 'Information Systems', years: '2019 - 2023' }] })
  assert.deepEqual(eduRows(n), [[UNI, 'Bachelor of Science', 'Information Systems', 2019, 2023, false]])
})

test('pendidikan: sekolah menengah dengan gelar = jenjang', () => {
  const n = norm({ education: [{ school: 'SMA Negeri 1 Contoh', degree: 'SMA', field: 'IPA', years: '2016 - 2019' }] })
  assert.deepEqual(eduRows(n), [['SMA Negeri 1 Contoh', 'SMA', 'IPA', 2016, 2019, false]])
})

test('pendidikan: IPK dalam berbagai bentuk dan nama bidang', () => {
  for (const extra of [
    { gpa: 3.75, gpa_scale: 4 },
    { gpa: '3,75/4,00' },
    { ipk: '3,75' },
    { cgpa: '3.75/4.00' },
    { gpa: 3.75, max_gpa: 4 },
    { GPA: '3,75 dari 4,00' },
  ]) {
    const n = norm({ education: [{ school: UNI, degree: 'S1', field: 'Sistem Informasi', years: '2019 - 2023', ...extra }] })
    assert.deepEqual([n.education[0].gpa, n.education[0].max_gpa], [3.75, 4], JSON.stringify(extra))
  }
  // IPK karangan yang tidak ada di PDF dibuang
  const fake = norm({ education: [{ school: UNI, degree: 'S1', field: 'Sistem Informasi', years: '2019 - 2023', gpa: 3.99 }] })
  assert.equal(fake.education[0].gpa, null)
})

test('pendidikan: nama kunci daftar dan jawaban yang dibungkus', () => {
  const item = { school: UNI, degree: 'S1', field: 'Sistem Informasi', years: '2019 - 2023' }
  for (const raw of [{ education: [item] }, { educations: [item] }, { education_history: [item] }, { academic_background: [item] }, { data: { education: [item] } }, { profile: { educations: [item] } }]) {
    assert.deepEqual(eduRows(norm(raw)), [[UNI, 'S1', 'Sistem Informasi', 2019, 2023, false]], JSON.stringify(Object.keys(raw)))
  }
})

test('pendidikan: grounding tetap berlaku (sekolah karangan dibuang, bentuk apa pun)', () => {
  for (const [name, item] of EDUCATION_SHAPES) {
    const fake = JSON.parse(JSON.stringify(item).replace(UNI, 'Universitas Karangan Abadi'))
    const n = norm({ education: [fake] })
    assert.equal(n.education.length, 0, name)
    assert.equal(n.dropped.education, 1, name)
  }
})
