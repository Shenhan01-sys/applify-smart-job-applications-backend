import test from 'node:test'
import assert from 'node:assert/strict'
import { ExtensionPlanner, invalidatePlannerContextCache, orderedEducation, planInstitutionAnswers, sanitizeExtensionControls } from '../services/extension-planner.js'
import {
  dropMisplacedUrlActions,
  isHighSchoolInstitutionControl,
  isInstitutionControl,
  isUrlValue,
  isUrlishControl,
} from '../services/extension-field-guards.js'
import { makeExtensionTestDb, USER_ID } from './extension-test-db.js'

// Uji kirim nyata SmartRecruiters (27 November 2026, Pusat Inovasi Global): kolom wajib "Institution*" pada blok Education
// ke-4 terisi URL LinkedIn. Aturan: URL hanya ke kolom URL, nama institusi hanya dari tabel `education`.

const LINKEDIN = 'https://www.linkedin.com/in/hans-gunawan01'
const GITHUB = 'https://github.com/Shenhan01-sys'

const EDUCATION = [
  { institution: 'SMA Negeri 1 Yogyakarta', degree: 'SMA/IPA', start_year: 2018, end_year: 2021, is_current: false },
  { institution: 'Universitas Kristen Duta Wacana', degree: 'S1 Sistem Informasi', start_year: 2022, end_year: 2026, is_current: true },
]

async function plan(opts: {
  jobId: string
  controls: any[]
  ai?: unknown
  education?: any[]
  answers?: Array<{ question_key: string; question_label: string; answer: string }>
  pageUrl?: string
}) {
  invalidatePlannerContextCache()
  let prompt = ''
  const planner = new ExtensionPlanner(async (req: any) => {
    prompt = JSON.stringify(req)
    return { model: 'm', text: JSON.stringify(opts.ai ?? { actions: [] }) }
  })
  const res = await planner.planForm({
    db: makeExtensionTestDb({
      jobs: [{ id: opts.jobId, title: 'Python Developer', company: 'Pusat Inovasi Global', description: '', location: 'Kochi' }],
      profiles: [{ id: USER_ID, full_name: 'Hans Gunawan', skills: [], linkedin_url: LINKEDIN, github_url: GITHUB }],
      education: (opts.education ?? EDUCATION).map((e) => ({ user_id: USER_ID, ...e })),
      user_form_answers: (opts.answers ?? []).map((a) => ({ user_id: USER_ID, ...a })),
    }).db,
    userId: USER_ID,
    jobId: opts.jobId,
    pageUrl: opts.pageUrl ?? 'https://jobs.smartrecruiters.com/oneclick-ui/company/PusatInovasiGlobal/publication/x',
    rawControls: opts.controls,
  })
  const byId = Object.fromEntries(res.actions.map((a: any) => [a.controlId, a]))
  const asked = res.pendingQuestions.map((q: any) => q.label)
  return { res, byId, asked, prompt }
}

const inst = (id: string, extra: Record<string, unknown> = {}) => ({ controlId: id, kind: 'text', label: 'Institution*', required: true, ...extra })

// ---------------------------------------------------------------------------------------------------------------------
// Penjaga murni
// ---------------------------------------------------------------------------------------------------------------------

test('isUrlValue: hanya nilai yang seluruhnya satu URL', () => {
  for (const v of [LINKEDIN, GITHUB, 'http://example.com/a', 'www.hans.dev', 'linkedin.com/in/hans', 'github.com/Shenhan01-sys', ' https://x.io/y ']) {
    assert.equal(isUrlValue(v), true, v)
  }
  for (const v of [
    'Universitas Kristen Duta Wacana',
    'Node.js',
    'Lihat https://github.com/x untuk contoh kode saya',
    'hans@example.com',
    '',
    '   ',
    null,
    undefined,
    42,
    true,
  ]) {
    assert.equal(isUrlValue(v as unknown), false, String(v))
  }
})

test('isUrlishControl: label yang menanyakan URL lolos, Institution tidak, walau grup atau name menyebut LinkedIn', () => {
  const base = { kind: 'text' as const, groupLabel: '', name: '', placeholder: '', inputType: 'text' }
  for (const label of ['LinkedIn', 'LinkedIn Profile URL', 'Github Profile*', 'Website', 'Portfolio', 'Portofolio / Tautan', 'Personal site', 'Link to your work', 'X (fka Twitter)']) {
    assert.equal(isUrlishControl({ ...base, label }), true, label)
  }
  assert.equal(isUrlishControl({ ...base, label: 'Anything', inputType: 'url' }), true, 'inputType url')
  assert.equal(isUrlishControl({ ...base, label: 'Anything', placeholder: 'https://' }), true, 'placeholder http')
  assert.equal(isUrlishControl({ ...base, label: 'Profile', groupLabel: 'Links' }), true, 'label polos ikut grup')
  assert.equal(isUrlishControl({ ...base, label: '', name: '', groupLabel: 'Web profiles' }), true, 'tanpa label ikut grup')

  for (const label of ['Institution*', 'School', 'University', 'Company', 'Job title', 'Description', 'Major', 'Full name']) {
    assert.equal(isUrlishControl({ ...base, label }), false, label)
  }
  assert.equal(isUrlishControl({ ...base, label: 'Institution*', groupLabel: 'LinkedIn', name: 'linkedin' }), false, 'grup dan name tercemar')
  assert.equal(isUrlishControl({ ...base, label: 'Institution*', groupLabel: 'Links' }), false)
  assert.equal(isUrlishControl({ ...base, label: 'Company', groupLabel: 'Links profile' }), false, 'label bermakna lain tidak ikut grup')
  assert.equal(isUrlishControl({ ...base, label: 'Major', groupLabel: 'LinkedIn' }), false)
})

test('isInstitutionControl: nama institusi ya; atribut pendidikan, pertanyaan, dan jenis lain tidak', () => {
  const base = { kind: 'text' as const, groupLabel: '', name: '', placeholder: '', inputType: 'text' }
  for (const label of ['Institution*', 'School', 'University', 'College', 'School name', 'Name of school', 'Nama sekolah', 'Universitas', 'Last university attended', 'High school']) {
    assert.equal(isInstitutionControl({ ...base, label }), true, label)
  }
  assert.equal(isInstitutionControl({ ...base, kind: 'select', label: 'University' }), true, 'select ikut')
  for (const label of [
    'School location',
    'University graduation year',
    'Degree',
    'Field of study',
    'Institution website',
    'Did you attend a university?',
    'Which university did you attend?',
    'Apakah Anda lulusan universitas',
    'Company',
    'Job title',
    '',
  ]) {
    assert.equal(isInstitutionControl({ ...base, label }), false, label)
  }
  assert.equal(isInstitutionControl({ ...base, kind: 'checkbox', label: 'University' }), false, 'checkbox bukan nama')
  assert.equal(isInstitutionControl({ ...base, kind: 'textarea', label: 'University' }), false, 'textarea bukan nama')
  assert.equal(isHighSchoolInstitutionControl({ ...base, label: 'High school' }), true)
  assert.equal(isHighSchoolInstitutionControl({ ...base, label: 'SMA/SMK' }), true)
  assert.equal(isHighSchoolInstitutionControl({ ...base, label: 'University' }), false)
})

test('dropMisplacedUrlActions: URL di kolom non-URL dibuang, di kolom URL dan teks biasa dibiarkan', () => {
  const controls = sanitizeExtensionControls([
    { controlId: 'inst', kind: 'text', label: 'Institution*' },
    { controlId: 'li', kind: 'text', label: 'LinkedIn' },
    { controlId: 'about', kind: 'textarea', label: 'Tell us about yourself' },
    { controlId: 'chk', kind: 'checkbox', label: 'Remote' },
  ])
  const { actions, droppedControlIds } = dropMisplacedUrlActions(
    [
      { controlId: 'inst', value: LINKEDIN },
      { controlId: 'li', value: LINKEDIN },
      { controlId: 'about', value: `Profil saya ada di ${LINKEDIN} dan kode di ${GITHUB}.` },
      { controlId: 'chk', value: true },
      { controlId: 'ghost', value: LINKEDIN },
    ],
    controls
  )
  assert.deepEqual(droppedControlIds, ['inst'])
  assert.deepEqual(actions.map((a) => a.controlId), ['li', 'about', 'chk', 'ghost'])
})

test('planInstitutionAnswers: satu kolom = kuliah terbaru; beberapa kolom = baris ke-N; kelebihan blok = null', () => {
  const ctl = (id: string, extra: Record<string, unknown> = {}) =>
    sanitizeExtensionControls([{ controlId: id, kind: 'text', label: 'Institution*', ...extra }])[0]
  const single = planInstitutionAnswers([ctl('a')], EDUCATION)
  assert.deepEqual(single.get('a'), { answer: 'Universitas Kristen Duta Wacana', repeated: false })

  const four = planInstitutionAnswers([ctl('a'), ctl('b'), ctl('c'), ctl('d')], EDUCATION)
  assert.deepEqual([...four.values()].map((v) => v.answer), ['Universitas Kristen Duta Wacana', 'SMA Negeri 1 Yogyakarta', null, null])
  assert.ok([...four.values()].every((v) => v.repeated))

  // repeaterIndex (mulai 1) menentukan baris walau hanya satu kolom yang dikirim.
  const second = planInstitutionAnswers([ctl('x', { repeaterIndex: 2 })], EDUCATION)
  assert.deepEqual(second.get('x'), { answer: 'SMA Negeri 1 Yogyakarta', repeated: true })
  const beyond = planInstitutionAnswers([ctl('y', { repeaterIndex: 3 })], EDUCATION)
  assert.deepEqual(beyond.get('y'), { answer: null, repeated: true })

  assert.deepEqual(planInstitutionAnswers([ctl('a')], []).get('a'), { answer: null, repeated: false })
  assert.deepEqual(planInstitutionAnswers([ctl('a')], null).get('a'), { answer: null, repeated: false })
  assert.equal(planInstitutionAnswers([sanitizeExtensionControls([{ controlId: 'c', kind: 'text', label: 'Company' }])[0]], EDUCATION).size, 0)
  assert.deepEqual(orderedEducation(EDUCATION).map((r) => r.institution), ['Universitas Kristen Duta Wacana', 'SMA Negeri 1 Yogyakarta'])
  assert.deepEqual(orderedEducation([{ institution: '  ' }, null, { institution: 'X' }] as any), [{ institution: 'X' }])
})

// ---------------------------------------------------------------------------------------------------------------------
// Perencana lengkap
// ---------------------------------------------------------------------------------------------------------------------

test('SmartRecruiters: empat blok Education, dua baris di profil. Blok 3 dan 4 kosong dan menjadi Perlu dicek, bukan URL LinkedIn', async () => {
  const controls = [
    inst('i1'),
    inst('i2'),
    inst('i3'),
    inst('i4'),
    { controlId: 'li', kind: 'text', label: 'LinkedIn', required: false },
    { controlId: 'x', kind: 'text', label: 'X (fka Twitter)', required: false },
  ]
  // Model yang keliru menaruh {{linkedin_url}} di semua Institution (perilaku yang terjadi di uji nyata).
  const ai = { actions: ['i1', 'i2', 'i3', 'i4'].map((controlId) => ({ controlId, value: '{{linkedin_url}}' })) }
  const { res, byId, asked, prompt } = await plan({ jobId: 'job-sr-4edu', controls, ai })

  assert.equal(byId.i1.value, 'Universitas Kristen Duta Wacana')
  assert.equal(byId.i2.value, 'SMA Negeri 1 Yogyakarta')
  assert.equal(byId.i1.source, 'fact')
  assert.ok(!('i3' in byId) && !('i4' in byId), JSON.stringify(res.actions))
  assert.equal(byId.li.value, LINKEDIN, 'kolom LinkedIn sungguhan tetap terisi')
  assert.ok(!res.actions.some((a: any) => a.controlId.startsWith('i') && String(a.value).includes('linkedin')), JSON.stringify(res.actions))
  // Blok kelebihan dilaporkan sebagai pertanyaan wajib dan tidak pernah dikirim ke model.
  assert.equal(res.pendingQuestions.filter((q: any) => /institution/i.test(q.label)).length >= 1, true, JSON.stringify(asked))
  assert.doesNotMatch(prompt, /\\"controlId\\":\\"i[1-4]\\"/)
})

test('Institution tunggal dengan grup dan name tercemar "LinkedIn": tetap nama kuliah, tidak URL (jalur pencocokan label)', async () => {
  const { byId } = await plan({
    jobId: 'job-polluted',
    controls: [inst('i1', { groupLabel: 'LinkedIn', name: 'linkedin_institution', placeholder: 'LinkedIn' })],
  })
  assert.equal(byId.i1.value, 'Universitas Kristen Duta Wacana')
})

test('Institution tanpa data pendidikan: tidak diisi, tidak ke AI, jadi Perlu dicek walau AI menjawab URL atau nama karangan', async () => {
  const { res, byId, asked, prompt } = await plan({
    jobId: 'job-no-edu',
    education: [],
    controls: [inst('i1'), { controlId: 'li', kind: 'text', label: 'LinkedIn', required: false }],
    ai: { actions: [{ controlId: 'i1', value: '{{linkedin_url}}' }, { controlId: 'li', value: '{{linkedin_url}}' }] },
  })
  assert.ok(!('i1' in byId), JSON.stringify(res.actions))
  assert.ok(asked.includes('Institution*'), JSON.stringify(asked))
  assert.doesNotMatch(prompt, /\\"controlId\\":\\"i1\\"/)
  assert.equal(byId.li.value, LINKEDIN)
})

test('jawaban tersimpan berupa URL untuk Institution dibuang oleh penjaga URL dan kolomnya menjadi pertanyaan', async () => {
  const { res, byId, asked } = await plan({
    jobId: 'job-saved-url',
    education: [],
    controls: [inst('i1')],
    answers: [{ question_key: 'institution', question_label: 'Institution', answer: LINKEDIN }],
  })
  assert.ok(!('i1' in byId), JSON.stringify(res.actions))
  assert.ok(asked.includes('Institution*'), JSON.stringify(asked))
})

test('jawaban tersimpan teks biasa untuk Institution tunggal tetap dipakai, tetapi tidak untuk blok berulang', async () => {
  const answers = [{ question_key: 'institution', question_label: 'Institution', answer: 'Institut Teknologi Bandung' }]
  const single = await plan({ jobId: 'job-saved-single', education: [], controls: [inst('i1')], answers })
  assert.equal(single.byId.i1.value, 'Institut Teknologi Bandung')
  assert.equal(single.byId.i1.source, 'saved')

  const repeated = await plan({ jobId: 'job-saved-rep', education: [], controls: [inst('i1'), inst('i2')], answers })
  assert.ok(!('i1' in repeated.byId) && !('i2' in repeated.byId), JSON.stringify(repeated.res.actions))
})

test('Institution yang sudah berisi nama dibiarkan; yang berisi URL sisa isian salah diganti nama kuliah', async () => {
  const { byId, res } = await plan({
    jobId: 'job-prefilled',
    controls: [inst('i1', { currentValue: 'Universitas Gadjah Mada' }), inst('i2', { currentValue: LINKEDIN })],
  })
  assert.ok(!('i1' in byId), JSON.stringify(res.actions))
  assert.equal(byId.i2.value, 'SMA Negeri 1 Yogyakarta', 'blok ke-2 = baris pendidikan ke-2')
})

test('SMA: kolom "High school" diisi dari baris SMA, bukan dari kuliah', async () => {
  const { byId } = await plan({
    jobId: 'job-hs',
    controls: [
      { controlId: 'uni', kind: 'text', label: 'University', required: true },
      { controlId: 'hs', kind: 'text', label: 'High school', required: false },
    ],
  })
  assert.equal(byId.uni.value, 'Universitas Kristen Duta Wacana')
  assert.equal(byId.hs.value, 'SMA Negeri 1 Yogyakarta')
})

test('negatif: model menaruh token URL di kolom non-URL (Company, Description, Job title) dibuang; di GitHub tetap masuk', async () => {
  const controls = [
    { controlId: 'co', kind: 'text', label: 'Company', required: true },
    { controlId: 'desc', kind: 'textarea', label: 'Description', required: false },
    { controlId: 'jt', kind: 'text', label: 'Job title', required: true },
    { controlId: 'gh', kind: 'text', label: 'Github Profile*', required: true },
  ]
  const { res, byId, asked } = await plan({
    jobId: 'job-url-tokens',
    controls,
    ai: {
      actions: [
        { controlId: 'co', value: '{{linkedin_url}}' },
        { controlId: 'desc', value: GITHUB },
        { controlId: 'jt', value: '{{portfolio_url}}' },
        { controlId: 'gh', value: '{{github_url}}' },
      ],
    },
  })
  assert.ok(!('co' in byId) && !('desc' in byId) && !('jt' in byId), JSON.stringify(res.actions))
  assert.equal(byId.gh.value, GITHUB)
  assert.ok(asked.includes('Company') && asked.includes('Job title'), JSON.stringify(asked))
  assert.ok(asked.includes('Description') || res.pendingQuestions.length >= 2)
})

test('URL literal dari model di kolom non-URL dibuang, tetapi kalimat yang memuat tautan di kolom esai tetap diterima', async () => {
  const essay = `Kode saya ada di ${GITHUB} dan profil di ${LINKEDIN}.`
  const { byId } = await plan({
    jobId: 'job-essay',
    controls: [
      { controlId: 'q', kind: 'textarea', label: 'Describe your open source work', required: true },
      { controlId: 'n', kind: 'text', label: 'Referral name', required: false },
    ],
    ai: { actions: [{ controlId: 'q', value: essay }, { controlId: 'n', value: LINKEDIN }] },
  })
  assert.equal(byId.q?.value, essay)
  assert.ok(!('n' in byId))
})

test('kolom URL sungguhan tetap terisi: LinkedIn, GitHub, Website, dan inputType url lewat jalur fakta dan AI', async () => {
  const { byId } = await plan({
    jobId: 'job-url-ok',
    controls: [
      { controlId: 'li', kind: 'text', label: 'LinkedIn Profile URL', required: false },
      { controlId: 'gh', kind: 'text', label: 'GitHub', required: false },
      { controlId: 'web', kind: 'text', label: 'Anything', inputType: 'url', required: false },
      { controlId: 'pf', kind: 'text', label: 'Link to your best work', required: false },
    ],
    ai: { actions: [{ controlId: 'web', value: '{{portfolio_url}}' }, { controlId: 'pf', value: '{{github_url}}' }] },
  })
  assert.equal(byId.li.value, LINKEDIN)
  assert.equal(byId.gh.value, GITHUB)
  assert.equal(byId.pf.value, GITHUB)
  // Tidak ada website di profil uji, jadi token portofolio tidak terurai dan kolom dibiarkan.
  assert.ok(!('web' in byId))
})

test('blok pendidikan berulang melebihi baris profil (repeaterIndex) tidak diisi AI; blok yang punya data tetap ditawarkan', async () => {
  const controls = [
    { controlId: 'm1', kind: 'text', label: 'Major', sectionHeading: 'Education', repeaterIndex: 1, required: false },
    { controlId: 'm2', kind: 'text', label: 'Major', sectionHeading: 'Education', repeaterIndex: 2, required: false },
    { controlId: 'm3', kind: 'text', label: 'Major', sectionHeading: 'Education', repeaterIndex: 3, required: false },
    { controlId: 'w3', kind: 'text', label: 'Role', sectionHeading: 'Experience', repeaterIndex: 3, required: false },
  ]
  const { byId, prompt } = await plan({
    jobId: 'job-overflow',
    controls,
    ai: { actions: controls.map((c) => ({ controlId: c.controlId, value: 'Informatics' })) },
  })
  assert.equal(byId.m1?.value, 'Informatics')
  assert.equal(byId.m2?.value, 'Informatics')
  assert.ok(!('m3' in byId), 'blok ke-3 melebihi 2 baris pendidikan')
  assert.equal(byId.w3?.value, 'Informatics', 'bagian lain (Experience) tidak terpengaruh')
  assert.doesNotMatch(prompt, /\\"controlId\\":\\"m3\\"/)
  assert.match(prompt, /Riwayat pendidikan di profil: 2 baris/)
})

test('prompt memuat aturan token URL dan institusi', async () => {
  const { prompt } = await plan({
    jobId: 'job-prompt',
    controls: [{ controlId: 'q', kind: 'textarea', label: 'Why us?', required: true }],
  })
  assert.match(prompt, /hanya untuk kolom yang labelnya menanyakan URL/)
  assert.match(prompt, /nama institusi pendidikan/)
})
