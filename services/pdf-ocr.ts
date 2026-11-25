/**
 * OCR untuk PDF tanpa lapisan teks (25 November 2026). Contoh nyata: CV Canva yang diunduh dengan opsi "Ratakan PDF"
 * berisi satu gambar 300 dpi per halaman, tanpa font dan tanpa operator teks, sehingga pembaca teks PDF hanya
 * mendapat 0 karakter. Peramban berbasis Chrome tetap bisa menyeleksi teksnya karena menjalankan OCR sendiri.
 *
 * PDF dikirim ke Gemini (API native, input `application/pdf`) dengan perintah menyalin teks apa adanya. Hasilnya
 * hanya dipakai sebagai teks sumber untuk pratinjau impor; pengguna tetap memeriksa sebelum menyimpan. Isi CV memang
 * sudah dikirim ke penyedia model bahasa pada impor biasa, jadi OCR tidak menambah penerima data baru.
 */
export const OCR_TIMEOUT_MS = 45_000
export const DEFAULT_OCR_MODEL = 'gemini-3.5-flash-lite'
const GEMINI_NATIVE_URL = 'https://generativelanguage.googleapis.com/v1beta/models'

const OCR_PROMPT = [
  'Transcribe ALL text in this PDF exactly as written, in natural reading order (top to bottom; for multi-column',
  'layouts, finish one column before the next). Keep the original language, spelling, dates, numbers, emails and URLs.',
  'Put each line or bullet on its own line and separate pages with a line containing only "---PAGE---".',
  'Do not summarize, translate, correct, reorder sections, or add anything that is not visible in the document.',
  'If there is no readable text, reply with an empty response.',
].join(' ')

export interface OcrOptions {
  apiKey?: string | null
  model?: string
  timeoutMs?: number
  fetchImpl?: typeof fetch
}

/**
 * Teks per halaman hasil OCR. null = OCR tidak tersedia atau gagal (tanpa kunci, HTTP gagal, timeout, galat jaringan);
 * [] = OCR berjalan tetapi tidak menemukan teks. Tidak pernah melempar.
 */
export async function ocrPdfPages(buffer: Buffer, opts: OcrOptions = {}): Promise<string[] | null> {
  const apiKey = opts.apiKey === undefined ? process.env.GEMINI_API_KEY : opts.apiKey
  if (!apiKey) {
    console.warn('[pdf-ocr] GEMINI_API_KEY tidak ada; OCR dilewati')
    return null
  }
  const model = opts.model ?? (process.env.GEMINI_OCR_MODEL || DEFAULT_OCR_MODEL)
  const fetchImpl = opts.fetchImpl ?? fetch
  try {
    const resp = await fetchImpl(`${GEMINI_NATIVE_URL}/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ inline_data: { mime_type: 'application/pdf', data: buffer.toString('base64') } }, { text: OCR_PROMPT }] }],
        generationConfig: { temperature: 0, maxOutputTokens: 8192 },
      }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? OCR_TIMEOUT_MS),
    })
    if (!resp.ok) {
      console.warn(`[pdf-ocr] Gemini HTTP ${resp.status}`)
      return null
    }
    const data = (await resp.json()) as any
    const parts: any[] = data?.candidates?.[0]?.content?.parts ?? []
    const text = parts.map((p) => (typeof p?.text === 'string' ? p.text : '')).join('').trim()
    if (!text) return []
    return text.split(/^\s*---PAGE---\s*$/m).map((p) => p.trim()).filter(Boolean)
  } catch (e) {
    // Nama galat saja; pesan bisa memuat potongan isi.
    console.warn(`[pdf-ocr] gagal (${(e as Error)?.name ?? 'Error'})`)
    return null
  }
}
