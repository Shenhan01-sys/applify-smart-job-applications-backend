import test from 'node:test'
import assert from 'node:assert/strict'
import { ExtensionPlanner, invalidatePlannerContextCache } from '../services/extension-planner.js'
import { makeExtensionTestDb, USER_ID } from './extension-test-db.js'

// Audit formulir Workable asli (Ajaia, Ajaib): kolom wajib "Summary" (area teks), "Address" (teks), dan "Country"
// (combobox baca-saja dengan pilihan tetap, ada "Others") tidak terisi dari profil.

const PAGE = 'https://apply.workable.com/ajaia/j/ABC123/apply/'

async function plan(profile: Record<string, unknown>, rawControls: Record<string, unknown>[], jobId = 'job-workable') {
  invalidatePlannerContextCache()
  let prompt = ''
  const planner = new ExtensionPlanner(async (req: any) => {
    prompt = String(req.user ?? '')
    return { model: 'm', text: '{"actions":[]}' }
  })
  const res = await planner.planForm({
    db: makeExtensionTestDb({
      jobs: [{ id: jobId, title: 'Backend Engineer', company: 'Ajaia', description: '', location: 'Remote' }],
      profiles: [{ id: USER_ID, full_name: 'Budi Santoso', skills: [], ...profile }],
      user_form_answers: [],
    }).db,
    userId: USER_ID,
    jobId,
    pageUrl: PAGE,
    rawControls,
  })
  return { res, prompt }
}

const actionFor = (res: { actions: any[] }, controlId: string) => res.actions.find((a) => a.controlId === controlId)

// ---------------------------------------------------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------------------------------------------------

const SUMMARY = 'Backend engineer dengan tiga tahun pengalaman membangun API dan antrean pekerjaan.'

test('Summary: area teks wajib terisi dari profiles.summary', async () => {
  for (const label of ['Summary', 'Professional summary', 'About you', 'Ringkasan', 'Summary *']) {
    const { res } = await plan({ summary: SUMMARY }, [{ controlId: 's', kind: 'textarea', label, required: true }])
    assert.deepEqual(actionFor(res, 's'), { controlId: 's', kind: 'textarea', value: SUMMARY, source: 'fact' }, label)
  }
})

test('Summary: headline bukan ringkasan, tanpa summary kolom dibiarkan untuk pengguna', async () => {
  const { res } = await plan({ headline: 'Backend Engineer | Node.js' }, [{ controlId: 's', kind: 'textarea', label: 'Summary', required: true }])
  assert.equal(actionFor(res, 's'), undefined)
  assert.ok(res.pendingQuestions.some((q) => q.label === 'Summary'), JSON.stringify(res.pendingQuestions))
})

test('Summary: label yang bukan ringkasan profil dan kolom teks satu baris tidak diisi', async () => {
  const { res } = await plan({ summary: SUMMARY }, [
    { controlId: 'a', kind: 'textarea', label: 'Summary of your last role', required: true },
    { controlId: 'b', kind: 'textarea', label: 'Job summary', required: true },
    { controlId: 'c', kind: 'text', label: 'Summary', required: true },
  ])
  assert.deepEqual(res.actions, [])
})

test('Summary: tokennya ada di fakta kandidat tanpa teksnya, dan mengikuti maxLength', async () => {
  const { res, prompt } = await plan({ summary: SUMMARY }, [
    { controlId: 's', kind: 'textarea', label: 'Summary', required: true, maxLength: 50 },
    { controlId: 'x', kind: 'textarea', label: 'Ceritakan motivasimu', required: true },
  ])
  assert.ok(prompt.includes('{{summary}}'), 'model diberi tahu token tersedia')
  assert.ok(!prompt.includes('antrean pekerjaan'), 'teks ringkasan tidak dikirim ke prompt')
  const value = String(actionFor(res, 's')?.value ?? '')
  assert.ok(value.length > 0 && value.length <= 50, value)
  assert.ok(SUMMARY.startsWith(value.replace(/\s+$/, '')), value)
})

// ---------------------------------------------------------------------------------------------------------------------
// Address
// ---------------------------------------------------------------------------------------------------------------------

test('Address: label polos terisi dari lokasi profil (kota, negara), bukan alamat jalan', async () => {
  const profile = { location: 'Sleman, Yogyakarta, Indonesia' }
  for (const label of ['Address', 'Alamat', 'Current address', 'Alamat saat ini', 'Your address', 'Address *']) {
    const { res } = await plan(profile, [{ controlId: 'a', kind: 'text', label, required: true }])
    assert.deepEqual(actionFor(res, 'a'), { controlId: 'a', kind: 'text', value: 'Sleman, Yogyakarta, Indonesia', source: 'fact' }, label)
  }
})

test('Address: kotak cari bebas diketik (typeToSearch), City of residence memakai kota', async () => {
  const { res } = await plan({ location: 'Sleman, Yogyakarta, Indonesia' }, [
    { controlId: 'a', kind: 'select', searchable: true, label: 'Address', required: true },
    { controlId: 'c', kind: 'text', label: 'City of residence', required: true },
    { controlId: 'd', kind: 'select', searchable: true, label: 'City of residence', required: true },
  ])
  assert.deepEqual(actionFor(res, 'a'), { controlId: 'a', kind: 'select', value: 'Sleman, Yogyakarta, Indonesia', source: 'fact', typeToSearch: true })
  assert.deepEqual(actionFor(res, 'c'), { controlId: 'c', kind: 'text', value: 'Sleman', source: 'fact' })
  assert.deepEqual(actionFor(res, 'd'), { controlId: 'd', kind: 'select', value: 'Sleman', source: 'fact', typeToSearch: true })
})

test('Address: kolom alamat jalan atau kode pos tidak mendapat jalan karangan', async () => {
  const { res } = await plan({ location: 'Sleman, Yogyakarta, Indonesia' }, [
    { controlId: 'l1', kind: 'text', label: 'Street address', required: true },
    { controlId: 'l2', kind: 'text', label: 'Address line 1', required: true },
    { controlId: 'l3', kind: 'text', label: 'Alamat lengkap', required: true },
    { controlId: 'l4', kind: 'text', label: 'Alamat jalan', required: true },
    { controlId: 'p', kind: 'text', label: 'Postal code', required: true },
    { controlId: 'h', kind: 'text', label: 'Address', helperText: 'Street name and house number', required: true },
    { controlId: 'ph', kind: 'text', label: 'Address', placeholder: 'Jl. Kaliurang KM 5 No. 1', required: true },
    { controlId: 'n', kind: 'text', label: 'Address', name: 'address_line_1', required: true },
    { controlId: 'e', kind: 'text', label: 'Home address street', required: true },
  ])
  assert.deepEqual(res.actions, [])
  const asked = res.pendingQuestions.map((q) => q.label)
  assert.ok(asked.includes('Street address') && asked.includes('Postal code'), JSON.stringify(asked))
})

test('Address: tanpa kota di profil (hanya negara atau kosong) tidak ada tebakan; email address tetap email', async () => {
  for (const location of ['Indonesia', '']) {
    const { res } = await plan({ location }, [{ controlId: 'a', kind: 'text', label: 'Address', required: true }])
    assert.equal(actionFor(res, 'a'), undefined, `location=${JSON.stringify(location)}`)
  }
  const { res } = await plan({ location: 'Sleman, Yogyakarta, Indonesia' }, [
    { controlId: 'm', kind: 'text', inputType: 'email', label: 'Email address', required: true },
    { controlId: 'w', kind: 'text', label: 'Website address', required: false },
  ])
  assert.ok(!res.actions.some((a) => a.value === 'Sleman, Yogyakarta, Indonesia'), JSON.stringify(res.actions))
})

// ---------------------------------------------------------------------------------------------------------------------
// Country
// ---------------------------------------------------------------------------------------------------------------------

const COUNTRY_OPTIONS = ['Indonesia', 'Singapore', 'Malaysia', 'Philippines', 'Others']
const countryControl = (extra: Record<string, unknown> = {}) => ({
  controlId: 'co',
  kind: 'select',
  role: 'combobox',
  readOnly: true,
  label: 'Country',
  required: true,
  options: COUNTRY_OPTIONS,
  ...extra,
})

test('Country: kota Indonesia atau "Indonesia" menjadi pilihan Indonesia pada combobox baca-saja', async () => {
  for (const location of ['Sleman, Yogyakarta', 'Jakarta Selatan', 'Bandung, Indonesia', 'Indonesia']) {
    const { res } = await plan({ location }, [countryControl()])
    assert.deepEqual(actionFor(res, 'co'), { controlId: 'co', kind: 'select', value: 'Indonesia', source: 'fact' }, location)
  }
})

test('Country: pilihan dicocokkan tanpa membedakan huruf, label Negara dan Country of residence ikut', async () => {
  const { res } = await plan({ location: 'Sleman, Yogyakarta' }, [
    countryControl({ options: ['INDONESIA', 'singapore', 'others'] }),
    countryControl({ controlId: 'ng', label: 'Negara', options: ['indonesia', 'Lainnya'] }),
    countryControl({ controlId: 'cr', label: 'Country of residence' }),
  ])
  assert.equal(actionFor(res, 'co')?.value, 'INDONESIA')
  assert.equal(actionFor(res, 'ng')?.value, 'indonesia')
  assert.equal(actionFor(res, 'cr')?.value, 'Indonesia')
})

test('Country: negara tidak ada di pilihan memakai Others bila ada, selain itu dibiarkan kosong', async () => {
  const withOthers = await plan({ location: 'Tokyo, Japan' }, [countryControl()])
  assert.deepEqual(actionFor(withOthers.res, 'co'), { controlId: 'co', kind: 'select', value: 'Others', source: 'fact' })

  const noOthers = await plan({ location: 'Tokyo, Japan' }, [countryControl({ options: ['Indonesia', 'Singapore', 'Malaysia'] })])
  assert.equal(actionFor(noOthers.res, 'co'), undefined)
  assert.ok(noOthers.res.pendingQuestions.some((q) => q.label === 'Country'), JSON.stringify(noOthers.res.pendingQuestions))

  const lainnya = await plan({ location: 'Tokyo, Japan' }, [countryControl({ options: ['Indonesia', 'Singapore', 'Lainnya'] })])
  assert.equal(actionFor(lainnya.res, 'co')?.value, 'Lainnya')
})

test('Country: kota non-Indonesia tanpa negara tidak ditebak, juga tidak jatuh ke Others', async () => {
  for (const location of ['Paris', 'Tokyo', 'Kuala Lumpur', '']) {
    const { res } = await plan({ location }, [countryControl()])
    assert.equal(actionFor(res, 'co'), undefined, `location=${JSON.stringify(location)}`)
  }
})

test('Country: pilihan yang menyerupai negaranya tetapi ambigu tidak jatuh ke Others', async () => {
  const { res } = await plan({ location: 'Texas, United States' }, [
    countryControl({ options: ['Indonesia', 'United States Minor Outlying Islands', 'United States Virgin Islands', 'Others'] }),
  ])
  assert.equal(actionFor(res, 'co'), undefined)
})

test('Country: kewarganegaraan, negara asal, dan kode negara telepon bukan kolom negara tempat tinggal', async () => {
  const { res } = await plan({ location: 'Sleman, Yogyakarta' }, [
    countryControl({ controlId: 'n', label: 'Nationality' }),
    countryControl({ controlId: 'o', label: 'Country of origin' }),
    countryControl({ controlId: 'b', label: 'Country of birth' }),
    { controlId: 'cc', kind: 'select', label: 'Country code', options: ['Indonesia (+62)', 'Singapore (+65)', 'Others (+0)'], required: true },
  ])
  assert.ok(!res.actions.some((a) => ['n', 'o', 'b'].includes(a.controlId)), JSON.stringify(res.actions))
  // Pemilih kode telepon tetap lewat jalurnya sendiri (Indonesia, +62), bukan jalur negara tempat tinggal.
  assert.equal(actionFor(res, 'cc')?.value, 'Indonesia (+62)')
})
