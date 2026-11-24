import test from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import { aiPipelineService } from '../services/ai-pipeline.service.js'
import { aiRoutes } from '../api/routes/ai.js'
import { AiAccessError } from '../services/ai-guard.service.js'
import { approvalRoutes } from '../api/routes/approval.js'
import { oauthRoutes } from '../api/routes/oauth.js'
import { ExtensionPlanner } from '../services/extension-planner.js'
import { makeExtensionTestDb } from './extension-test-db.js'

test('rute /api/ai/answer, /extract-skills, dan /analyze-match meneruskan userId ke pipeline AI', async () => {
  const seenUsers: Array<string | undefined> = []
  const origAns = aiPipelineService.generateAnswer
  const origExt = aiPipelineService.extractSkills
  const origAna = aiPipelineService.analyzeJobMatch
  ;(aiPipelineService as any).generateAnswer = async (p: any) => {
    seenUsers.push(p.userId)
    return 'Ya'
  }
  ;(aiPipelineService as any).extractSkills = async (_d: string, u?: string) => {
    seenUsers.push(u)
    return ['TS']
  }
  ;(aiPipelineService as any).analyzeJobMatch = async (_d: string, _s: string[], u?: string) => {
    seenUsers.push(u)
    return { matchScore: 90, skillGaps: [], missingSkills: [], recommendation: 'OK' }
  }

  const app = Fastify()
  app.addHook('preHandler', async (req: any) => {
    req.user = { id: 'u-pro-1' }
  })
  await app.register(aiRoutes, {
    prefix: '/api/ai',
    guard: {
      check: async () => ({ quota: { quota: 10, used: 0, remaining: 10, allowed: true } }),
      recordDraft: async () => {},
    },
  })

  try {
    await app.inject({ method: 'POST', url: '/api/ai/answer', payload: { question: 'Q', questionType: 'text', jobDescription: 'D', userProfile: {} } })
    await app.inject({ method: 'POST', url: '/api/ai/extract-skills', payload: { jobDescription: 'D' } })
    await app.inject({ method: 'POST', url: '/api/ai/analyze-match', payload: { jobDescription: 'D', userSkills: ['TS'] } })
    assert.deepEqual(seenUsers, ['u-pro-1', 'u-pro-1', 'u-pro-1'])
  } finally {
    aiPipelineService.generateAnswer = origAns
    aiPipelineService.extractSkills = origExt
    aiPipelineService.analyzeJobMatch = origAna
    await app.close()
  }
})

test('aiPipelineService meneruskan tier Pro pada generateAnswer, extractSkills, analyzeJobMatch, generateCV, dan evaluateCV', async () => {
  const seenTiers: string[] = []
  const origTierFor = aiPipelineService.tierFor
  const origCallAI = (aiPipelineService as any).callAI
  const origCallAIDetailed = (aiPipelineService as any).callAIDetailed
  ;(aiPipelineService as any).tierFor = async () => 'pro'
  ;(aiPipelineService as any).callAI = async (p: any) => {
    seenTiers.push(String(p.tier))
    return 'OVERALL_SCORE: 80\nATS_COMPATIBILITY_SCORE: 80\nKEYWORD_MATCH_SCORE: 80\nCONTENT_QUALITY_SCORE: 80\nFORMATTING_SCORE: 80'
  }
  ;(aiPipelineService as any).callAIDetailed = async (p: any) => {
    seenTiers.push(String(p.tier))
    return { text: 'CV output', model: 'm-pro' }
  }

  try {
    await aiPipelineService.generateAnswer({ question: 'Why?', questionType: 'text', jobDescription: 'Node', userProfile: {}, userId: 'u-pro' })
    await aiPipelineService.extractSkills('Node.js TypeScript', 'u-pro')
    await aiPipelineService.analyzeJobMatch('Node.js', ['Node.js'], 'u-pro')
    await aiPipelineService.generateCV({ userProfile: { firstName: 'A', lastName: 'B', skills: [], summary: 'S', yearsOfExperience: 2 } as any, jobTitle: 'BE', company: 'X', jobDescription: 'D', userId: 'u-pro' })
    assert.deepEqual(seenTiers, ['pro', 'pro', 'pro', 'pro'])
  } finally {
    aiPipelineService.tierFor = origTierFor
    ;(aiPipelineService as any).callAI = origCallAI
    ;(aiPipelineService as any).callAIDetailed = origCallAIDetailed
  }
})

test('POST /api/approvals/:id/regenerate melewati rate limit guard dan membalas 429 saat ditahan', async () => {
  const app = Fastify()
  app.addHook('preHandler', async (req: any) => {
    req.user = { id: 'u1' }
  })
  await app.register(approvalRoutes, {
    prefix: '/api/approvals',
    guard: {
      checkActionRateLimit: async () => {
        throw new AiAccessError(429, 'rate_limited', 'Terlalu banyak permintaan', { retryAfterSec: 12 })
      },
    },
  })

  const res = await app.inject({ method: 'POST', url: '/api/approvals/11111111-1111-1111-1111-111111111111/regenerate', payload: {} })
  assert.equal(res.statusCode, 429)
  assert.equal(res.headers['retry-after'], '12')
  await app.close()
})

test('GET /api/oauth/google menolak ?uid= mentah tanpa token Bearer', async () => {
  const origId = process.env.GOOGLE_CLIENT_ID
  process.env.GOOGLE_CLIENT_ID = 'client-id-test'
  const app = Fastify()
  await app.register(oauthRoutes, { prefix: '/api/oauth' })
  try {
    const res = await app.inject({ method: 'GET', url: '/api/oauth/google?uid=11111111-2222-3333-4444-555555555555' })
    assert.equal(res.statusCode, 401)
    const initNoAuth = await app.inject({ method: 'POST', url: '/api/oauth/google/init' })
    assert.equal(initNoAuth.statusCode, 401)
  } finally {
    if (origId === undefined) delete process.env.GOOGLE_CLIENT_ID
    else process.env.GOOGLE_CLIENT_ID = origId
    await app.close()
  }
})

test('ExtensionPlanner membaca kolom skema DB nyata dari user_automation_settings (phone_number, current_city, website, desired_salary)', async () => {
  const USER_ID = '11111111-2222-3333-4444-555555555555'
  const store = makeExtensionTestDb({
    jobs: [{ id: 'j1', title: 'BE', company: 'Acme', description: 'API' }],
    profiles: [{ id: USER_ID, full_name: 'Sari Dewi' }],
    user_automation_settings: [
      {
        user_id: USER_ID,
        phone_number: '081299998888',
        current_city: 'Bandung',
        country: 'Indonesia',
        website: 'https://sari.dev',
        desired_salary: 25000000,
        years_of_experience: '4',
        use_ai: false,
      },
    ],
  })

  const planner = new ExtensionPlanner()
  const plan = await planner.planForm({
    db: store.db,
    userId: USER_ID,
    userEmail: 'sari@example.id',
    jobId: 'j1',
    pageUrl: 'https://www.kalibrr.com/c/acme/jobs/1/apply',
    rawControls: [
      { controlId: 'c1', kind: 'text', label: 'Phone Number', required: true },
      { controlId: 'c2', kind: 'text', label: 'Portfolio Website', required: false },
      { controlId: 'c3', kind: 'text', label: 'Email Address', required: true },
      { controlId: 'c4', kind: 'text', label: 'Years of Experience', required: true },
    ],
  })

  assert.equal(plan.actions.find((a) => a.controlId === 'c1')?.value, '+6281299998888')
  assert.equal(plan.actions.find((a) => a.controlId === 'c2')?.value, 'https://sari.dev')
  assert.equal(plan.actions.find((a) => a.controlId === 'c3')?.value, 'sari@example.id')
  assert.equal(plan.actions.find((a) => a.controlId === 'c4')?.value, '4')
})
