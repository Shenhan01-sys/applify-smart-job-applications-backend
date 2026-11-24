import { test } from 'node:test'
import assert from 'node:assert/strict'
import { NOW } from './helpers/linkedinFixture.ts'
import { makePdf } from './helpers/makePdf.ts'
import {
  LIMITS,
  buildModelPrompt,
  cleanAchievementDescription,
  cleanPdfText,
  fillAchievementGaps,
  normalizeExtraction,
  parseWithRules,
  splitSections,
} from '../services/linkedin-import.ts'
import { LinkedInImportService } from '../services/linkedin-import.service.ts'

/**
 * Laporan produksi: 15 penghargaan pemilik hasil impor 23 November berjudul lengkap, tetapi hanya satu yang punya
 * deskripsi, padahal CV-nya memuat keterangan di bawah tiap judul. Penyebab yang dibuktikan di sini:
 *  1. Prompt model menyuruh `description` = null kecuali publikasi, jadi keterangan penghargaan tidak pernah dibawa.
 *  2. Parser aturan selalu mengisi `description: null`, dan baris poin atau kalimat di bawah judul CV biasa terbaca
 *     sebagai judul penghargaan baru (atau sebagai sertifikat baru di seksi Sertifikasi).
 *  3. Judul seksi "Awards", "Achievements", dan "Prestasi" tidak dikenali sebagai penghargaan.
 * Semua teks SINTETIS (tokoh, lomba, dan karya fiktif). Tanpa jaringan.
 */

const CV_ID = cleanPdfText([
  [
    'Dewi Anggraini Sintetis',
    'Yogyakarta',
    'PENDIDIKAN',
    'Universitas Fiktif Nusantara',
    'S1 Sistem Informasi | 2022 - Sekarang',
    'IPK 3.75/4.00',
    '',
    'PENGALAMAN KERJA',
    'PT Fiktif Teknologi',
    'Backend Intern',
    'Januari 2025 - Sekarang',
    '- Membuat API pendaftaran.',
    'Achievements:',
    '- Menurunkan waktu respons 40%.',
    '',
    'PENGHARGAAN',
    'Juara 1 Lomba Karya Tulis Ilmiah Nasional (2024)',
    '• Diselenggarakan oleh Kementerian Fiktif, diikuti 120 tim dari 40 perguruan tinggi.',
    '• Mengusulkan sistem peringatan dini banjir berbasis sensor murah.',
    'Mahasiswa Berprestasi Fakultas Teknologi Informasi, Maret 2023',
    'Dipilih dari 85 mahasiswa berdasarkan IPK, organisasi, dan karya ilmiah',
    'tingkat fakultas.',
    'Beasiswa Unggulan Fiktif Angkatan 2022',
    'Diberikan oleh Yayasan Fiktif',
    'https://beasiswa.example.org/penerima',
    '',
    'PUBLIKASI',
    'Analisis Sentimen Ulasan Aplikasi Transportasi Daring dengan Naive Bayes (2025)',
    'Penulis: Dewi Anggraini Sintetis, Budi Contoh Fiktif',
    'Jurnal Teknologi Fiktif, Vol. 4 No. 2, hlm. 10-20.',
    '',
    'SERTIFIKASI',
    'Google Data Analytics Certificate',
    '• Menyelesaikan delapan kursus analitik data dan satu proyek akhir.',
    'AWS Cloud Practitioner',
    '',
    'KEAHLIAN',
    'Python, SQL',
  ].join('\n'),
])

const CV_EN = cleanPdfText([
  [
    'Rudi Contoh Fiktif',
    'EDUCATION',
    'Fictional University of Technology',
    'Bachelor of Computer Science | 2019 - 2023',
    'AWARDS',
    'Best Paper Award, Fictional Conference on Informatics 2023',
    'Recognised for a study on caching strategies for mobile learning applications.',
    'The paper was selected from 212 submissions.',
    'Dean\'s List',
    'Awarded for a GPA above 3.7 in five consecutive semesters.',
    'PUBLICATIONS',
    'A Study of Caching on Mobile Learning',
    'Authors: Rudi Contoh Fiktif, Sari Penulis Fiktif',
    'Published in Journal of Fictional Computing, 2023.',
  ].join('\n'),
])

const norm = (raw: unknown, sourceText: string) => normalizeExtraction(raw, { sourceText, now: NOW })
const rulesAchievements = (text: string) => norm(parseWithRules(text), text).achievements
const brief = (a: { title: string; category: string; issuer: string | null; achievement_date: string | null; description: string | null; url: string | null }) => [a.category, a.title, a.issuer, a.achievement_date, a.description, a.url]

// ───────────────────────────────────────────────────────────── seksi

test('splitSections: Awards, Achievements, dan Prestasi = penghargaan; "Achievements:" dengan titik dua di dalam pengalaman bukan seksi penghargaan', () => {
  const keys = (t: string) => splitSections(t).map((b) => b.key).filter((k) => k !== 'preamble')
  for (const h of ['Awards', 'AWARDS', 'Achievements', 'Awards & Achievements', 'Achievements and Awards', 'Prestasi', 'Prestasi dan Penghargaan']) {
    assert.deepEqual(keys(`${h}\nx`), ['honors'], h)
  }
  assert.deepEqual(keys('Experience\nPT Fiktif\nAchievements:\n- Menurunkan biaya 40%.'), ['experience', 'other'])
  assert.deepEqual(keys('Publications\nx'), ['publications'])
})

// ───────────────────────────────────────────────────────────── jalur aturan: CV biasa

test('parser aturan, CV Indonesia: poin dan kalimat di bawah judul menjadi deskripsi item itu, bukan judul baru', () => {
  const got = rulesAchievements(CV_ID)
  assert.deepEqual(got.map(brief), [
    [
      'award',
      'Juara 1 Lomba Karya Tulis Ilmiah Nasional',
      null,
      '2024-01-01',
      'Diselenggarakan oleh Kementerian Fiktif, diikuti 120 tim dari 40 perguruan tinggi.\nMengusulkan sistem peringatan dini banjir berbasis sensor murah.',
      null,
    ],
    ['award', 'Mahasiswa Berprestasi Fakultas Teknologi Informasi', null, '2023-03-01', 'Dipilih dari 85 mahasiswa berdasarkan IPK, organisasi, dan karya ilmiah tingkat fakultas.', null],
    ['award', 'Beasiswa Unggulan Fiktif Angkatan 2022', 'Yayasan Fiktif', null, null, 'https://beasiswa.example.org/penerima'],
    [
      'publication',
      'Analisis Sentimen Ulasan Aplikasi Transportasi Daring dengan Naive Bayes',
      null,
      '2025-01-01',
      'Penulis: Dewi Anggraini Sintetis, Budi Contoh Fiktif\nJurnal Teknologi Fiktif, Vol. 4 No. 2, hlm. 10-20.',
      null,
    ],
  ])
  assert.ok(got.every((a) => !/[•]/.test(a.description ?? '')), 'tanda poin tidak ikut tersimpan')
})

test('parser aturan, CV Inggris: seksi "Awards", kalimat di bawah judul, dan baris "Authors:" menjadi deskripsi', () => {
  const got = rulesAchievements(CV_EN)
  assert.deepEqual(got.map((a) => [a.category, a.title, a.description]), [
    [
      'award',
      'Best Paper Award, Fictional Conference on Informatics 2023',
      'Recognised for a study on caching strategies for mobile learning applications.\nThe paper was selected from 212 submissions.',
    ],
    ['award', "Dean's List", 'Awarded for a GPA above 3.7 in five consecutive semesters.'],
    ['publication', 'A Study of Caching on Mobile Learning', 'Authors: Rudi Contoh Fiktif, Sari Penulis Fiktif\nPublished in Journal of Fictional Computing, 2023.'],
  ])
})

test('parser aturan: deskripsi dipotong 600 karakter di batas kata dan diberi catatan', () => {
  const sentence = 'Mengembangkan prototipe layanan pemantauan kualitas udara berbasis sensor murah untuk sekolah. '
  const text = cleanPdfText([`Penghargaan\nJuara Harapan Lomba Inovasi Teknologi Fiktif 2024\n• ${sentence.repeat(12).trim()}`])
  const [a] = rulesAchievements(text)
  assert.ok(a.description, 'deskripsi tetap ada')
  assert.ok(a.description!.length <= LIMITS.achievementDescription, `panjang ${a.description!.length}`)
  assert.ok(a.description!.length > 500, 'dipotong mendekati batas, bukan dibuang')
  assert.ok(a.description!.endsWith('sekolah.') || /\S$/.test(a.description!), 'tidak berakhir di tengah kata')
  assert.match(a.notes.join(' '), /dipotong sampai 600 karakter/)
})

test('parser aturan: poin dan kalimat di bawah sertifikat tidak menjadi sertifikat baru', () => {
  const text = cleanPdfText(['Sertifikasi\nGoogle Data Analytics Certificate\n• Menyelesaikan delapan kursus analitik data dan satu proyek akhir.\nAWS Cloud Practitioner'])
  const certs = norm(parseWithRules(text), text).certifications
  assert.deepEqual(certs.map((c) => c.name), ['Google Data Analytics Certificate', 'AWS Cloud Practitioner'])
})

test('parser aturan: kolom kiri PDF LinkedIn tanpa poin atau kalimat tetap dibaca seperti sebelumnya (tanpa deskripsi dan tautan)', () => {
  const text = cleanPdfText(['Honors-Awards\nBest Paper Award at Simulasi\n(KONFIK 2024)\nFinalist - Lomba Analitik Data Mahasiswa\nTingkat Nasional (LAD/NAS)\nPublications\nDashboard Design for Job Seekers\n(Jurnal Fiktif 2024)'])
  const got = rulesAchievements(text)
  assert.deepEqual(got.map((a) => [a.title, a.issuer, a.description, a.url]), [
    ['Best Paper Award at Simulasi', 'KONFIK', null, null],
    ['Finalist - Lomba Analitik Data Mahasiswa Tingkat Nasional (LAD/NAS)', null, null, null],
    ['Dashboard Design for Job Seekers', 'Jurnal Fiktif', null, null],
  ])
})

// ───────────────────────────────────────────────────────────── jalur AI

test('cleanAchievementDescription: poin dan nomor di depan baris dibuang, baris kosong dan pengulangan judul hilang', () => {
  assert.equal(cleanAchievementDescription('• Dipilih dari 85 peserta\n- Tingkat fakultas\n\n1. Hadiah uang tunai', 'Mahasiswa Berprestasi'), 'Dipilih dari 85 peserta\nTingkat fakultas\nHadiah uang tunai')
  assert.equal(cleanAchievementDescription('Mahasiswa Berprestasi\n• Dipilih dari 85 peserta', 'Mahasiswa Berprestasi'), 'Dipilih dari 85 peserta')
  assert.equal(cleanAchievementDescription(null), '')
})

test('hasil model: deskripsi penghargaan dibawa, poin dibuang, dan dipotong 600 karakter dengan catatan', () => {
  const src = CV_ID
  const n = norm(
    {
      achievements: [
        {
          title: 'Mahasiswa Berprestasi Fakultas Teknologi Informasi',
          kind: 'award',
          date: 'Maret 2023',
          description: '• Dipilih dari 85 mahasiswa berdasarkan IPK, organisasi, dan karya ilmiah\n• tingkat fakultas.',
        },
      ],
    },
    src,
  )
  assert.equal(n.achievements[0].description, 'Dipilih dari 85 mahasiswa berdasarkan IPK, organisasi, dan karya ilmiah\ntingkat fakultas.')

  const long = 'Mahasiswa mengembangkan prototipe pemantauan kualitas udara. '.repeat(30).trim()
  const big = norm({ achievements: [{ title: 'Juara Harapan Lomba Inovasi', kind: 'award', description: long }] }, `Penghargaan\nJuara Harapan Lomba Inovasi\n${long}`).achievements[0]
  assert.ok(big.description!.length <= LIMITS.achievementDescription)
  assert.ok(big.description!.length > 500)
  assert.match(big.notes.join(' '), /dipotong sampai 600 karakter/)
})

test('hasil model: deskripsi karangan dibuang dengan catatan; tautan hanya bila tertulis di PDF dan berskema http(s)', () => {
  const title = 'Beasiswa Unggulan Fiktif Angkatan 2022'
  const one = (extra: Record<string, unknown>) => norm({ achievements: [{ title, kind: 'award', ...extra }] }, CV_ID).achievements[0]
  const invented = one({ description: 'Beasiswa penuh untuk peneliti antariksa dari lembaga karangan' })
  assert.equal(invented.description, null)
  assert.match(invented.notes.join(' '), /Deskripsi tidak dimasukkan/)
  assert.equal(one({ url: 'https://beasiswa.example.org/penerima' }).url, 'https://beasiswa.example.org/penerima')
  assert.equal(one({ url: 'https://karangan.example.net/x' }).url, null, 'tautan yang tidak ada di PDF dibuang')
  assert.equal(one({ url: 'javascript:alert(1)' }).url, null)
  assert.equal(one({ url: 'beasiswa.example.org/penerima' }).url, null, 'tanpa skema http(s) bukan tautan sah')
})

test('hasil model: kind "achievement" atau "prestasi" dibaca sebagai penghargaan, bukan dibuang', () => {
  const src = 'Prestasi\nJuara 1 Lomba Karya Tulis Ilmiah Nasional\n2024'
  const n = norm({ achievements: [{ title: 'Juara 1 Lomba Karya Tulis Ilmiah Nasional', kind: 'achievement', date: '2024' }] }, src)
  assert.deepEqual(n.achievements.map((a) => a.category), ['award'])
  assert.equal(n.dropped.achievements, 0)
})

test('buildModelPrompt: deskripsi penghargaan diminta (bukan hanya publikasi) dan ada bidang url', () => {
  const p = buildModelPrompt(CV_ID)
  assert.match(p.user, /"description": string \| null, "url": string \| null/)
  assert.match(p.user, /at most 600 characters/)
  assert.match(p.user, /remove the bullet marks/)
  assert.match(p.user, /Achievements/)
  assert.doesNotMatch(p.user, /"description": for a publication, the authors or publisher lines directly under its title, copied as written; otherwise null/)
})

// ───────────────────────────────────────────────────────────── melengkapi hasil AI dari parser aturan

test('fillAchievementGaps: hanya bidang kosong yang diisi, judul sama (tanpa peduli huruf besar), yang sudah terisi tidak disentuh', () => {
  const ai = [
    { title: 'Mahasiswa Berprestasi Fakultas Teknologi Informasi', category: 'award', issuer: 'Fakultas Fiktif', achievement_date: null, description: null, url: null, notes: [] },
    { title: 'Juara 1 Lomba Karya Tulis Ilmiah Nasional', category: 'award', issuer: null, achievement_date: '2024-01-01', description: 'Ringkasan dari AI', url: null, notes: [] },
    { title: 'Penghargaan Tidak Ada di Aturan', category: 'award', issuer: null, achievement_date: null, description: null, url: null, notes: [] },
  ] as const
  const rules = rulesAchievements(CV_ID)
  const { items, filled } = fillAchievementGaps([...ai].map((a) => ({ ...a })) as never, rules)
  assert.equal(filled, 1, 'hanya satu item yang ada bidang kosongnya dan punya padanan di aturan')
  assert.equal(items[0].description, 'Dipilih dari 85 mahasiswa berdasarkan IPK, organisasi, dan karya ilmiah tingkat fakultas.')
  assert.equal(items[0].issuer, 'Fakultas Fiktif', 'penyelenggara dari AI tidak ditimpa')
  assert.equal(items[0].achievement_date, '2023-03-01')
  assert.equal(items[1].description, 'Ringkasan dari AI', 'deskripsi AI tidak ditimpa')
  assert.equal(items[2].description, null)
})

function service(llm: unknown) {
  return new LinkedInImportService({ llm: llm as never, now: () => NOW })
}
const pdfOf = (text: string) => makePdf([text.split('\n')])

test('layanan, jalur AI: AI menjawab deskripsi null, deskripsi di PDF dilengkapi dari parser aturan; yang diisi AI tidak ditimpa', async () => {
  const aiAnswer = {
    full_name: 'Dewi Anggraini Sintetis',
    achievements: [
      { title: 'Juara 1 Lomba Karya Tulis Ilmiah Nasional', kind: 'award', issuer: null, date: '(2024)', description: null },
      { title: 'Mahasiswa Berprestasi Fakultas Teknologi Informasi', kind: 'award', issuer: null, date: null, description: 'Dipilih dari 85 mahasiswa' },
      { title: 'Beasiswa Unggulan Fiktif Angkatan 2022', kind: 'award', issuer: null, date: null, description: null, url: null },
    ],
  }
  const preview = await service(async () => ({ text: JSON.stringify(aiAnswer), model: 'm' })).importFromPdf(pdfOf(CV_ID.replace(/•/g, '-')), { userId: 'u1' })
  assert.equal(preview.meta.method, 'ai')
  const byTitle = Object.fromEntries(preview.achievements.map((a) => [a.title, a]))
  assert.match(byTitle['Juara 1 Lomba Karya Tulis Ilmiah Nasional'].description ?? '', /Diselenggarakan oleh Kementerian Fiktif/)
  assert.equal(byTitle['Mahasiswa Berprestasi Fakultas Teknologi Informasi'].description, 'Dipilih dari 85 mahasiswa', 'deskripsi AI dipertahankan')
  assert.equal(byTitle['Beasiswa Unggulan Fiktif Angkatan 2022'].issuer, 'Yayasan Fiktif')
  assert.equal(byTitle['Beasiswa Unggulan Fiktif Angkatan 2022'].url, 'https://beasiswa.example.org/penerima')
  assert.ok(preview.achievements.every((a) => (a.description ?? '').length <= LIMITS.achievementDescription))
})

test('layanan, jalur aturan (AI mati): deskripsi penghargaan dan publikasi ikut ke pratinjau', async () => {
  const preview = await service(async () => {
    throw new Error('AI mati')
  }).importFromPdf(pdfOf(CV_EN), { userId: 'u1' })
  assert.equal(preview.meta.method, 'rules')
  assert.deepEqual(preview.achievements.map((a) => [a.title, a.description]), [
    ['Best Paper Award, Fictional Conference on Informatics 2023', 'Recognised for a study on caching strategies for mobile learning applications.\nThe paper was selected from 212 submissions.'],
    ["Dean's List", 'Awarded for a GPA above 3.7 in five consecutive semesters.'],
    ['A Study of Caching on Mobile Learning', 'Authors: Rudi Contoh Fiktif, Sari Penulis Fiktif\nPublished in Journal of Fictional Computing, 2023.'],
  ])
})
