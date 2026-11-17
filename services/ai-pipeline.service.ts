import axios from 'axios'
import { tracingService } from './tracing.service.js'

const getOpenRouterKey = () => process.env.OPENROUTER_API_KEY
const getGroqKey = () => process.env.GROQ_API_KEY
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions'
const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions'

// Free model slugs are retired often: by 2026-10 half of the original chain (gpt-oss-20b:free,
// nemotron nano, ling tiny, Groq llama-3.3-70b ...) no longer existed. The chains are therefore
// configurable (OPENROUTER_FALLBACK_MODELS / GROQ_FALLBACK_MODELS, comma-separated) and filtered at
// runtime against each provider's live model list, so a retired slug costs no request.
const envList = (name: string, defaults: string[]) =>
  process.env[name] ? process.env[name]!.split(',').map((m) => m.trim()).filter(Boolean) : defaults

// Free OpenRouter models, tried in order after the primary model (OPENROUTER_MODEL env).
const FREE_MODEL_FALLBACKS: string[] = envList('OPENROUTER_FALLBACK_MODELS', [
  'google/gemma-4-26b-a4b-it:free',
  'google/gemma-4-31b-it:free',
  'nvidia/nemotron-3-super-120b-a12b:free',
  'qwen/qwen3.8-27b:free',
  'nvidia/nemotron-3.5-lightning:free',
  'nvidia/nemotron-3-ultra-550b-a55b:free',
  'inclusionai/ling-3.0-flash-sante:free',
  'openrouter/free',
])

// Groq backup models (tried AFTER the OpenRouter chain). Groq is a separate provider with its own
// rate limits, so it is a true backup when the OpenRouter free tier is exhausted.
const GROQ_MODEL_FALLBACKS: string[] = envList('GROQ_FALLBACK_MODELS', [
  'openai/gpt-oss-120b',
  'openai/gpt-oss-20b',
  'qwen/qwen3.8-27b',
])

const MODEL_LIST_TTL_MS = 60 * 60 * 1000
const modelListCache = new Map<string, { at: number; ids: Set<string> | null }>()

/** Live model ids of a provider (cached 1 h). Returns null when the list cannot be fetched (no filtering). */
async function liveModels(url: string, apiKey?: string): Promise<Set<string> | null> {
  const hit = modelListCache.get(url)
  if (hit && Date.now() - hit.at < MODEL_LIST_TTL_MS) return hit.ids
  let ids: Set<string> | null = null
  try {
    const res = await axios.get(url, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      timeout: 10000,
      validateStatus: () => true,
    })
    if (res.status === 200 && Array.isArray(res.data?.data)) {
      ids = new Set(res.data.data.map((m: any) => m.id))
    }
  } catch {
    /* keep null: try the configured chain as-is */
  }
  modelListCache.set(url, { at: Date.now(), ids })
  return ids
}

const onlyLive = (chain: string[], live: Set<string> | null) => (live ? chain.filter((m) => live.has(m)) : chain)

async function getModelChain(primary?: string): Promise<string[]> {
  const chain: string[] = []
  if (primary) chain.push(primary)
  for (const m of FREE_MODEL_FALLBACKS) {
    if (!chain.includes(m)) chain.push(m)
  }
  return onlyLive(chain, await liveModels('https://openrouter.ai/api/v1/models'))
}

async function getGroqChain(): Promise<string[]> {
  return onlyLive(GROQ_MODEL_FALLBACKS, await liveModels('https://api.groq.com/openai/v1/models', getGroqKey()))
}

// The OpenRouter free tier has an account-wide daily cap. Once it is hit, every free model answers
// 429, so skip straight to Groq until the cap resets (next UTC midnight).
let openRouterCappedUntil = 0
const isDailyCap = (data: unknown) => /free-models-per-day|per[- ]day/i.test(JSON.stringify(data ?? ''))
const nextUtcMidnight = () => {
  const d = new Date()
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1)
}

interface AIGenerationParams {
  model: string
  messages: Array<{ role: string; content: string }>
  temperature?: number
  max_tokens?: number
}

interface CoverLetterParams {
  jobTitle: string
  company: string
  jobDescription: string
  userProfile: {
    firstName: string
    lastName: string
    yearsOfExperience: string
    skills: string[]
    summary: string
  }
  tone?: 'professional' | 'casual' | 'enthusiastic'
}

interface AnswerQuestionParams {
  question: string
  questionType: 'text' | 'textarea' | 'select' | 'radio' | 'checkbox' | 'file'
  options?: string[]
  jobDescription: string
  userProfile: any
}

export class AIPipelineService {
  /** Provider/model that answered the most recent call (diagnostics and test metrics). */
  lastModelUsed: string | null = null

  private async callAI(params: AIGenerationParams): Promise<string> {
    const chain = Date.now() < openRouterCappedUntil
      ? []
      : await getModelChain(params.model || process.env.OPENROUTER_MODEL)
    let lastError: any = chain.length === 0 ? new Error('OpenRouter free-tier daily cap reached') : null

    for (let i = 0; i < chain.length; i++) {
      const model = chain[i]
      try {
        const response = await axios.post(
          OPENROUTER_URL,
          {
            model,
            messages: params.messages,
            temperature: params.temperature ?? 0.7,
            max_tokens: params.max_tokens ?? 2000,
          },
          {
            headers: {
              Authorization: `Bearer ${getOpenRouterKey()}`,
              'Content-Type': 'application/json',
              'HTTP-Referer': 'https://applify.id',
              'X-Title': 'Applify Job Automation',
            },
            // Validate so that 4xx/5xx throw and we can catch + retry.
            validateStatus: () => true,
          }
        )

        // 429 = rate limited → try next model, or skip OpenRouter entirely if the daily cap is hit
        if (response.status === 429) {
          lastError = new Error(`Rate limited (429) on ${model}`)
          if (isDailyCap(response.data)) {
            console.warn('[AI] OpenRouter free-tier daily cap reached; using Groq until UTC midnight')
            openRouterCappedUntil = nextUtcMidnight()
            break
          }
          console.warn(`[AI] 429 rate-limited on ${model}, switching to next model...`)
          await new Promise((r) => setTimeout(r, 1500)) // brief backoff
          continue
        }

        // Other non-OK statuses → throw to catch below
        if (response.status < 200 || response.status >= 300) {
          throw new Error(`OpenRouter ${response.status}: ${JSON.stringify(response.data)}`)
        }

        // Some free (reasoning) models answer 200 with an empty `content` when they spend the token
        // budget on hidden reasoning. An empty draft is a failure, not a success → try the next model.
        const content: string = response.data?.choices?.[0]?.message?.content ?? ''
        if (!content.trim()) {
          console.warn(`[AI] Empty completion from ${model}, switching to next model...`)
          lastError = new Error(`Empty completion from ${model}`)
          continue
        }
        if (i > 0) {
          console.log(`[AI] Succeeded on fallback model ${model} (after ${i} retry)`)
        }
        this.lastModelUsed = `openrouter:${model}`
        return content
      } catch (error: any) {
        const msg = error.message || ''
        const status = error.response?.status
        // 429 or rate-limit error → try next model
        if (status === 429 || /429|rate.?limit/i.test(msg)) {
          console.warn(`[AI] Rate limited on ${model} (${msg.substring(0, 60)}), switching to next model...`)
          lastError = error
          await new Promise((r) => setTimeout(r, 1500))
          continue
        }
        // Non-rate-limit error → log and try next model too (more resilient)
        console.error(`[AI] Error on ${model}: ${msg.substring(0, 80)}`)
        lastError = error
        // Still try next model as fallback
        continue
      }
    }

    // All OpenRouter models exhausted → try Groq backup provider
    if (getGroqKey()) {
      console.warn(`[AI] All OpenRouter models exhausted. Trying Groq backup provider...`)
      const groqResult = await this.callGroq(params)
      if (groqResult !== null) {
        return groqResult
      }
    }

    throw new Error(`AI generation failed after ${chain.length} OpenRouter + Groq model attempts. Last: ${lastError?.message || 'unknown'}`)
  }

  // Groq backup provider — OpenAI-compatible API at api.groq.com.
  // Returns null if all Groq models fail (so caller can throw combined error).
  private async callGroq(params: AIGenerationParams): Promise<string | null> {
    const groqKey = getGroqKey()
    if (!groqKey) return null

    const groqChain = await getGroqChain()
    for (let i = 0; i < groqChain.length; i++) {
      const model = groqChain[i]
      try {
        const response = await axios.post(
          GROQ_URL,
          {
            model,
            messages: params.messages,
            temperature: params.temperature ?? 0.7,
            max_tokens: params.max_tokens ?? 2000,
          },
          {
            headers: {
              Authorization: `Bearer ${groqKey}`,
              'Content-Type': 'application/json',
            },
            validateStatus: () => true,
          }
        )

        if (response.status === 429) {
          console.warn(`[AI] Groq 429 on ${model}, trying next Groq model...`)
          await new Promise((r) => setTimeout(r, 1500))
          continue
        }

        if (response.status < 200 || response.status >= 300) {
          throw new Error(`Groq ${response.status}: ${JSON.stringify(response.data).substring(0, 100)}`)
        }

        const content: string = response.data?.choices?.[0]?.message?.content ?? ''
        if (!content.trim()) {
          console.warn(`[AI] Empty completion from Groq ${model}, trying next Groq model...`)
          continue
        }
        console.log(`[AI] Succeeded on Groq model ${model} (backup provider)`)
        this.lastModelUsed = `groq:${model}`
        return content
      } catch (error: any) {
        console.error(`[AI] Groq error on ${model}: ${(error.message || '').substring(0, 80)}`)
        await new Promise((r) => setTimeout(r, 1500))
        continue
      }
    }
    return null
  }

  async generateCoverLetter(params: CoverLetterParams & { userId?: string }): Promise<string> {
    const { jobTitle, company, jobDescription, userProfile, tone = 'professional', userId } = params
    const startTime = Date.now()

    const prompt = `Write a compelling cover letter for a ${jobTitle} position at ${company}.

Job Description:
${jobDescription}

Candidate Profile:
- Name: ${userProfile.firstName} ${userProfile.lastName}
- Experience: ${userProfile.yearsOfExperience} years
- Skills: ${userProfile.skills.join(', ')}
- Background: ${userProfile.summary}

Instructions:
- Tone: ${tone}
- Length: 200-300 words
- Highlight relevant skills and experience
- Show enthusiasm for the company and role
- Include a strong call to action
- Do NOT use generic templates - make it personalized

Write the cover letter now (just the body, no header/footer):`

    // Use free model for Free tier, Claude for Pro tier
    const model = getOpenRouterKey() ? (process.env.OPENROUTER_MODEL || 'openai/gpt-oss-20b:free') : 'openrouter/free'

    const result = await this.callAI({
      model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.8,
      max_tokens: 1500,
    })

    // Trace the generation
    await tracingService.traceAIGeneration({
      userId,
      type: 'cover_letter',
      model,
      prompt,
      output: result,
      duration: Date.now() - startTime,
    })

    return result
  }

  /**
   * Tulis ulang surat lamaran yang sudah ada mengikuti instruksi pengguna (layar persetujuan, tombol
   * "Tulis ulang"). Fakta dari surat asli dipertahankan; model dilarang menambah fakta baru.
   */
  async regenerateCoverLetter(params: {
    original: string
    instructions: string
    jobTitle: string
    company: string
    jobDescription: string
    userId?: string
  }): Promise<string> {
    const { original, instructions, jobTitle, company, jobDescription, userId } = params
    const startTime = Date.now()

    const prompt = `Rewrite the cover letter below for a ${jobTitle} position at ${company}.

Candidate's instructions for the rewrite:
${instructions}

Rules:
- Keep every fact that is in the original letter. Do NOT invent employers, degrees, skills, numbers or dates.
- Keep the same language as the original letter.
- Output only the letter body (no header, footer, subject line or commentary).

Job Description:
${jobDescription || '(not available)'}

Original cover letter:
${original}`

    const model = getOpenRouterKey() ? (process.env.OPENROUTER_MODEL || 'openai/gpt-oss-20b:free') : 'openrouter/free'

    const result = await this.callAI({
      model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.7,
      max_tokens: 1500,
    })

    await tracingService.traceAIGeneration({
      userId,
      type: 'cover_letter',
      model,
      prompt,
      output: result,
      duration: Date.now() - startTime,
      metadata: { regenerate: true },
    })

    return result
  }

  async generateAnswer(params: AnswerQuestionParams): Promise<string> {
    const { question, questionType, options, jobDescription, userProfile } = params

    let prompt = `You are helping a job applicant answer an application question.

Question: "${question}"
Question Type: ${questionType}
Job Description: ${jobDescription}
Candidate Info: ${JSON.stringify(userProfile, null, 2)}
`

    if (options && options.length > 0) {
      prompt += `\nAvailable Options: ${options.join(', ')}`
    }

    prompt += `\n\nProvide a concise, relevant answer. For ${questionType} questions, `

    switch (questionType) {
      case 'text':
        prompt += 'provide a brief, factual answer (1-2 sentences).'
        break
      case 'textarea':
        prompt += 'provide a well-structured, detailed paragraph response.'
        break
      case 'select':
      case 'radio':
        prompt += `choose the BEST option from: ${options?.join(', ')}. Respond with ONLY the chosen option text.`
        break
      case 'checkbox':
        prompt += `select ALL applicable options from: ${options?.join(', ')}. Respond with the chosen options separated by commas.`
        break
      default:
        prompt += 'provide an appropriate answer.'
    }

    const model = getOpenRouterKey() ? (process.env.OPENROUTER_MODEL || 'openai/gpt-oss-20b:free') : 'openrouter/free'

    return this.callAI({
      model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.6,
      max_tokens: 800,
    })
  }

  async extractSkills(jobDescription: string): Promise<string[]> {
    const prompt = `Extract the top 10 most important skills from this job description. Return ONLY a comma-separated list of skills.

Job Description:
${jobDescription}`

    const model = getOpenRouterKey() ? (process.env.OPENROUTER_MODEL || 'openai/gpt-oss-20b:free') : 'openrouter/free'

    const response = await this.callAI({
      model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.3,
      max_tokens: 300,
    })

    return response.split(',').map((s: string) => s.trim()).filter(Boolean)
  }

  async analyzeJobMatch(jobDescription: string, userSkills: string[]): Promise<{
    matchScore: number
    skillGaps: string[]
    missingSkills: string[]
    recommendation: string
  }> {
    const prompt = `Analyze how well this candidate matches the job based on their skills.

Job Description:
${jobDescription}

Candidate Skills: ${userSkills.join(', ')}

Provide analysis in this exact format:
MATCH_SCORE: [0-100 number]
SKILL_GAPS: [comma-separated list of skills they should learn]
MISSING_SKILLS: [comma-separated list of required skills they don't have]
RECOMMENDATION: [1-2 sentence recommendation]`

    const model = getOpenRouterKey() ? (process.env.OPENROUTER_MODEL || 'openai/gpt-oss-20b:free') : 'openrouter/free'

    const response = await this.callAI({
      model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.4,
      max_tokens: 500,
    })

    const matchScore = parseInt(response.match(/MATCH_SCORE:\s*(\d+)/)?.[1] || '50')
    const skillGaps = response.match(/SKILL_GAPS:\s*(.+)/)?.[1]?.split(',').map((s: string) => s.trim()) || []
    const missingSkills = response.match(/MISSING_SKILLS:\s*(.+)/)?.[1]?.split(',').map((s: string) => s.trim()) || []
    const recommendation = response.match(/RECOMMENDATION:\s*(.+)/)?.[1] || 'Review the job requirements carefully.'

    return { matchScore, skillGaps, missingSkills, recommendation }
  }

  // ─── CV / Resume Generation ───────────────────────────────────────────────

  async generateCV(params: {
    userProfile: {
      firstName: string
      lastName: string
      currentTitle?: string
      email?: string
      phone?: string
      location?: string
      linkedinUrl?: string
      yearsOfExperience: string
      skills: string[]
      summary: string
      workExperiences?: Array<{ role_title: string; company_name: string; start_date: string; end_date?: string; description?: string }>
      education?: Array<{ degree: string; field_of_study: string; institution: string; start_year?: number; end_year?: number }>
    }
    jobTitle: string
    company: string
    jobDescription: string
    userId?: string
  }): Promise<string> {
    const { userProfile, jobTitle, company, jobDescription, userId } = params
    const startTime = Date.now()

    const expLines = (userProfile.workExperiences || [])
      .map(e => `  - ${e.role_title} at ${e.company_name} (${e.start_date}${e.end_date ? ' - ' + e.end_date : ' - present'})${e.description ? ': ' + e.description : ''}`)
      .join('\n')

    const eduLines = (userProfile.education || [])
      .map(e => `  - ${e.degree} in ${e.field_of_study} at ${e.institution} (${e.start_year || ''}-${e.end_year || ''})`)
      .join('\n')

    const prompt = `You are an expert CV/resume writer specializing in ATS-optimized resumes.

TASK: Create a professional, ATS-friendly CV/resume for the following candidate, tailored to the target job.

=== TARGET JOB ===
Title: ${jobTitle}
Company: ${company}
Job Description:
${jobDescription}

=== CANDIDATE PROFILE ===
Name: ${userProfile.firstName} ${userProfile.lastName}
Current Title: ${userProfile.currentTitle || 'N/A'}
Email: ${userProfile.email || 'candidate@email.com'}
Phone: ${userProfile.phone || '+62-xxx-xxx-xxxx'}
Location: ${userProfile.location || 'Indonesia'}
LinkedIn: ${userProfile.linkedinUrl || 'linkedin.com/in/candidate'}
Years of Experience: ${userProfile.yearsOfExperience}
Skills: ${userProfile.skills.join(', ')}
Summary: ${userProfile.summary}

Work Experience:
${expLines || '  (See summary above)'}

Education:
${eduLines || '  (Not specified)'}

=== REQUIREMENTS ===
1. ATS-OPTIMIZED: Use standard section headings, no tables/columns/text boxes, no graphics
2. KEYWORD-OPTIMIZED: Naturally incorporate keywords from the job description
3. ACTION VERBS: Start bullet points with strong action verbs (Led, Developed, Implemented, Achieved, etc.)
4. QUANTIFIABLE: Include metrics, percentages, and numbers where possible
5. TAILORED: Highlight experience most relevant to ${jobTitle} at ${company}
6. PROFESSIONAL: Clean, single-column, easy to parse
7. DENSE & COMPLETE: This CV MUST be substantial and information-rich. Aim for a FULL one page minimum (and two pages if the candidate has enough experience). Do NOT leave sections thin. Every section should be well-developed with concrete detail. Never fabricate skills, roles, or metrics the candidate does not have.

=== OUTPUT FORMAT (plain text, ATS-friendly) ===
Use this EXACT structure:

[FULL NAME]
[Phone] | [Email] | [Location] | [LinkedIn]

PROFESSIONAL SUMMARY
[5-6 sentences. Detailed summary covering: years of experience, seniority level, core domain expertise, signature achievements with numbers, key technical stack, and clear alignment with the target role. Be specific and dense — no fluff.]

CORE COMPETENCIES
[Comma-separated list of 15-22 relevant skills/keywords drawn from the job description and the candidate's actual profile]

PROFESSIONAL EXPERIENCE
[Job Title] | [Company] | [Location] | [Start Date - End Date]
  - [Action verb bullet point with quantifiable achievement + context, 25-40 words]
  - [Action verb bullet point with quantifiable achievement + context, 25-40 words]
  - [Action verb bullet point with quantifiable achievement + context, 25-40 words]
  - [Action verb bullet point with quantifiable achievement + context, 25-40 words]
  - [Action verb bullet point with quantifiable achievement + context, 25-40 words]

[Previous Job Title] | [Company] | [Location] | [Start Date - End Date]
  - [Action verb bullet point with quantifiable achievement + context, 20-35 words]
  - [Action verb bullet point with quantifiable achievement + context, 20-35 words]
  - [Action verb bullet point with quantifiable achievement + context, 20-35 words]
  - [Action verb bullet point with quantifiable achievement + context, 20-35 words]

[Earlier Job Title] | [Company] | [Location] | [Start Date - End Date]
  - [Action verb bullet point with quantifiable achievement]
  - [Action verb bullet point with quantifiable achievement]
  - [Action verb bullet point with quantifiable achievement]

KEY PROJECTS
  - [Project name]: [1-2 sentence description with technologies used and measurable impact]
  - [Project name]: [1-2 sentence description with technologies used and measurable impact]

EDUCATION
[Degree] in [Field of Study] | [Institution] | [Graduation Year]

CERTIFICATIONS & ACHIEVEMENTS
  - [Relevant certification or achievement]
  - [Relevant certification or achievement]
  - [Relevant certification or achievement]

TECHNICAL SKILLS
[Group technical skills by category: Languages, Frameworks, Databases, Tools/Cloud, Methodologies]

=== IMPORTANT ===
- Generate REALISTIC but professional content strictly based on the candidate's actual profile. Do NOT exaggerate seniority, invent skills, or claim experience the candidate does not have.
- Expand sparse work history into plausible, role-appropriate achievements using the candidate's real title and skills — stay within reason.
- Each recent job should have 4-5 detailed bullet points; earlier jobs 3 bullets.
- Keep the entire CV to approximately 600-850 words so it fills ONE full page, or at most TWO pages for very experienced candidates (10+ years, 4+ roles). Avoid padding — do not exceed 2 pages. Only produce less if the candidate genuinely has very little experience — and say so in the evaluation.
- Do NOT include any meta-commentary, just the CV content.
- Use real dates (month year format) for experience.

Generate the CV now:`

    const model = getOpenRouterKey() ? (process.env.OPENROUTER_MODEL || 'openai/gpt-oss-20b:free') : 'openrouter/free'

    const result = await this.callAI({
      model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.7,
      max_tokens: 2800,
    })

    await tracingService.traceAIGeneration({
      userId,
      type: 'cv_generation',
      model,
      prompt,
      output: result,
      duration: Date.now() - startTime,
    })

    return result
  }

  // ─── CV Evaluation & Scoring ──────────────────────────────────────────────

  async evaluateCV(params: {
    cvText: string
    jobTitle: string
    company: string
    jobDescription: string
    userId?: string
  }): Promise<{
    overallScore: number
    atsCompatibilityScore: number
    keywordMatchScore: number
    contentQualityScore: number
    formattingScore: number
    strengths: string[]
    weaknesses: string[]
    missingKeywords: string[]
    recommendations: string[]
    lengthAssessment: string
    summary: string
  }> {
    const { cvText, jobTitle, company, jobDescription, userId } = params
    const startTime = Date.now()

    const prompt = `You are an expert ATS (Applicant Tracking System) analyzer and resume reviewer.

TASK: Evaluate the following CV/resume against the target job and provide a detailed assessment with scores.

=== TARGET JOB ===
Title: ${jobTitle}
Company: ${company}
Job Description:
${jobDescription}

=== CANDIDATE CV ===
${cvText}

=== EVALUATION CRITERIA ===
Score each category from 0-100:

1. ATS_COMPATIBILITY: How well will ATS software parse this CV? (standard headings, no tables/columns, plain text, standard fonts)
2. KEYWORD_MATCH: How many keywords from the job description appear in the CV?
3. CONTENT_QUALITY: Are achievements quantified? Are action verbs used? Is content relevant and impactful?
4. FORMATTING: Is the layout clean, consistent, and professional? Proper section order?

=== OUTPUT FORMAT ===
Provide your evaluation in this EXACT format:

OVERALL_SCORE: [0-100]
ATS_COMPATIBILITY_SCORE: [0-100]
KEYWORD_MATCH_SCORE: [0-100]
CONTENT_QUALITY_SCORE: [0-100]
FORMATTING_SCORE: [0-100]

STRENGTHS:
- [strength 1]
- [strength 2]
- [strength 3]

WEAKNESSES:
- [weakness 1]
- [weakness 2]
- [weakness 3]

MISSING_KEYWORDS:
- [keyword from job description not found in CV]
- [keyword from job description not found in CV]

RECOMMENDATIONS:
- [actionable recommendation 1]
- [actionable recommendation 2]
- [actionable recommendation 3]
- [actionable recommendation 4]

LENGTH_ASSESSMENT: [Assess whether the CV fills a full page (1 page minimum) or extends to 2 pages. Explain in 1-2 sentences WHY — e.g. sufficient experience and detail for 2 pages, or limited history so 1 page is appropriate and rational. Do not exaggerate.]

SUMMARY: [2-3 sentence overall assessment of the CV's effectiveness for this specific job]`

    const model = getOpenRouterKey() ? (process.env.OPENROUTER_MODEL || 'openai/gpt-oss-20b:free') : 'openrouter/free'

    const response = await this.callAI({
      model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.4,
      max_tokens: 1500,
    })

    await tracingService.traceAIGeneration({
      userId,
      type: 'cv_evaluation',
      model,
      prompt,
      output: response,
      duration: Date.now() - startTime,
    })

    const overallScore = parseInt(response.match(/OVERALL_SCORE:\s*(\d+)/)?.[1] || '50')
    const atsCompatibilityScore = parseInt(response.match(/ATS_COMPATIBILITY_SCORE:\s*(\d+)/)?.[1] || '50')
    const keywordMatchScore = parseInt(response.match(/KEYWORD_MATCH_SCORE:\s*(\d+)/)?.[1] || '50')
    const contentQualityScore = parseInt(response.match(/CONTENT_QUALITY_SCORE:\s*(\d+)/)?.[1] || '50')
    const formattingScore = parseInt(response.match(/FORMATTING_SCORE:\s*(\d+)/)?.[1] || '50')

    const strengthsBlock = response.match(/STRENGTHS:\s*\n([\s\S]*?)(?=\n\n|\nWEAKNESSES:)/)?.[1] || ''
    const weaknessesBlock = response.match(/WEAKNESSES:\s*\n([\s\S]*?)(?=\n\n|\nMISSING_KEYWORDS:)/)?.[1] || ''
    const missingBlock = response.match(/MISSING_KEYWORDS:\s*\n([\s\S]*?)(?=\n\n|\nRECOMMENDATIONS:)/)?.[1] || ''
    const recBlock = response.match(/RECOMMENDATIONS:\s*\n([\s\S]*?)(?=\n\n|\nLENGTH_ASSESSMENT:)/)?.[1] || ''
    const lengthAssessment = response.match(/LENGTH_ASSESSMENT:\s*(.+)/)?.[1]?.trim() || 'Length assessment unavailable.'
    const summary = response.match(/SUMMARY:\s*(.+)/)?.[1]?.trim() || 'Review needed.'

    const parseBullets = (block: string) =>
      block.split('\n').map(l => l.replace(/^[-•]\s*/, '').trim()).filter(Boolean)

    return {
      overallScore,
      atsCompatibilityScore,
      keywordMatchScore,
      contentQualityScore,
      formattingScore,
      strengths: parseBullets(strengthsBlock),
      weaknesses: parseBullets(weaknessesBlock),
      missingKeywords: parseBullets(missingBlock),
      recommendations: parseBullets(recBlock),
      lengthAssessment,
      summary,
    }
  }
}

export const aiPipelineService = new AIPipelineService()
