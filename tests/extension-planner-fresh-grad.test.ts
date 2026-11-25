import test from 'node:test'
import assert from 'node:assert/strict'
import { ExtensionPlanner, NO_WORK_EXPERIENCE_RE, invalidatePlannerContextCache, latestWorkExperience, monthYear, noWorkExperienceState } from '../services/extension-planner.js'
import { makeExtensionTestDb, USER_ID } from './extension-test-db.js'

// Uji live JobStreet 26 November 2026: langkah profil meminta "Posisi pekerjaan" dan "Nama perusahaan", dengan sakelar
// "Saya baru masuk dunia kerja" untuk pelamar tanpa riwayat kerja.

const CONTROLS = [
  { controlId: 'fresh', kind: 'checkbox', label: 'Saya baru masuk dunia kerja', required: false },
  { controlId: 'title', kind: 'select', label: 'Posisi pekerjaan', required: true },
  { controlId: 'company', kind: 'text', label: 'Nama perusahaan', required: true },
  { controlId: 'city', kind: 'text', label: 'Kota domisili', required: true },
]

function seed(jobId: string, opts: { work?: any[]; years?: number | null } = {}) {
  return {
    jobs: [{ id: jobId, title: 'QA Tester Intern', company: 'Acme', description: '', location: 'Jakarta' }],
    profiles: [{ id: USER_ID, full_name: 'Budi Santoso', skills: [], experience_years: opts.years ?? null }],
    work_experiences: (opts.work ?? []).map((w) => ({ user_id: USER_ID, ...w })),
    user_form_answers: [],
  }
}

async function plan(jobId: string, opts: { work?: any[]; years?: number | null }, aiText = '{"actions":[]}') {
  invalidatePlannerContextCache()
  let aiControls: string[] = []
  const planner = new ExtensionPlanner(async (req: any) => {
    aiControls = String(req.user ?? req.prompt ?? JSON.stringify(req)).match(/"controlId":"[^"]+"/g) ?? []
    return { model: 'm', text: aiText }
  })
  const res = await planner.planForm({
    db: makeExtensionTestDb(seed(jobId, opts)).db,
    userId: USER_ID,
    jobId,
    pageUrl: 'https://id.jobstreet.com/id/job/1/apply/profile',
    rawControls: CONTROLS,
  })
  return { res, aiControls }
}

test('tanpa riwayat kerja: sakelar dicentang lebih dulu, posisi dan perusahaan tidak diisi atau ditanyakan', async () => {
  const { res } = await plan('job-fresh', {}, '{"actions":[{"controlId":"title","value":"QA Tester"}]}')
  assert.deepEqual(res.actions[0], { controlId: 'fresh', kind: 'checkbox', value: true, source: 'fact' })
  const ids = res.actions.map((a: any) => a.controlId)
  assert.ok(!ids.includes('title') && !ids.includes('company'), JSON.stringify(res.actions))
  const asked = res.pendingQuestions.map((q: any) => q.label)
  assert.ok(!asked.includes('Posisi pekerjaan') && !asked.includes('Nama perusahaan'), JSON.stringify(asked))
  assert.ok(asked.includes('Kota domisili') || ids.includes('city'), 'kolom lain tetap diproses')
})

test('dengan riwayat kerja: sakelar tidak dicentang walau AI memintanya', async () => {
  const { res } = await plan(
    'job-exp',
    { work: [{ company_name: 'PT Contoh', is_current: true, start_date: '2024-01-01', end_date: null }] },
    '{"actions":[{"controlId":"fresh","value":true}]}',
  )
  assert.ok(!res.actions.some((a: any) => a.controlId === 'fresh'), JSON.stringify(res.actions))
})

test('experience_years positif dihitung punya pengalaman; galat kueri riwayat kerja dihitung tidak diketahui', () => {
  assert.equal(noWorkExperienceState([], { experience_years: 2 }), 'has')
  assert.equal(noWorkExperienceState([], { experience_years: 0 }), 'none')
  assert.equal(noWorkExperienceState(null, {}), 'unknown')
  assert.equal(noWorkExperienceState([{ company_name: 'X' }], {}), 'has')
})

test('sakelar yang sudah menyala tidak diklik ulang', async () => {
  invalidatePlannerContextCache()
  const planner = new ExtensionPlanner(async () => ({ model: 'm', text: '{"actions":[]}' }))
  const res = await planner.planForm({
    db: makeExtensionTestDb(seed('job-on')).db,
    userId: USER_ID,
    jobId: 'job-on',
    pageUrl: 'https://id.jobstreet.com/id/job/1/apply/profile',
    rawControls: [{ ...CONTROLS[0], checked: true }, CONTROLS[3]],
  })
  assert.ok(!res.actions.some((a: any) => a.controlId === 'fresh'))
})

test('NO_WORK_EXPERIENCE_RE: label sakelar dikenali, label biasa tidak', () => {
  for (const l of ['Saya baru masuk dunia kerja', 'Saya belum punya pengalaman kerja', "I don't have work experience", 'I have no work experience', 'Fresh graduate']) {
    assert.match(l, NO_WORK_EXPERIENCE_RE, l)
  }
  for (const l of ['Pengalaman kerja (tahun)', 'Posisi pekerjaan', 'Saya setuju dengan syarat']) assert.doesNotMatch(l, NO_WORK_EXPERIENCE_RE, l)
})

test('riwayat karir: peran terakhir jadi token, bulan mulai cocok dengan pilihan "Agu", dan masuk prompt', async () => {
  invalidatePlannerContextCache()
  let prompt = ''
  const planner = new ExtensionPlanner(async (req: any) => {
    prompt = JSON.stringify(req)
    return {
      model: 'm',
      text: JSON.stringify({
        actions: [
          { controlId: 'company', value: '{{latest_company}}' },
          { controlId: 'smonth', value: '{{latest_start_month}}' },
          { controlId: 'syear', value: '{{latest_start_year}}' },
          { controlId: 'still', value: true },
        ],
      }),
    }
  })
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des']
  const res = await planner.planForm({
    db: makeExtensionTestDb(
      seed('job-career', {
        work: [
          { company_name: 'PT Lama', role_title: 'Intern', is_current: false, start_date: '2022-01-01', end_date: '2022-06-30' },
          { company_name: 'Kebaya Oma', role_title: 'Freelancer', is_current: true, start_date: '2024-08-01', end_date: null },
        ],
      }),
    ).db,
    userId: USER_ID,
    jobId: 'job-career',
    pageUrl: 'https://id.jobstreet.com/id/job/1/apply/profile',
    rawControls: [
      { controlId: 'company', kind: 'text', label: 'Nama perusahaan', required: true },
      { controlId: 'smonth', kind: 'select', label: 'Mulai', options: months, required: false },
      { controlId: 'syear', kind: 'select', label: 'Mulai tahun', options: ['2026', '2025', '2024', '2023'], required: false },
      { controlId: 'still', kind: 'checkbox', label: 'Masih dalam jabatan ini', required: false },
    ],
  })
  const byId = Object.fromEntries(res.actions.map((a: any) => [a.controlId, a.value]))
  assert.equal(byId.company, 'Kebaya Oma')
  assert.equal(byId.smonth, 'Agu')
  assert.equal(byId.syear, '2024')
  assert.equal(byId.still, true)
  assert.match(prompt, /latest_company/)
  assert.match(prompt, /Masih menjabat di peran ini: ya/)
})

test('monthYear dan latestWorkExperience', () => {
  assert.deepEqual(monthYear('2024-08-01'), { month: 'Agustus', year: '2024' })
  assert.equal(monthYear('bukan tanggal'), null)
  assert.equal(monthYear(null), null)
  const rows = [
    { role_title: 'A', start_date: '2023-01-01', is_current: false },
    { role_title: 'B', start_date: '2020-01-01', is_current: true },
    { role_title: '', company_name: '', start_date: '2025-01-01', is_current: true },
  ]
  assert.equal(latestWorkExperience(rows)?.role_title, 'B')
  assert.equal(latestWorkExperience(null), null)
})

test('judul kelompok (legend Mulai/Berakhir) ikut di label pertanyaan Bulan dan Tahun', async () => {
  invalidatePlannerContextCache()
  let prompt = ''
  const planner = new ExtensionPlanner(async (req: any) => {
    prompt = JSON.stringify(req)
    return { model: 'm', text: '{"actions":[]}' }
  })
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des']
  const res = await planner.planForm({
    db: makeExtensionTestDb(seed('job-group')).db,
    userId: USER_ID,
    jobId: 'job-group',
    pageUrl: 'https://id.jobstreet.com/id/job/1/apply/profile',
    rawControls: [
      { controlId: 'sm', kind: 'select', label: 'Bulan', groupLabel: 'Mulai', options: months, required: true },
      { controlId: 'em', kind: 'select', label: 'Bulan', groupLabel: 'Berakhir', options: months, required: true },
    ],
  })
  assert.match(prompt, /Mulai Bulan/)
  assert.match(prompt, /Berakhir Bulan/)
  const labels = res.pendingQuestions.map((q: any) => q.label)
  assert.ok(labels.includes('Mulai Bulan') && labels.includes('Berakhir Bulan'), JSON.stringify(labels))
})
