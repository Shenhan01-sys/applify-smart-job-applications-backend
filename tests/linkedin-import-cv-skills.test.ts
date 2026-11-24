import { test } from 'node:test'
import assert from 'node:assert/strict'
import { NOW } from './helpers/linkedinFixture.ts'
import { buildModelPrompt, cleanPdfText, normalizeExtraction, parseWithRules, splitSections } from '../services/linkedin-import.ts'
import { LinkedInImportService } from '../services/linkedin-import.service.ts'

/**
 * Celah skill pada CV biasa: impor hanya membaca seksi "Top Skills" milik PDF LinkedIn. Seksi "Skills", "Keahlian",
 * "Kemampuan", "Keterampilan", "Technical Skills", "Hard Skills", "Soft Skills", dan "Tools" di CV biasa diabaikan,
 * jadi skill tidak masuk profil. Teks SINTETIS (tokoh fiktif), tanpa jaringan.
 */

const norm = (raw: unknown, sourceText: string) => normalizeExtraction(raw, { sourceText, now: NOW })
const skillsOf = (cv: string) => {
  const text = cleanPdfText([cv])
  return norm(parseWithRules(text), text).skills.map((s) => [s.name, s.category])
}

test('splitSections: judul skill CV biasa dikenali sebagai seksi skills; "Top Skills" LinkedIn tetap topSkills', () => {
  for (const h of ['Skills', 'KEAHLIAN', 'Kemampuan', 'Keterampilan', 'Technical Skills', 'Hard Skills', 'Soft Skills', 'Tools', 'Keterampilan Teknis', 'Skills:']) {
    const blocks = splitSections(`Nama Sintetis\n${h}\nPython`)
    assert.deepEqual(blocks.map((b) => b.key), ['preamble', 'skills'], h)
  }
  assert.deepEqual(splitSections('Top Skills\nPython').map((b) => b.key), ['preamble', 'topSkills'])
  assert.deepEqual(splitSections('Kemampuan Teratas\nPython').map((b) => b.key), ['preamble', 'topSkills'])
})

test('aturan: skill CV biasa dipisah koma, titik koma, pipa, garis miring, poin, dan baris baru', () => {
  const names = skillsOf(
    [
      'Dewi Lestari Sintetis',
      'KEAHLIAN',
      'Python, SQL | Excel; Power BI',
      '• React',
      '- Node.js/Express',
      'HTML/CSS',
      'Python / R',
    ].join('\n'),
  ).map((s) => s[0])
  assert.deepEqual(names, ['Python', 'SQL', 'Excel', 'Power BI', 'React', 'Node.js', 'Express', 'HTML', 'CSS', 'R'])
})

test('aturan: singkatan berslash tidak dipecah (CI/CD, UI/UX, TCP/IP, A/B Testing)', () => {
  const names = skillsOf(['Skills', 'CI/CD, UI/UX, TCP/IP', 'A/B Testing'].join('\n')).map((s) => s[0])
  assert.deepEqual(names, ['CI/CD', 'UI/UX', 'TCP/IP', 'A/B Testing'])
})

test('aturan: label di depan daftar ("Bahasa Pemrograman: Java, Go") dibuang, dan beberapa seksi skill digabung', () => {
  const names = skillsOf(['Technical Skills', 'Bahasa Pemrograman: Java, Go', 'Tools: Git, Docker', 'Soft Skills', 'Komunikasi, Kerja Tim'].join('\n')).map((s) => s[0])
  assert.deepEqual(names, ['Java', 'Go', 'Git', 'Docker', 'Komunikasi', 'Kerja Tim'])
})

test('aturan: duplikat tanpa memandang huruf besar dibuang sekali; kalimat dan item lebih dari 40 karakter tidak masuk', () => {
  const long = 'Sertifikasi Manajemen Proyek Profesional Tingkat Lanjut Internasional'
  const sentence = 'Saya berpengalaman membangun dasbor untuk tim operasional.'
  const text = cleanPdfText([['Keahlian', 'Python, python, PYTHON', sentence, long, 'SQL'].join('\n')])
  const n = norm(parseWithRules(text), text)
  assert.deepEqual(n.skills.map((s) => s.name), ['Python', 'SQL'])
  assert.equal(n.dropped.skills, 2 + 0, 'kalimat dan item panjang dihitung terbuang; duplikat tidak dihitung dua kali sebagai karangan')
})

test('aturan: paling banyak 40 skill teknis dari seksi skill; sisanya dihitung terbuang', () => {
  const items = Array.from({ length: 55 }, (_, i) => `Alat${String(i + 1).padStart(2, '0')}`)
  const text = cleanPdfText([['Skills', items.join(', ')].join('\n')])
  const n = norm(parseWithRules(text), text)
  assert.equal(n.skills.filter((s) => s.category === 'technical').length, 40)
  assert.equal(n.dropped.skills, 15)
})

test('aturan: skill LinkedIn "Top Skills" tetap terbaca seperti sebelumnya', () => {
  assert.deepEqual(skillsOf(['Top Skills', 'Python', 'Data Visualization', 'Experience', 'Fiktif', 'Engineer', 'January 2020 - Present'].join('\n')), [
    ['Python', 'technical'],
    ['Data Visualization', 'technical'],
  ])
})

test('normalizeExtraction: jawaban model berisi daftar dipisah koma dipecah, kalimat dan item panjang dibuang, bahasa tidak terpengaruh', () => {
  const src = 'Keahlian\nPython, SQL, Excel\nSaya berpengalaman membangun dasbor untuk tim operasional\nBahasa\nIndonesia (Native)\nInggris'
  const n = norm(
    {
      skills: ['Python, SQL, excel', 'Saya berpengalaman membangun dasbor untuk tim operasional', 'python'],
      languages: [{ name: 'Indonesia', level: 'Native' }, { name: 'Inggris', level: null }],
    },
    src,
  )
  assert.deepEqual(n.skills.map((s) => [s.name, s.category]), [
    ['Python', 'technical'],
    ['SQL', 'technical'],
    ['excel', 'technical'],
    ['Indonesia', 'language'],
    ['Inggris', 'language'],
  ])
  assert.equal(n.dropped.skills, 2, 'kalimat dan duplikat "python"')
})

test('prompt model: skill diambil dari Top Skills atau seksi Skills/Keahlian/Kemampuan/Keterampilan/Tools CV biasa, satu nama pendek per item', () => {
  const { user } = buildModelPrompt('Keahlian\nPython')
  const rule = user.split('\n').find((l) => l.startsWith('- "skills"')) ?? ''
  for (const word of ['Top Skills', 'Skills', 'Technical Skills', 'Hard Skills', 'Soft Skills', 'Tools', 'Keahlian', 'Kemampuan', 'Keterampilan']) assert.ok(rule.includes(word), word)
  assert.match(rule, /40 characters/)
  assert.match(rule, /comma/i)
})

const CV_TEXT = ['Dewi Lestari Sintetis', 'PENGALAMAN KERJA', 'Studio Fiktif Cahaya', 'Analis Data', 'Januari 2022 - Sekarang', 'KEAHLIAN', 'Python, SQL | Excel'].join('\n')

const svc = (llmJson: unknown) =>
  new LinkedInImportService({
    now: () => NOW,
    log: () => {},
    extractPages: async () => [CV_TEXT],
    llm: async () => ({ text: JSON.stringify(llmJson), model: 'tiruan' }),
  })

test('layanan: AI mengembalikan pengalaman tetapi skill kosong padahal CV punya seksi Keahlian -> skill dibaca parser aturan, dengan peringatan', async () => {
  const preview = await svc({
    experiences: [{ company: 'Studio Fiktif Cahaya', title: 'Analis Data', date_range: 'Januari 2022 - Sekarang' }],
    skills: [],
  }).importFromPdf(Buffer.from('%PDF-tiruan'), { userId: 'u1' })
  assert.equal(preview.meta.method, 'ai')
  assert.deepEqual(preview.skills.map((s) => s.name), ['Python', 'SQL', 'Excel'])
  assert.ok(preview.warnings.some((w) => /skill.*aturan sederhana/i.test(w)), preview.warnings.join(' | '))
})

test('layanan: AI sudah menemukan skill -> hasil AI dipakai apa adanya', async () => {
  const preview = await svc({
    experiences: [{ company: 'Studio Fiktif Cahaya', title: 'Analis Data', date_range: 'Januari 2022 - Sekarang' }],
    skills: ['Python', 'Excel'],
  }).importFromPdf(Buffer.from('%PDF-tiruan'), { userId: 'u1' })
  assert.deepEqual(preview.skills.map((s) => s.name), ['Python', 'Excel'])
  assert.ok(!preview.warnings.some((w) => /skill.*aturan sederhana/i.test(w)))
})

test('layanan: AI gagal total, skill CV biasa terbaca parser aturan', async () => {
  const failing = new LinkedInImportService({
    now: () => NOW,
    log: () => {},
    extractPages: async () => [CV_TEXT],
    llm: async () => {
      throw new Error('boom')
    },
  })
  const preview = await failing.importFromPdf(Buffer.from('%PDF-tiruan'), { userId: 'u1' })
  assert.equal(preview.meta.method, 'rules')
  assert.deepEqual(preview.skills.map((s) => s.name), ['Python', 'SQL', 'Excel'])
})
