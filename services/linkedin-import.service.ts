import { aiPipelineService } from './ai-pipeline.service.js'
import { LinkedInImportError, assertPdfUpload, extractPdfPages } from './linkedin-pdf.js'
import {
  assemblePreview,
  buildModelPrompt,
  cleanPdfText,
  emptyMainSections,
  fillAchievementGaps,
  hasCvSkillsSection,
  isEmptyExtraction,
  LIMITS,
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
 * - Waktu tunggu AI dibatasi satu anggaran total (AI_BUDGET_MS, bawaan 40 detik) yang diteruskan ke rantai sebagai
 *   deadline: rantai berhenti memulai panggilan baru dan memendekkan batas tiap panggilan ke sisa waktu. Pagar
 *   Promise.race (AI_STEP_TIMEOUT_MS) hanya jaga-jaga bila satu panggilan menggantung di luar batas axios.
 * - Kuota draf AI TIDAK terpakai. Batas lajunya ada di AiGuardService.checkImportRate (dipanggil oleh rute).
 * - Isi PDF dan data pribadi tidak dicatat di log; hanya jumlah halaman, karakter, dan item.
 */

export type JsonLlm = (params: { system: string; user: string; userId?: string; deadlineAt?: number }) => Promise<{ text: string; model: string | null }>

/**
 * Anggaran waktu total untuk AI. Rantai penuh (Gemini, Claude, sampai sembilan model OpenRouter, lalu Groq) bisa
 * memakan beberapa menit; lewat anggaran ini parser aturan dipakai. UAT 2026-11-20: batas lama 75 detik membuat
 * pengguna menunggu 90 sampai 110 detik sebelum pratinjau cadangan muncul. Bisa diubah lewat LINKEDIN_IMPORT_AI_BUDGET_MS.
 */
export const AI_BUDGET_MS = Number(process.env.LINKEDIN_IMPORT_AI_BUDGET_MS) > 0 ? Number(process.env.LINKEDIN_IMPORT_AI_BUDGET_MS) : 40_000
/** Pagar keras di atas anggaran, untuk panggilan yang menggantung di luar batas waktu axios (mis. DNS). */
export const AI_HARD_GRACE_MS = 3_000
export const AI_STEP_TIMEOUT_MS = AI_BUDGET_MS + AI_HARD_GRACE_MS

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
  /** Pagar keras Promise.race (ms). Bawaan: anggaran + AI_HARD_GRACE_MS. */
  aiTimeoutMs?: number
  /** Anggaran waktu AI (ms) yang diteruskan ke rantai model sebagai deadline. Bawaan: AI_BUDGET_MS. */
  aiBudgetMs?: number
  /** Penulis log selesai (satu baris). Bawaan: console.log. Hanya tes yang mengisi ini. */
  log?: (line: string) => void
  /** Jam monotonik untuk durasi (ms). Hanya tes yang mengisi ini. */
  clock?: () => number
}

const sumDropped = (n: NormalizedExtraction) => n.dropped.experiences + n.dropped.education + n.dropped.certifications + n.dropped.achievements + n.dropped.skills

export class LinkedInImportService {
  constructor(private readonly deps: LinkedInImportDeps = {}) {}

  async importFromPdf(body: unknown, ctx: { userId?: string } = {}): Promise<ImportPreview> {
    const clock = this.deps.clock ?? Date.now
    const startedAt = clock()
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
    let aiError: string | null = null
    const aiStartedAt = clock()

    try {
      const llm: JsonLlm = this.deps.llm ?? ((p) => aiPipelineService.completeJson(p))
      const budgetMs = this.deps.aiBudgetMs ?? AI_BUDGET_MS
      const out = await withTimeout(
        llm({ system: prompt.system, user: prompt.user, userId: ctx.userId, deadlineAt: Date.now() + budgetMs }),
        this.deps.aiTimeoutMs ?? budgetMs + AI_HARD_GRACE_MS,
      )
      const normalized = normalizeExtraction(JSON.parse(out.text), { sourceText: text, now })
      if (!isEmptyExtraction(normalized)) {
        result = normalized
        method = 'ai'
        model = out.model ?? null
      }
    } catch (e) {
      aiFailed = true
      // Pesan galat bisa memuat potongan isi permintaan; hanya nama galatnya yang dicatat.
      aiError = (e as Error)?.name ?? 'Error'
      console.warn(`[linkedin-import] AI gagal (${aiError}), memakai parser aturan`)
    }
    const aiMs = clock() - aiStartedAt

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
      this.log({ event: 'import_failed', code: 'nothing_found', method: null, model: null, aiFailed, aiError, pages: pages.length, chars: text.length, durationMs: clock() - startedAt, aiMs })
      throw new LinkedInImportError(
        422,
        'nothing_found',
        'Tidak ada data profil yang bisa dibaca dari PDF ini. Pastikan PDF diunduh dari LinkedIn (Lainnya, Simpan ke PDF) dan bukan hasil pindai.',
      )
    }

    // AI sering melewatkan Pendidikan pada CV biasa (bukan ekspor LinkedIn). Bila seksinya ada di PDF tetapi AI
    // tidak menghasilkan satu entri pun, bagian itu dibaca ulang dengan parser aturan. Hasil AI lain tidak disentuh.
    if (method === 'ai' && result.education.length === 0 && emptyMainSections(text, { experience: 1, education: 0 }).includes('Pendidikan')) {
      const fromRules = normalizeExtraction(parseWithRules(text), { sourceText: text, now })
      if (fromRules.education.length > 0) {
        result = { ...result, education: fromRules.education, dropped: { ...result.dropped, education: result.dropped.education + fromRules.dropped.education } }
        warnings.push('AI tidak menemukan riwayat pendidikan, jadi bagian Pendidikan dibaca dengan aturan sederhana. Periksa hasilnya dengan teliti.')
      }
    }

    // Hal yang sama untuk skill: CV biasa punya seksi Skills/Keahlian, tetapi AI kadang hanya mengisi pengalaman.
    if (method === 'ai' && !result.skills.some((k) => k.category === 'technical') && hasCvSkillsSection(text)) {
      const fromRules = normalizeExtraction(parseWithRules(text), { sourceText: text, now }).skills.filter((k) => k.category === 'technical')
      if (fromRules.length > 0) {
        const languages = result.skills.filter((k) => k.category !== 'technical')
        result = { ...result, skills: [...fromRules, ...languages].slice(0, LIMITS.maxSkills) }
        warnings.push('AI tidak menemukan skill, jadi bagian Skill dibaca dengan aturan sederhana. Periksa hasilnya dengan teliti.')
      }
    }

    // AI sering menjawab null untuk keterangan di bawah judul penghargaan atau publikasi. Bidang yang kosong dilengkapi dari
    // parser aturan untuk judul yang sama; yang sudah diisi AI tidak disentuh.
    if (method === 'ai' && result.achievements.some((a) => !a.description || !a.url || !a.issuer || !a.achievement_date)) {
      const fromRules = normalizeExtraction(parseWithRules(text), { sourceText: text, now }).achievements
      const gaps = fillAchievementGaps(result.achievements, fromRules)
      if (gaps.filled > 0) result = { ...result, achievements: gaps.items }
    }

    // Bagian yang ada di PDF tetapi tidak menghasilkan satu item pun: beri tahu, supaya kosongnya tidak dikira data kosong.
    const missing = emptyMainSections(text, { experience: result.experiences.length, education: result.education.length })
    if (missing.length > 0) {
      warnings.push(`Bagian ${missing.join(' dan ')} ada di PDF tetapi isinya tidak berhasil dibaca. Tambahkan manual bila perlu.`)
    }

    const dropped = sumDropped(result)
    if (dropped > 0) warnings.push(`${dropped} item tidak dimasukkan karena datanya tidak lengkap atau tidak cocok dengan isi PDF. Tambahkan manual bila perlu.`)

    const preview = assemblePreview(result, text, { method, model, pages: pages.length, truncated: prompt.truncated }, warnings)
    this.log({
      event: 'import_done',
      method,
      model,
      aiFailed,
      aiError,
      durationMs: clock() - startedAt,
      aiMs,
      pages: pages.length,
      chars: text.length,
      counts: {
        experiences: preview.experiences.length,
        education: preview.education.length,
        certifications: preview.certifications.length,
        awards: preview.achievements.filter((a) => a.category === 'award').length,
        publications: preview.achievements.filter((a) => a.category === 'publication').length,
        skills: preview.skills.filter((k) => k.category !== 'language').length,
        languages: preview.skills.filter((k) => k.category === 'language').length,
      },
      dropped: preview.meta.dropped,
      emptySections: missing,
    })
    return preview
  }

  /**
   * Satu baris JSON dengan awalan tetap, supaya mudah dicari (grep '[linkedin-import] {') dan dicatat di log uji.
   * Hanya metode, nama model, durasi, dan hitungan; tidak ada isi PDF atau data pribadi.
   */
  private log(entry: Record<string, unknown>): void {
    const line = `[linkedin-import] ${JSON.stringify(entry)}`
    if (this.deps.log) this.deps.log(line)
    else console.log(line)
  }
}

export const linkedInImportService = new LinkedInImportService()
