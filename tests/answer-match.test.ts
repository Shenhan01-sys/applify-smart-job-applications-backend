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

test('findFlexibleSavedAnswer: sinonim Discipline/Major, School/University tanpa membocorkan SMA, serta lokasi kerja', () => {
  const bank = [
    { key: 'major of study', label: 'Major of Study', answer: 'Information Systems' },
    { key: 'university', label: 'University', answer: 'Universitas Kristen Duta Wacana' },
    { key: 'high school name', label: 'High school name', answer: 'SMA Kolese De Britto' },
    { key: 'country of residence', label: 'Country of residence', answer: 'Indonesia' },
  ]
  assert.equal(findFlexibleSavedAnswer('Discipline*', bank)?.answer, 'Information Systems')
  assert.equal(findFlexibleSavedAnswer('School', bank)?.answer, 'Universitas Kristen Duta Wacana')
  assert.equal(
    findFlexibleSavedAnswer('School', [{ key: 'high school name', label: 'High school name', answer: 'SMA Kolese De Britto' }]),
    undefined
  )
  assert.equal(
    findFlexibleSavedAnswer(
      "What was your bachelor's university degree result, or expected result if you have not yet graduated?",
      bank
    ),
    undefined
  )
  assert.equal(findFlexibleSavedAnswer('In which country do you currently work?', bank)?.answer, 'Indonesia')
})

test('ExtensionPlanner: "In which country do you currently work?" terisi deterministik dari lokasi profil dan degree masuk konteks', async () => {
  const store = makeExtensionTestDb({
    jobs: [{ id: 'job-c', title: 'Software Engineer', company: 'Canonical', description: '', location: 'Remote' }],
    profiles: [{ id: USER_ID, full_name: 'Hans Gunawan', location: 'Yogyakarta dan Sekitarnya' }],
    education: [{ user_id: USER_ID, institution: 'Universitas Kristen Duta Wacana', degree: 'S1 Sistem Informasi', start_year: 2022, end_year: 2026, is_current: true }],
  })
  let userPrompt = ''
  const planner = new ExtensionPlanner(async (req) => {
    userPrompt = req.user
    return { model: 'mock:test', text: JSON.stringify({ actions: [{ controlId: 'c_deg_text', value: '{{degree}}' }] }) }
  })
  const res = await planner.planForm({
    db: store.db,
    userId: USER_ID,
    jobId: 'job-c',
    pageUrl: 'https://job-boards.greenhouse.io/canonical/jobs/1',
    rawControls: [
      { controlId: 'c_work_country', kind: 'select', label: 'In which country do you currently work?*', options: ['United States', 'Indonesia'], required: true },
      { controlId: 'c_school', kind: 'select', label: 'School*', options: ['Other', 'Universitas Kristen Duta Wacana'], required: true },
      { controlId: 'c_deg_select', kind: 'select', label: 'Degree', options: ["Associate's Degree", 'Bachelors', "Bachelor's Degree", "Master's Degree"], required: false },
      { controlId: 'c_deg_text', kind: 'text', label: 'Degree / Discipline', required: true },
    ],
  })
  assert.equal(res.actions.find((a) => a.controlId === 'c_work_country')?.value, 'Indonesia')
  assert.equal(res.actions.find((a) => a.controlId === 'c_school')?.value, 'Universitas Kristen Duta Wacana')
  assert.equal(res.actions.find((a) => a.controlId === 'c_deg_select')?.value, "Bachelor's Degree")
  assert.equal(res.actions.find((a) => a.controlId === 'c_deg_text')?.value, 'S1 Sistem Informasi')
  assert.ok(userPrompt.includes('{{degree}}'))
})

test('ExtensionPlanner: profil Canonical (B.Sc., Information Systems, IPK 3.79/4, start 2023, skills, Nationality/Gender/Race)', async () => {
  const store = makeExtensionTestDb({
    jobs: [{ id: 'job-canon', title: 'Graduate Software Engineer', company: 'Canonical', description: '', location: 'Remote' }],
    profiles: [{ id: USER_ID, full_name: 'Hans Gunawan', current_title: 'Web 3 Developer', location: 'Yogyakarta dan Sekitarnya' }],
    user_skills: [
      { user_id: USER_ID, name: 'Python' },
      { user_id: USER_ID, name: 'Go' },
      { user_id: USER_ID, name: 'PostgreSQL' },
    ],
    education: [
      {
        user_id: USER_ID,
        institution: 'Universitas Kristen Duta Wacana',
        degree: 'B.Sc.',
        field_of_study: 'Information Systems',
        start_year: 2023,
        end_year: null,
        is_current: true,
        gpa: 3.79,
        max_gpa: 4,
      },
    ],
    user_form_answers: [
      { user_id: USER_ID, question_key: 'nationality', question_label: 'Nationality*', answer: 'Indonesian' },
      { user_id: USER_ID, question_key: 'gender', question_label: 'Gender', answer: 'Male' },
      { user_id: USER_ID, question_key: 'race or ethnicity', question_label: 'Race or ethnicity', answer: 'ASEAN' },
      { user_id: USER_ID, question_key: 'are you hispanic latino', question_label: 'Are you Hispanic/Latino?', answer: 'No' },
    ],
  })
  const planner = new ExtensionPlanner(async () => ({ model: 'mock:test', text: '{"actions":[]}' }))
  const res = await planner.planForm({
    db: store.db,
    userId: USER_ID,
    jobId: 'job-canon',
    pageUrl: 'https://job-boards.greenhouse.io/canonical/jobs/8379825',
    rawControls: [
      { controlId: 'c_phone_cc', kind: 'select', label: 'Country', options: ['United States +1', 'Afghanistan +93', 'Albania +355'], required: false },
      { controlId: 'c_deg', kind: 'select', label: 'Degree', options: ['Associates', 'Bachelors', "Bachelor's Degree", 'Masters'], required: false },
      { controlId: 'c_grad27', kind: 'select', label: 'Please confirm that your first university degree (bachelor or undergrad) completed, or is expected to complete, in 2026 or 2027.*', options: ['Yes', 'No'], required: true },
      { controlId: 'c_gpa', kind: 'textarea', label: "What was your bachelor's university degree result, or expected result if you have not yet graduated?", required: true },
      { controlId: 'c_langs', kind: 'radio', inputType: 'checkbox', label: 'Which programming languages do you feel most confident using (Choose up to three)? *', options: ['C', 'Golang', 'Python'], required: true },
      { controlId: 'c_areas', kind: 'radio', inputType: 'checkbox', label: 'Which areas of engineering are most interesting to you? (Choose up to three) *', options: ['Kernel', 'Databases', 'Graphics'], required: true },
      { controlId: 'c_nat', kind: 'select', searchable: true, label: 'Please indicate your nationality:', options: [], required: false },
      { controlId: 'c_gen', kind: 'select', label: 'Which gender do you identify as?*', options: ['Female', 'Male', 'Prefer not to say'], required: true },
      { controlId: 'c_race', kind: 'select', label: 'Please indicate your race or ethnicity:*', options: ['Asian', 'Black or African', 'White / European'], required: true },
      { controlId: 'c_hisp', kind: 'select', label: 'Are you Hispanic/Latino?', options: ['Yes', 'No', 'Decline To Self Identify'], required: false },
    ],
  })
  const byId = Object.fromEntries(res.actions.map((a) => [a.controlId, a.value]))
  assert.equal(byId.c_phone_cc, 'Indonesia')
  assert.equal(byId.c_deg, "Bachelor's Degree")
  assert.equal(byId.c_grad27, 'Yes')
  assert.equal(byId.c_gpa, 'GPA score of 3.79/4 (predicted/current)')
  assert.equal(byId.c_langs, 'Python')
  assert.equal(byId.c_areas, 'Databases')
  assert.equal(byId.c_nat, 'Indonesian')
  assert.equal(byId.c_gen, 'Male')
  assert.equal(byId.c_race, 'Asian')
  assert.equal(byId.c_hisp, 'No')
})
