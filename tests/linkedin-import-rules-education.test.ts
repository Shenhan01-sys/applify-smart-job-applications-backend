import { test } from 'node:test'
import assert from 'node:assert/strict'
import { NOW, fixturePdf, fixtureText } from './helpers/linkedinFixture.ts'
import { cleanPdfText, emptyMainSections, normalizeExtraction, parseWithRules } from '../services/linkedin-import.ts'
import { LinkedInImportService } from '../services/linkedin-import.service.ts'

/**
 * Parser aturan (cadangan bila AI tidak tersedia) untuk seksi Pendidikan dan Sertifikasi, dan baris log selesai.
 * Semua teks SINTETIS (tokoh fiktif): tests/fixtures/linkedin/synthetic-profile-id-pendidikan.txt dan teks inline.
 * Tanpa jaringan: model AI diganti tiruan.
 */

const ID_NAME = 'synthetic-profile-id-pendidikan.txt'
const ID_TEXT = cleanPdfText([fixtureText(ID_NAME)])
const norm = (raw: unknown, sourceText: string) => normalizeExtraction(raw, { sourceText, now: NOW })
const eduOf = (text: string) => norm(parseWithRules(text), text).education.map((e) => [e.institution, e.degree, e.field_of_study, e.start_year, e.end_year, e.is_current])

// ───────────────────────────────────────────────────────────── Pendidikan

test('aturan: Pendidikan berbahasa Indonesia, tanggal bernama bulan, satu baris dan terpotong di tengah tanggal', () => {
  const n = norm(parseWithRules(ID_TEXT), ID_TEXT)
  assert.deepEqual(
    n.education.map((e) => [e.institution, e.degree, e.field_of_study, e.start_year, e.end_year, e.is_current]),
    [
      ['Akademi Fiktif Parahyangan', 'Diploma Tiga', 'Manajemen Informatika', 2026, 2026, false], // "(Juni" / "2026 - September 2026)"
      ['Universitas Fiktif Nusantara', 'Gelar Sarjana', 'Sistem Informasi', 2023, 2026, false], // satu baris
      ['Politeknik Fiktif Pasundan', 'Gelar Sarjana Terapan', 'Teknik Informatika', 2020, 2023, false], // "(Juli" / "2020 - Juli 2023)"
      ['Sekolah Menengah Atas Fiktif 1', 'Ilmu Pengetahuan Alam', null, 2017, 2020, false], // tahun saja, tanpa bidang
    ],
  )
  assert.equal(n.dropped.education, 0)
})

test('aturan: bagian lain dari fixture Indonesia tetap terbaca (pengalaman, sertifikat yang terpotong, skill, bahasa)', () => {
  const n = norm(parseWithRules(ID_TEXT), ID_TEXT)
  assert.equal(n.fullName, 'Dewi Lestari Sintetis')
  assert.deepEqual(n.experiences.map((e) => [e.company_name, e.role_title, e.is_current]), [
    ['Studio Fiktif Cahaya', 'Analis Data', true],
    ['Toko Fiktif Mandiri', 'Staf Administrasi', false],
  ])
  // judul sertifikat di kolom kiri terpotong: baris pendek sesudah baris penuh, dan baris berawalan huruf kecil, menyambung
  assert.deepEqual(n.certifications.map((c) => c.name), [
    'Analis Data Profesional Bersertifikat Tingkat Lanjut',
    'Cloud Practitioner Associate Certified dan Keamanan Informasi',
    'Scrum Fundamentals',
  ])
  assert.deepEqual(n.skills.map((s) => [s.name, s.category]), [
    ['Analisis Data', 'technical'], ['Pemrograman Python', 'technical'], ['Manajemen Proyek', 'technical'],
    ['Indonesia', 'language'], ['Inggris', 'language'],
  ])
})

test('aturan: Pendidikan berbahasa Inggris, tahun saja dan bernama bulan, sedang berjalan, dan tanggal turun ke baris berikutnya', () => {
  const text = [
    'Contact', 'www.linkedin.com/in/tokoh-sintetis (LinkedIn)',
    'Top Skills', 'Python',
    'Tokoh Sintetis Satu', 'Engineer at Fiktif', 'Jakarta, Indonesia',
    'Education',
    'Universitas Fiktif Barat', "Bachelor's degree, Computer Science · (2019 - 2023)",
    'Fiktif Institute of Technology', 'Master of Science - MS, Data Science · (Aug 2023 - Jun 2025)',
    'Universitas Fiktif Timur', 'Doctor of Philosophy - PhD, Informatics · (Agustus 2025 - Sekarang)',
    'Universitas Fiktif Utara', 'Associate degree, Business Administration ·', '(2015 - 2017)',
  ].join('\n')
  assert.deepEqual(eduOf(text), [
    ['Universitas Fiktif Timur', 'Doctor of Philosophy - PhD', 'Informatics', 2025, null, true],
    ['Fiktif Institute of Technology', 'Master of Science - MS', 'Data Science', 2023, 2025, false],
    ['Universitas Fiktif Barat', "Bachelor's degree", 'Computer Science', 2019, 2023, false],
    ['Universitas Fiktif Utara', 'Associate degree', 'Business Administration', 2015, 2017, false],
  ])
})

test('aturan: nama sekolah yang terpotong (baris kedua diawali huruf kecil) disambung; gelar sebelumnya tidak ikut tertelan', () => {
  const text = [
    'Contact', 'www.linkedin.com/in/tokoh-sintetis (LinkedIn)',
    'Top Skills', 'Python',
    'Tokoh Sintetis Dua', 'Engineer at Fiktif', 'Jakarta, Indonesia',
    'Pendidikan',
    'Universitas Fiktif A', 'Gelar Sarjana, Sistem Informasi · (2010 - 2014)',
    'Sekolah Tinggi Teknologi Fiktif', 'dan Bisnis Nusantara', 'Gelar Sarjana, Manajemen · (2014 - 2018)',
  ].join('\n')
  assert.deepEqual(eduOf(text).map((e) => e[0]), ['Sekolah Tinggi Teknologi Fiktif dan Bisnis Nusantara', 'Universitas Fiktif A'])
})

test('aturan: kurung yang tidak berisi tahun, atau rentang yang menggantung ("2018 -"), tidak menelan baris lain dan dihitung terbuang', () => {
  const text = [
    'Contact', 'www.linkedin.com/in/tokoh-sintetis (LinkedIn)',
    'Top Skills', 'Python',
    'Tokoh Sintetis Tiga', 'Engineer at Fiktif', 'Jakarta, Indonesia',
    'Pendidikan',
    'Universitas Fiktif (UF)', 'Gelar Sarjana, Hukum · (2012 - 2016)',
    'Universitas Fiktif Tengah', 'Gelar Sarjana, Ekonomi · (2018 -)',
  ].join('\n')
  const n = norm(parseWithRules(text), text)
  assert.deepEqual(n.education.map((e) => e.institution), ['Universitas Fiktif (UF)'])
  assert.equal(n.dropped.education, 1, 'rentang menggantung = terbuang dan dihitung, bukan hilang diam-diam')
})

test('aturan: satu tahun saja di kurung ("(2018)") dipakai sebagai tahun masuk dan lulus, dengan catatan', () => {
  const text = ['Education', 'Universitas Fiktif Tengah', 'Gelar Sarjana, Ekonomi · (2018)'].join('\n')
  const n = norm(parseWithRules(text), text)
  assert.deepEqual(n.education.map((e) => [e.institution, e.start_year, e.end_year]), [['Universitas Fiktif Tengah', 2018, 2018]])
  assert.match(n.education[0].notes.join(' '), /satu tahun/)
  assert.equal(n.dropped.education, 0)
})

// ───────────────────────────────────────────────────────────── peringatan bagian kosong

test('emptyMainSections: bagian yang ada di PDF tetapi nol item disebut; bagian yang memang tidak ada tidak disebut', () => {
  assert.deepEqual(emptyMainSections(ID_TEXT, { experience: 2, education: 0 }), ['Pendidikan'])
  assert.deepEqual(emptyMainSections(ID_TEXT, { experience: 0, education: 0 }), ['Pengalaman', 'Pendidikan'])
  assert.deepEqual(emptyMainSections(ID_TEXT, { experience: 2, education: 4 }), [])
  const noEdu = 'Contact\nwww.linkedin.com/in/x-sintetis (LinkedIn)\nExperience\nFiktif\nEngineer\nJanuary 2020 - Present'
  assert.deepEqual(emptyMainSections(noEdu, { experience: 1, education: 0 }), [])
})

test('layanan: jalur AI tanpa pendidikan padahal PDF punya seksi Pendidikan = peringatan, bukan diam', async () => {
  const withoutEdu = {
    full_name: 'Dewi Lestari Sintetis',
    experiences: [{ company: 'Studio Fiktif Cahaya', title: 'Analis Data', date_range: 'Maret 2022 - Sekarang (4 tahun 9 bulan)' }],
    skills: ['Analisis Data'],
  }
  const svc = new LinkedInImportService({ llm: async () => ({ text: JSON.stringify(withoutEdu), model: 'm' }), now: () => NOW, log: () => {} })
  const preview = await svc.importFromPdf(fixturePdf(ID_NAME))
  assert.equal(preview.meta.method, 'ai')
  assert.equal(preview.education.length, 0)
  assert.match(preview.warnings.join(' '), /Bagian Pendidikan ada di PDF tetapi isinya tidak berhasil dibaca/)
})

// ───────────────────────────────────────────────────────────── jalur cadangan dan baris log

test('layanan: AI mati = parser aturan memberi 4 pendidikan dari PDF, tanpa peringatan bagian kosong', async () => {
  const logs: string[] = []
  const svc = new LinkedInImportService({
    llm: async () => {
      throw Object.assign(new Error('semua model gagal'), { name: 'AiBudgetExhausted' })
    },
    now: () => NOW,
    log: (l) => logs.push(l),
  })
  const preview = await svc.importFromPdf(fixturePdf(ID_NAME))
  assert.equal(preview.meta.method, 'rules')
  assert.equal(preview.education.length, 4)
  assert.equal(preview.experiences.length, 2)
  assert.equal(preview.certifications.length, 3)
  assert.doesNotMatch(preview.warnings.join(' '), /Bagian .* ada di PDF/)
  assert.match(preview.warnings.join(' '), /AI sedang tidak tersedia/)
  assert.equal(logs.length, 1)
})

test('log selesai: satu baris JSON berawalan tetap; metode, model, durasi, hitungan per bagian, dibuang; tanpa data pribadi', async () => {
  const logs: string[] = []
  let t = 1_000
  const svc = new LinkedInImportService({
    llm: async () => {
      throw Object.assign(new Error('Teks galat Dewi Lestari Sintetis tidak boleh bocor'), { name: 'AiBudgetExhausted' })
    },
    now: () => NOW,
    log: (l) => logs.push(l),
    clock: () => (t += 250),
  })
  await svc.importFromPdf(fixturePdf(ID_NAME))
  assert.equal(logs.length, 1)
  assert.ok(logs[0].startsWith('[linkedin-import] {'), logs[0])
  const entry = JSON.parse(logs[0].slice('[linkedin-import] '.length))
  assert.equal(entry.event, 'import_done')
  assert.equal(entry.method, 'rules')
  assert.equal(entry.model, null)
  assert.equal(entry.aiFailed, true)
  assert.equal(entry.aiError, 'AiBudgetExhausted')
  assert.equal(typeof entry.durationMs, 'number')
  assert.ok(entry.durationMs >= entry.aiMs && entry.aiMs > 0)
  assert.equal(entry.pages, 1)
  assert.deepEqual(entry.counts, { experiences: 2, education: 4, certifications: 3, awards: 0, publications: 0, skills: 3, languages: 2 })
  assert.deepEqual(entry.dropped, { experiences: 0, education: 0, certifications: 0, achievements: 0, skills: 0 })
  assert.deepEqual(entry.emptySections, [])
  for (const secret of ['Dewi', 'Lestari', 'Fiktif', 'example.com', 'bocor']) assert.ok(!logs[0].includes(secret), `log memuat "${secret}"`)
})

test('log selesai: jalur AI mencatat metode ai dan nama model; nothing_found juga dicatat tanpa isi PDF', async () => {
  const logs: string[] = []
  const ai = new LinkedInImportService({
    llm: async () => ({ text: JSON.stringify({ full_name: 'Dewi Lestari Sintetis', skills: ['Analisis Data'] }), model: 'gemini:contoh-model' }),
    now: () => NOW,
    log: (l) => logs.push(l),
  })
  await ai.importFromPdf(fixturePdf(ID_NAME))
  const done = JSON.parse(logs[0].slice('[linkedin-import] '.length))
  assert.equal(done.method, 'ai')
  assert.equal(done.model, 'gemini:contoh-model')
  assert.equal(done.aiFailed, false)
  assert.equal(done.aiError, null)

  const none = new LinkedInImportService({ llm: async () => ({ text: '{}', model: 'm' }), extractPages: async () => ['Dokumen biasa tentang cuaca hari ini, tanpa profil siapa pun di dalamnya.'], now: () => NOW, log: (l) => logs.push(l) })
  await assert.rejects(none.importFromPdf(fixturePdf(ID_NAME)), (e: any) => e.code === 'nothing_found')
  const failed = JSON.parse(logs[1].slice('[linkedin-import] '.length))
  assert.equal(failed.event, 'import_failed')
  assert.equal(failed.code, 'nothing_found')
})

// ───────────────────────────────────────────────────────────── anggaran waktu AI

test('layanan: anggaran AI dikirim ke rantai sebagai deadline mutlak (sekitar sekarang + anggaran), bukan batas lepas', async () => {
  let seen: any
  const before = Date.now()
  const svc = new LinkedInImportService({
    llm: async (p) => {
      seen = p
      return { text: JSON.stringify({ full_name: 'Dewi Lestari Sintetis', skills: ['Analisis Data'] }), model: 'm' }
    },
    now: () => NOW,
    aiBudgetMs: 12_345,
    log: () => {},
  })
  await svc.importFromPdf(fixturePdf(ID_NAME))
  assert.ok(seen.deadlineAt >= before + 12_345 && seen.deadlineAt <= Date.now() + 12_345, `deadlineAt=${seen.deadlineAt - before}`)
})

test('layanan: AI menggantung melewati pagar keras = pratinjau dari parser aturan, tidak ikut menunggu selamanya', async () => {
  const t0 = Date.now()
  const svc = new LinkedInImportService({ llm: () => new Promise(() => {}), aiTimeoutMs: 30, now: () => NOW, log: () => {} })
  const preview = await svc.importFromPdf(fixturePdf(ID_NAME))
  assert.equal(preview.meta.method, 'rules')
  assert.equal(preview.education.length, 4)
  assert.ok(Date.now() - t0 < 5_000)
})
