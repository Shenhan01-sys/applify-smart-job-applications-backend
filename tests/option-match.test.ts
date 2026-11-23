import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { aiPipelineService } from '../services/ai-pipeline.service.ts'
import { formAutofillService, type FormContext, type FormField } from '../services/form-autofill.service.ts'
import { matchOptionStrict, normalizeOptionText } from '../services/option-match.ts'
import { ExtensionPlanner, questionKey } from '../services/extension-planner.ts'
import { buildApprovalAnswers } from '../services/approval-answers.service.ts'
import { makeExtensionTestDb, USER_ID } from './extension-test-db.ts'

/**
 * Pilihan select/radio tidak pernah ditebak: tanpa opsi yang persis sama (dinormalkan) atau tepat satu opsi berawalan
 * jawaban pada batas kata, hasilnya kosong dengan keyakinan 0 supaya pengguna ditanya. Tidak ada cadangan "opsi
 * pertama" (form-autofill.service.ts) dan tidak ada pencocokan "mengandung" (extension-planner.ts). AI diganti tiruan.
 */

const blockAI = async () => {
  throw new Error('real AI call blocked in tests')
}
;(aiPipelineService as any).generateAnswer = blockAI
afterEach(() => {
  ;(aiPipelineService as any).generateAnswer = blockAI
})

const ctx = (settings: Record<string, unknown> = {}): FormContext => ({
  jobTitle: 'Engineer',
  company: 'Acme',
  jobDescription: '',
  userSettings: { first_name: 'Budi', last_name: 'Uji', ...settings },
  userProfile: { email: 'x@example.test' },
})
const select = (label: string, options: string[]): FormField => ({ type: 'select', label, options })
const radio = (label: string, options: string[]): FormField => ({ type: 'radio', label, options })

test('matchOptionStrict: persis (dinormalkan) menang; satu opsi berawalan pada batas kata diterima', () => {
  assert.equal(matchOptionStrict('yes', ['No', 'Yes']), 'Yes')
  assert.equal(matchOptionStrict('  YES. ', ['No', 'Yes']), 'Yes')
  assert.equal(matchOptionStrict('Yes', ['Yes', 'Yes, with sponsorship']), 'Yes') // persis menang atas awalan
  assert.equal(matchOptionStrict('Yes', ['Yes, I am authorized', 'No']), 'Yes, I am authorized')
  assert.equal(matchOptionStrict('Indonesia', ['Indonesia (+62)', 'Malaysia (+60)']), 'Indonesia (+62)')
  assert.equal(matchOptionStrict('Decline', ['Male', 'Decline to self-identify']), 'Decline to self-identify')
  assert.equal(normalizeOptionText('  Prefer   NOT to say! '), 'prefer not to say')
})

test('matchOptionStrict: tanpa kecocokan, bukan batas kata, ambigu, atau duplikat menghasilkan null', () => {
  assert.equal(matchOptionStrict('Maybe', ['Yes', 'No']), null)
  assert.equal(matchOptionStrict('No', ['None of the above', 'Non-binary', 'Yes']), null) // bukan batas kata
  assert.equal(matchOptionStrict('Yes, definitely', ['Yes', 'No']), null) // jawaban lebih panjang dari opsi: tidak ditebak
  assert.equal(matchOptionStrict('United States', ['United States of America', 'United States Minor Outlying Islands']), null) // ambigu
  assert.equal(matchOptionStrict('Yes', ['Yes', 'yes ']), null) // opsi duplikat (sama persis sesudah dinormalkan)
  assert.equal(matchOptionStrict('Ya', ['Ya, tentu', 'Ya, dengan syarat']), null)
  assert.equal(matchOptionStrict('', ['Yes']), null)
  assert.equal(matchOptionStrict(undefined, ['Yes']), null)
  assert.equal(matchOptionStrict('Yes', []), null)
  assert.equal(matchOptionStrict('Yes', ['', '   ']), null)
})

test('FormAutofillService visa: tanpa opsi padanan kosong dengan keyakinan 0, bukan opsi pertama', async () => {
  const noMatch = await formAutofillService.fillField(radio('Do you require visa sponsorship?', ['Authorized to work', 'Need sponsorship']), ctx({ require_visa: 'no' }))
  assert.equal(noMatch.value, '')
  assert.equal(noMatch.confidence, 0)

  const yesNo = await formAutofillService.fillField(radio('Do you require visa sponsorship?', ['Yes', 'No']), ctx({ require_visa: 'no' }))
  assert.equal(yesNo.value, 'No')
  assert.equal(yesNo.confidence, 0.95)

  // "No" persis = nilai bawaan database: tetap dijawab, tetapi keyakinan sedang
  const unconfirmed = await formAutofillService.fillField(radio('Visa sponsorship', ['Yes', 'No']), ctx({ require_visa: 'No' }))
  assert.equal(unconfirmed.value, 'No')
  assert.equal(unconfirmed.confidence, 0.6)

  const free = await formAutofillService.fillField({ type: 'text', label: 'Visa sponsorship needed?' }, ctx({ require_visa: 'no' }))
  assert.equal(free.value, 'no') // teks bebas dipakai apa adanya
})

test('FormAutofillService demografi: opsi tak cocok tidak jatuh ke opsi pertama; "Decline" hanya bila ada opsi yang jelas', async () => {
  const gender = await formAutofillService.fillField(select('Gender', ['Male', 'Female', "I don't wish to answer"]), ctx())
  assert.equal(gender.value, '') // dulu: "Male" (opsi pertama)
  assert.equal(gender.confidence, 0)

  const declined = await formAutofillService.fillField(select('Gender', ['Male', 'Female', 'Decline to self-identify']), ctx())
  assert.equal(declined.value, 'Decline to self-identify')
  assert.equal(declined.confidence, 0.9)

  const saved = await formAutofillService.fillField(select('Veteran status', ['I am a veteran', 'Not a veteran']), ctx({ veteran_status: 'Not a veteran' }))
  assert.equal(saved.value, 'Not a veteran')

  const ambiguous = await formAutofillService.fillField(select('Race / ethnicity', ['Asian (East)', 'Asian (South)']), ctx({ ethnicity: 'Asian' }))
  assert.equal(ambiguous.value, '')
  assert.equal(ambiguous.confidence, 0)

  const disability = await formAutofillService.fillField(radio('Disability status', ['Yes', 'No']), ctx({ disability_status: 'maybe' }))
  assert.equal(disability.value, '')
  assert.equal(disability.confidence, 0)
})

test('FormAutofillService AI: jawaban select/radio tanpa opsi padanan dikosongkan, keyakinan 0, wajib dicek', async () => {
  const withAnswer = (answer: string) => {
    ;(aiPipelineService as any).generateAnswer = async () => answer
  }
  withAnswer('Yes')
  const ok = await formAutofillService.fillField(select('Do you enjoy solving puzzles?', ['Yes', 'No']), ctx())
  assert.equal(ok.value, 'Yes')
  assert.equal(ok.confidence, 0.75)
  assert.equal(ok.source, 'ai')

  withAnswer('Probably')
  const miss = await formAutofillService.fillField(select('Do you enjoy solving puzzles?', ['Yes', 'No']), ctx())
  assert.equal(miss.value, '')
  assert.equal(miss.confidence, 0)
  assert.equal(miss.needsReview, true)
  assert.equal(miss.source, 'ai')

  withAnswer('Probably')
  const text = await formAutofillService.fillField({ type: 'text', label: 'Anything else about you?' }, ctx())
  assert.equal(text.value, 'Probably')
  assert.equal(text.confidence, 0.75)
})

test('FormAutofillService cadangan terakhir: select/radio tidak diisi opsi pertama; teks tetap berkeyakinan 0,3', async () => {
  const ctxNoAi = ctx({ use_ai: false })
  const sel = await formAutofillService.fillField(select('Preferred contact time', ['Morning', 'Evening']), ctxNoAi)
  assert.equal(sel.value, '')
  assert.equal(sel.confidence, 0)
  assert.equal(sel.source, 'default')
  assert.equal(sel.needsReview, true)
  const rad = await formAutofillService.fillField(radio('Preferred contact time', ['Morning', 'Evening']), ctxNoAi)
  assert.equal(rad.value, '')
  const txt = await formAutofillService.fillField({ type: 'textarea', label: 'Tell us more' }, ctxNoAi)
  assert.equal(txt.value, '')
  assert.equal(txt.confidence, 0.3)
  const chk = await formAutofillService.fillField({ type: 'checkbox', label: 'Pick any', options: ['A', 'B'] }, ctxNoAi)
  assert.deepEqual(chk.value, [])
})

test('approval-answers: sponsor visa dengan nilai tak dikenal kosong dan wajib dicek (dulu "Yes" dari opsi pertama)', async () => {
  const rows = await buildApprovalAnswers({
    settings: { first_name: 'A', last_name: 'B', phone_number: '+62811', current_city: 'Jogja', years_of_experience: '2', desired_salary: 1, notice_period: 30, require_visa: 'tidak tahu', linkedin_url: 'https://x.test', use_ai: false },
    profile: { email: 'a@b.test' },
    job: { title: 'T', company: 'C', description: '' },
  })
  const visa = rows.find((r) => r.question.startsWith('Butuh sponsor visa'))!
  assert.equal(visa.answer, '')
  assert.equal(visa.confidence, 0)
  assert.equal(visa.needs_review, true)
})

// ---- planner ekstensi -------------------------------------------------------------------------------------

async function plan(opts: { controls: any[]; saved?: Array<{ label: string; answer: string }>; aiActions?: Array<{ controlId: string; value: string }> }) {
  const planner = new ExtensionPlanner(async () => ({ model: 'm', text: JSON.stringify({ actions: opts.aiActions ?? [] }) }))
  const store = makeExtensionTestDb({
    jobs: [{ id: 'job-1', title: 'Engineer', company: 'Acme', description: '', location: 'Jakarta, Indonesia' }],
    user_form_answers: (opts.saved ?? []).map((s) => ({ user_id: USER_ID, question_key: questionKey(s.label), question_label: s.label, answer: s.answer })),
  })
  return planner.planForm({
    db: store.db,
    userId: USER_ID,
    jobId: 'job-1',
    pageUrl: 'https://boards.greenhouse.io/acme/jobs/1',
    rawControls: opts.controls,
  })
}

test('planner: jawaban tersimpan hanya dipakai bila persis atau satu opsi berawalan pada batas kata', async () => {
  const controls = [
    { controlId: 'c1', kind: 'select', label: 'Work authorization status', options: ['Yes, I am authorized', 'No'], required: true },
    { controlId: 'c2', kind: 'select', label: 'Pick a colour', options: ['Red', 'Blue'], required: true },
    { controlId: 'c3', kind: 'select', label: 'Country of residence', options: ['United States of America', 'United States Minor Outlying Islands'], required: true },
  ]
  const res = await plan({
    controls,
    saved: [
      { label: 'Work authorization status', answer: 'Yes' },
      { label: 'Pick a colour', answer: 'Green' },
      { label: 'Country of residence', answer: 'United States' },
    ],
  })
  const byId = new Map(res.actions.map((a) => [a.controlId, a]))
  assert.equal((byId.get('c1') as any)?.value, 'Yes, I am authorized')
  assert.equal(byId.has('c2'), false) // tidak ada padanan: tidak diisi
  assert.equal(byId.has('c3'), false) // ambigu: tidak diisi
  // yang tidak terisi masuk daftar pertanyaan untuk pengguna
  const pendingKeys = res.pendingQuestions.map((q) => q.key)
  assert.ok(pendingKeys.includes(questionKey('Pick a colour')))
  assert.ok(pendingKeys.includes(questionKey('Country of residence')))
})

test('planner: nilai AI untuk select/radio tidak memakai pencocokan "mengandung" lagi', async () => {
  const res = await plan({
    controls: [
      { controlId: 'c1', kind: 'select', label: 'Are you open to relocation?', options: ['Yes', 'No'], required: true },
      { controlId: 'c2', kind: 'radio', label: 'Preferred shift', groupLabel: 'Preferred shift', options: ['Day', 'Night'], required: true },
      { controlId: 'c3', kind: 'select', label: 'Notice period', options: ['Immediately', '1 month', '2 months'], required: true },
    ],
    aiActions: [
      { controlId: 'c1', value: 'Yes, definitely' }, // dulu cocok ke "Yes" lewat "mengandung"
      { controlId: 'c2', value: 'Night' }, // persis
      { controlId: 'c3', value: '1' }, // "1" berawalan "1 month" pada batas kata, satu-satunya
    ],
  })
  const byId = new Map(res.actions.map((a) => [a.controlId, a]))
  assert.equal(byId.has('c1'), false)
  assert.equal((byId.get('c2') as any)?.value, 'Night')
  assert.equal((byId.get('c3') as any)?.value, '1 month')
  assert.ok(res.pendingQuestions.some((q) => q.key === questionKey('Are you open to relocation?')))
})
