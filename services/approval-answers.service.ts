import { formAutofillService, type FillResult, type FormContext, type FormField } from './form-autofill.service.js'
import { buildAchievementLines } from './profile-context.js'
import { deriveExperienceYears } from './experience-years.js'

/**
 * Jawaban formulir standar yang disiapkan agen untuk satu lamaran, lengkap dengan skor keyakinan, supaya
 * layar persetujuan bisa menandai yang perlu dicek pengguna. Nilainya berasal dari
 * FormAutofillService.fillField, jalur pengisian yang sama dengan POST /api/ai/fill-form:
 *   - source 'rule'    : dicocokkan dengan aturan tetap dari Pengaturan Otomasi (keyakinan 0,7 sampai 0,99)
 *   - source 'ai'      : ditulis AI (keyakinan 0,75), selalu ditandai untuk dicek
 *   - source 'default' : tidak ada data atau AI gagal (keyakinan 0,3), wajib dicek
 *
 * Ini daftar pertanyaan standar, bukan isi formulir portal yang sebenarnya: formulir hanya terbaca saat
 * worker membukanya, setelah persetujuan. Pengisian nyata tetap dilakukan worker (worker/src/lib/ai.ts).
 */

export type AnswerSource = FillResult['source'] | 'profile'
export type ConfidenceLevel = 'high' | 'medium' | 'low'

export interface ApprovalAnswer {
  question: string
  answer: string
  /** 0..1 */
  confidence: number
  needs_review: boolean
  source: AnswerSource
}

/** Batas tampilan: di atas 0,8 tinggi; 0,5 sampai 0,8 sedang; di bawah 0,5 rendah. */
export const CONFIDENCE_HIGH_ABOVE = 0.8
export const CONFIDENCE_LOW_BELOW = 0.5

export function confidenceLevel(confidence: number): ConfidenceLevel {
  if (!(confidence >= 0)) return 'low'
  if (confidence > CONFIDENCE_HIGH_ABOVE) return 'high'
  if (confidence < CONFIDENCE_LOW_BELOW) return 'low'
  return 'medium'
}

interface StandardQuestion {
  /** teks yang dilihat pengguna */
  display: string
  field: FormField
  /** kunci user_automation_settings yang harus terisi ('email' = email akun); bila kosong jawaban ditandai belum ada data */
  requires?: string
}

export function standardQuestions(company: string): StandardQuestion[] {
  return [
    { display: 'Nama lengkap', field: { type: 'text', label: 'Full name' }, requires: 'first_name' },
    { display: 'Email', field: { type: 'text', label: 'Email' }, requires: 'email' },
    { display: 'Nomor telepon', field: { type: 'text', label: 'Phone number' }, requires: 'phone_number' },
    { display: 'Kota domisili', field: { type: 'text', label: 'Current city' }, requires: 'current_city' },
    {
      display: 'Total pengalaman kerja (tahun)',
      field: { type: 'text', label: 'Total years of experience' },
      requires: 'years_of_experience',
    },
    { display: 'Ekspektasi gaji', field: { type: 'text', label: 'Expected salary' }, requires: 'desired_salary' },
    {
      display: 'Masa pemberitahuan (notice period)',
      field: { type: 'text', label: 'Notice period' },
      requires: 'notice_period',
    },
    {
      display: 'Butuh sponsor visa?',
      field: { type: 'radio', label: 'Do you require visa sponsorship?', options: ['Yes', 'No'] },
      requires: 'require_visa',
    },
    { display: 'Profil LinkedIn', field: { type: 'text', label: 'LinkedIn profile URL' }, requires: 'linkedin_url' },
    {
      // Nama perusahaan sengaja tidak masuk label: label dicocokkan dengan aturan kata kunci, dan nama
      // seperti "GoPay" atau "Real Estate" akan memicu aturan gaji atau provinsi. Perusahaan ada di prompt AI
      // lewat deskripsi lowongan.
      display: `Mengapa tertarik pada posisi ini di ${company || 'perusahaan ini'}?`,
      field: { type: 'textarea', label: 'Why are you interested in this role?' },
    },
  ]
}

const asText = (v: FillResult['value']): string => {
  if (Array.isArray(v)) return v.join(', ')
  if (typeof v === 'boolean') return v ? 'Ya' : 'Tidak'
  return v == null ? '' : String(v)
}

export type Filler = (field: FormField, ctx: FormContext) => Promise<FillResult>

export interface AnswerInput {
  settings: Record<string, any>
  /** `achievements`: baris penghargaan dan publikasi (buildAchievementLines). Hanya dipakai untuk jawaban AI teks panjang. */
  profile: { email?: string | null; skills?: string[]; achievements?: string[] }
  job: { title: string; company: string; description: string }
  /** Baris `profiles` pengguna. Dipakai hanya untuk kolom Pengaturan Otomasi yang kosong. */
  profileRow?: Record<string, any> | null
  /** Baris `work_experiences` (start_date, end_date, is_current). Dasar tahun pengalaman bila kolom lain kosong atau 0. */
  workExperiences?: Array<Record<string, any>> | null
  /** Jam yang dipakai menghitung peran yang masih berjalan. Hanya tes yang mengisi ini. */
  now?: Date
}

/** Keyakinan jawaban yang diambil dari Profil. Kota diturunkan dari teks lokasi bebas, jadi hanya "sedang". */
const PROFILE_CONFIDENCE: Record<string, number> = {
  first_name: 0.85,
  phone_number: 0.85,
  linkedin_url: 0.85,
  years_of_experience: 0.85,
  current_city: 0.75,
}

/** Tahun pengalaman yang dihitung dari tanggal riwayat kerja: hasil hitungan, jadi selalu "sedang" dan dicek pengguna. */
export const DERIVED_YEARS_CONFIDENCE = 0.7
/** Tahun pengalaman 0 padahal profil punya riwayat kerja: hampir pasti salah, jadi "rendah". */
export const CONTRADICTED_YEARS_CONFIDENCE = 0.4

const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')

/**
 * Lengkapi Pengaturan Otomasi dengan data Profil (`profiles`) untuk kolom yang kosong. Kolom yang sudah
 * diisi di Pengaturan Otomasi selalu menang. Mengembalikan pengaturan gabungan dan kunci yang berasal dari Profil.
 *   full_name -> first_name + last_name (kata pertama = nama depan, sisanya = nama belakang)
 *   phone -> phone_number, linkedin_url -> linkedin_url, portfolio_url -> website
 *   location -> current_city (bagian sebelum koma pertama; "Yogyakarta, Indonesia" -> "Yogyakarta")
 *   experience_years -> years_of_experience, hanya bila > 0 (0 adalah nilai bawaan kolom, bukan jawaban pengguna)
 *   tahun pengalaman kosong atau 0 di keduanya -> dihitung dari work_experiences (periode digabung, peran berjalan
 *   sampai hari ini, dibulatkan ke bawah). Kuncinya masuk `derived`; jawabannya diberi keyakinan sedang.
 *
 * Nilai "0" di Pengaturan Otomasi diperlakukan sebagai belum diisi, sama seperti 0 di profil: itu nilai bawaan,
 * dan menjawab 0 tahun dengan yakin padahal ada riwayat kerja menyesatkan (uji klik produksi 20 November 2026).
 */
export function mergeProfileIntoSettings(
  settings: Record<string, any> | null | undefined,
  profileRow: Record<string, any> | null | undefined,
  workExperiences?: Array<Record<string, any>> | null,
  now: Date = new Date()
): { settings: Record<string, any>; fromProfile: Set<string>; derived: Set<string> } {
  const merged: Record<string, any> = { ...(settings ?? {}) }
  const fromProfile = new Set<string>()
  const derived = new Set<string>()
  const yearsFromProfile = Number(profileRow?.experience_years)
  const yearsUnset = isBlank(merged.years_of_experience) || Number(String(merged.years_of_experience).trim()) === 0
  if (yearsUnset) {
    if (Number.isFinite(yearsFromProfile) && yearsFromProfile > 0) {
      merged.years_of_experience = String(yearsFromProfile)
      fromProfile.add('years_of_experience')
    } else {
      const d = deriveExperienceYears(workExperiences, now)
      if (d && d.years > 0) {
        merged.years_of_experience = String(d.years)
        fromProfile.add('years_of_experience')
        derived.add('years_of_experience')
      }
    }
  }
  if (!profileRow) return { settings: merged, fromProfile, derived }
  const fill = (key: string, value: unknown) => {
    const v = typeof value === 'number' ? String(value) : text(value)
    if (v && isBlank(merged[key])) {
      merged[key] = v
      fromProfile.add(key)
    }
  }
  const fullName = text(profileRow.full_name).replace(/\s+/g, ' ')
  if (fullName && isBlank(merged.first_name) && isBlank(merged.last_name)) {
    const [first, ...rest] = fullName.split(' ')
    merged.first_name = first
    fromProfile.add('first_name')
    if (rest.length) {
      merged.last_name = rest.join(' ')
      fromProfile.add('last_name')
    }
  }
  fill('phone_number', profileRow.phone)
  fill('linkedin_url', profileRow.linkedin_url)
  fill('website', profileRow.portfolio_url)
  const city = text(profileRow.location).split(',')[0].trim()
  fill('current_city', city)
  return { settings: merged, fromProfile, derived }
}

/**
 * Jalankan pertanyaan standar lewat `filler` (default: FormAutofillService.fillField) dan bentuk jawaban
 * yang siap disimpan di approval_requests.answers. Aturannya:
 *   needs_review = needsReview dari filler, ATAU keyakinan tidak tinggi (<= 0,8), ATAU jawaban kosong,
 *                  ATAU jawaban dari AI, ATAU data sumbernya belum diisi pengguna.
 */
// The AI question can wait on a whole model chain (OpenRouter free models, then Groq). Creating the approval
// must not hang on it: after this long the answer is left as "no data, check it yourself".
const AI_ANSWER_TIMEOUT_MS = Number(process.env.APPROVAL_ANSWER_TIMEOUT_MS || 25_000)

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`answer timed out after ${ms} ms`)), ms)
  })
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer))
}

export async function buildApprovalAnswers(
  input: AnswerInput,
  filler: Filler = (f, c) => formAutofillService.fillField(f, c),
  timeoutMs: number = AI_ANSWER_TIMEOUT_MS
): Promise<ApprovalAnswer[]> {
  const { profile, job } = input
  const { settings, fromProfile, derived } = mergeProfileIntoSettings(input.settings, input.profileRow, input.workExperiences, input.now)
  const hasWorkHistory = Array.isArray(input.workExperiences) && input.workExperiences.length > 0
  const ctx: FormContext = {
    jobTitle: job.title,
    company: job.company,
    jobDescription: job.description,
    userSettings: settings,
    userProfile: profile,
  }

  const out: ApprovalAnswer[] = []
  for (const q of standardQuestions(job.company)) {
    const missing = q.requires ? isBlank(q.requires === 'email' ? profile.email : settings[q.requires]) : false
    if (missing) {
      // Tanpa data sumber, nilai bawaan aturan (mis. "0 tahun") hanya menyesatkan: kosongkan dan tandai.
      out.push({ question: q.display, answer: '', confidence: 0, needs_review: true, source: 'default' })
      continue
    }
    let res: FillResult
    try {
      res = await withTimeout(filler(q.field, ctx), timeoutMs)
    } catch (e) {
      out.push({ question: q.display, answer: '', confidence: 0, needs_review: true, source: 'default' })
      continue
    }
    const answer = asText(res.value)
    // Jawaban aturan yang datanya berasal dari Profil (bukan Pengaturan Otomasi) diberi sumber 'profile'.
    const viaProfile = res.source === 'rule' && !!q.requires && fromProfile.has(q.requires) && answer.trim() !== ''
    let confidence = viaProfile ? Math.min(res.confidence, PROFILE_CONFIDENCE[q.requires!] ?? 0.85) : res.confidence
    let source: AnswerSource = viaProfile ? 'profile' : res.source
    if (viaProfile && derived.has(q.requires!)) confidence = Math.min(confidence, DERIVED_YEARS_CONFIDENCE)
    // Jawaban 0 tahun padahal ada riwayat kerja (mis. nilai bawaan 0 di Pengaturan Otomasi, atau semua peran kurang
    // dari setahun): jangan dilaporkan yakin. Rendah dan wajib dicek pengguna.
    if (q.requires === 'years_of_experience' && hasWorkHistory && Number(answer.trim()) === 0 && answer.trim() !== '') {
      confidence = Math.min(confidence, CONTRADICTED_YEARS_CONFIDENCE)
      source = 'default'
    }
    out.push({
      question: q.display,
      answer,
      confidence,
      source,
      needs_review:
        res.needsReview ||
        confidenceLevel(confidence) !== 'high' ||
        answer.trim() === '' ||
        (source !== 'rule' && source !== 'profile'),
    })
  }
  return out
}

function isBlank(v: unknown): boolean {
  return v == null || (typeof v === 'string' && v.trim() === '')
}

/** Minimal shape of the Supabase client used here. */
export interface AnswersDb {
  from(table: string): any
}

/**
 * Baca data pengguna dan lowongan, lalu bangun jawaban. Tidak pernah melempar: kegagalan apa pun
 * menghasilkan daftar kosong, supaya pengajuan persetujuan tidak tertahan oleh fitur pratinjau ini.
 */
/**
 * Penghargaan dan publikasi pengguna sebagai baris konteks (maks. 8). Membaca tabel `achievements`; kegagalan
 * membaca tidak boleh menggagalkan jawaban lain, jadi hasilnya kosong dan jawaban dibuat tanpa daftar ini.
 */
async function loadAchievementLines(db: AnswersDb, userId: string): Promise<string[]> {
  try {
    const { data } = await db
      .from('achievements')
      .select('title, category, issuer, achievement_date, is_featured, created_at')
      .eq('user_id', userId)
      .order('achievement_date', { ascending: false, nullsFirst: false })
      .limit(50)
    return buildAchievementLines(data)
  } catch (e) {
    console.warn('[approval-answers] penghargaan tidak terbaca, jawaban dibuat tanpa daftar ini:', (e as Error)?.message)
    return []
  }
}

/**
 * Periode kerja pengguna untuk menghitung tahun pengalaman. Gagal membaca = null (jawaban dibuat tanpa hitungan ini,
 * seperti sebelum fitur ini ada), jadi pengajuan persetujuan tidak tertahan.
 */
async function loadWorkExperiences(db: AnswersDb, userId: string): Promise<Array<Record<string, any>> | null> {
  try {
    const { data, error } = await db.from('work_experiences').select('start_date, end_date, is_current').eq('user_id', userId).limit(100)
    return !error && Array.isArray(data) ? data : null
  } catch (e) {
    console.warn('[approval-answers] riwayat kerja tidak terbaca, tahun pengalaman tidak dihitung:', (e as Error)?.message)
    return null
  }
}

export async function prepareApprovalAnswers(
  db: AnswersDb,
  args: { userId: string; email?: string | null; jobId?: string | null; jobTitle: string; company: string },
  filler?: Filler
): Promise<ApprovalAnswer[]> {
  try {
    const [{ data: settings }, { data: profileRow }, { data: skills }, { data: jobRow }, achievements, workExperiences] = await Promise.all([
      db.from('user_automation_settings').select('*').eq('user_id', args.userId).maybeSingle(),
      db.from('profiles').select('*').eq('id', args.userId).maybeSingle(),
      db.from('user_skills').select('name').eq('user_id', args.userId),
      args.jobId ? db.from('jobs').select('description').eq('id', args.jobId).maybeSingle() : Promise.resolve({ data: null }),
      loadAchievementLines(db, args.userId),
      loadWorkExperiences(db, args.userId),
    ])
    return await buildApprovalAnswers(
      {
        settings: settings ?? {},
        profileRow: profileRow ?? null,
        workExperiences,
        profile: {
          email: args.email ?? null,
          skills: (skills ?? []).map((s: any) => s.name).filter(Boolean),
          ...(achievements.length > 0 ? { achievements } : {}),
        },
        job: { title: args.jobTitle, company: args.company, description: String(jobRow?.description ?? '') },
      },
      filler
    )
  } catch (e) {
    console.warn('[approval-answers] gagal menyiapkan jawaban:', (e as Error)?.message)
    return []
  }
}

/** Terima `answers` kiriman klien hanya bila bentuknya benar; buang sisanya. */
export function sanitizeClientAnswers(raw: unknown): ApprovalAnswer[] {
  if (!Array.isArray(raw)) return []
  const out: ApprovalAnswer[] = []
  for (const a of raw) {
    if (!a || typeof a !== 'object' || typeof (a as any).question !== 'string') continue
    const c = Number((a as any).confidence)
    out.push({
      question: String((a as any).question).slice(0, 300),
      answer: String((a as any).answer ?? '').slice(0, 2000),
      confidence: Number.isFinite(c) ? Math.min(1, Math.max(0, c)) : 0,
      needs_review: (a as any).needs_review !== false,
      source: ['rule', 'ai', 'default', 'profile'].includes((a as any).source) ? (a as any).source : 'default',
    })
  }
  return out
}

/** Ambil cover_letter dari ai_applications milik pengguna; null bila tidak ada, bukan milik pengguna, atau kosong. */
export async function coverLetterFromApplication(db: { from(t: string): any }, userId: string, applicationId: string): Promise<string | null> {
  try {
    const { data } = await db.from('ai_applications').select('cover_letter').eq('id', applicationId).eq('user_id', userId).maybeSingle()
    const text = typeof data?.cover_letter === 'string' ? data.cover_letter.trim() : ''
    return text || null
  } catch {
    return null
  }
}
