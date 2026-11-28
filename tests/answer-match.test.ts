import test from 'node:test'
import assert from 'node:assert/strict'
import { findFlexibleSavedAnswer } from '../services/answer-match.js'
import { ExtensionPlanner } from '../services/extension-planner.js'
import { makeExtensionTestDb, USER_ID } from './extension-test-db.js'

test('findFlexibleSavedAnswer: cocok sinonim dan kata inti tanpa menukar pertanyaan berlawanan', () => {
  const bank = [
    { key: 'umur', label: 'Umur', answer: '21' },
    { key: 'birth place', label: 'Birth Place', answer: 'Yogyakarta' },
    { key: 'current salary', label: 'Current monthly salary', answer: '5000000' },
    { key: 'high school name', label: 'High school name', answer: 'De Britto College' },
  ]
  assert.equal(findFlexibleSavedAnswer('Berapa usia Anda saat ini?', bank)?.answer, '21')
  assert.equal(findFlexibleSavedAnswer('Tempat lahir', bank)?.answer, 'Yogyakarta')
  // Makna berlawanan tidak boleh cocok
  assert.equal(findFlexibleSavedAnswer('Expected monthly salary', bank), undefined)
  assert.equal(findFlexibleSavedAnswer('University name', bank), undefined)
  assert.equal(findFlexibleSavedAnswer('Tanggal berakhir', [{ key: 'tanggal mulai', label: 'Tanggal mulai', answer: '2024' }]), undefined)
})

test('ExtensionPlanner: jawaban tersimpan dicocokkan fleksibel & AI token saved_answer_N untuk fakta pribadi tidak dibuang', async () => {
  const store = makeExtensionTestDb({
    jobs: [{ id: 'job-1', title: 'Software Engineer', company: 'Acme', description: '', location: 'Jakarta' }],
    profiles: [{ id: USER_ID, full_name: 'Hans Gunawan', location: 'Jakarta, Indonesia' }],
    user_form_answers: [
      { user_id: USER_ID, question_key: 'umur', question_label: 'Umur', answer: '21' },
      { user_id: USER_ID, question_key: 'kewarganegaraan saya', question_label: 'Kewarganegaraan saya', answer: 'Indonesia' },
    ],
  })
  let sawSavedInPrompt = false
  const planner = new ExtensionPlanner(async (req) => {
    sawSavedInPrompt = req.user.includes('saved_answer_') && req.system.includes('saved_answer_N')
    return {
      model: 'mock:test',
      text: JSON.stringify({
        actions: [{ controlId: 'c_wn', value: '{{saved_answer_2}}' }],
      }),
    }
  })

  const res = await planner.planForm({
    db: store.db,
    userId: USER_ID,
    jobId: 'job-1',
    pageUrl: 'https://jobs.example.com/apply',
    rawControls: [
      { controlId: 'c_age', kind: 'text', label: 'Berapa usia Anda?', placeholder: 'tahun', required: true },
      { controlId: 'c_wn', kind: 'text', label: 'Status warga negara pemohon', required: true },
    ],
  })

  assert.equal(sawSavedInPrompt, true)
  assert.deepEqual(
    res.actions.map((a) => ({ id: a.controlId, value: a.value, source: a.source })),
    [
      { id: 'c_age', value: '21', source: 'saved' },
      { id: 'c_wn', value: 'Indonesia', source: 'ai' },
    ]
  )
  assert.deepEqual(res.pendingQuestions, [])
})

test('ExtensionPlanner: label tidak tertimpa noise Loading dan mengutamakan konteks daripada placeholder', async () => {
  const store = makeExtensionTestDb({
    jobs: [{ id: 'job-1', title: 'Software Engineer', company: 'Acme', description: '', location: 'Jakarta' }],
    profiles: [{ id: USER_ID, full_name: 'Hans Gunawan', location: 'Jakarta, Indonesia' }],
  })
  const planner = new ExtensionPlanner(async () => ({ model: 'mock:test', text: '{"actions":[]}' }))
  const res = await planner.planForm({
    db: store.db,
    userId: USER_ID,
    jobId: 'job-1',
    pageUrl: 'https://jobs.example.com/apply',
    rawControls: [
      {
        controlId: 'c_loc',
        kind: 'text',
        label: 'Current location ✱No location found. Try entering a different locationLoading',
        required: true,
      },
      {
        controlId: 'c_age',
        kind: 'text',
        label: '',
        helperText: 'Berapa umur Anda?',
        placeholder: 'tahun',
        required: true,
      },
    ],
  })
  assert.deepEqual(
    res.pendingQuestions.map((q) => q.label),
    ['Current location ✱', 'Berapa umur Anda?']
  )
})

test('ExtensionPlanner: placeholder "tahun" tidak dipakai sebagai label pertanyaan bila label dan konteks kosong', async () => {
  const store = makeExtensionTestDb({
    jobs: [{ id: 'job-1', title: 'Software Engineer', company: 'Acme', description: '', location: 'Jakarta' }],
    profiles: [{ id: USER_ID, full_name: 'Hans Gunawan', location: 'Jakarta, Indonesia' }],
  })
  const planner = new ExtensionPlanner(async () => ({ model: 'mock:test', text: '{"actions":[]}' }))
  const res = await planner.planForm({
    db: store.db,
    userId: USER_ID,
    jobId: 'job-1',
    pageUrl: 'https://jobs.example.com/apply',
    rawControls: [
      {
        controlId: 'c_no_label',
        kind: 'text',
        label: '',
        placeholder: 'tahun',
        name: '',
        required: true,
      },
    ],
  })
  assert.equal(res.pendingQuestions.length, 1)
  assert.notEqual(res.pendingQuestions[0].label, 'tahun')
  assert.equal(res.pendingQuestions[0].label, 'Kolom wajib tanpa label 1')
})
