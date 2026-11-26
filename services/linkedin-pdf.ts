import { extractText, getDocumentProxy } from 'unpdf'

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

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('pdf_parse_timeout')), ms)
  })
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer))
}

/** Teks per halaman. Galat pustaka (PDF rusak, berkata sandi, terlalu panjang) menjadi LinkedInImportError 422. */
export async function extractPdfPages(buffer: Buffer): Promise<string[]> {
  try {
    return await withTimeout(readPages(buffer), PDF_PARSE_TIMEOUT_MS)
  } catch (e) {
    if (e instanceof LinkedInImportError) throw e
    // Pesan pustaka bisa memuat potongan isi berkas; hanya nama galatnya yang dicatat.
    console.warn(`[linkedin-import] PDF tidak terbaca (${(e as Error)?.name ?? 'Error'})`)
    throw new LinkedInImportError(422, 'pdf_unreadable', 'PDF tidak bisa dibaca. PDF yang rusak atau dikunci kata sandi tidak didukung.')
  }
}

async function readPages(buffer: Buffer): Promise<string[]> {
  // Salinan, karena pdf.js boleh melepas buffer yang diberikan.
  const pdf = await getDocumentProxy(new Uint8Array(buffer))
  try {
    if (pdf.numPages > PDF_MAX_PAGES) {
      throw new LinkedInImportError(422, 'pdf_too_long', `PDF terlalu panjang (${pdf.numPages} halaman). Profil LinkedIn biasanya kurang dari ${PDF_MAX_PAGES} halaman.`)
    }
    const { text } = await extractText(pdf, { mergePages: false })
    const pages = Array.isArray(text) ? text : [String(text ?? '')]
    const chars = pages.join('').replace(/\s+/g, '').length
    if (chars < PDF_MIN_TEXT_CHARS || isGarbledPdfText(pages)) {
      throw new LinkedInImportError(422, 'pdf_no_text', PDF_NO_TEXT_MESSAGE)
    }
    return pages
  } finally {
    try {
      await (pdf as unknown as { destroy?: () => Promise<void> }).destroy?.()
    } catch {
      // membersihkan memori saja; kegagalannya tidak mengubah hasil
    }
  }
}
