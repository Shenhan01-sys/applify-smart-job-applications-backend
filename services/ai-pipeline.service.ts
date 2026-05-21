import axios from 'axios'
import { tracingService } from './tracing.service.js'

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions'

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
  private async callAI(params: AIGenerationParams): Promise<string> {
    try {
      const response = await axios.post(
        OPENROUTER_URL,
        {
          model: params.model,
          messages: params.messages,
          temperature: params.temperature ?? 0.7,
          max_tokens: params.max_tokens ?? 2000,
        },
        {
          headers: {
            Authorization: `Bearer ${OPENROUTER_API_KEY}`,
            'Content-Type': 'application/json',
            'HTTP-Referer': 'https://applify.id',
            'X-Title': 'Applify Job Automation',
          },
        }
      )

      return response.data.choices[0]?.message?.content || ''
    } catch (error: any) {
      console.error('AI generation failed:', error.response?.data || error.message)
      throw new Error(`AI generation failed: ${error.message}`)
    }
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
    const model = OPENROUTER_API_KEY ? 'anthropic/claude-3.5-sonnet' : 'openrouter/free'

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

    const model = OPENROUTER_API_KEY ? 'anthropic/claude-3.5-sonnet' : 'openrouter/free'

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

    const model = OPENROUTER_API_KEY ? 'anthropic/claude-3.5-sonnet' : 'openrouter/free'

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

    const model = OPENROUTER_API_KEY ? 'anthropic/claude-3.5-sonnet' : 'openrouter/free'

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
}

export const aiPipelineService = new AIPipelineService()
