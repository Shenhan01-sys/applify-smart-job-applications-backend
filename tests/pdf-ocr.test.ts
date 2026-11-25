import { test } from 'node:test'
import assert from 'node:assert/strict'
import { NOW } from './helpers/linkedinFixture.ts'
import { ocrPdfPages } from '../services/pdf-ocr.ts'
import { LinkedInImportError, PDF_NO_TEXT_MESSAGE } from '../services/linkedin-pdf.ts'
import { LinkedInImportService } from '../services/linkedin-import.service.ts'

/**
 * OCR untuk PDF berupa gambar (CV Canva yang diratakan). Teks SINTETIS, tanpa jaringan: fetch dan OCR dipalsukan.
 */

const CV_TEXT = [
  'Dewi Lestari Sintetis', 'Analis Data',
  'PENGALAMAN KERJA', 'Studio Fiktif Cahaya', 'Analis Data', 'Januari 2022 - Sekarang',
  'RIWAYAT PENDIDIKAN', 'Universitas Fiktif Nusantara', 'S1 Sistem Informasi, IPK 3,75/4,00', '2018 s/d 2022',
  'KEAHLIAN', 'Python',
].join('\n')

const noText = async (): Promise<string[]> => {
  throw new LinkedInImportError(422, 'pdf_no_text', 'tanpa teks')
}

const svc = (ocrPages: (b: Buffer) => Promise<string[] | null>) =>
  new LinkedInImportService({
    now: () => NOW,
    log: () => {},
    extractPages: noText,
    ocrPages,
    llm: async () => ({
      text: JSON.stringify({
        full_name: 'Dewi Lestari Sintetis',
        experiences: [{ company: 'Studio Fiktif Cahaya', title: 'Analis Data', date_range: 'Januari 2022 - Sekarang' }],
        education: [{ school: 'Universitas Fiktif Nusantara', degree: 'S1', field: 'Sistem Informasi', years: '2018 s/d 2022' }],
        skills: ['Python'],
      }),
      model: 'tiruan',
    }),
  })

test('impor: PDF tanpa teks dibaca lewat OCR, dengan peringatan untuk diperiksa', async () => {
  let ocrCalls = 0
  const preview = await svc(async () => {
    ocrCalls++
    return [CV_TEXT]
  }).importFromPdf(Buffer.from('%PDF-tiruan'), { userId: 'u1' })
  assert.equal(ocrCalls, 1)
  assert.equal(preview.experiences.length, 1)
  assert.equal(preview.education[0]?.institution, 'Universitas Fiktif Nusantara')
  assert.ok(preview.warnings.some((w) => /OCR/.test(w)), preview.warnings.join(' | '))
})

test('impor: OCR tidak tersedia atau hasilnya terlalu pendek -> 422 pdf_no_text dengan pesan Canva', async () => {
  for (const ocr of [async () => null, async () => ['ab']]) {
    await assert.rejects(svc(ocr).importFromPdf(Buffer.from('%PDF-tiruan'), { userId: 'u1' }), (e: any) => {
      assert.equal(e.code, 'pdf_no_text')
      assert.equal(e.message, PDF_NO_TEXT_MESSAGE)
      assert.match(e.message, /Canva/)
      return true
    })
  }
})

test('impor: PDF yang punya teks tidak memanggil OCR', async () => {
  let ocrCalls = 0
  const s = new LinkedInImportService({
    now: () => NOW,
    log: () => {},
    extractPages: async () => [CV_TEXT],
    ocrPages: async () => {
      ocrCalls++
      return null
    },
    llm: async () => ({ text: JSON.stringify({ experiences: [], education: [], skills: ['Python'] }), model: 'tiruan' }),
  })
  const preview = await s.importFromPdf(Buffer.from('%PDF-tiruan'), { userId: 'u1' })
  assert.equal(ocrCalls, 0)
  assert.ok(!preview.warnings.some((w) => /OCR/.test(w)))
})

test('impor: galat PDF lain (rusak) tidak memicu OCR', async () => {
  let ocrCalls = 0
  const s = new LinkedInImportService({
    log: () => {},
    extractPages: async () => {
      throw new LinkedInImportError(422, 'pdf_unreadable', 'rusak')
    },
    ocrPages: async () => {
      ocrCalls++
      return [CV_TEXT]
    },
  })
  await assert.rejects(s.importFromPdf(Buffer.from('%PDF-tiruan'), {}), (e: any) => e.code === 'pdf_unreadable')
  assert.equal(ocrCalls, 0)
})

test('ocrPdfPages: tanpa kunci API -> null tanpa memanggil jaringan', async () => {
  let called = false
  const r = await ocrPdfPages(Buffer.from('%PDF'), { apiKey: '', fetchImpl: (async () => { called = true; return new Response('{}') }) as typeof fetch })
  assert.equal(r, null)
  assert.equal(called, false)
})

test('ocrPdfPages: mengirim PDF sebagai inline_data dan memecah halaman pada ---PAGE---', async () => {
  let sent: any = null
  let url = ''
  let headers: any = null
  const fetchImpl = (async (u: string, init: any) => {
    url = u
    headers = init.headers
    sent = JSON.parse(init.body)
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'Halaman satu\n---PAGE---\nHalaman dua' }] } }] }), { status: 200 })
  }) as unknown as typeof fetch
  const r = await ocrPdfPages(Buffer.from('%PDF-x'), { apiKey: 'kunci-tiruan', model: 'model-tiruan', fetchImpl })
  assert.deepEqual(r, ['Halaman satu', 'Halaman dua'])
  assert.match(url, /models\/model-tiruan:generateContent$/)
  assert.equal(headers['x-goog-api-key'], 'kunci-tiruan')
  const part = sent.contents[0].parts[0].inline_data
  assert.equal(part.mime_type, 'application/pdf')
  assert.equal(Buffer.from(part.data, 'base64').toString(), '%PDF-x')
  assert.equal(sent.generationConfig.temperature, 0)
})

test('ocrPdfPages: HTTP gagal, respons kosong, atau galat jaringan -> null', async () => {
  const mk = (fn: () => Promise<Response>) => fn as unknown as typeof fetch
  assert.equal(await ocrPdfPages(Buffer.from('%PDF'), { apiKey: 'k', fetchImpl: mk(async () => new Response('x', { status: 429 })) }), null)
  assert.equal(await ocrPdfPages(Buffer.from('%PDF'), { apiKey: 'k', fetchImpl: mk(async () => new Response(JSON.stringify({ candidates: [] }))) }), null)
  assert.equal(await ocrPdfPages(Buffer.from('%PDF'), { apiKey: 'k', fetchImpl: mk(async () => { throw new TypeError('fetch failed') }) }), null)
})
