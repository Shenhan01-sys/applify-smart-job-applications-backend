import { test } from 'node:test'
import assert from 'node:assert/strict'
import { NOW } from './helpers/linkedinFixture.ts'
import { ocrPdfSelectedPages } from '../services/pdf-ocr.ts'
import { findSparsePages } from '../services/linkedin-pdf.ts'
import { LinkedInImportService } from '../services/linkedin-import.service.ts'

/**
 * PDF hibrida: sebagian halaman punya lapisan teks, sebagian berupa gambar. OCR hanya untuk halaman tanpa teks,
 * bukan semua-atau-tidak-sama-sekali. Teks SINTETIS, tanpa jaringan: fetch, OCR, dan model AI dipalsukan.
 */

const HEAD_PAGE = ['Dewi Lestari Sintetis', 'Analis Data', 'dewi.sintetis@contoh.test', 'Bandung, Indonesia', 'Ringkasan: analis data dengan minat pada pelaporan.'].join('\n')
const BODY_PAGE = ['PENGALAMAN KERJA', 'Studio Fiktif Cahaya', 'Analis Data', 'Januari 2022 - Sekarang', 'RIWAYAT PENDIDIKAN', 'Universitas Fiktif Nusantara', 'S1 Sistem Informasi', '2018 s/d 2022'].join('\n')
const TAIL_PAGE = 'KEAHLIAN: Python, SQL, pelaporan dan visualisasi data'

type OcrSelected = (b: Buffer, pageNumbers: number[]) => Promise<Map<number, string> | null>
interface Seen {
  user?: string
  log?: any
}

function hybridService(pages: string[], ocrSelectedPages?: OcrSelected, seen: Seen = {}) {
  return new LinkedInImportService({
    now: () => NOW,
    log: (line) => {
      seen.log = JSON.parse(line.slice(line.indexOf('{')))
    },
    extractPages: async () => pages,
    ocrPages: async () => {
      throw new Error('OCR seluruh berkas tidak boleh dipanggil untuk PDF hibrida')
    },
    ocrSelectedPages,
    llm: async (p) => {
      seen.user = p.user
      return {
        text: JSON.stringify({
          full_name: 'Dewi Lestari Sintetis',
          experiences: [{ company: 'Studio Fiktif Cahaya', title: 'Analis Data', date_range: 'Januari 2022 - Sekarang' }],
          education: [{ school: 'Universitas Fiktif Nusantara', degree: 'S1', field: 'Sistem Informasi', years: '2018 s/d 2022' }],
          skills: ['Python'],
        }),
        model: 'tiruan',
      }
    },
  })
}

const entries = (m: Map<number, string> | null) => (m ? [...m] : null)

test('findSparsePages: hanya PDF hibrida (ada halaman bertulisan dan ada yang kosong atau pendek) yang menghasilkan daftar', () => {
  assert.deepEqual(findSparsePages([HEAD_PAGE, '', TAIL_PAGE]), [2])
  assert.deepEqual(findSparsePages([HEAD_PAGE, '  \n 3 ', '', TAIL_PAGE]), [2, 3]) // nomor halaman saja = tanpa lapisan teks
  assert.deepEqual(findSparsePages([HEAD_PAGE, BODY_PAGE]), [])
  assert.deepEqual(findSparsePages(['', '']), []) // semua kosong: urusan PDF_MIN_TEXT_CHARS, bukan hibrida
  assert.deepEqual(findSparsePages(['abc', 'def']), []) // semua tipis: perilaku lama
  assert.deepEqual(findSparsePages([]), [])
})

test('hibrida: hanya halaman tanpa teks yang di-OCR, hasilnya disisipkan pada urutan halaman dan diberi peringatan', async () => {
  const seen: Seen = {}
  let asked: number[] = []
  const preview = await hybridService(
    [HEAD_PAGE, '', TAIL_PAGE],
    async (_b, n) => {
      asked = n
      return new Map([[2, BODY_PAGE]])
    },
    seen,
  ).importFromPdf(Buffer.from('%PDF-tiruan'), { userId: 'u1' })
  assert.deepEqual(asked, [2])
  // teks halaman 1 dan 3 (lapisan teks) dan halaman 2 (OCR) sama-sama sampai ke model, berurutan
  const u = seen.user ?? ''
  assert.ok(u.indexOf('Ringkasan: analis data') >= 0 && u.indexOf('Ringkasan: analis data') < u.indexOf('Studio Fiktif Cahaya'))
  assert.ok(u.indexOf('Studio Fiktif Cahaya') < u.indexOf('KEAHLIAN: Python'))
  // pengalaman hanya ada di halaman OCR; lolos pemeriksaan teks sumber karena teks OCR ikut menjadi sumber
  assert.equal(preview.experiences.length, 1)
  assert.equal(preview.education[0]?.institution, 'Universitas Fiktif Nusantara')
  assert.ok(preview.warnings.some((w) => /Halaman 2 PDF berupa gambar.*OCR/.test(w)), preview.warnings.join(' | '))
  assert.deepEqual([seen.log.sparsePages, seen.log.ocrPages], [[2], [2]])
})

test('hibrida: OCR tidak tersedia -> teks yang ada dipakai apa adanya, peringatan menyebut halaman tanpa teks', async () => {
  const seen: Seen = {}
  const preview = await hybridService([HEAD_PAGE, BODY_PAGE, '', '4', TAIL_PAGE], async () => null, seen).importFromPdf(Buffer.from('%PDF-tiruan'), { userId: 'u1' })
  assert.equal(preview.experiences.length, 1) // dari halaman 2 yang punya lapisan teks
  assert.ok(preview.warnings.some((w) => /Halaman 3 dan 4 PDF tidak punya teks.*OCR sedang tidak tersedia/.test(w)), preview.warnings.join(' | '))
  assert.ok(!preview.warnings.some((w) => /dibaca dengan OCR/.test(w)))
  assert.deepEqual([seen.log.sparsePages, seen.log.ocrPages], [[3, 4], []])
})

test('hibrida: OCR hanya menemukan sebagian halaman -> halaman yang tetap kosong dilaporkan', async () => {
  const preview = await hybridService([HEAD_PAGE, '', '', ''], async () => new Map([[2, BODY_PAGE], [4, '']])).importFromPdf(Buffer.from('%PDF-tiruan'), { userId: 'u1' })
  assert.ok(preview.warnings.some((w) => /Halaman 2 PDF berupa gambar/.test(w)), preview.warnings.join(' | '))
  assert.ok(preview.warnings.some((w) => /Halaman 3 dan 4 PDF tidak punya teks.*bahkan setelah OCR/.test(w)), preview.warnings.join(' | '))
})

test('hibrida: hasil OCR yang tidak lebih panjang dari lapisan teks tidak menggantikannya', async () => {
  const seen: Seen = {}
  const preview = await hybridService([HEAD_PAGE, 'Hal 2 dari tiga', TAIL_PAGE], async () => new Map([[2, 'x']]), seen).importFromPdf(Buffer.from('%PDF-tiruan'), {})
  assert.ok((seen.user ?? '').includes('Hal 2 dari tiga'))
  assert.ok(preview.warnings.some((w) => /Halaman 2 PDF tidak punya teks.*bahkan setelah OCR/.test(w)), preview.warnings.join(' | '))
})

test('hibrida: PDF yang semua halamannya punya teks tidak memanggil OCR halaman', async () => {
  let calls = 0
  await hybridService([HEAD_PAGE, BODY_PAGE, TAIL_PAGE], async () => {
    calls++
    return new Map<number, string>()
  }).importFromPdf(Buffer.from('%PDF-tiruan'), {})
  assert.equal(calls, 0)
})

test('hibrida: OCR halaman yang melempar tidak menggagalkan impor, diperlakukan sebagai OCR tidak tersedia', async () => {
  const preview = await hybridService([HEAD_PAGE, '', TAIL_PAGE], async () => {
    throw new Error('jaringan putus')
  }).importFromPdf(Buffer.from('%PDF-tiruan'), {})
  assert.ok(preview.warnings.some((w) => /Halaman 2 PDF tidak punya teks.*tidak tersedia/.test(w)), preview.warnings.join(' | '))
})

const gemini = (text: string) => (async () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }), { status: 200 })) as unknown as typeof fetch

test('ocrPdfSelectedPages: prompt menyebut halaman yang diminta; hasil dipasangkan lewat penanda ---PAGE n---', async () => {
  let sent: any = null
  const fetchImpl = (async (_u: string, init: any) => {
    sent = JSON.parse(init.body)
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: '---PAGE 2---\nIsi dua\nbaris dua\n---PAGE 5---\nIsi lima\n---PAGE 9---\nBukan diminta' }] } }] }), { status: 200 })
  }) as unknown as typeof fetch
  const r = await ocrPdfSelectedPages(Buffer.from('%PDF-x'), [5, 2, 2], { apiKey: 'k', fetchImpl })
  assert.deepEqual(entries(r), [[2, 'Isi dua\nbaris dua'], [5, 'Isi lima']])
  const prompt: string = sent.contents[0].parts[1].text
  assert.match(prompt, /ONLY page\(s\) 2, 5 of this PDF/)
  assert.equal(sent.contents[0].parts[0].inline_data.mime_type, 'application/pdf')
})

test('ocrPdfSelectedPages: halaman tanpa isi tidak ada di peta; tanpa penanda dipasangkan hanya bila urutannya pasti', async () => {
  const k = { apiKey: 'k' }
  assert.deepEqual(entries(await ocrPdfSelectedPages(Buffer.from('%PDF'), [2, 3], { ...k, fetchImpl: gemini('---PAGE 2---\nIsi dua\n---PAGE 3---') })), [[2, 'Isi dua']])
  assert.deepEqual(entries(await ocrPdfSelectedPages(Buffer.from('%PDF'), [4], { ...k, fetchImpl: gemini('Teks tanpa penanda') })), [[4, 'Teks tanpa penanda']])
  assert.deepEqual(entries(await ocrPdfSelectedPages(Buffer.from('%PDF'), [2, 3], { ...k, fetchImpl: gemini('A\n---PAGE---\nB') })), [[2, 'A'], [3, 'B']])
  assert.deepEqual(entries(await ocrPdfSelectedPages(Buffer.from('%PDF'), [2, 3], { ...k, fetchImpl: gemini('Satu blok tanpa penanda') })), [])
  assert.deepEqual(entries(await ocrPdfSelectedPages(Buffer.from('%PDF'), [2], { ...k, fetchImpl: gemini('') })), [])
})

test('ocrPdfSelectedPages: tanpa kunci, HTTP gagal, atau galat jaringan -> null; daftar halaman kosong tidak memanggil jaringan', async () => {
  let called = 0
  const spy = (async () => {
    called++
    return new Response('{}')
  }) as unknown as typeof fetch
  assert.equal(await ocrPdfSelectedPages(Buffer.from('%PDF'), [2], { apiKey: '', fetchImpl: spy }), null)
  assert.equal((await ocrPdfSelectedPages(Buffer.from('%PDF'), [], { apiKey: 'k', fetchImpl: spy }))?.size, 0)
  assert.equal(called, 0)
  assert.equal(await ocrPdfSelectedPages(Buffer.from('%PDF'), [2], { apiKey: 'k', fetchImpl: (async () => new Response('x', { status: 500 })) as unknown as typeof fetch }), null)
  assert.equal(
    await ocrPdfSelectedPages(Buffer.from('%PDF'), [2], {
      apiKey: 'k',
      fetchImpl: (async () => {
        throw new TypeError('fetch failed')
      }) as unknown as typeof fetch,
    }),
    null,
  )
})
