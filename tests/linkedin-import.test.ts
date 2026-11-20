import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makePdf } from './helpers/makePdf.ts'
import { NOW, fixturePages, fixturePdf, fixtureText } from './helpers/linkedinFixture.ts'
import { LinkedInImportError, PDF_MAX_BYTES, assertPdfUpload, extractPdfPages } from '../services/linkedin-pdf.ts'
import {
  LIMITS,
  assemblePreview,
  buildModelPrompt,
  cleanPdfText,
  extractLinkedInUrl,
  languageLevel,
  normalizeExtraction,
  parseDateRange,
  parseWithRules,
  parseYearRange,
  redactForModel,
  splitSections,
} from '../services/linkedin-import.ts'
import { LinkedInImportService } from '../services/linkedin-import.service.ts'
import { acceptJsonObject } from '../services/json-output.ts'

/**
 * Impor profil dari PDF LinkedIn, tanpa jaringan: model AI diganti tiruan, PDF dibuat di memori oleh makePdf,
 * dan teksnya dari fixture SINTETIS (tokoh fiktif; lihat tests/fixtures/linkedin/synthetic-profile-en.txt).
 */

const TEXT = cleanPdfText([fixtureText()])
const norm = (raw: unknown, sourceText = TEXT) => normalizeExtraction(raw, { sourceText, now: NOW })

// ───────────────────────────────────────────────────────────── validasi unggahan

test('assertPdfUpload: bukan Buffer, kosong, teks biasa, dan gambar ditolak 400; lewat 5 MB ditolak 413', () => {
  const code = (body: unknown) => {
    try {
      assertPdfUpload(body)
      return 'ok'
    } catch (e) {
      assert.ok(e instanceof LinkedInImportError)
      return `${e.statusCode}:${e.code}`
    }
  }
  assert.equal(code({ file: 'x' }), '400:not_pdf')
  assert.equal(code(undefined), '400:not_pdf')
  assert.equal(code(Buffer.alloc(0)), '400:empty_file')
  assert.equal(code(Buffer.from('Halo, ini bukan PDF')), '400:not_pdf')
  assert.equal(code(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), '400:not_pdf')
  assert.equal(code(Buffer.from('<html>%PDF</html>')), '400:not_pdf', 'penanda harus di awal berkas')
  const big = Buffer.alloc(PDF_MAX_BYTES + 1, 0x20)
  big.write('%PDF-1.4')
  assert.equal(code(big), '413:file_too_large')
  const exact = Buffer.alloc(PDF_MAX_BYTES, 0x20)
  exact.write('%PDF-1.4')
  assert.equal(code(exact), 'ok', 'tepat 5 MB masih diterima')
})

test('extractPdfPages: PDF sungguhan dibaca per halaman, urutan baris terjaga', async () => {
  const pages = await extractPdfPages(fixturePdf())
  assert.equal(pages.length, 2)
  assert.match(pages[0], /^Contact\nwww\.linkedin\.com\/in\/rina-kusuma-sintetis \(LinkedIn\)/)
  assert.match(pages[1], /Bachelor of Engineering - BE, Information Systems · \(2014 - 2018\)/)
})

test('extractPdfPages: rusak = 422 pdf_unreadable; tanpa teks (pindai) = 422 pdf_no_text; terlalu panjang = 422 pdf_too_long', async () => {
  const fail = async (buf: Buffer) => {
    try {
      await extractPdfPages(buf)
      return 'ok'
    } catch (e) {
      assert.ok(e instanceof LinkedInImportError, String(e))
      assert.equal(e.statusCode, 422)
      return e.code
    }
  }
  assert.equal(await fail(Buffer.from('%PDF-1.4\nini bukan isi PDF yang sah\n%%EOF')), 'pdf_unreadable')
  assert.equal(await fail(makePdf([[], []])), 'pdf_no_text')
  assert.equal(await fail(makePdf(Array.from({ length: 26 }, () => ['x']))), 'pdf_too_long')
})

// ───────────────────────────────────────────────────────────── tanggal

test('parseDateRange: Inggris, Indonesia, sampai sekarang, ISO; hasil YYYY-MM-01 dan is_current', () => {
  assert.deepEqual(parseDateRange('January 2022 - Present (2 years 11 months)', NOW), { start: '2022-01-01', end: null, is_current: true, notes: [] })
  assert.deepEqual(parseDateRange('Maret 2019 - Agustus 2021', NOW), { start: '2019-03-01', end: '2021-08-01', is_current: false, notes: [] })
  assert.deepEqual(parseDateRange('Mei 2020 - Sekarang', NOW), { start: '2020-05-01', end: null, is_current: true, notes: [] })
  assert.deepEqual(parseDateRange('Sep 2018 - Feb 2020 (1 year 6 months)', NOW), { start: '2018-09-01', end: '2020-02-01', is_current: false, notes: [] })
  assert.deepEqual(parseDateRange('2022-01 - 2023-05', NOW), { start: '2022-01-01', end: '2023-05-01', is_current: false, notes: [] })
  assert.equal(parseDateRange('Des 2021 – Jan 2022', NOW)?.start, '2021-12-01', 'en dash dan singkatan Desember')
})

test('parseDateRange: hanya tahun diisi Januari dan Desember dengan catatan; tahun ini berakhir di bulan ini', () => {
  const r = parseDateRange('2019 - 2021', NOW)
  assert.equal(r?.start, '2019-01-01')
  assert.equal(r?.end, '2021-12-01')
  assert.equal(r?.notes.length, 2)
  assert.match(r!.notes.join(' '), /Januari/)
  assert.match(r!.notes.join(' '), /Desember/)
  const thisYear = parseDateRange('2025 - 2026', NOW)
  assert.equal(thisYear?.end, '2026-11-01', 'tahun berjalan: bulan ini, bukan Desember di masa depan')
  assert.match(thisYear!.notes.join(' '), /bulan ini/)
})

test('parseDateRange: tidak sah = null (masa depan, selesai sebelum mulai, sampah, kosong)', () => {
  assert.equal(parseDateRange('January 2027 - Present', NOW), null, 'mulai di masa depan')
  assert.equal(parseDateRange('January 2020 - March 2027', NOW), null, 'selesai di masa depan')
  assert.equal(parseDateRange('June 2021 - May 2021', NOW), null, 'selesai sebelum mulai')
  assert.equal(parseDateRange('Smarch 2021 - May 2022', NOW), null, 'bulan tidak dikenal')
  assert.equal(parseDateRange('sejak dulu', NOW), null)
  assert.equal(parseDateRange('', NOW), null)
  assert.equal(parseDateRange(null, NOW), null)
  assert.equal(parseDateRange(42, NOW), null)
})

test('parseYearRange dan languageLevel: tahun, Present, tingkat bahasa Inggris dan Indonesia', () => {
  assert.deepEqual(parseYearRange('2020 - 2024'), { start: 2020, end: 2024 })
  assert.deepEqual(parseYearRange('(2021 - Present)'), { start: 2021, end: 'present' })
  assert.deepEqual(parseYearRange('2018'), { start: 2018, end: null })
  assert.equal(parseYearRange('tanpa tahun'), null)
  assert.equal(languageLevel('Native or Bilingual'), 5)
  assert.equal(languageLevel('Asli atau dwibahasa'), 5)
  assert.equal(languageLevel('Full Professional'), 4)
  assert.equal(languageLevel('Profesional penuh'), 4)
  assert.equal(languageLevel('Professional Working'), 3)
  assert.equal(languageLevel('Kemampuan kerja profesional'), 3)
  assert.equal(languageLevel('Limited Working'), 2)
  assert.equal(languageLevel('Elementary'), 1)
  assert.equal(languageLevel(null), 3)
})

// ───────────────────────────────────────────────────────────── teks

test('cleanPdfText membuang penanda halaman dan karakter tak terlihat; redactForModel membuang email dan nomor telepon', () => {
  const cleaned = cleanPdfText(['Contact X​\nPage 1 of 2', 'Halaman 2 dari 2\nExperience'])
  assert.equal(cleaned, 'Contact X\nExperience')
  const red = redactForModel(TEXT)
  assert.ok(!red.includes('rina.sintetis@example.com'))
  assert.ok(!red.includes('+62 812 0000 0000'))
  assert.ok(red.includes('linkedin.com/in/rina-kusuma-sintetis'), 'tautan LinkedIn tetap ada')
  assert.equal(redactForModel('Hubungi saya: a.b@contoh.id sekarang'), 'Hubungi saya: [email] sekarang')
})

test('extractLinkedInUrl: biasa, terpotong dua baris, dan tidak ada', () => {
  assert.equal(extractLinkedInUrl(TEXT), 'https://www.linkedin.com/in/rina-kusuma-sintetis')
  assert.equal(extractLinkedInUrl('Contact\nwww.linkedin.com/in/nama-yang-sangat-panjang-\nabc123 (LinkedIn)\nTop Skills'), 'https://www.linkedin.com/in/nama-yang-sangat-panjang-abc123')
  assert.equal(extractLinkedInUrl('Contact\nhttps://id.linkedin.com/in/budi-santoso (LinkedIn)'), 'https://www.linkedin.com/in/budi-santoso')
  assert.equal(extractLinkedInUrl('Contact\nwww.example.com (Personal)'), null)
})

test('splitSections: judul Inggris dan Indonesia dikenali', () => {
  const keys = (t: string) => splitSections(t).map((b) => b.key).filter((k) => k !== 'preamble')
  assert.deepEqual(keys(TEXT), ['contact', 'topSkills', 'languages', 'certifications', 'summary', 'experience', 'education'])
  assert.deepEqual(keys('Kontak\nx\nKemampuan Teratas\ny\nBahasa\nz\nSertifikasi\nq\nRingkasan\nr\nPengalaman\ns\nPendidikan\nt'), [
    'contact', 'topSkills', 'languages', 'certifications', 'summary', 'experience', 'education',
  ])
})

// ───────────────────────────────────────────────────────────── parser aturan + validator

test('parser aturan pada fixture sintetis: profil, 4 jabatan (grup perusahaan), pendidikan, sertifikat, skill, bahasa', () => {
  const preview = assemblePreview(norm(parseWithRules(TEXT)), TEXT, { method: 'rules', model: null, pages: 2, truncated: false }, [])
  assert.deepEqual(preview.profile, {
    full_name: 'Rina Kusuma Wardhani',
    current_title: 'Senior Data Analyst',
    location: 'Yogyakarta, Daerah Istimewa Yogyakarta, Indonesia',
    linkedin_url: 'https://www.linkedin.com/in/rina-kusuma-sintetis',
  })
  assert.deepEqual(
    preview.experiences.map((e) => [e.company_name, e.role_title, e.start_date, e.end_date, e.is_current, e.employment_type, e.location_type]),
    [
      ['Biru Langit Labs', 'Senior Data Analyst', '2022-01-01', null, true, 'full-time', 'on-site'],
      ['PT Nusantara Digital Solusi', 'Data Analyst', '2020-03-01', '2021-12-01', false, 'full-time', 'on-site'],
      ['PT Nusantara Digital Solusi', 'Junior Data Analyst', '2018-09-01', '2020-02-01', false, 'full-time', 'on-site'],
      ['Studio Kopi Hitam', 'Data Intern', '2018-06-01', '2018-08-01', false, 'internship', 'remote'],
    ],
  )
  assert.match(preview.experiences[0].description!, /^Lead a team of three analysts\. Built a demand forecasting model that reduced stock-outs\./)
  assert.equal(preview.experiences[3].description, null)
  assert.deepEqual(
    preview.education.map((e) => [e.institution, e.degree, e.field_of_study, e.start_year, e.end_year, e.is_current]),
    [
      ['Universitas Fiktif Nusantara', 'Bachelor of Engineering - BE', 'Information Systems', 2014, 2018, false],
      ['Sekolah Menengah Atas Contoh 1 Yogyakarta', 'SMA', 'IPA', 2011, 2014, false],
    ],
  )
  assert.deepEqual(preview.certifications, [
    { name: 'Google Data Analytics Professional Certificate', issuer: '' },
    { name: 'AWS Certified Cloud Practitioner', issuer: '' },
  ])
  assert.deepEqual(preview.skills.map((s) => [s.name, s.category, s.proficiency_level]), [
    ['Python', 'technical', 3], ['Data Analysis', 'technical', 3], ['Project Management', 'technical', 3],
    ['Indonesian', 'language', 5], ['English', 'language', 4], ['Japanese', 'language', 1],
  ])
  assert.deepEqual(preview.meta.dropped, { experiences: 0, education: 0, certifications: 0, skills: 0 })
})

test('parser aturan pada judul Indonesia: Pengalaman, Pendidikan, Sekarang, tanggal Indonesia', () => {
  const id = [
    'Kontak', 'www.linkedin.com/in/budi-sintetis (LinkedIn)',
    'Kemampuan Teratas', 'Akuntansi',
    'Bahasa', 'Inggris (Kemampuan kerja profesional)',
    'Budi Pratama Sintetis', 'Akuntan di Toko Fiktif', 'Surabaya, Jawa Timur, Indonesia',
    'Pengalaman', 'Toko Fiktif Sejahtera', 'Akuntan', 'Januari 2021 - Sekarang (3 tahun 11 bulan)', 'Surabaya, Jawa Timur, Indonesia',
    'Pendidikan', 'Universitas Fiktif Surabaya', 'Sarjana Ekonomi, Akuntansi · (2016 - 2020)',
  ].join('\n')
  const n = norm(parseWithRules(id), id)
  assert.equal(n.fullName, 'Budi Pratama Sintetis')
  assert.equal(n.experiences[0].start_date, '2021-01-01')
  assert.equal(n.experiences[0].is_current, true)
  assert.equal(n.education[0].degree, 'Sarjana Ekonomi')
  assert.equal(n.education[0].field_of_study, 'Akuntansi')
  assert.deepEqual(n.skills.map((s) => [s.name, s.category, s.proficiency_level]), [['Akuntansi', 'technical', 3], ['Inggris', 'language', 3]])
})

test('normalizeExtraction: item tidak sah dibuang dan dihitung (kosong, masa depan, urutan terbalik, panjang, ganda, bukan objek)', () => {
  const longName = 'A'.repeat(LIMITS.name + 1)
  const n = norm({
    experiences: [
      { company: 'Biru Langit Labs', title: 'Senior Data Analyst', date_range: 'January 2022 - Present' }, // sah
      { company: '', title: 'Data Analyst', date_range: 'March 2020 - December 2021' }, // perusahaan kosong
      { company: 'PT Nusantara Digital Solusi', title: '', date_range: 'March 2020 - December 2021' }, // jabatan kosong
      { company: 'PT Nusantara Digital Solusi', title: 'Data Analyst', date_range: 'March 2020 - December 2027' }, // selesai di masa depan
      { company: 'PT Nusantara Digital Solusi', title: 'Junior Data Analyst', date_range: 'December 2021 - March 2020' }, // terbalik
      { company: 'Studio Kopi Hitam', title: 'Data Intern', date_range: 'tanpa tanggal' }, // tanggal tidak terbaca
      { company: longName, title: 'Data Analyst', date_range: 'March 2020 - December 2021' }, // terlalu panjang
      { company: 'Biru Langit Labs', title: 'Senior Data Analyst', date_range: 'January 2022 - Present' }, // ganda
      'bukan objek',
      null,
    ],
  })
  assert.equal(n.experiences.length, 1)
  assert.equal(n.dropped.experiences, 9)
})

test('normalizeExtraction: tanggal dinormalkan YYYY-MM-01, Present = is_current dan end_date null, urut terbaru dulu', () => {
  const n = norm({
    experiences: [
      { company: 'Studio Kopi Hitam', title: 'Data Intern', date_range: 'June 2018 - August 2018 (3 months)' },
      { company: 'Biru Langit Labs', title: 'Senior Data Analyst', date_range: 'January 2022 - Present (2 years 11 months)' },
      { company: 'PT Nusantara Digital Solusi', title: 'Data Analyst', date_range: 'March 2020 - December 2021' },
    ],
  })
  assert.deepEqual(n.experiences.map((e) => [e.role_title, e.start_date, e.end_date, e.is_current]), [
    ['Senior Data Analyst', '2022-01-01', null, true],
    ['Data Analyst', '2020-03-01', '2021-12-01', false],
    ['Data Intern', '2018-06-01', '2018-08-01', false],
  ])
})

test('normalizeExtraction: perusahaan, jabatan, sekolah, dan sertifikat karangan model (tidak ada di PDF) dibuang', () => {
  const n = norm({
    full_name: 'Tokoh Karangan',
    headline: 'Chief Everything Officer',
    experiences: [
      { company: 'Biru Langit Labs', title: 'Senior Data Analyst', date_range: 'January 2022 - Present' },
      { company: 'Google LLC', title: 'Senior Data Analyst', date_range: 'January 2019 - December 2021' },
      { company: 'Biru Langit Labs', title: 'Chief Data Officer', date_range: 'January 2019 - December 2021' },
    ],
    education: [
      { school: 'Universitas Fiktif Nusantara', degree: 'Bachelor of Engineering - BE', field: 'Information Systems', years: '2014 - 2018' },
      { school: 'Stanford University', degree: 'PhD', field: 'Computer Science', years: '2018 - 2022' },
    ],
    certifications: [{ name: 'AWS Certified Cloud Practitioner' }, { name: 'Certified Kubernetes Administrator' }],
    skills: ['Python', 'Rust'],
    languages: [{ name: 'English', level: 'Full Professional' }, { name: 'Mandarin', level: 'Native or Bilingual' }],
  })
  assert.equal(n.fullName, null)
  assert.equal(n.headline, null)
  assert.deepEqual(n.experiences.map((e) => e.company_name + '/' + e.role_title), ['Biru Langit Labs/Senior Data Analyst'])
  assert.deepEqual(n.education.map((e) => e.institution), ['Universitas Fiktif Nusantara'])
  assert.deepEqual(n.certifications.map((c) => c.name), ['AWS Certified Cloud Practitioner'])
  assert.deepEqual(n.skills.map((s) => s.name), ['Python', 'English'])
  assert.deepEqual(n.dropped, { experiences: 2, education: 1, certifications: 1, skills: 2 })
})

test('normalizeExtraction pendidikan: Present = is_current, bidang dipindah ke jenjang bila jenjang kosong, tanpa tahun atau jenjang dibuang', () => {
  const src = 'Universitas Fiktif Nusantara\nInformation Systems · (2022 - Present)\nSekolah Menengah Atas Contoh 1 Yogyakarta\nSMA, IPA · (2011 - 2014)\nUniversitas Contoh Lain'
  const n = norm(
    {
      education: [
        { school: 'Universitas Fiktif Nusantara', degree: null, field: 'Information Systems', years: '2022 - Present' },
        { school: 'Sekolah Menengah Atas Contoh 1 Yogyakarta', degree: 'SMA', field: 'IPA', years: '2011 - 2014' },
        { school: 'Universitas Contoh Lain', degree: 'S1', field: null, years: null },
        { school: 'Sekolah Menengah Atas Contoh 1 Yogyakarta', degree: 'SMA', field: 'IPA', years: '2011 - 2014' },
        { school: 'Universitas Contoh Lain', degree: 'SMA', field: null, years: '1900 - 1903' },
        { school: 'Universitas Contoh Lain', degree: 'SMA', field: null, years: '2030 - 2060' },
      ],
    },
    src,
  )
  assert.deepEqual(n.education.map((e) => [e.institution, e.degree, e.field_of_study, e.start_year, e.end_year, e.is_current]), [
    ['Universitas Fiktif Nusantara', 'Information Systems', null, 2022, null, true],
    ['Sekolah Menengah Atas Contoh 1 Yogyakarta', 'SMA', 'IPA', 2011, 2014, false],
  ])
  assert.equal(n.dropped.education, 4)
})

test('normalizeExtraction deskripsi: kata karangan membuat deskripsi dibuang dengan catatan; terlalu panjang dipotong; baris dipertahankan', () => {
  const src = 'Biru Langit Labs\nSenior Data Analyst\nJanuary 2022 - Present\nBuilt dashboards for operations teams.\nMaintain executive reporting.'
  const base = { company: 'Biru Langit Labs', title: 'Senior Data Analyst', date_range: 'January 2022 - Present' }
  const kept = norm({ experiences: [{ ...base, description: 'Built dashboards for operations teams.\nMaintain executive reporting.' }] }, src).experiences[0]
  assert.equal(kept.description, 'Built dashboards for operations teams.\nMaintain executive reporting.')
  assert.deepEqual(kept.notes, [])
  const invented = norm({ experiences: [{ ...base, description: 'Increased revenue by 400 percent across Southeast Asian subsidiaries through blockchain automation.' }] }, src).experiences[0]
  assert.equal(invented.description, null)
  assert.match(invented.notes.join(' '), /Deskripsi tidak dimasukkan/)
  const word = 'dashboards '
  const longSrc = `${src}\n${word.repeat(400)}`
  const long = norm({ experiences: [{ ...base, description: word.repeat(400) }] }, longSrc).experiences[0]
  assert.ok(long.description!.length <= LIMITS.longText)
  assert.match(long.notes.join(' '), /dipotong/)
})

test('normalizeExtraction skill: tingkat bahasa dipetakan, ganda dan terlalu panjang dibuang, batas 50, kategori selalu sah', () => {
  const names = Array.from({ length: 60 }, (_, i) => `Skill${i}`)
  const n = norm({ skills: [...names, 'Skill1', 'x'.repeat(61)], languages: [] }, names.join('\n') + '\n' + 'x'.repeat(61))
  assert.equal(n.skills.length, LIMITS.maxSkills)
  assert.ok(n.skills.every((s) => ['technical', 'tool', 'language', 'soft'].includes(s.category) && s.proficiency_level >= 1 && s.proficiency_level <= 5))
  assert.equal(n.dropped.skills, 60 + 2 - LIMITS.maxSkills)
})

test('normalizeExtraction: masukan sampah (bukan objek, tipe salah) tidak melempar galat', () => {
  for (const raw of [null, undefined, 'teks', 42, [], { experiences: 'bukan daftar', education: { a: 1 }, skills: 7 }]) {
    const n = norm(raw)
    assert.equal(n.experiences.length + n.education.length + n.certifications.length + n.skills.length, 0)
  }
})

test('buildModelPrompt: batas teks, data tak tepercaya, tanpa email dan telepon', () => {
  const p = buildModelPrompt(TEXT)
  assert.match(p.system, /untrusted data/i)
  assert.match(p.system, /Never invent/)
  assert.match(p.user, /<profile_text>/)
  assert.ok(!p.user.includes('@example.com') && !p.user.includes('+62 812'))
  assert.equal(p.truncated, false)
  const huge = buildModelPrompt('a'.repeat(100_000))
  assert.equal(huge.truncated, true)
  assert.ok(huge.user.length < 40_000)
})

// ───────────────────────────────────────────────────────────── acceptJsonObject

test('acceptJsonObject: JSON polos, berpagar kode, dengan basa-basi, dengan blok pikir diterima; bukan objek ditolak', () => {
  const ok = (s: string) => (acceptJsonObject(s) as any).ok === true
  assert.ok(ok('{"a":1}'))
  assert.ok(ok('```json\n{"a":1}\n```'))
  assert.ok(ok('Berikut hasilnya:\n{"a":{"b":[1,2]}}\nSemoga membantu.'))
  assert.ok(ok('<think>mikir {x}</think>{"a":1}'))
  assert.equal((acceptJsonObject('```json\n{"a":1}\n```') as any).text, '{"a":1}')
  for (const bad of ['', '<think>', 'tidak ada json', '[1,2,3]', '{"a":', '{a:1}', '"teks"']) assert.equal((acceptJsonObject(bad) as any).ok, false, bad)
})

// ───────────────────────────────────────────────────────────── orkestrasi dengan model tiruan

const AI_JSON = {
  full_name: 'Rina Kusuma Wardhani',
  headline: 'Senior Data Analyst at Biru Langit Labs',
  location: 'Yogyakarta, Daerah Istimewa Yogyakarta, Indonesia',
  experiences: [
    { company: 'Biru Langit Labs', title: 'Senior Data Analyst', date_range: 'January 2022 - Present (2 years 11 months)', location: 'Yogyakarta, Daerah Istimewa Yogyakarta, Indonesia', description: 'Lead a team of three analysts.' },
    { company: 'PT Nusantara Digital Solusi', title: 'Data Analyst', date_range: 'March 2020 - December 2021 (1 year 10 months)', location: 'Jakarta, Indonesia', description: 'Analyzed sales data across 40 stores.' },
  ],
  education: [{ school: 'Universitas Fiktif Nusantara', degree: 'Bachelor of Engineering - BE', field: 'Information Systems', years: '2014 - 2018' }],
  certifications: [{ name: 'AWS Certified Cloud Practitioner', issuer: null }],
  skills: ['Python', 'Data Analysis'],
  languages: [{ name: 'English', level: 'Full Professional' }],
}

function service(llm: any, extra: Record<string, unknown> = {}) {
  return new LinkedInImportService({ llm, now: () => NOW, ...extra })
}

test('layanan, jalur AI: hasil model divalidasi kode, metode ai, model tercatat, tanpa peringatan', async () => {
  let seen: any
  const svc = service(async (p: any) => {
    seen = p
    return { text: JSON.stringify(AI_JSON), model: 'test:model-1' }
  })
  const preview = await svc.importFromPdf(fixturePdf(), { userId: 'u1' })
  assert.equal(preview.meta.method, 'ai')
  assert.equal(preview.meta.model, 'test:model-1')
  assert.equal(preview.meta.pages, 2)
  assert.deepEqual(preview.warnings, [])
  assert.equal(preview.profile.full_name, 'Rina Kusuma Wardhani')
  assert.equal(preview.profile.current_title, 'Senior Data Analyst')
  assert.equal(preview.profile.linkedin_url, 'https://www.linkedin.com/in/rina-kusuma-sintetis', 'tautan dari kode, bukan dari model')
  assert.equal(preview.experiences.length, 2)
  assert.equal(preview.experiences[0].start_date, '2022-01-01')
  assert.equal(preview.skills.map((s) => s.name).join(','), 'Python,Data Analysis,English')
  // model hanya menerima teks tanpa email dan telepon, dan userId diteruskan untuk memilih paket
  assert.equal(seen.userId, 'u1')
  assert.ok(!seen.user.includes('rina.sintetis@example.com') && !seen.user.includes('+62 812 0000 0000'))
  assert.match(seen.user, /Bachelor of Engineering - BE, Information Systems/)
})

test('layanan: model gagal = parser aturan dengan peringatan; hasilnya tetap utuh untuk tata letak LinkedIn', async () => {
  const svc = service(async () => {
    throw new Error('AI generation failed after 8 OpenRouter + Groq model attempts')
  })
  const preview = await svc.importFromPdf(fixturePdf())
  assert.equal(preview.meta.method, 'rules')
  assert.equal(preview.meta.model, null)
  assert.match(preview.warnings.join(' '), /AI sedang tidak tersedia/)
  assert.equal(preview.experiences.length, 4)
  assert.equal(preview.profile.full_name, 'Rina Kusuma Wardhani')
})

test('layanan: model kehabisan waktu = parser aturan; jawaban JSON rusak = parser aturan', async () => {
  const hang = service(() => new Promise(() => {}), { aiTimeoutMs: 20 })
  assert.equal((await hang.importFromPdf(fixturePdf())).meta.method, 'rules')
  const broken = service(async () => ({ text: 'bukan json', model: 'm' }))
  assert.equal((await broken.importFromPdf(fixturePdf())).meta.method, 'rules')
})

test('layanan: semua isi jawaban model karangan = terbuang, lalu parser aturan dipakai dengan peringatan', async () => {
  const invented = {
    full_name: 'Tokoh Karangan',
    experiences: [{ company: 'Google LLC', title: 'CEO', date_range: 'January 2010 - Present' }],
    education: [{ school: 'Harvard', degree: 'PhD', field: null, years: '2000 - 2004' }],
    skills: ['Telepati'],
  }
  const preview = await service(async () => ({ text: JSON.stringify(invented), model: 'm' })).importFromPdf(fixturePdf())
  assert.equal(preview.meta.method, 'rules')
  assert.match(preview.warnings.join(' '), /AI tidak menemukan data/)
  assert.ok(!JSON.stringify(preview).includes('Google LLC'))
})

test('layanan: sebagian isi jawaban model karangan = dibuang, sisanya dipakai, peringatan jumlah item dibuang', async () => {
  const mixed = { ...AI_JSON, experiences: [...AI_JSON.experiences, { company: 'Google LLC', title: 'Staff Engineer', date_range: 'January 2015 - December 2017' }], skills: ['Python', 'Telepati'] }
  const preview = await service(async () => ({ text: JSON.stringify(mixed), model: 'm' })).importFromPdf(fixturePdf())
  assert.equal(preview.meta.method, 'ai')
  assert.equal(preview.experiences.length, 2)
  assert.deepEqual(preview.meta.dropped, { experiences: 1, education: 0, certifications: 0, skills: 1 })
  assert.match(preview.warnings.join(' '), /2 item tidak dimasukkan/)
})

test('layanan: PDF tanpa data profil sama sekali = 422 nothing_found', async () => {
  const pdf = makePdf([['Dokumen biasa tentang cuaca hari ini. Hujan turun di sore hari dan angin bertiup pelan dari barat laut.', 'Tidak ada hubungannya dengan LinkedIn atau profil siapa pun.']])
  await assert.rejects(
    service(async () => ({ text: '{}', model: 'm' })).importFromPdf(pdf),
    (e: any) => e instanceof LinkedInImportError && e.statusCode === 422 && e.code === 'nothing_found',
  )
})

test('layanan: berkas yang bukan PDF ditolak sebelum model dipanggil', async () => {
  let called = 0
  const svc = service(async () => {
    called++
    return { text: '{}', model: 'm' }
  })
  await assert.rejects(svc.importFromPdf(Buffer.from('bukan pdf')), (e: any) => e instanceof LinkedInImportError && e.code === 'not_pdf')
  assert.equal(called, 0)
})
