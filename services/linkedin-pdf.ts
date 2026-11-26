import { existsSync } from 'node:fs'
import { Worker } from 'node:worker_threads'
import { extractText, extractTextItems, getDocumentProxy } from 'unpdf'

/**
 * Validasi dan ekstraksi teks PDF untuk impor profil dari PDF LinkedIn. Semuanya di memori: berkas tidak ditulis
 * ke disk, Storage, maupun database. Isi teks tidak pernah dicatat di log; hanya ukuran dan jumlah halaman.
 */

/** Batas ukuran sama dengan unggah CV (5 MB). */
export const PDF_MAX_BYTES = 5 * 1024 * 1024
/** PDF profil LinkedIn paling panjang yang masih wajar. Lebih dari ini ditolak sebelum diurai. */
export const PDF_MAX_PAGES = 25
/** Di bawah ini (tanpa spasi) PDF dianggap hasil pindai atau gambar: tidak ada teks yang bisa dibaca. */
export const PDF_MIN_TEXT_CHARS = 80
/**
 * PDF hibrida: halaman dengan huruf dan angka kurang dari ini dianggap tanpa lapisan teks (gambar atau kosong).
 * Hanya dipakai bila halaman lain di berkas yang sama punya teks; PDF yang seluruhnya tipis tetap lewat PDF_MIN_TEXT_CHARS.
 */
export const PDF_MIN_PAGE_CHARS = 20
export const OCR_NOT_CONFIGURED_MESSAGE =
  'PDF ini berupa gambar, tetapi layanan pembaca teks gambar (OCR) belum diaktifkan di server ini. Unduh ulang CV dari Canva sebagai PDF Standar tanpa opsi Ratakan PDF, atau isi profil secara manual.'
export const OCR_UNAVAILABLE_MESSAGE =
  'PDF ini berupa gambar, dan pembaca teks gambar (OCR) sedang tidak tersedia. Coba lagi beberapa menit lagi. Bila tetap gagal, unduh ulang CV dari Canva sebagai PDF Standar tanpa opsi Ratakan PDF.'
export const PDF_NO_TEXT_MESSAGE =
  'Teks di PDF ini tidak bisa dibaca karena isinya berupa gambar (hasil pindai, atau CV Canva yang diunduh dengan opsi Ratakan PDF). Unduh ulang dari Canva sebagai PDF Standar tanpa Ratakan PDF, atau dari LinkedIn: Lainnya, Simpan ke PDF.'
const PDF_PARSE_TIMEOUT_MS = 20_000

export type ImportErrorCode =
  | 'not_pdf'
  | 'empty_file'
  | 'file_too_large'
  | 'pdf_unreadable'
  | 'pdf_too_long'
  | 'pdf_no_text'
  | 'ocr_unavailable'
  | 'nothing_found'

/** Galat impor dengan status HTTP dan kode yang dibaca antarmuka. `message` siap tampil (Bahasa Indonesia). */
export class LinkedInImportError extends Error {
  constructor(
    readonly statusCode: 400 | 413 | 415 | 422 | 503,
    readonly code: ImportErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'LinkedInImportError'
  }
}

/** Berkas harus berupa PDF sungguhan: tidak kosong, di bawah batas ukuran, dan diawali penanda `%PDF`. */
export function assertPdfUpload(body: unknown): Buffer {
  if (!Buffer.isBuffer(body)) {
    throw new LinkedInImportError(400, 'not_pdf', 'Unggah berkas PDF (CV standar atau simpan dari LinkedIn).')
  }
  if (body.length === 0) {
    throw new LinkedInImportError(400, 'empty_file', 'Berkas kosong. Pilih berkas PDF yang valid.')
  }
  if (body.length > PDF_MAX_BYTES) {
    throw new LinkedInImportError(413, 'file_too_large', 'Ukuran PDF terlalu besar, maksimal 5 MB. Kompres PDF atau ekspor ulang dengan ukuran lebih kecil.')
  }
  if (body.subarray(0, 4).toString('latin1') !== '%PDF') {
    throw new LinkedInImportError(400, 'not_pdf', 'Berkas ini bukan PDF. Unggah berkas PDF yang valid.')
  }
  return body
}

/**
 * Deteksi teks sampah hasil CIDFont / tabel ToUnicode rusak (48.1 BS-U1-03):
 * panjang non-spasi bisa >= 80 karakter tetapi isinya didominasi karakter pengganti (\uFFFD), area privat Unicode,
 * atau simbol acak tanpa kata terbaca. Mengembalikan true agar layanan otomatis jatuh ke OCR.
 */
export function isGarbledPdfText(pages: readonly string[]): boolean {
  const joined = pages.join('\n')
  const nonWs = joined.replace(/\s+/g, '')
  if (nonWs.length < PDF_MIN_TEXT_CHARS) return false
  const badGlyphs = (nonWs.match(/[\uFFFD\uE000-\uF8FF\u0000-\u0008\u000B\u000C\u000E-\u001F]/g) ?? []).length
  if (badGlyphs / nonWs.length >= 0.15) return true
  const alnum = meaningfulChars(nonWs)
  if (alnum / nonWs.length < 0.35) return true
  const words = joined.match(/\p{L}{3,}/gu) ?? []
  if (nonWs.length >= 120 && words.length < 5) return true
  return false
}

/** Jumlah huruf dan angka (tanpa spasi dan tanda baca) dalam teks satu halaman. */
export function meaningfulChars(text: string): number {
  return (text.match(/[\p{L}\p{N}]/gu) ?? []).length
}

/**
 * Nomor halaman (mulai 1) yang lapisan teksnya kosong atau terlalu pendek, tetapi hanya untuk PDF hibrida: ada
 * halaman yang punya teks dan ada yang tidak. Bila semua halaman tipis atau semua halaman cukup, hasilnya
 * kosong (perilaku lama: OCR hanya lewat PDF_MIN_TEXT_CHARS untuk seluruh berkas).
 */
export function findSparsePages(pages: string[]): number[] {
  const sparse: number[] = []
  pages.forEach((p, i) => {
    if (meaningfulChars(p) < PDF_MIN_PAGE_CHARS) sparse.push(i + 1)
  })
  return sparse.length > 0 && sparse.length < pages.length ? sparse : []
}

export interface PdfTextItem {
  str: string
  x: number
  y: number
  width?: number
  height?: number
  hasEOL?: boolean
}

const LINE_Y_TOLERANCE = 3
const GUTTER_MIN_WIDTH = 18

function joinLineItems(items: readonly PdfTextItem[]): string {
  const sorted = [...items].sort((a, b) => a.x - b.x)
  let line = ''
  let prevEnd: number | null = null
  for (const item of sorted) {
    const text = String(item.str ?? '')
    if (!text) continue
    if (prevEnd !== null && item.x - prevEnd > 1.5 && !line.endsWith(' ') && !text.startsWith(' ')) {
      line += ' '
    }
    line += text
    const w = typeof item.width === 'number' && Number.isFinite(item.width) && item.width >= 0 ? item.width : text.length * 4
    prevEnd = item.x + w
  }
  return line.replace(/[ \t]+/g, ' ').trim()
}

function itemsToLines(items: readonly PdfTextItem[]): string[] {
  const valid = items.filter((it) => typeof it?.str === 'string' && it.str.trim().length > 0 && Number.isFinite(it.x) && Number.isFinite(it.y))
  if (valid.length === 0) return []
  const sorted = [...valid].sort((a, b) => (Math.abs(b.y - a.y) > LINE_Y_TOLERANCE ? b.y - a.y : a.x - b.x))
  const lines: PdfTextItem[][] = []
  for (const item of sorted) {
    const last = lines[lines.length - 1]
    if (!last || Math.abs(last[0].y - item.y) > LINE_Y_TOLERANCE) {
      lines.push([item])
    } else {
      last.push(item)
    }
  }
  return lines.map(joinLineItems).filter(Boolean)
}

/**
 * Rekonstruksi teks satu halaman dari koordinat (x, y) `extractTextItems` (audit 47.1 P2-3).
 * Jika halaman memiliki tata letak 2 kolom yang terpisah jelas (mis. CV Word/PPT dua kolom),
 * kolom kiri dibaca utuh dari atas ke bawah baru diikuti kolom kanan, alih-alih bercampur antar-kolom.
 */
export function reconstructPageTextFromItems(items: readonly PdfTextItem[]): string {
  const valid = items.filter((it) => typeof it?.str === 'string' && it.str.trim().length > 0 && Number.isFinite(it.x) && Number.isFinite(it.y))
  if (valid.length === 0) return ''

  let minX = Infinity
  let maxX = -Infinity
  for (const it of valid) {
    const w = typeof it.width === 'number' && Number.isFinite(it.width) && it.width > 0 ? it.width : 0
    if (it.x < minX) minX = it.x
    if (it.x + w > maxX) maxX = it.x + w
  }
  const span = maxX - minX
  if (span < 120 || valid.length < 6) {
    return itemsToLines(valid).join('\n')
  }

  // Cari celah vertikal (gutter) pada kandidat x di rentang tengah halaman (25%..75%).
  const itemWidth = (it: PdfTextItem) => (typeof it.width === 'number' && Number.isFinite(it.width) && it.width > 0 ? it.width : String(it.str).length * 4)
  const narrow = valid.filter((it) => itemWidth(it) < span * 0.55)
  const leftStarts = [...new Set(narrow.map((it) => it.x))].sort((a, b) => a - b)
  const lowBound = minX + span * 0.25
  const highBound = minX + span * 0.75

  let splitX: number | null = null
  let bestScore = -1
  for (const candX of leftStarts) {
    if (candX < lowBound || candX > highBound) continue
    const probeX = candX - 2
    // Cari bagian badan di mana kolom kiri dan kanan tidak melintasi probeX.
    const leftSide = valid.filter((it) => it.x + itemWidth(it) <= probeX)
    const rightSide = valid.filter((it) => it.x >= probeX)
    if (leftSide.length < 2 || rightSide.length < 2) continue
    const leftMaxY = Math.max(...leftSide.map((it) => it.y))
    const leftMinY = Math.min(...leftSide.map((it) => it.y))
    const rightMaxY = Math.max(...rightSide.map((it) => it.y))
    const rightMinY = Math.min(...rightSide.map((it) => it.y))
    const overlapTop = Math.min(leftMaxY, rightMaxY)
    const overlapBottom = Math.max(leftMinY, rightMinY)
    if (overlapTop <= overlapBottom) continue

    const body = valid.filter((it) => it.y <= overlapTop + LINE_Y_TOLERANCE)
    const crossing = body.filter((it) => it.x < probeX && it.x + itemWidth(it) > probeX + 4)
    if (crossing.length > Math.floor(body.length * 0.1)) continue

    const leftRows = itemsToLines(body.filter((it) => it.x < probeX)).length
    const rightRows = itemsToLines(body.filter((it) => it.x >= probeX)).length
    if (leftRows < 2 || rightRows < 2) continue

    const maxLeftEnd = Math.max(...body.filter((it) => it.x < probeX).map((it) => it.x + itemWidth(it)))
    const minRightStart = Math.min(...body.filter((it) => it.x >= probeX).map((it) => it.x))
    const gutter = minRightStart - maxLeftEnd
    if (gutter < GUTTER_MIN_WIDTH) continue

    const score = Math.min(leftRows, rightRows) * 100 + gutter
    if (score > bestScore) {
      bestScore = score
      splitX = (maxLeftEnd + minRightStart) / 2
    }
  }

  if (splitX === null) {
    return itemsToLines(valid).join('\n')
  }

  const colLeft = valid.filter((it) => it.x < splitX!)
  const colRight = valid.filter((it) => it.x >= splitX!)
  const bodyTop = Math.max(
    Math.min(Math.max(...colLeft.map((it) => it.y)), Math.max(...colRight.map((it) => it.y))) + LINE_Y_TOLERANCE,
    0
  )
  // Item lebar yang melintasi batas kolom dan berada di atas area 2 kolom tetap menjadi header atas.
  const headerItems = valid.filter((it) => it.y > bodyTop && it.x < splitX! && it.x + itemWidth(it) > splitX!)
  const headerSet = new Set(headerItems)
  const leftItems = valid.filter((it) => !headerSet.has(it) && it.x < splitX!)
  const rightItems = valid.filter((it) => !headerSet.has(it) && it.x >= splitX!)

  return [
    ...itemsToLines(headerItems),
    ...itemsToLines(leftItems),
    ...itemsToLines(rightItems),
  ].join('\n')
}

const SECTION_LIKE_RE = /^(?:summary|ringkasan|experience|pengalaman|education|pendidikan|skills|keahlian|projects|proyek|certifications|sertifikasi)$/i
const PAGE_COUNTER_RE = /^(?:page|halaman|hal\.?)\s*\d+(?:\s*(?:of|dari|\/)\s*\d+)?$/i

/**
 * Hapus header/footer berulang di dokumen >= 3 halaman (mis. nomor halaman atau nama dokumen yang muncul
 * identik di baris pertama/terakhir >= 60% halaman, audit 47.1 P2-3).
 */
export function stripRepeatedHeadersFooters(pages: readonly string[]): string[] {
  if (pages.length < 3) return [...pages]
  const threshold = Math.max(3, Math.ceil(pages.length * 0.6))
  const splitPages = pages.map((p) => p.split('\n'))
  const firstCounts = new Map<string, number>()
  const lastCounts = new Map<string, number>()

  const normEdge = (line: string): string => line.trim().replace(/\d+/g, '#').toLowerCase()

  for (const lines of splitPages) {
    const nonEmpty = lines.map((l) => l.trim()).filter(Boolean)
    if (nonEmpty.length === 0) continue
    const first = normEdge(nonEmpty[0])
    const last = normEdge(nonEmpty[nonEmpty.length - 1])
    if (first && !SECTION_LIKE_RE.test(nonEmpty[0])) firstCounts.set(first, (firstCounts.get(first) ?? 0) + 1)
    if (last && nonEmpty.length > 1 && !SECTION_LIKE_RE.test(nonEmpty[nonEmpty.length - 1])) {
      lastCounts.set(last, (lastCounts.get(last) ?? 0) + 1)
    }
  }

  return splitPages.map((lines) => {
    const trimmed = [...lines]
    while (trimmed.length > 0 && !trimmed[0].trim()) trimmed.shift()
    while (trimmed.length > 0 && !trimmed[trimmed.length - 1].trim()) trimmed.pop()
    if (trimmed.length > 1) {
      const firstRaw = trimmed[0].trim()
      if ((firstCounts.get(normEdge(firstRaw)) ?? 0) >= threshold || PAGE_COUNTER_RE.test(firstRaw)) {
        trimmed.shift()
      }
    }
    if (trimmed.length > 1) {
      const lastRaw = trimmed[trimmed.length - 1].trim()
      if ((lastCounts.get(normEdge(lastRaw)) ?? 0) >= threshold || PAGE_COUNTER_RE.test(lastRaw)) {
        trimmed.pop()
      }
    }
    return trimmed.join('\n')
  })
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('pdf_parse_timeout')), ms)
  })
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer))
}

function resolveWorkerScriptUrl(): URL | null {
  const direct = new URL('./pdf-parse-worker.mjs', import.meta.url)
  if (existsSync(direct)) return direct
  const fromDist = new URL('../../services/pdf-parse-worker.mjs', import.meta.url)
  if (existsSync(fromDist)) return fromDist
  return null
}

/**
 * Jalankan penguraian PDF di worker thread terpisah agar timeout benar-benar menghentikan pekerjaan CPU
 * lewat `worker.terminate()` (audit 47.1 P2-6).
 */
export async function parsePdfInWorker(
  buffer: Buffer,
  opts: { timeoutMs?: number; maxPages?: number; workerUrl?: URL } = {}
): Promise<string[]> {
  const scriptUrl = opts.workerUrl ?? resolveWorkerScriptUrl()
  if (!scriptUrl) {
    return withTimeout(readPages(buffer, opts.maxPages ?? PDF_MAX_PAGES), opts.timeoutMs ?? PDF_PARSE_TIMEOUT_MS)
  }

  const timeoutMs = opts.timeoutMs ?? PDF_PARSE_TIMEOUT_MS
  const maxPages = opts.maxPages ?? PDF_MAX_PAGES

  const raw = await new Promise<{ itemsPerPage?: PdfTextItem[][]; fallbackPages?: string[] }>((resolve, reject) => {
    const worker = new Worker(scriptUrl, {
      workerData: { buffer: new Uint8Array(buffer), maxPages },
    })
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      void worker.terminate().catch(() => {})
      reject(new Error('pdf_parse_timeout'))
    }, timeoutMs)

    worker.once('message', (msg: any) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (msg?.ok) {
        resolve({ itemsPerPage: msg.itemsPerPage, fallbackPages: msg.fallbackPages })
      } else if (msg?.errorCode === 'pdf_too_long') {
        reject(
          new LinkedInImportError(
            422,
            'pdf_too_long',
            `PDF terlalu panjang (${msg.numPages} halaman). Profil LinkedIn biasanya kurang dari ${maxPages} halaman.`
          )
        )
      } else {
        reject(Object.assign(new Error(msg?.errorName ?? 'pdf_worker_error'), { name: msg?.errorName ?? 'Error' }))
      }
    })
    worker.once('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(err)
    })
    worker.once('exit', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(new Error(`pdf_worker_exited_${code}`))
    })
  })

  const rawPages = Array.isArray(raw.itemsPerPage)
    ? raw.itemsPerPage.map((pageItems) => reconstructPageTextFromItems(pageItems))
    : (raw.fallbackPages ?? [])
  return finalizePages(rawPages)
}

function finalizePages(rawPages: readonly string[]): string[] {
  const pages = stripRepeatedHeadersFooters(rawPages)
  const chars = pages.join('').replace(/\s+/g, '').length
  if (chars < PDF_MIN_TEXT_CHARS || isGarbledPdfText(pages)) {
    throw new LinkedInImportError(422, 'pdf_no_text', PDF_NO_TEXT_MESSAGE)
  }
  return pages
}

/** Teks per halaman. Galat pustaka (PDF rusak, berkata sandi, terlalu panjang) menjadi LinkedInImportError 422. */
export async function extractPdfPages(buffer: Buffer): Promise<string[]> {
  try {
    return await parsePdfInWorker(buffer, { timeoutMs: PDF_PARSE_TIMEOUT_MS, maxPages: PDF_MAX_PAGES })
  } catch (e) {
    if (e instanceof LinkedInImportError) throw e
    // Pesan pustaka bisa memuat potongan isi berkas; hanya nama galatnya yang dicatat.
    console.warn(`[linkedin-import] PDF tidak terbaca (${(e as Error)?.name ?? 'Error'})`)
    throw new LinkedInImportError(422, 'pdf_unreadable', 'PDF tidak bisa dibaca. PDF yang rusak atau dikunci kata sandi tidak didukung.')
  }
}

async function readPages(buffer: Buffer, maxPages = PDF_MAX_PAGES): Promise<string[]> {
  // Salinan, karena pdf.js boleh melepas buffer yang diberikan.
  const pdf = await getDocumentProxy(new Uint8Array(buffer))
  try {
    if (pdf.numPages > maxPages) {
      throw new LinkedInImportError(422, 'pdf_too_long', `PDF terlalu panjang (${pdf.numPages} halaman). Profil LinkedIn biasanya kurang dari ${maxPages} halaman.`)
    }
    let pages: string[] | null = null
    try {
      const itemsRes = await extractTextItems(pdf as any)
      if (Array.isArray(itemsRes?.items) && itemsRes.items.length > 0) {
        pages = itemsRes.items.map((pageItems) => reconstructPageTextFromItems(pageItems))
      }
    } catch {
      pages = null
    }
    if (!pages) {
      const { text } = await extractText(pdf, { mergePages: false })
      pages = Array.isArray(text) ? text : [String(text ?? '')]
    }
    return finalizePages(pages)
  } finally {
    try {
      await (pdf as unknown as { destroy?: () => Promise<void> }).destroy?.()
    } catch {
      // membersihkan memori saja; kegagalannya tidak mengubah hasil
    }
  }
}
