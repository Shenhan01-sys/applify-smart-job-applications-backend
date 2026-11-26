import test from 'node:test'
import assert from 'node:assert/strict'
import { ExtensionPlanner, sanitizeExtensionControls } from '../services/extension-planner.js'
import type { GuardDb } from '../services/queue-guard.js'

function fakePlannerDb(opts: {
  workRows?: any[]
  profile?: any
  answers?: Array<{ question_key: string; question_label: string; answer: string }>
} = {}): GuardDb {
  return {
    from(table: string) {
      const chain: any = {
        select() { return chain },
        eq() { return chain },
        in() { return chain },
        order() { return chain },
        limit() {
          if (table === 'user_form_answers') return Promise.resolve({ data: opts.answers ?? [], error: null })
          if (table === 'work_experiences') return Promise.resolve({ data: opts.workRows ?? [], error: null })
          if (table === 'user_skills') return Promise.resolve({ data: [], error: null })
          if (table === 'user_achievements') return Promise.resolve({ data: [], error: null })
          return Promise.resolve({ data: [], error: null })
        },
        maybeSingle() {
          if (table === 'jobs') return Promise.resolve({ data: { id: 'job-1', title: 'Engineer', company: 'Acme', location: 'Jakarta' }, error: null })
          if (table === 'profiles') return Promise.resolve({ data: opts.profile ?? { full_name: 'Budi', experience_years: 2 }, error: null })
          if (table === 'user_automation_settings') return Promise.resolve({ data: { use_ai: true }, error: null })
          return Promise.resolve({ data: null, error: null })
        },
      }
      return chain
    },
  }
}

test('U2-01: ExtensionPlanner dapat mematikan toggle/checkbox yang menyala lewat fact, saved, maupun AI', async () => {
  const planner = new ExtensionPlanner(async () => ({
    model: 'fake-model',
    text: JSON.stringify({
      actions: [{ controlId: 'c-ai-off', value: false }],
    }),
  }))

  const db = fakePlannerDb({
    workRows: [{ role: 'Developer', company: 'PT Maju' }],
    profile: { full_name: 'Budi', experience_years: 3 },
    answers: [{ question_key: 'butuh sponsor visa', question_label: 'Butuh sponsor visa', answer: 'Tidak' }],
  })

  const res = await planner.planForm({
    db,
    userId: 'u-1',
    jobId: 'job-1',
    pageUrl: 'https://id.jobstreet.com/id/job/123/apply',
    rawControls: [
      { controlId: 'c-fresh', kind: 'checkbox', role: 'switch', label: 'Saya baru masuk dunia kerja', checked: true, required: false },
      { controlId: 'c-saved-off', kind: 'checkbox', role: 'switch', label: 'Butuh sponsor visa', checked: true, required: false },
      { controlId: 'c-ai-off', kind: 'checkbox', role: 'switch', label: 'Masih bekerja di perusahaan sebelumnya', checked: true, required: false },
    ],
  })

  const byId = new Map(res.actions.map((a) => [a.controlId, a]))
  assert.equal(byId.get('c-fresh')?.value, false)
  assert.equal(byId.get('c-fresh')?.source, 'fact')
  assert.equal(byId.get('c-saved-off')?.value, false)
  assert.equal(byId.get('c-saved-off')?.source, 'saved')
  assert.equal(byId.get('c-ai-off')?.value, false)
  assert.equal(byId.get('c-ai-off')?.source, 'ai')
})

test('U2-02: sanitizeExtensionControls dan pendingQuestions menjaga konteks grup dan mendisambiguasi label kembar', async () => {
  const sanitized = sanitizeExtensionControls([
    {
      controlId: 'c-1',
      kind: 'text',
      label: 'Nama perusahaan',
      sectionHeading: 'Riwayat Pekerjaan',
      groupHeading: 'Pengalaman Terakhir',
      helperText: 'Kosongkan bila fresh graduate',
      repeaterIndex: 1,
      required: true,
    },
    {
      controlId: 'c-2',
      kind: 'text',
      label: 'Nama perusahaan',
      sectionHeading: 'Riwayat Pekerjaan',
      groupHeading: 'Pengalaman Sebelumnya',
      repeaterIndex: 2,
      required: true,
    },
  ])
  assert.equal(sanitized[0].sectionHeading, 'Riwayat Pekerjaan')
  assert.equal(sanitized[0].repeaterIndex, 1)

  const planner = new ExtensionPlanner(async () => ({ model: 'fake', text: '{"actions":[]}' }))
  const db = fakePlannerDb({ profile: { full_name: 'Siti' } })
  const res = await planner.planForm({
    db,
    userId: 'u-2',
    jobId: 'job-1',
    pageUrl: 'https://boards.greenhouse.io/acme/jobs/1',
    rawControls: sanitized,
  })

  assert.equal(res.pendingQuestions.length, 2)
  assert.equal(res.pendingQuestions[0].label, 'Nama perusahaan')
  assert.match(res.pendingQuestions[0].context ?? '', /Riwayat Pekerjaan/)
  assert.match(res.pendingQuestions[0].context ?? '', /Pengalaman Terakhir #1/)
  assert.equal(res.pendingQuestions[1].label, 'Nama perusahaan')
  assert.match(res.pendingQuestions[1].context ?? '', /Pengalaman Sebelumnya #2/)
  assert.notEqual(res.pendingQuestions[0].key, res.pendingQuestions[1].key)
})
