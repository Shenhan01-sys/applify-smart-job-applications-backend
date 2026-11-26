import test from 'node:test'
import assert from 'node:assert/strict'
import { assertPdfUpload, isGarbledPdfText, LinkedInImportError } from '../services/linkedin-pdf.js'
import { LinkedInImportService } from '../services/linkedin-import.service.js'
import { normalizeExtraction } from '../services/linkedin-import.js'
import { ownResumePath } from '../services/resume-file.service.js'

test('47.1 P3-2: assertPdfUpload menyertakan saran kompres saat ukuran > 5 MB dan tetap menolak non-PDF di offset 0', () => {
  const big = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(5 * 1024 * 1024 + 16)])
  assert.throws(
    () => assertPdfUpload(big),
    (e: unknown) => e instanceof LinkedInImportError && e.code === 'file_too_large' && /Kompres/i.test(e.message)
  )
  assert.throws(() => assertPdfUpload(Buffer.from('not a pdf')), (e: unknown) => e instanceof LinkedInImportError && e.code === 'not_pdf')
})

test('48.1 BS-U1-03: isGarbledPdfText mendeteksi teks CIDFont/ToUnicode rusak dan memicu fallback OCR', async () => {
  const garbled = '\uFFFD\uE001\uE002\uFFFD!@#$%^&*()_+=[]{}'.repeat(10)
  assert.equal(isGarbledPdfText([garbled]), true)
  assert.equal(isGarbledPdfText(['Budi Santoso Software Engineer Jakarta Pengalaman Kerja di PT Teknologi Nusantara sejak 2021 sampai sekarang']), false)

  let ocrCalled = false
  const svc = new LinkedInImportService({
    extractPages: async () => [garbled],
    ocrPages: async () => {
      ocrCalled = true
      return ['Budi Santoso\nSoftware Engineer\nJakarta, Indonesia\nExperience\nBackend Developer\nPT Teknologi Nusantara\nJan 2022 - Present']
    },
    llm: async () => ({
      model: 'fake',
      text: JSON.stringify({
        profile: { full_name: 'Budi Santoso', current_title: 'Software Engineer', location: 'Jakarta, Indonesia' },
        experiences: [],
        education: [],
        certifications: [],
        achievements: [],
        skills: [],
      }),
    }),
  })
  const preview = await svc.importFromPdf(Buffer.from('%PDF-1.4\nbody'))
  assert.equal(ocrCalled, true)
  assert.equal(preview.profile.full_name, 'Budi Santoso')
})

test('47.1 P2-7: totalBudgetMs terpadu melewati AI saat waktu tersisa < 4 detik dan tetap jatuh ke parser aturan', async () => {
  let llmCalled = false
  let t = 1_000
  const svc = new LinkedInImportService({
    clock: () => t,
    totalBudgetMs: 10_000,
    extractPages: async () => {
      t += 8_000
      return ['Siti Aminah\nData Analyst\nBandung\nExperience\nData Analyst\nPT Data Raya\nJan 2023 - Dec 2024\nSkills\nSQL, Python']
    },
    llm: async () => {
      llmCalled = true
      return { model: 'fake', text: '{}' }
    },
  })
  const preview = await svc.importFromPdf(Buffer.from('%PDF-1.4\nbody'))
  assert.equal(llmCalled, false)
  assert.ok(preview.warnings.some((w) => /aturan sederhana/i.test(w)))
})

test('47.1 Sup-2: readGpa menerima IPK bulat dengan skala (4/4) dan nilai rapor bulat (88)', () => {
  const source = 'Universitas Indonesia S1 Informatika 2020 - 2024 IPK 4/4 dan SMA Negeri 1 2017 - 2020 Nilai Rata-rata: 88'
  const out = normalizeExtraction(
    {
      profile: {},
      experiences: [],
      education: [
        { institution: 'Universitas Indonesia', degree: 'S1', field: 'Informatika', start_year: 2020, end_year: 2024, gpa: '4/4' },
        { institution: 'SMA Negeri 1', degree: 'SMA', start_year: 2017, end_year: 2020, gpa: 'Nilai Rata-rata: 88' },
      ],
      certifications: [],
      achievements: [],
      skills: [],
    },
    { sourceText: source, now: new Date('2026-11-26T00:00:00Z') }
  )
  assert.equal(out.education[0]?.gpa, 4)
  assert.equal(out.education[0]?.max_gpa, 4)
  assert.equal(out.education[1]?.gpa, 88)
  assert.equal(out.education[1]?.max_gpa, 100)
})

test('47.1 Sup-4: pesan nothing_found pasca-OCR tidak menyarankan ulang ekspor LinkedIn non-pindai', async () => {
  const svc = new LinkedInImportService({
    extractPages: async () => {
      throw new LinkedInImportError(422, 'pdf_no_text', 'no text')
    },
    ocrPages: async () => ['teks acak yang panjangnya cukup untuk melewati batas minimal delapan puluh karakter tanpa nama atau pengalaman kerja'],
    llm: async () => ({ model: 'fake', text: '{}' }),
  })
  await assert.rejects(
    () => svc.importFromPdf(Buffer.from('%PDF-1.4\nbody')),
    (e: unknown) => e instanceof LinkedInImportError && e.code === 'nothing_found' && /OCR/i.test(e.message) && !/bukan hasil pindai/i.test(e.message)
  )
})

test('47.1 Sup-5: ownResumePath menerima nama berkas CV lama berspasi dan tanda kurung sambil tetap menolak path traversal', () => {
  const u = 'user-123'
  assert.equal(ownResumePath(`${u}/CV Budi (final).pdf`, u), `${u}/CV Budi (final).pdf`)
  assert.equal(ownResumePath(`${u}/../CV Budi.pdf`, u), null)
  assert.equal(ownResumePath(`${u}/sub/CV Budi.pdf`, u), null)
  assert.equal(ownResumePath(`${u}/CV Budi.exe`, u), null)
})
