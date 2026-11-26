import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import { FakeDb } from './helpers/fakeDb.ts'
import { aiPipelineService } from '../services/ai-pipeline.service.ts'
import { formAutofillService, type FormContext, type FormField } from '../services/form-autofill.service.ts'
import { buildApprovalAnswers, prepareApprovalAnswers } from '../services/approval-answers.service.ts'
import { workAuthorizationFromUsCitizenship as fromPlanner } from '../services/extension-planner.ts'
import {
  citizenshipFormAnswer,
  isUsJobLocation,
  workAuthorizationFromUsCitizenship,
} from '../services/us-work-authorization.ts'
import { aiRoutes } from '../api/routes/ai.ts'

/**
 * `us_citizenship` (teks bebas, soal Amerika Serikat) dijawab hanya untuk lowongan yang negaranya jelas Amerika Serikat
 * dan hanya dengan nilai persis. Aturannya satu helper (us-work-authorization.ts) yang dipakai planner ekstensi dan
 * FormAutofillService. AI diganti tiruan yang melempar: tidak ada panggilan model di sini.
 */

;(aiPipelineService as any).generateAnswer = async () => {
  throw new Error('real AI call blocked in tests')
}

const US = 'San Francisco, CA, United States'
const settings = (usCitizenship: unknown) => ({ first_name: 'Budi', last_name: 'Uji', us_citizenship: usCitizenship, use_ai: false })
const ctx = (usCitizenship: unknown, jobLocation?: string | null): FormContext => ({
  jobTitle: 'Engineer',
  company: 'Acme',
  jobDescription: '',
  userSettings: settings(usCitizenship),
  userProfile: { email: 'x@example.test' },
  ...(jobLocation !== undefined ? { jobLocation } : {}),
})
const field = (label: string, options?: string[]): FormField => ({
  type: options ? 'select' : 'text',
  label,
  ...(options ? { options } : {}),
})
const fill = (label: string, c: FormContext, options?: string[]) => formAutofillService.fillField(field(label, options), c)

afterEach(() => {
  ;(aiPipelineService as any).generateAnswer = async () => {
    throw new Error('real AI call blocked in tests')
  }
})

test('helper bersama: planner dan form-autofill memakai fungsi yang sama', () => {
  assert.equal(fromPlanner, workAuthorizationFromUsCitizenship)
})

test('helper: nilai persis dan hanya untuk lowongan AS; Non-citizen dan sejenisnya tidak pernah Yes', () => {
  for (const v of ['US Citizen', 'u.s. citizen', 'Citizen', 'Permanent Resident', 'green-card holder', 'Green Card', 'yes', 'Ya']) {
    assert.equal(workAuthorizationFromUsCitizenship(v, US), 'Yes', v)
  }
  for (const v of ['Non-citizen', 'Not a citizen', 'No', 'Citizen of Indonesia', 'Decline', 'H-1B holder', '', null, undefined]) {
    assert.equal(workAuthorizationFromUsCitizenship(v, US), '', String(v))
  }
  for (const loc of ['Jakarta, Indonesia', 'London, United Kingdom', 'Remote', 'Austin, TX', '', null, undefined]) {
    assert.equal(workAuthorizationFromUsCitizenship('US Citizen', loc), '', String(loc))
    assert.equal(isUsJobLocation(loc), false, String(loc))
  }
  assert.equal(isUsJobLocation('Austin, TX, USA'), true)
  assert.equal(isUsJobLocation('Amerika Serikat'), true)
})

test('helper: pertanyaan dengan pilihan hanya dijawab dari pilihan persis atau Yes; tanpa kecocokan kosong dengan keyakinan 0', () => {
  const none = { value: '', confidence: 0 }
  // pilihan yang persis sama dengan nilai pengguna
  assert.deepEqual(citizenshipFormAnswer({ usCitizenship: 'US Citizen', jobLocation: US, options: ['Non-citizen', 'US Citizen', 'Decline'] }), { value: 'US Citizen', confidence: 0.9 })
  // nilai "Non-citizen" milik pengguna dijawab dengan pilihan "Non-citizen" yang persis sama, bukan pilihan pertama
  assert.deepEqual(citizenshipFormAnswer({ usCitizenship: 'Non-citizen', jobLocation: US, options: ['US Citizen', 'Non-citizen'] }), { value: 'Non-citizen', confidence: 0.9 })
  // ya/tidak: berhak bekerja -> opsi Yes; tidak berhak -> kosong (tidak ada "No" yang diada-adakan)
  assert.deepEqual(citizenshipFormAnswer({ usCitizenship: 'Permanent Resident', jobLocation: US, options: ['No', 'Yes'], eligibleToWork: true }), { value: 'Yes', confidence: 0.9 })
  assert.deepEqual(citizenshipFormAnswer({ usCitizenship: 'Non-citizen', jobLocation: US, options: ['Yes', 'No'], eligibleToWork: true }), none)
  // tanpa kecocokan: tidak ada opsi pertama atau "Decline"
  assert.deepEqual(citizenshipFormAnswer({ usCitizenship: 'US Citizen', jobLocation: US, options: ['Citizen of another country', 'Decline'] }), none)
  // teks bebas
  assert.deepEqual(citizenshipFormAnswer({ usCitizenship: 'US Citizen', jobLocation: US, eligibleToWork: true }), { value: 'Yes', confidence: 0.9 })
  assert.deepEqual(citizenshipFormAnswer({ usCitizenship: 'US Citizen', jobLocation: US }), { value: 'US Citizen', confidence: 0.9 })
  assert.deepEqual(citizenshipFormAnswer({ usCitizenship: 'yes', jobLocation: US }), none) // "yes" bukan jawaban kewarganegaraan
  assert.deepEqual(citizenshipFormAnswer({ usCitizenship: 'Non-citizen', jobLocation: US, eligibleToWork: true }), none)
  // data kosong atau lowongan bukan AS
  assert.deepEqual(citizenshipFormAnswer({ usCitizenship: '', jobLocation: US, options: ['Decline'] }), none)
  assert.deepEqual(citizenshipFormAnswer({ usCitizenship: 'US Citizen', jobLocation: 'Jakarta, Indonesia', options: ['US Citizen'] }), none)
  assert.deepEqual(citizenshipFormAnswer({ usCitizenship: 'US Citizen', jobLocation: null, options: ['US Citizen'] }), none)
})

test('FormAutofillService: kewarganegaraan dijawab untuk lowongan AS dengan nilai persis', async () => {
  const a = await fill('Citizenship status', ctx('US Citizen', US), ['US Citizen', 'Non-citizen', 'Decline'])
  assert.equal(a.value, 'US Citizen')
  assert.equal(a.confidence, 0.9)
  const b = await fill('Are you eligible to work in the United States?', ctx('Green Card', US), ['Yes', 'No'])
  assert.equal(b.value, 'Yes')
  assert.equal(b.source, 'rule')
})

test('FormAutofillService: lowongan non-AS, lokasi tidak jelas, atau tanpa lokasi: kosong dengan keyakinan 0 (tidak ada Decline atau opsi pertama)', async () => {
  const cases: Array<[string, FormContext]> = [
    ['Jakarta, Indonesia', ctx('US Citizen', 'Jakarta, Indonesia')],
    ['London, United Kingdom', ctx('US Citizen', 'London, United Kingdom')],
    ['Remote', ctx('US Citizen', 'Remote')],
    ['tanpa lokasi (undefined)', ctx('US Citizen')],
    ['lokasi null', ctx('US Citizen', null)],
  ]
  for (const [name, c] of cases) {
    for (const label of ['Citizenship', 'Are you eligible to work in this country?']) {
      const r = await fill(label, c, ['Yes', 'No', 'Decline'])
      assert.equal(r.value, '', `${name} / ${label}`)
      assert.equal(r.confidence, 0, `${name} / ${label}`)
    }
  }
})

test('FormAutofillService: Non-citizen tidak pernah dijawab Yes; data kosong tidak lagi menjadi "Decline"', async () => {
  const nc = await fill('Are you eligible to work in the US?', ctx('Non-citizen', US), ['Yes', 'No'])
  assert.equal(nc.value, '')
  assert.equal(nc.confidence, 0)
  const nc2 = await fill('Citizenship', ctx('Not a citizen', US), ['US Citizen', 'Other'])
  assert.equal(nc2.value, '')
  const empty = await fill('Citizenship', ctx('', US), ['US Citizen', 'Decline'])
  assert.equal(empty.value, '')
  assert.equal(empty.confidence, 0)
})

test('FormAutofillService: "eligible to work in the United States/this country" tidak lagi jatuh ke aturan negara bagian atau negara; "Country of citizenship" tidak dijawab dari negara domisili', async () => {
  const base = { ...ctx('US Citizen', US), userSettings: { ...settings('US Citizen'), state: 'Jawa Tengah', country: 'Indonesia' } }
  const eligibleUs = await fill('Are you eligible to work in the United States?', base, ['Yes', 'No'])
  assert.equal(eligibleUs.value, 'Yes') // dulu: nama provinsi karena label memuat "state"
  const eligibleCountry = await fill('Are you eligible to work in this country?', base, ['Yes', 'No'])
  assert.equal(eligibleCountry.value, 'Yes') // dulu: "Indonesia" karena label memuat "country"
  // Dulu dijawab dengan negara domisili ("Indonesia"). Kewarganegaraan adalah fakta pribadi (27 November 2026): negara
  // domisili bukan kewarganegaraan, jadi pertanyaan ini kosong dan wajib dicek.
  const countryOfCitizenship = await fill('Country of citizenship', base)
  assert.equal(countryOfCitizenship.value, '')
  assert.equal(countryOfCitizenship.confidence, 0)
  assert.equal(countryOfCitizenship.needsReview, true)
  // Pertanyaan negara biasa tetap memakai aturan negara.
  assert.equal((await fill('Country', base)).value, 'Indonesia')
})

test('approval-answers: lokasi lowongan dari tabel jobs sampai ke FormContext.jobLocation', async () => {
  const seen: Array<string | null | undefined> = []
  const filler = async (f: FormField, c: FormContext) => {
    seen.push(c.jobLocation)
    return { field: f, value: '', confidence: 0, source: 'default' as const, needsReview: true }
  }
  await buildApprovalAnswers(
    { settings: { first_name: 'A', last_name: 'B' }, profile: { email: 'a@b.test' }, job: { title: 'T', company: 'C', description: '', location: 'Austin, TX, USA' } },
    filler
  )
  assert.ok(seen.length > 0)
  assert.ok(seen.every((l) => l === 'Austin, TX, USA'))

  seen.length = 0
  const db = new FakeDb({ jobs: [{ id: 'j1', description: 'd', location: 'Jakarta, Indonesia' }] })
  await prepareApprovalAnswers(db, { userId: 'u1', jobId: 'j1', jobTitle: 'T', company: 'C' }, filler)
  assert.ok(seen.length > 0)
  assert.ok(seen.every((l) => l === 'Jakarta, Indonesia'))
})

test('POST /api/ai/fill-form: tanpa jobLocation di konteks, pertanyaan kewarganegaraan tidak dijawab', async () => {
  const app = Fastify()
  app.addHook('preHandler', async (req) => {
    ;(req as any).user = { id: 'u1' }
  })
  const guard = { check: async () => ({ quota: { quota: 10, used: 0, remaining: 10, allowed: true } }), recordDraft: async () => {} }
  await app.register(aiRoutes, { prefix: '/api/ai', guard })
  const base = { jobTitle: 'T', company: 'C', jobDescription: '', userSettings: settings('US Citizen'), userProfile: {} }
  const fields = [field('Citizenship', ['US Citizen', 'Decline'])]

  const noLoc = await app.inject({ method: 'POST', url: '/api/ai/fill-form', payload: { fields, context: base } })
  assert.equal(noLoc.statusCode, 200)
  assert.equal(noLoc.json().results[0].value, '')
  assert.equal(noLoc.json().results[0].confidence, 0)

  const us = await app.inject({ method: 'POST', url: '/api/ai/fill-form', payload: { fields, context: { ...base, jobLocation: US } } })
  assert.equal(us.json().results[0].value, 'US Citizen')
  await app.close()
})
