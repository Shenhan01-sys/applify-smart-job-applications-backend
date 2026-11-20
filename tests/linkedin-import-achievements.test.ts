import { test } from 'node:test'
import assert from 'node:assert/strict'
import { NOW, fixturePdf, fixtureText } from './helpers/linkedinFixture.ts'
import {
  LIMITS,
  buildModelPrompt,
  cleanPdfText,
  isEmptyExtraction,
  normalizeExtraction,
  parseAchievementDate,
  parseWithRules,
  readAchievementDate,
  splitSections,
} from '../services/linkedin-import.ts'
import { LinkedInImportService } from '../services/linkedin-import.service.ts'

/**
 * Impor penghargaan (Honors-Awards) dan publikasi (Publications) dari PDF LinkedIn ke tabel achievements.
 * Semua teks di sini SINTETIS (tokoh dan karya fiktif; lihat tests/fixtures/linkedin/synthetic-profile-awards-*.txt).
 * Tata letaknya meniru PDF LinkedIn: judul di kolom kiri terpotong 2 sampai 3 baris, tanggal di baris sendiri.
 */

const EN = cleanPdfText([fixtureText('synthetic-profile-awards-en.txt')])
const ID = cleanPdfText([fixtureText('synthetic-profile-awards-id.txt')])
const norm = (raw: unknown, sourceText = EN) => normalizeExtraction(raw, { sourceText, now: NOW })
const YEAR_NOTE = 'Hanya tahun yang tercantum di PDF, tanggal diisi 1 Januari.'

const brief = (a: { category: string; title: string; issuer: string | null; achievement_date: string | null }) => [a.category, a.title, a.issuer, a.achievement_date]

// ───────────────────────────────────────────────────────────── seksi

test('splitSections: Honors-Awards dan Publications (Inggris) serta Penghargaan dan Publikasi (Indonesia) dikenali', () => {
  const keys = (t: string) => splitSections(t).map((b) => b.key).filter((k) => k !== 'preamble')
  assert.deepEqual(keys(EN), ['contact', 'topSkills', 'languages', 'honors', 'publications', 'summary', 'experience', 'education'])
  assert.deepEqual(keys(ID), ['contact', 'topSkills', 'languages', 'honors', 'publications', 'summary', 'experience', 'education'])
  for (const h of ['Honors-Awards', 'Honors & Awards', 'Honors and Awards', 'Honors–Awards', 'Penghargaan', 'Penghargaan dan Prestasi', 'Penghargaan & Prestasi']) {
    assert.deepEqual(keys(`${h}\nx`), ['honors'], h)
  }
  for (const h of ['Publications', 'Publication', 'Publikasi']) assert.deepEqual(keys(`${h}\nx`), ['publications'], h)
  // seksi lain yang tidak diimpor tetap "other", dan tidak ikut terbaca sebagai penghargaan
  assert.deepEqual(keys('Patents\nx\nProjects\ny'), ['other', 'other'])
  // judul seksi hanya dikenali bila seluruh barisnya judul: judul penghargaan yang memuat kata "Awards" bukan seksi
  assert.deepEqual(keys('Honors-Awards\nBest Awards Night\nPublications Chair'), ['honors'])
})

// ───────────────────────────────────────────────────────────── tanggal

test('readAchievementDate dan parseAchievementDate: tahun, bulan, penyelenggara, hari; hasil YYYY-MM-01', () => {
  const ok = (raw: unknown) => parseAchievementDate(raw, NOW)
  assert.deepEqual(ok('2025'), { year: 2025, month: null, issuer: null, date: '2025-01-01' })
  assert.deepEqual(ok('(2025)'), { year: 2025, month: null, issuer: null, date: '2025-01-01' })
  assert.deepEqual(ok('(APTIKOM 2025)'), { year: 2025, month: null, issuer: 'APTIKOM', date: '2025-01-01' })
  assert.deepEqual(ok('March 2025'), { year: 2025, month: 3, issuer: null, date: '2025-03-01' })
  assert.deepEqual(ok('(Maret 2022)'), { year: 2022, month: 3, issuer: null, date: '2022-03-01' })
  assert.deepEqual(ok('Mar 5, 2025'), { year: 2025, month: 3, issuer: null, date: '2025-03-01' })
  assert.deepEqual(ok('5 Maret 2025'), { year: 2025, month: 3, issuer: null, date: '2025-03-01' })
  assert.deepEqual(ok('Issued Mar 2025'), { year: 2025, month: 3, issuer: null, date: '2025-03-01' })
  assert.deepEqual(ok('(Universitas Fiktif 2023)'), { year: 2023, month: null, issuer: 'Universitas Fiktif', date: '2023-01-01' })
  assert.deepEqual(ok('Jurnal Fiktif, Mei 2024'), { year: 2024, month: 5, issuer: 'Jurnal Fiktif', date: '2024-05-01' })
  assert.deepEqual(ok('Juara 1 2025'), { year: 2025, month: null, issuer: 'Juara 1', date: '2025-01-01' }, 'angka bukan hari bila tidak di samping nama bulan')
  assert.equal(ok('November 2026')?.date, '2026-11-01', 'bulan ini masih sah')
  assert.equal(ok('2026')?.date, '2026-01-01', 'tahun berjalan masih sah')
  // tidak sah
  assert.equal(ok('December 2026'), null, 'bulan di masa depan')
  assert.equal(ok('2027'), null, 'tahun di masa depan')
  assert.equal(ok('1899'), null, 'terlalu lama')
  assert.equal(ok('12025'), null)
  assert.equal(ok('tanpa tahun'), null)
  assert.equal(ok('Satu Dua Tiga Empat Lima Enam Tujuh 2025')?.issuer, null, 'lebih dari 6 kata bukan nama penyelenggara')
  for (const bad of [null, undefined, 2025, {}, []]) assert.equal(ok(bad), null)
  // readAchievementDate tidak menolak masa depan dekat (dipakai untuk mengenali baris tanggal)
  assert.equal(readAchievementDate('December 2026', NOW)?.year, 2026)
})

// ───────────────────────────────────────────────────────────── parser aturan

test('parser aturan, PDF Inggris: judul terpotong 2-3 baris digabung, tahun dan (Penyelenggara Tahun) dibaca, label Authors bukan isi', () => {
  const n = norm(parseWithRules(EN))
  assert.equal(n.fullName, 'Dewi Anggraini Sintetis', 'nama, judul profil, dan lokasi dilepas dari ujung seksi Publications')
  assert.deepEqual(n.achievements.map(brief), [
    ['award', 'Best Paper Award at Simulasi', 'KONFIK', '2024-01-01'],
    ['award', '3rd Place Winner of Hackathon (Smart City Category)', null, '2023-01-01'],
    ['award', 'Finalist - Lomba Analitik Data Mahasiswa Tingkat Nasional (LAD/NAS)', null, null],
    ['award', 'Beasiswa Unggulan Fiktif Angkatan 2022', null, null],
    ["award", "Dean's List Award Semester 3", null, '2022-03-01'],
    ['publication', 'A Study of Caching on Mobile Learning: Understanding the Effect on Memory and Retrieval Speed', null, null],
    ['publication', 'Dashboard Design for Job Seekers', 'Jurnal Fiktif', '2024-01-01'],
  ])
  assert.deepEqual(n.achievements[0].notes, [YEAR_NOTE])
  assert.deepEqual(n.achievements[4].notes, [], 'bulan tercantum, jadi tanpa catatan')
  assert.deepEqual(n.achievements[2].notes, [])
  assert.ok(n.achievements.every((a) => a.description === null), 'tanpa baris penulis di PDF, deskripsi kosong (bukan kata "Authors")')
  assert.deepEqual(n.dropped, { experiences: 0, education: 0, certifications: 0, achievements: 0, skills: 0 })
  assert.ok(!n.achievements.some((a) => /Dewi|Surabaya|Data Analyst/.test(a.title)), 'nama dan lokasi profil tidak jadi penghargaan')
})

test('parser aturan, PDF Indonesia: Penghargaan dan Publikasi, tahun di baris sendiri, (Penyelenggara Tahun)', () => {
  const n = norm(parseWithRules(ID), ID)
  assert.equal(n.fullName, 'Budi Santoso Sintetis')
  assert.deepEqual(n.achievements.map(brief), [
    ['award', 'Juara 2 Lomba Karya Tulis Ilmiah (Nasional)', null, '2024-01-01'],
    ['award', 'Mahasiswa Berprestasi Fakultas', 'Universitas Fiktif', '2023-01-01'],
    ['publication', 'Analisis Sentimen Ulasan Aplikasi Transportasi Daring Menggunakan Metode Naive Bayes', null, null],
  ])
  assert.equal(n.dropped.achievements, 0)
})

test('parser aturan: halaman tanpa seksi penghargaan atau publikasi menghasilkan daftar kosong', () => {
  const raw = parseWithRules(cleanPdfText([fixtureText('synthetic-profile-en.txt')])) as any
  assert.deepEqual(raw.achievements, [])
})

// ───────────────────────────────────────────────────────────── hasil model (normalizeExtraction)

test('hasil model: judul yang barisnya terpotong (juga lintas halaman) tetap lolos pemeriksaan sumber', () => {
  const src = cleanPdfText(['Honors-Awards\nBest Paper Award at\nSimulasi Nasional', 'Page 2 of 2\n(KONFIK 2024)\nPublications\nA Study of Caching on Mobile\nLearning: Understanding the Effect\non Memory and Retrieval Speed\nAuthors'])
  const n = norm(
    {
      achievements: [
        { title: 'Best Paper Award at Simulasi Nasional', kind: 'award', issuer: null, date: '(KONFIK 2024)', description: null },
        { title: 'A Study of Caching on Mobile\nLearning: Understanding the Effect\n  on Memory and Retrieval Speed', kind: 'publication', issuer: null, date: null, description: 'Authors' },
      ],
    },
    src,
  )
  assert.deepEqual(n.achievements.map(brief), [
    ['award', 'Best Paper Award at Simulasi Nasional', 'KONFIK', '2024-01-01'],
    ['publication', 'A Study of Caching on Mobile Learning: Understanding the Effect on Memory and Retrieval Speed', null, null],
  ])
  assert.equal(n.achievements[1].description, null, 'label "Authors" saja bukan deskripsi')
  assert.deepEqual(n.achievements[1].notes, [], 'label dibuang tanpa catatan')
  assert.equal(n.dropped.achievements, 0)
})

test('hasil model: judul karangan, kind tidak dikenal, ganda, kosong, terlalu panjang, dan bukan objek dibuang dan dihitung', () => {
  const longTitle = 'Judul sangat panjang '.repeat(12)
  const src = `${EN}\n${longTitle}`
  const n = norm(
    {
      achievements: [
        { title: 'Best Paper Award at Simulasi', kind: 'award', date: '(KONFIK 2024)' }, // sah
        { title: 'Nobel Prize in Physics', kind: 'award', date: '2024' }, // karangan
        { title: 'Quantum Gravity Revisited', kind: 'publication' }, // karangan
        { title: 'Best Paper Award at Simulasi 2025', kind: 'award' }, // kata ada tetapi urutannya tidak ada di PDF
        { title: 'Dashboard Design for Job Seekers', kind: 'patent' }, // kind tidak dikenal
        { title: 'Dashboard Design for Job Seekers', kind: 'publication', issuer: 'Jurnal Fiktif', date: '(Jurnal Fiktif 2024)' }, // sah
        { title: 'dashboard design for job seekers', kind: 'publication' }, // ganda (huruf besar beda)
        { title: '', kind: 'award' }, // kosong
        { title: longTitle, kind: 'award' }, // lebih dari 200 karakter, walau ada di PDF
        'bukan objek',
        null,
      ],
    },
    src,
  )
  assert.deepEqual(n.achievements.map((a) => a.title), ['Best Paper Award at Simulasi', 'Dashboard Design for Job Seekers'])
  assert.equal(n.dropped.achievements, 9)
  assert.ok(longTitle.trim().length > LIMITS.achievementTitle)
})

test('hasil model: kategori dipetakan dari kind (Inggris dan Indonesia): award atau publication', () => {
  const n = norm({
    achievements: [
      { title: 'Best Paper Award at Simulasi', kind: 'award' },
      { title: '3rd Place Winner of Hackathon (Smart City Category)', kind: 'Honors-Awards' },
      { title: "Dean's List Award Semester 3", category: 'Penghargaan' },
      { title: 'Dashboard Design for Job Seekers', kind: 'Publications' },
      { title: 'Beasiswa Unggulan Fiktif Angkatan 2022', type: 'publikasi' },
    ],
  })
  assert.deepEqual(n.achievements.map((a) => a.category), ['award', 'award', 'award', 'publication', 'publication'])
})

test('hasil model, tanggal: hanya tahun yang ada di seksi penghargaan atau publikasi; bulan hanya bila tertulis persis; masa depan dibuang tanpa membuang item', () => {
  const n = norm({
    achievements: [
      { title: 'Best Paper Award at Simulasi', kind: 'award', date: '2024' }, // tahun ada di seksi
      { title: '3rd Place Winner of Hackathon (Smart City Category)', kind: 'award', date: 'March 2023' }, // bulan karangan: hanya tahun
      { title: "Dean's List Award Semester 3", kind: 'award', date: 'Maret 2022' }, // bulan tertulis di PDF: dipertahankan
      { title: 'Beasiswa Unggulan Fiktif Angkatan 2022', kind: 'award', date: '2019' }, // 2019 hanya di bagian Education
      { title: 'Finalist - Lomba Analitik Data Mahasiswa Tingkat Nasional (LAD/NAS)', kind: 'award', date: '2031' }, // masa depan
      { title: 'A Study of Caching on Mobile Learning: Understanding the Effect on Memory and Retrieval Speed', kind: 'publication', date: 2024 }, // angka, bukan teks
      { title: 'Dashboard Design for Job Seekers', kind: 'publication', date: 'tanpa tahun' },
    ],
  })
  assert.deepEqual(n.achievements.map((a) => a.achievement_date), ['2024-01-01', '2023-01-01', '2022-03-01', null, null, '2024-01-01', null])
  assert.equal(n.dropped.achievements, 0, 'tanggal yang buruk tidak membuang item')
  assert.deepEqual(n.achievements[1].notes, [YEAR_NOTE])
  assert.deepEqual(n.achievements[2].notes, [])
  assert.deepEqual(n.achievements[3].notes, [], 'tanpa tanggal tidak ada catatan')
})

test('hasil model, penyelenggara: harus ada di PDF; kosong diisi dari "(Penyelenggara Tahun)"', () => {
  const n = norm({
    achievements: [
      { title: 'Best Paper Award at Simulasi', kind: 'award', issuer: 'Google', date: '(KONFIK 2024)' }, // Google tidak ada di PDF, diganti dari tanggal
      { title: "Dean's List Award Semester 3", kind: 'award', issuer: 'Universitas Fiktif Surabaya', date: '(Maret 2022)' }, // ada di PDF
      { title: 'Beasiswa Unggulan Fiktif Angkatan 2022', kind: 'award', issuer: 'x'.repeat(121) }, // terlalu panjang
      { title: 'Dashboard Design for Job Seekers', kind: 'publication', issuer: 'Penerbit Karangan' },
    ],
  })
  assert.deepEqual(n.achievements.map((a) => a.issuer), ['KONFIK', 'Universitas Fiktif Surabaya', null, null])
})

test('hasil model, deskripsi publikasi: hanya yang ada di PDF; karangan dibuang dengan catatan; label Authors dan pengulangan judul dibuang diam-diam', () => {
  const src = `${EN}\nAuthors: Dewi Anggraini Sintetis, Budi Contoh Fiktif\nPublisher: Penerbit Fiktif Press`
  const title = 'Dashboard Design for Job Seekers'
  const base = { title, kind: 'publication' }
  const desc = (d: unknown) => norm({ achievements: [{ ...base, description: d }] }, src).achievements[0]
  assert.equal(desc('Authors: Dewi Anggraini Sintetis, Budi Contoh Fiktif\nPublisher: Penerbit Fiktif Press').description, 'Authors: Dewi Anggraini Sintetis, Budi Contoh Fiktif\nPublisher: Penerbit Fiktif Press')
  const invented = desc('Prof. Zeno Quasar, Lembaga Antariksa Karangan')
  assert.equal(invented.description, null)
  assert.match(invented.notes.join(' '), /Deskripsi tidak dimasukkan/)
  for (const label of ['Authors', 'authors:', 'Penulis', 'Co-authors', title.toUpperCase()]) {
    const a = desc(label)
    assert.equal(a.description, null, label)
    assert.deepEqual(a.notes, [], label)
  }
  const long = norm({ achievements: [{ ...base, description: 'Penerbit '.repeat(400) }] }, `${src}\n${'Penerbit '.repeat(400)}`).achievements[0]
  assert.ok(long.description!.length <= LIMITS.longText)
  assert.match(long.notes.join(' '), /dipotong/)
})

test('hasil model: batas 30 penghargaan dan publikasi; kelebihannya dihitung sebagai dibuang', () => {
  const titles = Array.from({ length: 35 }, (_, i) => `Penghargaan Contoh Nomor ${i + 1} Fiktif`)
  const n = norm({ achievements: titles.map((title) => ({ title, kind: 'award' })) }, `Honors-Awards\n${titles.join('\n')}`)
  assert.equal(n.achievements.length, LIMITS.maxAchievements)
  assert.equal(n.dropped.achievements, 35 - LIMITS.maxAchievements)
})

test('hasil model: achievements bukan daftar atau tipe salah tidak melempar galat; isEmptyExtraction memperhitungkan penghargaan', () => {
  for (const raw of [{ achievements: 'bukan daftar' }, { achievements: { a: 1 } }, { achievements: 7 }, { achievements: [[], [1]] }]) {
    const n = norm(raw)
    assert.equal(n.achievements.length, 0)
  }
  assert.equal(isEmptyExtraction(norm({})), true)
  assert.equal(isEmptyExtraction(norm({ achievements: [{ title: 'Best Paper Award at Simulasi', kind: 'award' }] })), false)
})

// ───────────────────────────────────────────────────────────── prompt dan layanan

test('buildModelPrompt: bentuk achievements, kind, aturan judul terpotong, dan label Authors dijelaskan', () => {
  const p = buildModelPrompt(EN)
  assert.match(p.system, /Honors-Awards, Publications/)
  assert.match(p.user, /"achievements": \[ \{ "title": string, "kind": "award" \| "publication", "issuer": string \| null, "date": string \| null, "description": string \| null \} \]/)
  assert.match(p.user, /Join the wrapped lines of ONE title/)
  assert.match(p.user, /Penghargaan/)
  assert.match(p.user, /Publikasi/)
  assert.match(p.user, /only says "Authors" is a label/)
  assert.ok(p.user.includes('3rd Place Winner of Hackathon'), 'teks seksi ikut terkirim ke model')
  assert.ok(!p.user.includes('dewi.sintetis@example.com'), 'email tetap tidak ikut terkirim')
})

const AI_ACHIEVEMENTS = {
  full_name: 'Dewi Anggraini Sintetis',
  experiences: [{ company: 'Perusahaan Fiktif', title: 'Data Analyst', date_range: 'January 2023 - Present (1 year 10 months)' }],
  achievements: [
    { title: 'Best Paper Award at Simulasi', kind: 'award', issuer: null, date: '(KONFIK 2024)', description: null },
    { title: '3rd Place Winner of Hackathon (Smart City Category)', kind: 'award', issuer: null, date: '2023', description: null },
    { title: 'Finalist - Lomba Analitik Data Mahasiswa Tingkat Nasional (LAD/NAS)', kind: 'award', issuer: null, date: null, description: null },
    { title: 'Beasiswa Unggulan Fiktif Angkatan 2022', kind: 'award', issuer: null, date: null, description: null },
    { title: "Dean's List Award Semester 3", kind: 'award', issuer: null, date: 'Maret 2022', description: null },
    { title: 'A Study of Caching on Mobile Learning: Understanding the Effect on Memory and Retrieval Speed', kind: 'publication', issuer: null, date: null, description: 'Authors' },
    { title: 'Dashboard Design for Job Seekers', kind: 'publication', issuer: 'Jurnal Fiktif', date: '(Jurnal Fiktif 2024)', description: null },
    { title: 'Turing Award for Fictional Computing', kind: 'award', issuer: 'ACM', date: '1999', description: null }, // karangan
  ],
}

function service(llm: any) {
  return new LinkedInImportService({ llm, now: () => NOW })
}

test('layanan, jalur AI: penghargaan dan publikasi masuk pratinjau, yang karangan dibuang dan dihitung di meta.dropped.achievements', async () => {
  let seen: any
  const preview = await service(async (p: any) => {
    seen = p
    return { text: JSON.stringify(AI_ACHIEVEMENTS), model: 'test:model-1' }
  }).importFromPdf(fixturePdf('synthetic-profile-awards-en.txt'), { userId: 'u1' })
  assert.equal(preview.meta.method, 'ai')
  assert.equal(preview.achievements.length, 7)
  assert.deepEqual(preview.achievements.filter((a) => a.category === 'award').length, 5)
  assert.deepEqual(preview.achievements.filter((a) => a.category === 'publication').length, 2)
  assert.equal(preview.achievements[0].issuer, 'KONFIK')
  assert.equal(preview.achievements[0].achievement_date, '2024-01-01')
  assert.ok(!preview.achievements.some((a) => /Turing/.test(a.title)))
  assert.deepEqual(preview.meta.dropped, { experiences: 0, education: 0, certifications: 0, achievements: 1, skills: 0 })
  assert.match(preview.warnings.join(' '), /1 item tidak dimasukkan/)
  assert.match(seen.user, /Dashboard Design for Job Seekers/)
})

test('layanan: hanya penghargaan yang terbaca (tanpa pengalaman atau pendidikan) tetap dihitung sebagai hasil AI yang berguna', async () => {
  const only = { achievements: AI_ACHIEVEMENTS.achievements.slice(0, 2) }
  const preview = await service(async () => ({ text: JSON.stringify(only), model: 'm' })).importFromPdf(fixturePdf('synthetic-profile-awards-en.txt'))
  assert.equal(preview.meta.method, 'ai')
  assert.equal(preview.achievements.length, 2)
  // Satu-satunya peringatan: PDF punya seksi Pengalaman dan Pendidikan, tetapi jawaban model tidak memuat itemnya.
  assert.deepEqual(preview.warnings, ['Bagian Pengalaman dan Pendidikan ada di PDF tetapi isinya tidak berhasil dibaca. Tambahkan manual bila perlu.'])
})

test('layanan, jalur aturan: model gagal = parser aturan tetap membaca penghargaan dan publikasi dari PDF (Inggris dan Indonesia)', async () => {
  const failing = service(async () => {
    throw new Error('AI generation failed after 8 OpenRouter + Groq model attempts')
  })
  const en = await failing.importFromPdf(fixturePdf('synthetic-profile-awards-en.txt'))
  assert.equal(en.meta.method, 'rules')
  assert.equal(en.achievements.length, 7)
  assert.equal(en.profile.full_name, 'Dewi Anggraini Sintetis')
  assert.equal(en.experiences.length, 1)
  const id = await failing.importFromPdf(fixturePdf('synthetic-profile-awards-id.txt'))
  assert.equal(id.meta.method, 'rules')
  assert.deepEqual(id.achievements.map((a) => a.category), ['award', 'award', 'publication'])
})

test('layanan: seluruh jawaban model karangan = dibuang, parser aturan membaca penghargaan asli dengan peringatan', async () => {
  const invented = { achievements: [{ title: 'Nobel Prize in Physics', kind: 'award', date: '2024' }] }
  const preview = await service(async () => ({ text: JSON.stringify(invented), model: 'm' })).importFromPdf(fixturePdf('synthetic-profile-awards-en.txt'))
  assert.equal(preview.meta.method, 'rules')
  assert.match(preview.warnings.join(' '), /AI tidak menemukan data/)
  assert.ok(!JSON.stringify(preview).includes('Nobel'))
  assert.equal(preview.achievements.length, 7)
})
