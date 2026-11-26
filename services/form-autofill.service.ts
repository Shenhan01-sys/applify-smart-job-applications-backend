import { aiPipelineService } from './ai-pipeline.service.js'
import { UNCONFIRMED_DEFAULT_CONFIDENCE, isUnconfirmedVisaDefault } from './applicant-fallbacks.js'
import { citizenshipFormAnswer } from './us-work-authorization.js'
import { matchOptionStrict } from './option-match.js'
import { classifyPersonalFact, type PersonalFactVerdict } from './personal-fact-extras.js'

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
  /**
   * Ada hanya bila pertanyaannya fakta pribadi yang tidak punya data tersimpan pengguna: jawabannya kosong dan
   * pengguna yang harus menjawab ("Perlu dicek"). Model tidak dipanggil untuk pertanyaan ini.
   */
  personalFact?: { category: string; reason: string }
}

/** Angka positif dari kolom numerik pengaturan. Kosong, null, NaN, 0, atau negatif = belum diisi (null). */
export function positiveSettingNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null
  const n = typeof value === 'number' ? value : Number(String(value).trim())
  return String(value).trim() !== '' && Number.isFinite(n) && n > 0 ? n : null
}

/** Pertanyaan yang menanyakan apakah pelamar MEMERLUKAN visa atau sponsor (bukan apakah ia memegang visa). */
const ASKS_VISA_NEED =
  /\bsponsor|\b(?:need|needs|require|requires|required|memerlukan|butuh|perlu)\b[^?]{0,40}\b(?:visa|work permit)\b|\bvisa\b[^?]{0,30}\b(?:needed|required|diperlukan|dibutuhkan)\b/

export class FormAutofillService {
  /**
   * Fill a single form field based on type and label
   */
  async fillField(field: FormField, context: FormContext): Promise<FillResult> {
    const { label, type, options } = field
    const labelLower = label.toLowerCase()
    const settings = context.userSettings

    // 0. Fakta pribadi (kewarganegaraan, izin kerja, sponsor visa, kerabat pejabat, riwayat bekerja, sumber lowongan,
    // kesanggupan, riwayat hukum, demografi, usia, NIK ...): hanya data yang pengguna simpan sendiri untuk pertanyaan yang
    // sama yang boleh dipakai. Model tidak dipanggil, dan tidak ada jawaban cadangan.
    const personal = classifyPersonalFact(label, options)
    if (personal) return this.fillPersonalFact(field, personal, context)

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
        console.error('AI answer generation failed:', String((error as any)?.message ?? error).slice(0, 120))
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
    if (label.includes('notice') || label.includes('availability')) {
      return this.noticeAnswer(label, settings)
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

  /**
   * Jawaban "butuh sponsor visa" dari `require_visa`. Kolom kosong bukan "No": jawaban yang diada-adakan dengan keyakinan
   * 0,95 menyesatkan (temuan 15 uji klik produksi 20 November 2026), jadi tanpa data nilainya kosong dengan keyakinan 0.
   * "No" persis adalah nilai bawaan kolom di database, bukan pilihan pengguna: dijawab, tetapi tidak dengan yakin.
   */
  private visaAnswer(options: string[] | undefined, settings: any): { value: string; confidence: number } {
    const visa = String(settings.require_visa ?? '').trim()
    if (!visa) return { value: '', confidence: 0 }
    const picked = this.pickOption(options, visa)
    return {
      value: picked.value,
      confidence: !picked.matched ? 0 : isUnconfirmedVisaDefault(visa) ? UNCONFIRMED_DEFAULT_CONFIDENCE : 0.95,
    }
  }

  /** Masa pemberitahuan dari `notice_period` (hari). Satuan yang menghasilkan 0 (mis. 14 hari dalam bulan) dibiarkan kosong untuk pengguna. */
  private noticeAnswer(label: string, settings: any): { value: string; confidence: number } {
    const days = positiveSettingNumber(settings.notice_period)
    if (days === null) return { value: '', confidence: 0 }
    const inUnit = label.includes('month') ? Math.floor(days / 30) : label.includes('week') ? Math.floor(days / 7) : days
    return inUnit > 0 ? { value: String(inUnit), confidence: 0.9 } : { value: '', confidence: 0 }
  }

  /**
   * Pertanyaan fakta pribadi. Hanya nilai yang pengguna simpan sendiri untuk pertanyaan yang sama yang dipakai
   * (Pengaturan Otomasi: sponsor visa, kewarganegaraan Amerika Serikat, masa pemberitahuan, gender, ras, disabilitas,
   * veteran). Tanpa data itu jawabannya kosong, keyakinan 0, dan wajib dicek: tidak ada panggilan model, tidak ada
   * "Decline", tidak ada opsi pertama, tidak ada tebakan dari lokasi.
   */
  private fillPersonalFact(field: FormField, personal: PersonalFactVerdict, context: FormContext): FillResult {
    const saved = this.savedPersonalAnswer(personal, field.label.toLowerCase(), field.options, context)
    if (saved && saved.value !== '' && saved.confidence > 0) {
      return { field, value: saved.value, confidence: saved.confidence, source: 'rule', needsReview: false }
    }
    return {
      field,
      value: this.getDefaultAnswer(field.type),
      confidence: 0,
      source: 'default',
      needsReview: true,
      personalFact: { category: personal.category, reason: personal.reason },
    }
  }

  private savedPersonalAnswer(
    personal: PersonalFactVerdict,
    label: string,
    options: string[] | undefined,
    context: FormContext
  ): { value: string; confidence: number } | null {
    const settings = context.userSettings ?? {}
    switch (personal.category) {
      case 'citizenship':
      case 'work_authorization': {
        // `us_citizenship` hanya untuk lowongan di Amerika Serikat dan hanya nilai persis (us-work-authorization.ts, aturan
        // bersama dengan planner ekstensi). "Country of citizenship" dan "Nationality" tidak punya data tersimpan: ditanyakan.
        const asksEligible = /eligible to work|authori[sz]ed to work/.test(label)
        if (asksEligible || (label.includes('citizenship') && !label.includes('country'))) {
          return citizenshipFormAnswer({
            usCitizenship: settings.us_citizenship,
            jobLocation: context.jobLocation,
            options,
            eligibleToWork: asksEligible,
          })
        }
        // "Do you need a visa to work ...?" sama dengan kolom `require_visa`; "Do you hold a valid visa?" tidak.
        return ASKS_VISA_NEED.test(label) ? this.visaAnswer(options, settings) : null
      }
      case 'sponsorship':
        return this.visaAnswer(options, settings)
      case 'internship_availability':
        // Hanya "notice period" yang punya kolom sendiri. Durasi magang, tanggal mulai, dan relokasi dijawab pengguna.
        return /notice period|masa pemberitahuan/.test(label) ? this.noticeAnswer(label, settings) : null
      case 'demographics': {
        const saved = /\b(?:gender|sex)\b|jenis kelamin/.test(label)
          ? settings.gender
          : /\b(?:race|ethnicity|ethnic)\b|\bsuku\b/.test(label)
            ? settings.ethnicity
            : /disab|handicap|difabel/.test(label)
              ? settings.disability_status
              : /\bveteran\b/.test(label)
                ? settings.veteran_status
                : null
        const value = String(saved ?? '').trim()
        if (!value) return null
        const picked = this.pickOption(options, value)
        return { value: picked.value, confidence: picked.matched ? 0.9 : 0 }
      }
      default:
        return null
    }
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
