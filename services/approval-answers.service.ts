import { formAutofillService, type FillResult, type FormContext, type FormField } from './form-autofill.service.js'

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

export type AnswerSource = FillResult['source']
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
  profile: { email?: string | null; skills?: string[] }
  job: { title: string; company: string; description: string }
}

/**
 * Jalankan pertanyaan standar lewat `filler` (default: FormAutofillService.fillField) dan bentuk jawaban
 * yang siap disimpan di approval_requests.answers. Aturannya:
 *   needs_review = needsReview dari filler, ATAU keyakinan tidak tinggi (<= 0,8), ATAU jawaban kosong,
 *                  ATAU jawaban dari AI, ATAU data sumbernya belum diisi pengguna.
 */
export async function buildApprovalAnswers(input: AnswerInput, filler: Filler = (f, c) => formAutofillService.fillField(f, c)): Promise<ApprovalAnswer[]> {
  const { settings, profile, job } = input
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
      res = await filler(q.field, ctx)
    } catch (e) {
      out.push({ question: q.display, answer: '', confidence: 0, needs_review: true, source: 'default' })
      continue
    }
    const answer = asText(res.value)
    out.push({
      question: q.display,
      answer,
      confidence: res.confidence,
      source: res.source,
      needs_review:
        res.needsReview || confidenceLevel(res.confidence) !== 'high' || answer.trim() === '' || res.source !== 'rule',
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
export async function prepareApprovalAnswers(
  db: AnswersDb,
  args: { userId: string; email?: string | null; jobId?: string | null; jobTitle: string; company: string },
  filler?: Filler
): Promise<ApprovalAnswer[]> {
  try {
    const [{ data: settings }, { data: skills }, { data: jobRow }] = await Promise.all([
      db.from('user_automation_settings').select('*').eq('user_id', args.userId).maybeSingle(),
      db.from('user_skills').select('name').eq('user_id', args.userId),
      args.jobId ? db.from('jobs').select('description').eq('id', args.jobId).maybeSingle() : Promise.resolve({ data: null }),
    ])
    return await buildApprovalAnswers(
      {
        settings: settings ?? {},
        profile: { email: args.email ?? null, skills: (skills ?? []).map((s: any) => s.name).filter(Boolean) },
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
      source: ['rule', 'ai', 'default'].includes((a as any).source) ? (a as any).source : 'default',
    })
  }
  return out
}
