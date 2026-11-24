import { test } from 'node:test'
import assert from 'node:assert/strict'
import { NOW } from './helpers/linkedinFixture.ts'
import { buildModelPrompt } from '../services/linkedin-import.ts'
import { LinkedInImportService } from '../services/linkedin-import.service.ts'

/**
 * Prompt model dan layanan impor untuk CV biasa (bukan PDF LinkedIn): jaring pengaman Pendidikan bila AI
 * melewatkannya, dan jalur AI mati. Pasangan tests/linkedin-import-cv-education.test.ts. Teks SINTETIS, tanpa jaringan.
 */

// ───────────────────────────────────────────────────────────── prompt dan layanan

test('prompt model: untuk CV biasa dan PDF LinkedIn, memuat aturan tahun tunggal dan IPK', () => {
  const { system, user } = buildModelPrompt('Pendidikan\nUniversitas Fiktif Barat')
  assert.match(system, /CV|resume/i)
  assert.match(user, /"gpa"/)
  assert.match(user, /single year|only one year/i)
  assert.match(system, /Riwayat Pendidikan|Education Background/i)
})

const CV_TEXT = [
  'Dewi Lestari Sintetis', 'Analis Data',
  'PENGALAMAN KERJA', 'Studio Fiktif Cahaya', 'Analis Data', 'Januari 2022 - Sekarang',
  'RIWAYAT PENDIDIKAN', 'Universitas Fiktif Nusantara', 'S1 Sistem Informasi, IPK 3,75/4,00', '2018 s/d 2022',
  'KEAHLIAN', 'Python',
].join('\n')

const svc = (llmJson: unknown) =>
  new LinkedInImportService({
    now: () => NOW,
    log: () => {},
    extractPages: async () => [CV_TEXT],
    llm: async () => ({ text: JSON.stringify(llmJson), model: 'tiruan' }),
  })

test('layanan: AI mengembalikan pengalaman tetapi pendidikan kosong, seksi Pendidikan ada di CV -> pendidikan diisi dari parser aturan dengan peringatan', async () => {
  const preview = await svc({
    full_name: 'Dewi Lestari Sintetis',
    experiences: [{ company: 'Studio Fiktif Cahaya', title: 'Analis Data', date_range: 'Januari 2022 - Sekarang' }],
    education: [],
    skills: ['Python'],
  }).importFromPdf(Buffer.from('%PDF-tiruan'), { userId: 'u1' })
  assert.equal(preview.meta.method, 'ai')
  assert.equal(preview.experiences.length, 1)
  assert.deepEqual(preview.education.map((e) => [e.institution, e.degree, e.field_of_study, e.start_year, e.end_year, e.gpa]), [
    ['Universitas Fiktif Nusantara', 'S1', 'Sistem Informasi', 2018, 2022, 3.75],
  ])
  assert.ok(preview.warnings.some((w) => /Pendidikan.*aturan sederhana/i.test(w)), preview.warnings.join(' | '))
  assert.ok(!preview.warnings.some((w) => /Bagian Pendidikan ada di PDF tetapi isinya tidak berhasil dibaca/.test(w)))
})

test('layanan: AI sudah menemukan pendidikan -> hasil AI dipakai apa adanya, tanpa peringatan aturan', async () => {
  const preview = await svc({
    experiences: [{ company: 'Studio Fiktif Cahaya', title: 'Analis Data', date_range: 'Januari 2022 - Sekarang' }],
    education: [{ school: 'Universitas Fiktif Nusantara', degree: 'S1', field: 'Sistem Informasi', years: '2018 s/d 2022', gpa: '3,75/4,00' }],
  }).importFromPdf(Buffer.from('%PDF-tiruan'), { userId: 'u1' })
  assert.deepEqual(preview.education.map((e) => [e.institution, e.start_year, e.end_year, e.gpa, e.max_gpa]), [['Universitas Fiktif Nusantara', 2018, 2022, 3.75, 4]])
  assert.ok(!preview.warnings.some((w) => /aturan sederhana/i.test(w)))
})

test('layanan: AI gagal total, CV biasa dibaca parser aturan dan pendidikannya ikut terbaca', async () => {
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
  assert.deepEqual(preview.education.map((e) => [e.institution, e.degree, e.start_year, e.end_year]), [['Universitas Fiktif Nusantara', 'S1', 2018, 2022]])
})
