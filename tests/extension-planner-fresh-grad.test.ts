import test from 'node:test'
import assert from 'node:assert/strict'
import { ExtensionPlanner, NO_WORK_EXPERIENCE_RE, invalidatePlannerContextCache, noWorkExperienceState } from '../services/extension-planner.js'
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
