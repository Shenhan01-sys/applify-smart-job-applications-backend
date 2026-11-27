import test from 'node:test'
import assert from 'node:assert/strict'
import { ExtensionPlanner, invalidatePlannerContextCache, latestEducation } from '../services/extension-planner.js'
import { makeExtensionTestDb, USER_ID } from './extension-test-db.js'

// Audit formulir Lever (Palantir SG New Grad): pertanyaan universitas, tahun lulus, dan SMA tidak punya token profil.
// Data berasal dari tabel `education` (institution, degree, start_year, end_year, is_current). Skema tidak punya kolom bahasa,
// jadi tidak ada token bahasa.

const CONTROLS = [
  { controlId: 'uni', kind: 'text', label: 'University', required: true },
  { controlId: 'grad', kind: 'text', label: 'Expected graduation year', required: true },
  { controlId: 'hs', kind: 'text', label: 'High school', required: false },
  { controlId: 'hsyear', kind: 'text', label: 'High school graduation year', required: false },
]

const AI_ALL = JSON.stringify({
  actions: [
    { controlId: 'uni', value: '{{school_name}}' },
    { controlId: 'grad', value: '{{graduation_year}}' },
    { controlId: 'hs', value: '{{high_school_name}}' },
    { controlId: 'hsyear', value: '{{high_school_year}}' },
  ],
})

async function run(jobId: string, education: any[]) {
  invalidatePlannerContextCache()
  let prompt = ''
  const planner = new ExtensionPlanner(async (req: any) => {
    prompt = JSON.stringify(req)
    return { model: 'm', text: AI_ALL }
  })
  const res = await planner.planForm({
    db: makeExtensionTestDb({
      jobs: [{ id: jobId, title: 'New Grad Engineer', company: 'Acme', description: '', location: 'Singapore' }],
      profiles: [{ id: USER_ID, full_name: 'Budi Santoso', skills: [] }],
      education: education.map((e) => ({ user_id: USER_ID, ...e })),
      user_form_answers: [],
    }).db,
    userId: USER_ID,
    jobId,
    pageUrl: 'https://jobs.lever.co/acme/1/apply',
    rawControls: CONTROLS,
  })
  const byId = Object.fromEntries(res.actions.map((a: any) => [a.controlId, a.value]))
  return { byId, prompt }
}

test('token pendidikan: universitas, tahun lulus (perkiraan, baris berjalan), SMA, dan tahun lulus SMA terisi dari tabel education', async () => {
  const { byId, prompt } = await run('job-edu-full', [
    { institution: 'SMA Negeri 1 Yogyakarta', degree: 'SMA/IPA', start_year: 2018, end_year: 2021, is_current: false },
    { institution: 'Universitas Kristen Duta Wacana', degree: 'S1 Sistem Informasi', start_year: 2022, end_year: 2026, is_current: true },
  ])
  assert.equal(byId.uni, 'Universitas Kristen Duta Wacana')
  assert.equal(byId.grad, '2026')
  assert.equal(byId.hs, 'SMA Negeri 1 Yogyakarta')
  assert.equal(byId.hsyear, '2021')
  assert.match(prompt, /token \{\{school_name\}\}/)
  assert.match(prompt, /token \{\{graduation_year\}\}/)
  assert.match(prompt, /token \{\{high_school_name\}\}/)
})

test('token pendidikan: tanpa end_year tahun lulus tidak ditebak, tanpa baris SMA token SMA tidak ada', async () => {
  const { byId, prompt } = await run('job-edu-partial', [
    { institution: 'Universitas Gadjah Mada', degree: 'S1 Ilmu Komputer', start_year: 2022, end_year: null, is_current: true },
  ])
  assert.equal(byId.uni, 'Universitas Gadjah Mada')
  assert.ok(!('grad' in byId), JSON.stringify(byId))
  assert.ok(!('hs' in byId) && !('hsyear' in byId), JSON.stringify(byId))
  assert.doesNotMatch(prompt, /\{\{graduation_year\}\}/)
  assert.doesNotMatch(prompt, /\{\{high_school_name\}\}/)
})

test('token pendidikan: tanpa data pendidikan tidak ada token dan tidak ada aksi', async () => {
  const { byId, prompt } = await run('job-edu-none', [])
  assert.deepEqual(byId, {})
  assert.doesNotMatch(prompt, /\{\{school_name\}\}/)
})

test('latestEducation: berjalan lebih dulu, lalu end_year terbesar; SMA dan kuliah dipisah; institusi kosong dilewati', () => {
  const rows = [
    { institution: 'Kampus Lama', degree: 'D3', start_year: 2015, end_year: 2018, is_current: false },
    { institution: 'Kampus Baru', degree: 'S1', start_year: 2019, end_year: 2023, is_current: false },
    { institution: '', degree: 'S2', start_year: 2024, end_year: 2026, is_current: true },
    { institution: 'SMK Negeri 2', degree: 'SMK', start_year: 2012, end_year: 2015, is_current: false },
    { institution: 'Sunrise High School', degree: 'High School Diploma', start_year: 2010, end_year: 2014, is_current: false },
    { institution: 'Master of Arts Academy', degree: 'MA Linguistics', start_year: 2024, end_year: 2026, is_current: false },
  ]
  assert.equal(latestEducation(rows)?.institution, 'Master of Arts Academy')
  assert.equal(latestEducation(rows, true)?.institution, 'SMK Negeri 2')
  assert.equal(latestEducation(rows.filter((r) => r.institution !== 'Master of Arts Academy'))?.institution, 'Kampus Baru')
  assert.equal(latestEducation(null), null)
  assert.equal(latestEducation([]), null)
  assert.equal(latestEducation([{ institution: 'Kampus Saja', degree: 'S1' }], true), null)
})
