import { aiPipelineService } from './ai-pipeline.service.js'
import { LinkedInImportError, assertPdfUpload, extractPdfPages } from './linkedin-pdf.js'
import {
  assemblePreview,
  buildModelPrompt,
  cleanPdfText,
  isEmptyExtraction,
  normalizeExtraction,
  parseWithRules,
  type ImportPreview,
  type NormalizedExtraction,
} from './linkedin-import.js'

/**
 * Impor profil dari PDF LinkedIn: PDF (di memori) -> teks -> model AI (JSON ketat) atau parser aturan -> pratinjau.
 *
 * - Hanya membaca. Tidak ada tulisan ke database, Storage, atau disk; penyimpanan terjadi di frontend setelah
 *   pengguna mengonfirmasi pratinjau, lewat CRUD profil yang sudah ada.
 * - Model AI dicoba lebih dulu lewat rantai yang sama dengan fitur lain (aiPipelineService.completeJson). Jawabannya
 *   tetap diperiksa kode (normalizeExtraction): fakta yang tidak ada di teks PDF dibuang. Bila model gagal, habis
 *   waktu, atau semua isinya terbuang, parser aturan (parseWithRules) dipakai dan pratinjau diberi peringatan.
 * - Kuota draf AI TIDAK terpakai. Batas lajunya ada di AiGuardService.checkImportRate (dipanggil oleh rute).
 * - Isi PDF dan data pribadi tidak dicatat di log; hanya jumlah halaman, karakter, dan item.
 */

export type JsonLlm = (params: { system: string; user: string; userId?: string }) => Promise<{ text: string; model: string | null }>

/** Batas menunggu seluruh rantai model. Rantai penuh bisa memakan beberapa menit; lewat ini parser aturan dipakai. */
export const AI_STEP_TIMEOUT_MS = 75_000

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error('ai_timeout'), { name: 'AiTimeout' })), ms)
  })
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer))
}

export interface LinkedInImportDeps {
  /** Hanya tes yang mengisi ini. Bawaan: aiPipelineService.completeJson (dibaca saat dipanggil). */
  llm?: JsonLlm
  extractPages?: (buffer: Buffer) => Promise<string[]>
  now?: () => Date
  aiTimeoutMs?: number
}

const sumDropped = (n: NormalizedExtraction) => n.dropped.experiences + n.dropped.education + n.dropped.certifications + n.dropped.skills

export class LinkedInImportService {
  constructor(private readonly deps: LinkedInImportDeps = {}) {}

  async importFromPdf(body: unknown, ctx: { userId?: string } = {}): Promise<ImportPreview> {
    const buffer = assertPdfUpload(body)
    const pages = await (this.deps.extractPages ?? extractPdfPages)(buffer)
    const text = cleanPdfText(pages)
    const now = (this.deps.now ?? (() => new Date()))()
    const warnings: string[] = []

    const prompt = buildModelPrompt(text)
    if (prompt.truncated) warnings.push('PDF sangat panjang, AI hanya membaca bagian awalnya.')

    let result: NormalizedExtraction | null = null
    let method: 'ai' | 'rules' = 'rules'
    let model: string | null = null
    let aiFailed = false

    try {
      const llm: JsonLlm = this.deps.llm ?? ((p) => aiPipelineService.completeJson(p))
      const out = await withTimeout(llm({ system: prompt.system, user: prompt.user, userId: ctx.userId }), this.deps.aiTimeoutMs ?? AI_STEP_TIMEOUT_MS)
      const normalized = normalizeExtraction(JSON.parse(out.text), { sourceText: text, now })
      if (!isEmptyExtraction(normalized)) {
        result = normalized
        method = 'ai'
        model = out.model ?? null
      }
    } catch (e) {
      aiFailed = true
      // Pesan galat bisa memuat potongan isi permintaan; hanya nama galatnya yang dicatat.
      console.warn(`[linkedin-import] AI gagal (${(e as Error)?.name ?? 'Error'}), memakai parser aturan`)
    }

    if (!result) {
      const normalized = normalizeExtraction(parseWithRules(text), { sourceText: text, now })
      if (!isEmptyExtraction(normalized)) {
        result = normalized
        warnings.push(
          aiFailed
            ? 'AI sedang tidak tersedia, jadi PDF dibaca dengan aturan sederhana. Periksa hasilnya dengan teliti.'
            : 'AI tidak menemukan data yang bisa dipakai, jadi PDF dibaca dengan aturan sederhana. Periksa hasilnya dengan teliti.',
        )
      }
    }
    if (!result) {
      throw new LinkedInImportError(
        422,
        'nothing_found',
        'Tidak ada data profil yang bisa dibaca dari PDF ini. Pastikan PDF diunduh dari LinkedIn (Lainnya, Simpan ke PDF) dan bukan hasil pindai.',
      )
    }

    const dropped = sumDropped(result)
    if (dropped > 0) warnings.push(`${dropped} item tidak dimasukkan karena datanya tidak lengkap atau tidak cocok dengan isi PDF. Tambahkan manual bila perlu.`)

    const preview = assemblePreview(result, text, { method, model, pages: pages.length, truncated: prompt.truncated }, warnings)
    console.log(
      `[linkedin-import] selesai metode=${method} halaman=${pages.length} karakter=${text.length} ` +
        `pengalaman=${preview.experiences.length} pendidikan=${preview.education.length} sertifikat=${preview.certifications.length} skill=${preview.skills.length} dibuang=${dropped}`,
    )
    return preview
  }
}

export const linkedInImportService = new LinkedInImportService()
