import { aiPipelineService } from './ai-pipeline.service.js'
import { UNCONFIRMED_DEFAULT_CONFIDENCE, isUnconfirmedVisaDefault } from './applicant-fallbacks.js'
import { citizenshipFormAnswer } from './us-work-authorization.js'
import { matchOptionStrict } from './option-match.js'

export interface FormField {
  type: 'text' | 'textarea' | 'select' | 'radio' | 'checkbox' | 'file'
  label: string
  id?: string
  name?: string
  options?: string[]
  required?: boolean
  placeholder?: string
}

export interface FormContext {
  jobTitle: string
  company: string
  jobDescription: string
  userSettings: any
  userProfile: any
  /**
   * Teks lokasi lowongan (`jobs.location`). Dipakai hanya untuk pertanyaan kewarganegaraan: `us_citizenship` dijawab
   * hanya untuk lowongan yang negaranya jelas Amerika Serikat. Kosong atau tidak jelas: pengguna ditanya.
   */
  jobLocation?: string | null
}

export interface FillResult {
  field: FormField
  value: string | string[] | boolean
  confidence: number
  source: 'rule' | 'ai' | 'default'
  needsReview: boolean
}

/** Angka positif dari kolom numerik pengaturan. Kosong, null, NaN, 0, atau negatif = belum diisi (null). */
export function positiveSettingNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null
  const n = typeof value === 'number' ? value : Number(String(value).trim())
  return String(value).trim() !== '' && Number.isFinite(n) && n > 0 ? n : null
}

export class FormAutofillService {
  /**
   * Fill a single form field based on type and label
   */
  async fillField(field: FormField, context: FormContext): Promise<FillResult> {
    const { label, type, options } = field
    const labelLower = label.toLowerCase()
    const settings = context.userSettings

    // 1. Try rule-based matching first (high confidence, no review needed)
    const ruleValue = this.matchByRules(labelLower, type, options, settings, context)
    if (ruleValue !== null) {
      return {
        field,
        value: ruleValue.value,
        confidence: ruleValue.confidence,
        source: 'rule',
        needsReview: false,
      }
    }

    // 2. For known question patterns, use AI
    if (settings.use_ai !== false) {
      try {
        const aiAnswer = await aiPipelineService.generateAnswer({
          question: label,
          questionType: type,
          options,
          jobDescription: context.jobDescription,
          userProfile: {
            name: `${settings.first_name} ${settings.last_name}`,
            experience: settings.years_of_experience,
            skills: context.userProfile?.skills || [],
            summary: settings.linkedin_summary || '',
            // Daftar penghargaan hanya dibawa bila ada; generateAnswer memakainya untuk pertanyaan teks panjang saja.
            ...(Array.isArray(context.userProfile?.achievements) && context.userProfile.achievements.length > 0
              ? { achievements: context.userProfile.achievements }
              : {}),
          },
        })

        const parsed = this.parseAnswer(aiAnswer, type, options)
        return {
          field,
          value: parsed.value,
          // Jawaban AI yang tidak punya pilihan padanan dikosongkan dengan keyakinan 0 dan wajib dicek (pengguna ditanya).
          confidence: parsed.matched ? 0.75 : 0,
          source: 'ai',
          needsReview: parsed.matched ? (settings.pause_at_failed_question ?? true) : true,
        }
      } catch (error) {
        console.error('AI answer generation failed:', error)
      }
    }

    // 3. Fallback to default/generic answers
    const defaultValue = this.getDefaultAnswer(type)
    return {
      field,
      value: defaultValue,
      confidence: (type === 'select' || type === 'radio') && defaultValue === '' ? 0 : 0.3,
      source: 'default',
      needsReview: true,
    }
  }

  /**
   * Match field label against known patterns
   */
  private matchByRules(
    label: string,
    type: string,
    options: string[] | undefined,
    settings: any,
    context: FormContext
  ): { value: any; confidence: number } | null {
    // Personal info
    if (label.includes('first name') || label.includes('given name')) {
      return { value: settings.first_name || '', confidence: 0.99 }
    }
    if (label.includes('last name') || label.includes('family name') || label.includes('surname')) {
      return { value: settings.last_name || '', confidence: 0.99 }
    }
    if (label.includes('full name') || label.includes('legal name')) {
      return { value: `${settings.first_name} ${settings.last_name}`.trim(), confidence: 0.99 }
    }
    if (label.includes('phone') || label.includes('mobile') || label.includes('contact number')) {
      return { value: settings.phone_number || '', confidence: 0.99 }
    }
    if (label.includes('email') && !label.includes('confirm')) {
      return { value: context.userProfile?.email || '', confidence: 0.99 }
    }

    // Citizenship dan izin kerja. Diperiksa SEBELUM aturan lokasi: "Are you eligible to work in the United States?"
    // mengandung "state" dan "in this country" mengandung "country", sehingga dulu terjawab dengan nama negara bagian
    // atau negara. `us_citizenship` hanya untuk lowongan di Amerika Serikat dan hanya nilai persis (aturan bersama dengan
    // planner ekstensi: us-work-authorization.ts). Selain itu kosong dengan keyakinan 0, bukan "Decline" atau opsi pertama.
    // "Country of citizenship" tetap lewat aturan negara di bawah seperti sebelumnya.
    const asksEligible = label.includes('eligible to work')
    if (asksEligible || (label.includes('citizenship') && !label.includes('country'))) {
      return citizenshipFormAnswer({
        usCitizenship: settings.us_citizenship,
        jobLocation: context.jobLocation,
        options,
        eligibleToWork: asksEligible,
      })
    }

    // Location
    if (label.includes('city') && !label.includes('current')) {
      return { value: settings.current_city || '', confidence: settings.current_city ? 0.85 : 0 }
    }
    if (label.includes('current city') || label.includes('location')) {
      // Dulu kota diambil dari kata terakhir judul lowongan bila data kosong; itu mengarang jawaban.
      return { value: settings.current_city || '', confidence: settings.current_city ? 0.85 : 0 }
    }
    if (label.includes('state') || label.includes('province')) {
      return { value: settings.state || '', confidence: 0.95 }
    }
    if (label.includes('zip') || label.includes('postal')) {
      return { value: settings.zipcode || '', confidence: 0.95 }
    }
    if (label.includes('country')) {
      return { value: settings.country || '', confidence: 0.95 }
    }
    if (label.includes('street') || label.includes('address')) {
      return { value: settings.street || '', confidence: 0.9 }
    }

    // Experience. Kolom kosong bukan "0 tahun": jawaban 0 dengan keyakinan 0,95 menyesatkan (uji klik produksi
    // 20 November 2026), jadi tanpa data nilainya kosong dengan keyakinan 0, sama seperti kota.
    if (label.includes('experience') && (label.includes('year') || label.includes('how many'))) {
      const years = String(settings.years_of_experience ?? '').trim()
      return { value: years, confidence: years ? 0.95 : 0 }
    }
    if (label.includes('current experience') || label.includes('total experience')) {
      const years = String(settings.years_of_experience ?? '').trim()
      return { value: years, confidence: years ? 0.95 : 0 }
    }

    // Salary. Kolom kosong, 0, atau tidak terbaca bukan gaji: jawaban "0" menyesatkan (UI lama menyimpan 0 untuk kolom
    // yang dikosongkan), jadi nilainya kosong dengan keyakinan 0 dan pengguna yang mengisi, sama seperti kota.
    if (label.includes('salary') || label.includes('compensation') || label.includes('ctc') || label.includes('pay')) {
      const amount = positiveSettingNumber(
        label.includes('current') || label.includes('present') ? settings.current_ctc : settings.desired_salary
      )
      return amount === null ? { value: '', confidence: 0 } : { value: String(amount), confidence: 0.9 }
    }

    // Notice period. Hanya nilai tersimpan yang dipakai; 30 hari bukan jawaban bawaan yang boleh diada-adakan.
    // Satuan yang menghasilkan 0 (mis. 14 hari dalam bulan) juga dibiarkan kosong untuk pengguna.
    if (label.includes('notice') || label.includes('availability')) {
      const days = positiveSettingNumber(settings.notice_period)
      if (days === null) return { value: '', confidence: 0 }
      const inUnit = label.includes('month') ? Math.floor(days / 30) : label.includes('week') ? Math.floor(days / 7) : days
      return inUnit > 0 ? { value: String(inUnit), confidence: 0.9 } : { value: '', confidence: 0 }
    }

    // Visa
    if (label.includes('visa') || label.includes('sponsorship') || label.includes('work authorization')) {
      const visa = String(settings.require_visa ?? '').trim()
      // Kolom kosong bukan "No": jawaban yang diada-adakan dengan keyakinan 0,95 menyesatkan (temuan 15 uji klik
      // produksi 20 November 2026), jadi tanpa data nilainya kosong dengan keyakinan 0, sama seperti kota.
      if (!visa) return { value: '', confidence: 0 }
      // "No" persis adalah nilai bawaan kolom di database, bukan pilihan pengguna: jawab, tetapi tidak dengan yakin.
      const picked = this.pickOption(options, visa)
      return {
        value: picked.value,
        confidence: !picked.matched ? 0 : isUnconfirmedVisaDefault(visa) ? UNCONFIRMED_DEFAULT_CONFIDENCE : 0.95,
      }
    }

    // Demographics
    if (label.includes('gender') || label.includes('sex')) {
      return this.demographicAnswer(options, settings.gender)
    }
    if (label.includes('ethnicity') || label.includes('race')) {
      return this.demographicAnswer(options, settings.ethnicity)
    }
    if (label.includes('disability') || label.includes('handicapped')) {
      return this.demographicAnswer(options, settings.disability_status)
    }
    if (label.includes('veteran')) {
      return this.demographicAnswer(options, settings.veteran_status)
    }

    // LinkedIn / Website
    if (label.includes('linkedin')) {
      return { value: settings.linkedin_url || '', confidence: 0.95 }
    }
    if (label.includes('website') || label.includes('portfolio') || label.includes('github')) {
      return { value: settings.website || '', confidence: 0.9 }
    }

    // Cover letter
    if (label.includes('cover letter')) {
      return { value: settings.cover_letter || '', confidence: 0.85 }
    }

    // Summary
    if (label.includes('summary') || label.includes('about yourself')) {
      return { value: settings.linkedin_summary || '', confidence: 0.85 }
    }

    // Signature
    if (label.includes('signature')) {
      return { value: `${settings.first_name} ${settings.last_name}`.trim(), confidence: 0.99 }
    }

    // Recent employer
    if (label.includes('current employer') || label.includes('most recent')) {
      return { value: settings.recent_employer || '', confidence: 0.9 }
    }

    // Confidence level
    if (label.includes('scale') && label.includes('1-10')) {
      return { value: settings.confidence_level || '7', confidence: 0.8 }
    }

    // Referral / How did you hear
    if (label.includes('hear') || label.includes('referral') || label.includes('how did you')) {
      return { value: 'LinkedIn Job Posting', confidence: 0.7 }
    }

    return null
  }

  /**
   * Pilih opsi untuk `value` tanpa menebak (option-match.ts). Tanpa daftar pilihan (teks bebas) nilainya dipakai apa
   * adanya. Dengan daftar pilihan: hanya opsi yang persis sama atau tepat satu opsi berawalan nilai pada batas kata;
   * selain itu kosong (`matched: false`) supaya pemanggil memberi keyakinan 0 dan pengguna ditanya. Tidak ada
   * cadangan "opsi pertama".
   */
  private pickOption(options: string[] | undefined, value: string): { value: string; matched: boolean } {
    if (!options || options.length === 0) return { value, matched: true }
    const hit = matchOptionStrict(value, options)
    return hit === null ? { value: '', matched: false } : { value: hit, matched: true }
  }

  /** Pertanyaan demografi: data pengguna bila ada, kalau tidak "Decline" (hanya bila ada opsi yang jelas cocok). */
  private demographicAnswer(options: string[] | undefined, saved: unknown): { value: string; confidence: number } {
    const picked = this.pickOption(options, String(saved ?? '').trim() || 'Decline')
    return { value: picked.value, confidence: picked.matched ? 0.9 : 0 }
  }

  private parseAnswer(answer: string, type: string, options: string[] | undefined): { value: any; matched: boolean } {
    if (type === 'checkbox') {
      return { value: answer.split(',').map((s) => s.trim()).filter(Boolean), matched: true }
    }
    if (type === 'radio' || type === 'select') {
      return this.pickOption(options, answer.trim())
    }
    return { value: answer.trim(), matched: true }
  }

  /** Jawaban bawaan terakhir. Radio/select tidak pernah diisi dengan opsi pertama: kosong, pengguna ditanya. */
  private getDefaultAnswer(type: string): any {
    switch (type) {
      case 'checkbox':
        return []
      case 'file':
        return null
      default:
        return ''
    }
  }
}

export const formAutofillService = new FormAutofillService()
