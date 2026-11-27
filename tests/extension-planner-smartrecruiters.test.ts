import test from 'node:test'
import assert from 'node:assert/strict'
import { ExtensionPlanner, invalidatePlannerContextCache, sanitizeExtensionControls } from '../services/extension-planner.js'
import { isCountryCodeSelect } from '../services/extension-control-hints.js'
import { planFileTargets } from '../services/extension-file-targets.js'
import { makeExtensionTestDb, USER_ID } from './extension-test-db.js'

// Uji isi nyata SmartRecruiters "Easy Apply" (oneclick-ui, 27 November 2026, Pusat Inovasi Global). Kontrol di bawah meniru
// bacaan ekstensi dari halaman itu (komponen web `spl-*` dalam shadow root): kolom terkunci pada hasil nyata, yaitu
// Institution (input combobox pencarian), pemilih kode negara telepon (tombol combobox yang daftarnya dimuat malas,
// labelnya "Afghanistan +93"), dan kotak persetujuan pemrosesan data pribadi (label tepat 300 huruf pertama).

const LINKEDIN = 'https://www.linkedin.com/in/hans-gunawan01/'

/** Satu baris pendidikan di tabel produksi: end_year kosong, gelar "B.Sc.". */
const UKDW = [{ institution: 'Universitas Kristen Duta Wacana (UKDW)', degree: 'B.Sc.', start_year: 2023, end_year: null, is_current: false }]

const CONSENT_LABEL =
  'Please be informed that your application to this job offer will trigger some processing of your personal data by the recruiting company, the data controller. SmartRecruiters, the data processor, has no control over such personal data processing. For more information on these personal data processing, please refer to the recruiting company’s privacy notice.'.slice(
    0,
    300
  )

async function plan(opts: { jobId: string; controls: any[]; education?: any[]; ai?: unknown; profile?: Record<string, unknown>; isRetry?: boolean }) {
  invalidatePlannerContextCache()
  let prompt = ''
  const planner = new ExtensionPlanner(async (req: any) => {
    prompt = JSON.stringify(req)
    return { model: 'm', text: JSON.stringify(opts.ai ?? { actions: [] }) }
  })
  const res = await planner.planForm({
    db: makeExtensionTestDb({
      jobs: [{ id: opts.jobId, title: 'Python Developer - Full Stack', company: 'Pusat Inovasi Global', description: '', location: 'Kochi' }],
      profiles: [{ id: USER_ID, full_name: 'Hans Gunawan', skills: [], linkedin_url: LINKEDIN, ...(opts.profile ?? {}) }],
      education: (opts.education ?? UKDW).map((e) => ({ user_id: USER_ID, ...e })),
    }).db,
    userId: USER_ID,
    jobId: opts.jobId,
    pageUrl: 'https://jobs.smartrecruiters.com/oneclick-ui/company/PusatInovasiGlobal/publication/f15adfc7',
    rawControls: opts.controls,
  })
  const byId = Object.fromEntries(res.actions.map((a: any) => [a.controlId, a]))
  const asked = res.pendingQuestions.map((q: any) => q.label)
  return { res, byId, asked, prompt }
}

/** Input combobox pencarian SmartRecruiters (`input[role=combobox]`, daftar saran dimuat dari server). */
const searchBox = (controlId: string, label: string, extra: Record<string, unknown> = {}) => ({
  controlId,
  kind: 'select',
  label,
  required: true,
  searchable: true,
  options: [],
  inputType: 'text',
  role: 'combobox',
  ...extra,
})

test('Institution (input combobox pencarian) diisi dari tabel education walau end_year kosong dan gelar "B.Sc."', async () => {
  const { res, byId, asked } = await plan({
    jobId: 'job-sr-inst',
    controls: [
      searchBox('applify_c_18', 'Institution*'),
      { controlId: 'applify_c_19', kind: 'text', label: 'Major', required: false },
      { controlId: 'applify_c_21', kind: 'select', label: 'School location', required: false, searchable: true, options: [] },
    ],
  })
  assert.deepEqual(byId.applify_c_18, {
    controlId: 'applify_c_18',
    kind: 'select',
    value: 'Universitas Kristen Duta Wacana (UKDW)',
    source: 'fact',
    typeToSearch: true,
  })
  assert.ok(!asked.includes('Institution*'), JSON.stringify(asked))
  assert.ok(!res.actions.some((a: any) => String(a.value).includes('linkedin')), JSON.stringify(res.actions))
})

test('Institution tidak pernah menerima URL walau model menjawab {{linkedin_url}} untuk kolom combobox itu', async () => {
  const { byId } = await plan({
    jobId: 'job-sr-inst-ai',
    controls: [searchBox('applify_c_18', 'Institution*'), { controlId: 'applify_c_22', kind: 'text', label: 'LinkedIn', required: false }],
    ai: { actions: [{ controlId: 'applify_c_18', value: '{{linkedin_url}}' }, { controlId: 'applify_c_22', value: '{{linkedin_url}}' }] },
  })
  assert.equal(byId.applify_c_18.value, 'Universitas Kristen Duta Wacana (UKDW)')
  assert.equal(byId.applify_c_22.value, LINKEDIN)
})

test('id kontrol kembar dari halaman (sisa tanda lama): yang pertama menurut urutan halaman dipakai, URL tidak masuk Institution', async () => {
  // Bentuk payload sebelum id dibuat unik (shadow root): Institution dan LinkedIn sama-sama `applify_c_10`. Ekstensi mengisi
  // elemen pertama menurut urutan dokumen, jadi perencana harus memakai kontrol pertama pula dan tidak mengirim URL ke sana.
  const controls = sanitizeExtensionControls([
    searchBox('applify_c_10', 'Institution*'),
    { controlId: 'applify_c_10', kind: 'text', label: 'LinkedIn', required: false },
  ])
  assert.deepEqual(controls.map((c) => c.label), ['Institution*'])
  const { byId } = await plan({
    jobId: 'job-sr-dup',
    controls: [
      searchBox('applify_c_10', 'Institution*'),
      { controlId: 'applify_c_10', kind: 'text', label: 'LinkedIn', required: false },
    ],
  })
  assert.equal(byId.applify_c_10.value, 'Universitas Kristen Duta Wacana (UKDW)')
})

test('pemilih kode negara "Afghanistan +93" tanpa daftar pilihan (dimuat malas) diisi Indonesia dan tidak ditanyakan', async () => {
  const { res, byId, asked } = await plan({
    jobId: 'job-sr-cc',
    controls: [
      searchBox('applify_c_7', 'Afghanistan +93', { required: false }),
      { controlId: 'applify_c_9', kind: 'text', label: 'Phone number', placeholder: '812 345 678', inputType: 'tel', required: true },
    ],
    profile: { phone: '+6289673280495' },
  })
  assert.deepEqual(byId.applify_c_7, { controlId: 'applify_c_7', kind: 'select', value: 'Indonesia', source: 'fact', typeToSearch: true })
  assert.ok(!asked.some((l: string) => /afghanistan/i.test(l)), JSON.stringify(asked))
  assert.ok(!res.pendingQuestions.some((q: any) => q.key === 'afghanistan 93'))
})

test('pemilih kode negara dengan label "Country code" atau pilihan terbaca: Indonesia (+62) dipilih langsung dari daftar', async () => {
  const bare = await plan({ jobId: 'job-sr-cc2', controls: [searchBox('cc', 'Country code', { required: false })] })
  assert.equal(bare.byId.cc.value, 'Indonesia')

  const withOptions = await plan({
    jobId: 'job-sr-cc3',
    controls: [
      {
        controlId: 'cc',
        kind: 'select',
        label: 'Afghanistan +93',
        required: false,
        options: ['Afghanistan +93', 'Åland Islands +358', 'Indonesia +62', 'Singapore +65'],
      },
    ],
  })
  assert.equal(withOptions.byId.cc.value, 'Indonesia +62')

  // Sudah Indonesia: dibiarkan, tidak ditanyakan.
  const already = await plan({ jobId: 'job-sr-cc4', controls: [searchBox('cc', 'Indonesia +62', { required: false })] })
  assert.ok(!('cc' in already.byId))
  assert.deepEqual(already.asked, [])
})

test('isCountryCodeSelect: "nama negara +kode" dikenali; label biasa dan non-select tidak', () => {
  const base = { kind: 'select' as const, groupLabel: '', name: '', placeholder: '', options: [] as string[], currentValue: '' }
  for (const label of ['Afghanistan +93', 'Åland Islands +358', 'Indonesia (+62)', 'United States +1', "Côte d'Ivoire +225"]) {
    assert.equal(isCountryCodeSelect({ ...base, label }), true, label)
  }
  for (const label of ['City', 'Years of experience', 'Expected salary 5000', 'Do you need +1 sponsorship for 2 years', 'Institution*', '']) {
    assert.equal(isCountryCodeSelect({ ...base, label }), false, label)
  }
  assert.equal(isCountryCodeSelect({ ...base, kind: 'text' as any, label: 'Afghanistan +93' }), false)
  assert.equal(isCountryCodeSelect({ ...base, label: 'Country', currentValue: 'Afghanistan +93' }), true, 'nilai terpilih ikut dibaca')
})

test('kotak persetujuan pemrosesan data pribadi (label 300 huruf pertama, tanpa kata "privacy") tidak pernah dicentang dan menjadi pertanyaan persetujuan', async () => {
  assert.ok(!/privacy/i.test(CONSENT_LABEL), 'label terpotong sebelum kata privacy: pengenalan harus bertumpu pada "personal data"')
  const controls = [{ controlId: 'applify_c_16', kind: 'checkbox', label: CONSENT_LABEL, required: true, inputType: 'checkbox' }]
  const { res, byId } = await plan({ jobId: 'job-sr-consent', controls, ai: { actions: [{ controlId: 'applify_c_16', value: true }] } })
  assert.ok(!('applify_c_16' in byId), JSON.stringify(res.actions))
  assert.equal(res.pendingQuestions.length, 1)
  assert.equal(res.pendingQuestions[0].reason, 'consent')
  assert.equal(res.pendingQuestions[0].required, true)
  assert.match(res.pendingQuestions[0].label, /^Please be informed/)
})

test('berkas: dua dropzone yang sama-sama berlabel "Choose a file or drop it here" menghasilkan satu target CV (yang pertama)', () => {
  const file = (controlId: string, elementId: string) => ({
    controlId,
    kind: 'file' as const,
    label: 'Choose a file or drop it here',
    groupLabel: '',
    name: '',
    placeholder: '',
    elementId,
  })
  const targets = planFileTargets([file('applify_c_0', 'spl-dropzone-file-input-2'), file('applify_c_14', 'spl-dropzone-file-input-1')])
  assert.deepEqual(targets, [{ controlId: 'applify_c_0', kind: 'resume' }])
})
