import { aiPipelineService } from './ai-pipeline.service.js'

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
}

export interface FillResult {
  field: FormField
  value: string | string[] | boolean
  confidence: number
  source: 'rule' | 'ai' | 'default'
  needsReview: boolean
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
          },
        })

        return {
          field,
          value: this.parseAnswer(aiAnswer, type, options),
          confidence: 0.75,
          source: 'ai',
          needsReview: settings.pause_at_failed_question ?? true,
        }
      } catch (error) {
        console.error('AI answer generation failed:', error)
      }
    }

    // 3. Fallback to default/generic answers
    return {
      field,
      value: this.getDefaultAnswer(type, options),
      confidence: 0.3,
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
      return { value: settings.current_city || context.jobTitle.split(' ').pop() || '', confidence: 0.85 }
    }
    if (label.includes('current city') || label.includes('location')) {
      return { value: settings.current_city || context.jobTitle.split(' ').pop() || '', confidence: 0.85 }
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

    // Experience
    if (label.includes('experience') && (label.includes('year') || label.includes('how many'))) {
      return { value: settings.years_of_experience || '0', confidence: 0.95 }
    }
    if (label.includes('current experience') || label.includes('total experience')) {
      return { value: settings.years_of_experience || '0', confidence: 0.95 }
    }

    // Salary
    if (label.includes('salary') || label.includes('compensation') || label.includes('ctc') || label.includes('pay')) {
      if (label.includes('current') || label.includes('present')) {
        return { value: settings.current_ctc?.toString() || '', confidence: 0.9 }
      }
      return { value: settings.desired_salary?.toString() || '', confidence: 0.9 }
    }

    // Notice period
    if (label.includes('notice') || label.includes('availability')) {
      if (label.includes('month')) return { value: Math.floor((settings.notice_period || 30) / 30).toString(), confidence: 0.9 }
      if (label.includes('week')) return { value: Math.floor((settings.notice_period || 30) / 7).toString(), confidence: 0.9 }
      return { value: (settings.notice_period || 30).toString(), confidence: 0.9 }
    }

    // Visa
    if (label.includes('visa') || label.includes('sponsorship') || label.includes('work authorization')) {
      return { value: this.findOption(options, settings.require_visa || 'No'), confidence: 0.95 }
    }

    // Citizenship
    if (label.includes('citizenship') || label.includes('eligible to work')) {
      return { value: this.findOption(options, settings.us_citizenship || 'Decline'), confidence: 0.9 }
    }

    // Demographics
    if (label.includes('gender') || label.includes('sex')) {
      return { value: this.findOption(options, settings.gender || 'Decline'), confidence: 0.9 }
    }
    if (label.includes('ethnicity') || label.includes('race')) {
      return { value: this.findOption(options, settings.ethnicity || 'Decline'), confidence: 0.9 }
    }
    if (label.includes('disability') || label.includes('handicapped')) {
      return { value: this.findOption(options, settings.disability_status || 'Decline'), confidence: 0.9 }
    }
    if (label.includes('veteran')) {
      return { value: this.findOption(options, settings.veteran_status || 'Decline'), confidence: 0.9 }
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

  private findOption(options: string[] | undefined, value: string): string {
    if (!options || options.length === 0) return value
    const exact = options.find((o) => o.toLowerCase() === value.toLowerCase())
    if (exact) return exact
    // Try partial match
    const partial = options.find((o) =>
      o.toLowerCase().includes(value.toLowerCase()) ||
      value.toLowerCase().includes(o.toLowerCase())
    )
    return partial || options[0] || value
  }

  private parseAnswer(answer: string, type: string, options: string[] | undefined): any {
    if (type === 'checkbox') {
      return answer.split(',').map((s) => s.trim()).filter(Boolean)
    }
    if (type === 'radio' || type === 'select') {
      return this.findOption(options, answer.trim())
    }
    return answer.trim()
  }

  private getDefaultAnswer(type: string, options: string[] | undefined): any {
    switch (type) {
      case 'checkbox':
        return []
      case 'radio':
      case 'select':
        return options?.[0] || ''
      case 'file':
        return null
      default:
        return ''
    }
  }
}

export const formAutofillService = new FormAutofillService()
