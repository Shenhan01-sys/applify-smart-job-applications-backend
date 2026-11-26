import test from 'node:test'
import assert from 'node:assert/strict'
import { ExtensionPlanner, invalidatePlannerContextCache } from '../services/extension-planner.js'
import { indonesiaDialOption, isCountryCodeSelect, isFileLikeSelect } from '../services/extension-control-hints.js'
import { makeExtensionTestDb, USER_ID } from './extension-test-db.js'

// Uji live Dealls 26 November 2026: kartu Persetujuan menanyakan "IDN (opsional)" (pemilih kode negara telepon) dan
// "File PDF (opsional)" (kontrol unggah berkas) sebagai dropdown "Pilih jawaban".

const DIAL_OPTIONS = ['Singapura (+65)', 'Indonesia (+62)', 'Malaysia (+60)', 'Amerika Serikat (+1)']
const base = { groupLabel: '', name: '', placeholder: '', currentValue: '' }

test('isCountryCodeSelect: label IDN atau +62, label kode negara, atau pilihan berisi kode telepon', () => {
  assert.equal(isCountryCodeSelect({ ...base, kind: 'select', label: 'IDN', options: DIAL_OPTIONS }), true)
  assert.equal(isCountryCodeSelect({ ...base, kind: 'select', label: 'IDN', options: [] }), true)
  assert.equal(isCountryCodeSelect({ ...base, kind: 'select', label: '+62', options: [] }), true)
  assert.equal(isCountryCodeSelect({ ...base, kind: 'select', label: 'Kode negara', options: [] }), true)
  assert.equal(isCountryCodeSelect({ ...base, kind: 'select', label: 'Negara', options: DIAL_OPTIONS }), true)
  assert.equal(isCountryCodeSelect({ ...base, kind: 'select', label: 'SGP', options: DIAL_OPTIONS }), true)
})

test('isCountryCodeSelect: pilihan biasa dan kolom teks bukan kode negara', () => {
  assert.equal(isCountryCodeSelect({ ...base, kind: 'select', label: 'Pendidikan terakhir', options: ['S1', 'S2', 'SMA'] }), false)
  assert.equal(isCountryCodeSelect({ ...base, kind: 'select', label: 'Pengalaman', options: ['1-3 tahun', '3-5 tahun', '5+ tahun'] }), false)
  assert.equal(isCountryCodeSelect({ ...base, kind: 'select', label: 'KTP', options: [] }), false)
  assert.equal(isCountryCodeSelect({ ...base, kind: 'text', label: 'IDN', options: [] }), false)
})

test('indonesiaDialOption: memilih Indonesia (+62) dari berbagai bentuk daftar', () => {
  assert.equal(indonesiaDialOption(DIAL_OPTIONS), 'Indonesia (+62)')
  assert.equal(indonesiaDialOption(['+1', '+62', '+65']), '+62')
  assert.equal(indonesiaDialOption(['SGP', 'IDN', 'MYS']), 'IDN')
  assert.equal(indonesiaDialOption(['Malaysia', 'Indonesia']), 'Indonesia')
  assert.equal(indonesiaDialOption(['+620', '+65']), null)
  assert.equal(indonesiaDialOption([]), null)
})

test('isFileLikeSelect: dropdown unggah berkas dikenali, pilihan jawaban nyata tidak', () => {
  assert.equal(isFileLikeSelect({ ...base, kind: 'select', label: 'File PDF', options: ['File PDF'] }), true)
  assert.equal(isFileLikeSelect({ ...base, kind: 'select', label: 'Unggah CV', options: [] }), true)
  assert.equal(isFileLikeSelect({ ...base, kind: 'select', label: 'Lampiran', options: ['Pilih berkas'] }), true)
  assert.equal(isFileLikeSelect({ ...base, kind: 'select', label: 'Dokumen identitas', options: ['KTP', 'Paspor'] }), false)
  assert.equal(isFileLikeSelect({ ...base, kind: 'select', label: 'Pendidikan terakhir', options: [] }), false)
  assert.equal(isFileLikeSelect({ ...base, kind: 'text', label: 'Unggah CV', options: [] }), false)
})

function seed(jobId: string) {
  return {
    jobs: [{ id: jobId, title: 'Junior Accountant', company: 'Acme', description: '', location: 'Jakarta' }],
    profiles: [{ id: USER_ID, full_name: 'Budi Santoso', skills: [] }],
    work_experiences: [],
    user_form_answers: [],
  }
}

async function plan(jobId: string, rawControls: any[], opts: { retryHints?: any[] } = {}) {
  invalidatePlannerContextCache()
  const aiSeen: string[] = []
  const planner = new ExtensionPlanner(async (req: any) => {
    aiSeen.push(...(String(req.user ?? JSON.stringify(req)).match(/"controlId":"[^"]+"/g) ?? []))
    return { model: 'm', text: '{"actions":[]}' }
  })
  const res = await planner.planForm({
    db: makeExtensionTestDb(seed(jobId)).db,
    userId: USER_ID,
    jobId,
    pageUrl: 'https://dealls.com/jobs/1/apply',
    rawControls,
    ...(opts.retryHints ? { retryHints: opts.retryHints } : {}),
  })
  return { res, aiSeen }
}

test('planner: pemilih kode negara bukan Indonesia diisi Indonesia (+62), tidak ditanyakan, dan tidak dikirim ke AI', async () => {
  const { res, aiSeen } = await plan('job-cc', [
    { controlId: 'cc', kind: 'select', label: 'SGP', required: false, options: DIAL_OPTIONS },
    { controlId: 'phone', kind: 'text', label: 'Nomor telepon', inputType: 'tel', required: true },
  ])
  const cc = res.actions.find((a: any) => a.controlId === 'cc')
  assert.deepEqual(cc, { controlId: 'cc', kind: 'select', value: 'Indonesia (+62)', source: 'fact' })
  assert.ok(!res.pendingQuestions.some((q: any) => q.label.includes('SGP')), JSON.stringify(res.pendingQuestions))
  assert.ok(!aiSeen.includes('"controlId":"cc"'), 'kode negara tidak dikirim ke AI')
})

test('planner: pemilih yang sudah menampilkan IDN (kasus Dealls) dibiarkan dan tidak ditanyakan', async () => {
  const { res } = await plan('job-idn', [{ controlId: 'cc', kind: 'select', label: 'IDN', required: false, options: DIAL_OPTIONS }])
  assert.ok(!res.actions.some((a: any) => a.controlId === 'cc'))
  assert.equal(res.pendingQuestions.length, 0, JSON.stringify(res.pendingQuestions))
})

test('planner: pemilih kode negara yang sudah Indonesia dibiarkan, dan yang tanpa pilihan terbaca tidak ditanyakan', async () => {
  const already = await plan('job-cc2', [
    { controlId: 'cc', kind: 'select', label: 'Kode negara', currentValue: 'Indonesia (+62)', required: false, options: DIAL_OPTIONS },
  ])
  assert.ok(!already.res.actions.some((a: any) => a.controlId === 'cc'))
  assert.equal(already.res.pendingQuestions.length, 0)

  const unknown = await plan('job-cc3', [{ controlId: 'cc', kind: 'select', label: 'IDN', required: true, options: [] }])
  assert.ok(!unknown.res.actions.some((a: any) => a.controlId === 'cc'))
  assert.equal(unknown.res.pendingQuestions.length, 0, JSON.stringify(unknown.res.pendingQuestions))
})

test('planner: dropdown unggah berkas menjadi pertanyaan jenis file tanpa pilihan, bukan select', async () => {
  const { res, aiSeen } = await plan('job-file', [
    { controlId: 'f1', kind: 'select', label: 'File PDF', required: false, options: ['File PDF'] },
    { controlId: 'name', kind: 'text', label: 'Nama lengkap', required: true },
  ])
  const q = res.pendingQuestions.find((x: any) => x.label === 'File PDF')
  assert.ok(q, JSON.stringify(res.pendingQuestions))
  assert.equal(q.kind, 'file')
  assert.equal(q.required, false)
  assert.equal('options' in q, false)
  assert.ok(!res.actions.some((a: any) => a.controlId === 'f1'))
  assert.ok(!aiSeen.includes('"controlId":"f1"'), 'dropdown berkas tidak dikirim ke AI')
})

test('planner: dropdown biasa berpilihan nyata tetap menjadi pertanyaan select', async () => {
  const { res } = await plan('job-sel', [
    { controlId: 'edu', kind: 'select', label: 'Pendidikan terakhir', required: true, options: ['SMA', 'S1', 'S2'] },
  ])
  const q = res.pendingQuestions.find((x: any) => x.label === 'Pendidikan terakhir')
  assert.equal(q?.kind, 'select')
  assert.deepEqual(q?.options, ['SMA', 'S1', 'S2'])
})
