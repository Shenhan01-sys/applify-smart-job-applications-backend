import { test } from 'node:test'
import assert from 'node:assert/strict'
import { NOW } from './helpers/linkedinFixture.ts'
import { ocrPdfPages, ocrPdfSelectedPages, type OcrOptions } from '../services/pdf-ocr.ts'
import { LinkedInImportError } from '../services/linkedin-pdf.ts'
import { LinkedInImportService, OCR_TRUNCATED_WARNING } from '../services/linkedin-import.service.ts'

/**
 * Audit 47.1 P1-4: hasil OCR yang terpotong batas keluaran (finishReason MAX_TOKENS) dulu diterima diam-diam.
 * Teks SINTETIS, tanpa jaringan: fetch, OCR, dan model AI dipalsukan.
 */

const CV_TEXT = [
  'Dewi Lestari Sintetis', 'Analis Data',
  'PENGALAMAN KERJA', 'Studio Fiktif Cahaya', 'Analis Data', 'Januari 2022 - Sekarang',
  'RIWAYAT PENDIDIKAN', 'Universitas Fiktif Nusantara', 'S1 Sistem Informasi, IPK 3,75/4,00', '2018 s/d 2022',
  'KEAHLIAN', 'Python',
].join('\n')

const HEAD_PAGE = ['Dewi Lestari Sintetis', 'Analis Data', 'dewi.sintetis@contoh.test', 'Bandung, Indonesia', 'Ringkasan: analis data dengan minat pada pelaporan.'].join('\n')
const TAIL_PAGE = 'KEAHLIAN: Python, SQL, pelaporan dan visualisasi data'

const gemini = (text: string, finishReason?: string) =>
  (async () =>
    new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] }, ...(finishReason ? { finishReason } : {}) }] }), {
      status: 200,
    })) as unknown as typeof fetch

const llm = async () => ({
  text: JSON.stringify({
    full_name: 'Dewi Lestari Sintetis',
    experiences: [{ company: 'Studio Fiktif Cahaya', title: 'Analis Data', date_range: 'Januari 2022 - Sekarang' }],
    education: [{ school: 'Universitas Fiktif Nusantara', degree: 'S1', field: 'Sistem Informasi', years: '2018 s/d 2022' }],
    skills: ['Python'],
  }),
  model: 'tiruan',
})

test('ocrPdfPages: finishReason MAX_TOKENS memanggil onTruncated dan teksnya tetap dikembalikan', async () => {
  let truncated = 0
  const r = await ocrPdfPages(Buffer.from('%PDF'), {
    apiKey: 'k',
    fetchImpl: gemini('Halaman satu\n---PAGE---\nHalaman dua yang terpotong di teng', 'MAX_TOKENS'),
    onTruncated: () => { truncated++ },
  })
  assert.equal(truncated, 1)
  assert.deepEqual(r, ['Halaman satu', 'Halaman dua yang terpotong di teng'])
})

test('ocrPdfPages: finishReason STOP atau tanpa finishReason tidak memanggil onTruncated', async () => {
  let truncated = 0
  const onTruncated = () => { truncated++ }
  assert.deepEqual(await ocrPdfPages(Buffer.from('%PDF'), { apiKey: 'k', fetchImpl: gemini('Satu', 'STOP'), onTruncated }), ['Satu'])
  assert.deepEqual(await ocrPdfPages(Buffer.from('%PDF'), { apiKey: 'k', fetchImpl: gemini('Satu'), onTruncated }), ['Satu'])
  assert.equal(truncated, 0)
})

test('ocrPdfPages: onTruncated yang melempar tidak membuat OCR gagal', async () => {
  const r = await ocrPdfPages(Buffer.from('%PDF'), {
    apiKey: 'k',
    fetchImpl: gemini('Satu', 'MAX_TOKENS'),
    onTruncated: () => { throw new Error('galat pemanggil') },
  })
  assert.deepEqual(r, ['Satu'])
})

test('ocrPdfSelectedPages: finishReason MAX_TOKENS memanggil onTruncated dan halaman yang sempat terbaca tetap ada', async () => {
  let truncated = 0
  const r = await ocrPdfSelectedPages(Buffer.from('%PDF'), [2, 3], {
    apiKey: 'k',
    fetchImpl: gemini('---PAGE 2---\nIsi dua\n---PAGE 3---\nIsi tiga yang terpot', 'MAX_TOKENS'),
    onTruncated: () => { truncated++ },
  })
  assert.equal(truncated, 1)
  assert.deepEqual([...(r ?? [])], [[2, 'Isi dua'], [3, 'Isi tiga yang terpot']])
  let normal = 0
  await ocrPdfSelectedPages(Buffer.from('%PDF'), [2], { apiKey: 'k', fetchImpl: gemini('---PAGE 2---\nIsi dua', 'STOP'), onTruncated: () => { normal++ } })
  assert.equal(normal, 0)
})

test('impor (PDF gambar): OCR terpotong -> teks dipakai, pratinjau diberi peringatan mungkin tidak lengkap', async () => {
  const svc = new LinkedInImportService({
    now: () => NOW,
    log: () => {},
    extractPages: async () => {
      throw new LinkedInImportError(422, 'pdf_no_text', 'tanpa teks')
    },
    // OCR sungguhan (Gemini dipalsukan) supaya sambungan opts.onTruncated dari layanan ikut teruji.
    ocrPages: (b, o?: OcrOptions) => ocrPdfPages(b, { ...o, apiKey: 'k', fetchImpl: gemini(CV_TEXT, 'MAX_TOKENS') }),
    llm,
  })
  const preview = await svc.importFromPdf(Buffer.from('%PDF-tiruan'), { userId: 'u1' })
  assert.equal(preview.experiences.length, 1)
  assert.ok(preview.warnings.includes(OCR_TRUNCATED_WARNING), preview.warnings.join(' | '))
  assert.match(OCR_TRUNCATED_WARNING, /OCR mungkin tidak lengkap/)
})

test('impor (PDF gambar): OCR selesai normal -> tidak ada peringatan terpotong', async () => {
  const svc = new LinkedInImportService({
    now: () => NOW,
    log: () => {},
    extractPages: async () => {
      throw new LinkedInImportError(422, 'pdf_no_text', 'tanpa teks')
    },
    ocrPages: (b, o?: OcrOptions) => ocrPdfPages(b, { ...o, apiKey: 'k', fetchImpl: gemini(CV_TEXT, 'STOP') }),
    llm,
  })
  const preview = await svc.importFromPdf(Buffer.from('%PDF-tiruan'), { userId: 'u1' })
  assert.ok(preview.warnings.some((w) => /OCR/.test(w)))
  assert.ok(!preview.warnings.includes(OCR_TRUNCATED_WARNING), preview.warnings.join(' | '))
})

test('impor (PDF hibrida): OCR halaman terpotong -> peringatan mungkin tidak lengkap ditambahkan', async () => {
  const svc = new LinkedInImportService({
    now: () => NOW,
    log: () => {},
    extractPages: async () => [HEAD_PAGE, '', TAIL_PAGE],
    ocrPages: async () => {
      throw new Error('OCR seluruh berkas tidak boleh dipanggil untuk PDF hibrida')
    },
    ocrSelectedPages: (b, n, o?: OcrOptions) =>
      ocrPdfSelectedPages(b, n, { ...o, apiKey: 'k', fetchImpl: gemini('---PAGE 2---\nPENGALAMAN KERJA\nStudio Fiktif Cahaya\nAnalis Data\nJanuari 2022 - Sekarang\nRIWAYAT PENDIDIKAN', 'MAX_TOKENS') }),
    llm,
  })
  const preview = await svc.importFromPdf(Buffer.from('%PDF-tiruan'), { userId: 'u1' })
  assert.ok(preview.warnings.includes(OCR_TRUNCATED_WARNING), preview.warnings.join(' | '))
  assert.ok(preview.warnings.some((w) => /Halaman 2 PDF berupa gambar/.test(w)), preview.warnings.join(' | '))
})

test('impor (PDF hibrida): OCR halaman normal -> tidak ada peringatan terpotong', async () => {
  const svc = new LinkedInImportService({
    now: () => NOW,
    log: () => {},
    extractPages: async () => [HEAD_PAGE, '', TAIL_PAGE],
    ocrPages: async () => null,
    ocrSelectedPages: (b, n, o?: OcrOptions) =>
      ocrPdfSelectedPages(b, n, { ...o, apiKey: 'k', fetchImpl: gemini('---PAGE 2---\nPENGALAMAN KERJA\nStudio Fiktif Cahaya\nAnalis Data\nJanuari 2022 - Sekarang\nRIWAYAT PENDIDIKAN', 'STOP') }),
    llm,
  })
  const preview = await svc.importFromPdf(Buffer.from('%PDF-tiruan'), { userId: 'u1' })
  assert.ok(!preview.warnings.includes(OCR_TRUNCATED_WARNING), preview.warnings.join(' | '))
})

test('impor: PDF yang punya teks tanpa halaman kosong tidak memicu peringatan terpotong', async () => {
  const svc = new LinkedInImportService({
    now: () => NOW,
    log: () => {},
    extractPages: async () => [CV_TEXT],
    llm,
  })
  const preview = await svc.importFromPdf(Buffer.from('%PDF-tiruan'), { userId: 'u1' })
  assert.ok(!preview.warnings.includes(OCR_TRUNCATED_WARNING))
})
