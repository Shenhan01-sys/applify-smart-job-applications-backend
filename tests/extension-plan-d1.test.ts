import test from 'node:test'
import assert from 'node:assert/strict'
import {
  EXT_QUESTION_REASONS,
  ExtensionPlanner,
  consentAnswerKey,
  fitToConstraints,
  isAffirmativeConsent,
  isConsentCheckbox,
  isMarketingOptIn,
  neutralPhoneNumber,
  sanitizeExtensionControls,
  sanitizePendingQuestions,
} from '../services/extension-planner.js'
import { buildApp, issueToken, makeExtensionTestDb, USER_ID } from './extension-test-db.js'

// -------------------------------------------------------------------------------------------------------------
// Paket D-1: sakelar mode, combobox pencarian, persetujuan, batas kolom, nomor telepon netral, alasan pertanyaan
// -------------------------------------------------------------------------------------------------------------

const PAGE_URL = 'https://dealls.com/apply/123'

interface Capture {
  calls: number
  user: string
  system: string
}

async function plan(
  rawControls: unknown[],
  opts: { aiText?: string; answers?: Array<{ question_key: string; answer: string }>; profile?: Record<string, unknown>; settings?: Record<string, unknown> } = {}
) {
  const cap: Capture = { calls: 0, user: '', system: '' }
  const planner = new ExtensionPlanner(async (req) => {
    cap.calls++
    cap.user = req.user
    cap.system = req.system
    return { model: 'm', text: opts.aiText ?? '{"actions":[]}' }
  })
  const store = makeExtensionTestDb({
    jobs: [{ id: 'job-1', title: 'Backend', company: 'Acme', description: '', location: 'Jakarta' }],
    profiles: [{ id: USER_ID, full_name: 'Budi Santoso', location: 'Jakarta Selatan, Indonesia', phone: '0812-3456-7890', ...(opts.profile ?? {}) }],
    user_automation_settings: [{ user_id: USER_ID, email: 'budi@example.id', ...(opts.settings ?? {}) }],
    user_form_answers: (opts.answers ?? []).map((a) => ({ user_id: USER_ID, question_label: a.question_key, ...a })),
  })
  const res = await planner.planForm({ db: store.db, userId: USER_ID, jobId: 'job-1', pageUrl: PAGE_URL, rawControls })
  return { res, cap }
}

const base = (over: Record<string, unknown> = {}) => ({
  controlId: 'c1',
  kind: 'text',
  label: 'Kolom',
  groupLabel: '',
  name: '',
  placeholder: '',
  inputType: 'text',
  required: true,
  options: [],
  currentValue: '',
  ...over,
})
const ai = (...actions: Array<{ controlId: string; value: unknown }>) => JSON.stringify({ actions })
const valueOf = (res: { actions: Array<{ controlId: string; value: string | boolean }> }, id: string) => res.actions.find((a) => a.controlId === id)?.value

// ---------- Sanitizer ----------

test('sanitizer: searchable, toggle, cvSourceUpload, batas panjang, pola, dan inputMode diterima hanya untuk jenis yang sah', () => {
  const [sel, tog, tel] = sanitizeExtensionControls([
    base({ controlId: 's', kind: 'select', searchable: true }),
    base({ controlId: 't', kind: 'radio', options: ['File PDF'], toggle: true, cvSourceUpload: true }),
    base({ controlId: 'p', inputType: 'tel', minLength: 9, maxLength: 14, pattern: '[0-9+]{9,14}', inputMode: ' TEL ' }),
  ])
  assert.equal(sel.searchable, true)
  assert.equal(tog.toggle, true)
  assert.equal(tog.cvSourceUpload, true)
  assert.equal(tel.minLength, 9)
  assert.equal(tel.maxLength, 14)
  assert.equal(tel.pattern, '[0-9+]{9,14}')
  assert.equal(tel.inputMode, 'tel')
})

test('sanitizer: petunjuk di jenis yang salah, bukan true persis, atau di luar batas dibuang; pola dipotong 200 karakter', () => {
  const [a] = sanitizeExtensionControls([base({ kind: 'text', searchable: true, toggle: true, cvSourceUpload: true })])
  for (const key of ['searchable', 'toggle', 'cvSourceUpload']) assert.ok(!(key in a), key)
  const [b] = sanitizeExtensionControls([base({ kind: 'select', searchable: 'true', minLength: 3, maxLength: 5, pattern: 'x' })])
  for (const key of ['searchable', 'minLength', 'maxLength', 'pattern']) assert.ok(!(key in b), key)
  const [c] = sanitizeExtensionControls([base({ kind: 'radio', cvSourceUpload: true })])
  assert.ok(!('cvSourceUpload' in c), 'cvSourceUpload hanya bersama toggle')
  const [d] = sanitizeExtensionControls([
    base({ minLength: -1, maxLength: 1.5, pattern: 'y'.repeat(500), inputMode: 'javascript:alert(1)' }),
    ])
  assert.ok(!('minLength' in d) && !('maxLength' in d) && !('inputMode' in d))
  assert.equal(d.pattern?.length, 200)
  const [e] = sanitizeExtensionControls([base({ minLength: 10, maxLength: 5 }), base({ controlId: 'c2', minLength: '9', maxLength: 1_000_000 })])
  assert.ok(!('minLength' in e), 'minLength di atas maxLength dibuang')
  assert.equal(e.maxLength, 5)
  const [, f] = sanitizeExtensionControls([base(), base({ controlId: 'c2', minLength: '9', maxLength: 1_000_000 })])
  assert.ok(!('minLength' in f) && !('maxLength' in f), 'bukan bilangan atau terlalu besar')
})

test('sanitizer: kontrol tanpa petunjuk tidak mendapat kunci baru', () => {
  const [c] = sanitizeExtensionControls([base()])
  for (const key of ['searchable', 'toggle', 'cvSourceUpload', 'minLength', 'maxLength', 'pattern', 'inputMode']) assert.ok(!(key in c), key)
})

test('sanitizePendingQuestions: reason hanya dari daftar tertutup', () => {
  const out = sanitizePendingQuestions([
    { label: 'Setuju syarat', kind: 'check', reason: 'consent' },
    { label: 'Kolom aneh', kind: 'text', reason: '<script>' },
  ])
  assert.equal(out[0].reason, 'consent')
  assert.ok(!('reason' in out[1]))
  assert.ok(EXT_QUESTION_REASONS.includes('free_text'))
})

// ---------- Sakelar mode ----------

test('toggle: radio sakelar "File PDF" tidak pernah ditanyakan, direncanakan, atau dikirim ke AI; kontrol lain tetap', async () => {
  const { res, cap } = await plan(
    [
      base({ controlId: 'rg_0', kind: 'radio', label: 'File PDF', groupLabel: 'File PDF', inputType: 'radio', options: ['File PDF'], toggle: true, cvSourceUpload: true }),
      base({ controlId: 'f1', kind: 'file', label: 'Resume', inputType: 'file', required: false }),
      base({ controlId: 'c2', label: 'Alasan melamar', kind: 'textarea', inputType: 'textarea' }),
    ],
    { aiText: ai({ controlId: 'rg_0', value: 'File PDF' }) }
  )
  assert.deepEqual(res.actions, [])
  assert.deepEqual(res.pendingQuestions.map((q) => q.label), ['Alasan melamar'])
  assert.ok(!cap.user.includes('rg_0') && !cap.user.includes('File PDF'))
  assert.equal(res.fileTargets.length, 1, 'unggahan CV tetap direncanakan')
})

// ---------- Combobox pencarian ----------

test('searchable: "Lokasi" tanpa pilihan diisi kota dari profil sebagai teks bebas dengan typeToSearch', async () => {
  const { res } = await plan([base({ controlId: 's1', kind: 'select', label: 'Lokasi', inputType: 'text', searchable: true, role: 'combobox' })])
  assert.deepEqual(res.actions, [{ controlId: 's1', kind: 'select', value: 'Jakarta Selatan', source: 'fact', typeToSearch: true }])
  assert.deepEqual(res.pendingQuestions, [])
})

test('searchable: tanpa data kota dan AI diam, kolom wajib ditanyakan sebagai teks bebas dengan alasan free_text', async () => {
  const { res } = await plan([base({ controlId: 's1', kind: 'select', label: 'Perusahaan impian', searchable: true })])
  assert.deepEqual(res.actions, [])
  assert.deepEqual(
    res.pendingQuestions.map((q) => [q.label, q.kind, q.reason, q.options]),
    [['Perusahaan impian', 'text', 'free_text', undefined]]
  )
})

test('searchable: jawaban AI untuk combobox pencarian tanpa pilihan ikut typeToSearch; dengan pilihan terbaca tidak', async () => {
  const { res, cap } = await plan(
    [
      base({ controlId: 's1', kind: 'select', label: 'Bidang minat', searchable: true }),
      base({ controlId: 's2', kind: 'select', label: 'Tingkat pendidikan', searchable: true, options: ['S1', 'S2'] }),
    ],
    { aiText: ai({ controlId: 's1', value: 'Teknologi' }, { controlId: 's2', value: 'S1' }) }
  )
  assert.deepEqual(res.actions.find((a) => a.controlId === 's1'), { controlId: 's1', kind: 'select', value: 'Teknologi', source: 'ai', typeToSearch: true })
  assert.deepEqual(res.actions.find((a) => a.controlId === 's2'), { controlId: 's2', kind: 'select', value: 'S1', source: 'ai' })
  const sent = JSON.parse(cap.user.slice(cap.user.indexOf('<untrusted_form_controls>') + 25, cap.user.lastIndexOf('</untrusted_form_controls>')))
  assert.equal(sent[0].searchable, true)
  assert.ok(!('searchable' in sent[1]), 'dengan daftar pilihan, jawabannya salah satu pilihan')
  assert.ok(cap.system.includes('searchable'))
})

test('searchable: jawaban tersimpan untuk combobox pencarian tanpa pilihan ikut typeToSearch', async () => {
  const { res } = await plan([base({ controlId: 's1', kind: 'select', label: 'Kota asal', searchable: true })], {
    answers: [{ question_key: 'kota asal', answer: 'Bandung' }],
  })
  assert.deepEqual(res.actions, [{ controlId: 's1', kind: 'select', value: 'Bandung', source: 'saved', typeToSearch: true }])
})

test('dropdown kustom biasa tanpa pilihan (bukan pencarian) tetap select dengan alasan no_options', async () => {
  const { res } = await plan([base({ controlId: 's1', kind: 'select', label: 'Jenis kelamin' })])
  assert.deepEqual(res.pendingQuestions.map((q) => [q.kind, q.reason]), [['select', 'no_options']])
})

// ---------- Persetujuan dan opt-in pemasaran ----------

test('persetujuan: syarat dan privasi wajib menjadi pertanyaan consent dan tidak pernah dicentang tahap tersimpan, fakta, atau AI', async () => {
  const controls = [
    base({ controlId: 'k1', kind: 'checkbox', inputType: 'checkbox', label: 'Saya setuju dengan Syarat dan Ketentuan' }),
    base({ controlId: 'k2', kind: 'checkbox', inputType: 'checkbox', label: 'I have read the Privacy Policy' }),
    base({ controlId: 'k3', kind: 'checkbox', inputType: 'checkbox', label: 'I agree to the terms' }),
  ]
  const { res, cap } = await plan(controls, {
    answers: [
      { question_key: 'saya setuju dengan syarat dan ketentuan', answer: 'ya' },
      { question_key: 'i agree to the terms', answer: 'yes' },
    ],
    aiText: ai({ controlId: 'k1', value: true }, { controlId: 'k2', value: true }, { controlId: 'k3', value: 'ya' }),
  })
  assert.deepEqual(res.actions, [])
  assert.deepEqual(
    res.pendingQuestions.map((q) => [q.label, q.kind, q.required, q.reason]),
    [
      ['Saya setuju dengan Syarat dan Ketentuan', 'check', true, 'consent'],
      ['I have read the Privacy Policy', 'check', true, 'consent'],
      ['I agree to the terms', 'check', true, 'consent'],
    ]
  )
  assert.equal(cap.calls, 0, 'tidak ada kontrol yang tersisa untuk AI, jadi model tidak dipanggil')
})

test('persetujuan: sudah dicentang pengguna di halaman tidak ditanyakan; opsional tidak ditanyakan dan tidak dicentang', async () => {
  const { res } = await plan(
    [
      base({ controlId: 'k1', kind: 'checkbox', inputType: 'checkbox', label: 'Saya setuju dengan syarat', checked: true, currentValue: 'true' }),
      base({ controlId: 'k2', kind: 'checkbox', inputType: 'checkbox', label: 'Saya setuju dengan kebijakan privasi', required: false }),
    ],
    { aiText: ai({ controlId: 'k2', value: true }) }
  )
  assert.deepEqual(res.actions, [])
  assert.deepEqual(res.pendingQuestions, [])
})

test('opt-in pemasaran: tidak pernah dicentang walau AI atau jawaban tersimpan setuju; wajib menjadi pertanyaan marketing_optin', async () => {
  const { res } = await plan(
    [
      base({ controlId: 'm1', kind: 'checkbox', inputType: 'checkbox', label: 'Saya setuju menerima newsletter dan promo', required: false }),
      base({ controlId: 'm2', kind: 'checkbox', inputType: 'checkbox', label: 'Kirimi saya info lowongan lain', required: true }),
    ],
    {
      answers: [{ question_key: 'saya setuju menerima newsletter dan promo', answer: 'ya' }],
      aiText: ai({ controlId: 'm1', value: true }, { controlId: 'm2', value: true }),
    }
  )
  assert.deepEqual(res.actions, [])
  assert.deepEqual(res.pendingQuestions.map((q) => [q.label, q.reason]), [['Kirimi saya info lowongan lain', 'marketing_optin']])
})

test('persetujuan: radio satu pilihan "Saya setuju" tidak pernah dipilih otomatis dan tidak dianggap sakelar, walau ditandai toggle', async () => {
  const { res } = await plan(
    [
      base({ controlId: 'rg_1', kind: 'radio', inputType: 'radio', label: 'Saya setuju', groupLabel: 'Saya setuju', options: ['Saya setuju'], toggle: true }),
      base({ controlId: 'rg_2', kind: 'radio', inputType: 'radio', label: 'File PDF', groupLabel: 'File PDF', options: ['File PDF'], toggle: true, cvSourceUpload: true }),
    ],
    { aiText: ai({ controlId: 'rg_1', value: 'Saya setuju' }), answers: [{ question_key: 'saya setuju', answer: 'Saya setuju' }] }
  )
  assert.deepEqual(res.actions, [])
  assert.deepEqual(res.pendingQuestions.map((q) => [q.label, q.kind, q.reason]), [['Saya setuju', 'radio', 'consent']])
})

test('persetujuan: kotak centang biasa tetap bisa dijawab AI; pembeda persetujuan dan pemasaran', async () => {
  const { res } = await plan([base({ controlId: 'x1', kind: 'checkbox', inputType: 'checkbox', label: 'Bersedia bekerja shift', required: false })], {
    aiText: ai({ controlId: 'x1', value: true }),
  })
  assert.deepEqual(res.actions.map((a) => [a.controlId, a.value, a.source]), [['x1', true, 'ai']])
  const mk = (label: string) => sanitizeExtensionControls([base({ kind: 'checkbox', label })])[0]
  assert.equal(isConsentCheckbox(mk('Saya setuju dengan Kebijakan Privasi')), true)
  assert.equal(isMarketingOptIn(mk('Saya setuju menerima promo')), true)
  assert.equal(isConsentCheckbox(mk('Saya setuju menerima promo')), false, 'pemasaran tidak dihitung persetujuan')
  assert.equal(isConsentCheckbox(mk('Bersedia shift malam')), false)
})

// ---------- Batas dan format ----------

test('batas kolom: prompt memuat minLength, maxLength, pattern, inputMode; aturan format telepon dan persetujuan ada di system prompt', async () => {
  const { cap } = await plan(
    [
      base({ controlId: 'c1', label: 'Nomor induk mahasiswa', minLength: 8, maxLength: 12, pattern: '[0-9]+', inputMode: 'numeric' }),
      base({ controlId: 'c2', label: 'Nomor telepon aktif', inputType: 'tel' }),
    ],
    { aiText: ai({ controlId: 'c1', value: '12345678' }) }
  )
  const sent = JSON.parse(cap.user.slice(cap.user.indexOf('<untrusted_form_controls>') + 25, cap.user.lastIndexOf('</untrusted_form_controls>')))
  const c1 = sent.find((c: { controlId: string }) => c.controlId === 'c1')
  assert.deepEqual([c1.minLength, c1.maxLength, c1.pattern, c1.inputMode], [8, 12, '[0-9]+', 'numeric'])
  assert.ok(/minLength, maxLength/.test(cap.system))
  assert.ok(/\+<kode negara>/.test(cap.system))
  assert.ok(/syarat dan ketentuan/.test(cap.system))
})

test('batas kolom: nilai AI di atas maxLength kolom teks dilewati; area teks dipotong di batas kalimat; di bawah minLength dilewati', async () => {
  const long = 'Saya bersemangat bergabung dengan tim Anda. Pengalaman saya cocok dengan kebutuhan peran ini. Terima kasih atas waktunya.'
  const { res } = await plan(
    [
      base({ controlId: 'c1', label: 'Nama panggilan', maxLength: 10 }),
      base({ controlId: 'c2', label: 'Alasan melamar', kind: 'textarea', inputType: 'textarea', maxLength: 100 }),
      base({ controlId: 'c3', label: 'Kode referral', minLength: 6 }),
    ],
    { aiText: ai({ controlId: 'c1', value: 'Budi Santoso Wijaya' }, { controlId: 'c2', value: long }, { controlId: 'c3', value: 'AB' }) }
  )
  assert.equal(valueOf(res, 'c1'), undefined)
  assert.equal(valueOf(res, 'c3'), undefined)
  const c2 = String(valueOf(res, 'c2'))
  assert.ok(c2.length <= 100 && c2.endsWith('.') && c2.includes('kebutuhan peran ini'), c2)
  assert.deepEqual(res.pendingQuestions.map((q) => q.label).sort(), ['Kode referral', 'Nama panggilan'])
})

test('batas kolom: fakta (email) yang lebih panjang dari maxLength tidak dipotong, kolom jadi pertanyaan', async () => {
  const { res } = await plan([base({ controlId: 'e1', label: 'Email', inputType: 'email', maxLength: 8 })])
  assert.deepEqual(res.actions, [])
  assert.deepEqual(res.pendingQuestions.map((q) => q.label), ['Email'])
})

test('fitToConstraints: pola tidak dijalankan di server (tidak ada pembekuan karena regex jahat)', () => {
  const c = sanitizeExtensionControls([base({ pattern: '(a+)+$', maxLength: 100 })])[0]
  const started = Date.now()
  assert.equal(fitToConstraints(c, `${'a'.repeat(60)}!`), `${'a'.repeat(60)}!`)
  assert.ok(Date.now() - started < 200)
  assert.equal(fitToConstraints(c, 'x'.repeat(101)), null)
})

// ---------- Telepon netral ----------

test('neutralPhoneNumber: kode negara ditambahkan, pemisah dibuang, bentuk yang tidak pasti tidak ditebak', () => {
  assert.equal(neutralPhoneNumber('0812-3456-7890'), '+6281234567890')
  assert.equal(neutralPhoneNumber('+62 812 3456 7890'), '+6281234567890')
  assert.equal(neutralPhoneNumber('62 812 3456 7890'), '+6281234567890')
  assert.equal(neutralPhoneNumber('0062 812 3456 7890'), '+6281234567890')
  assert.equal(neutralPhoneNumber('(021) 5555 1234', 'Indonesia'), '+62215555 1234'.replace(' ', ''))
  assert.equal(neutralPhoneNumber('0412 345 678', 'Australia'), '+61412345678')
  assert.equal(neutralPhoneNumber('0123456', 'Atlantis'), '0123456', 'negara di luar daftar: angka saja')
  assert.equal(neutralPhoneNumber('812345678'), '812345678', 'tanpa nol atau kode negara tidak ditebak')
  assert.equal(neutralPhoneNumber('abc'), '')
})

test('telepon: token {{phone}} dan kolom tel berisi nomor netral dengan kode negara', async () => {
  const { res } = await plan(
    [base({ controlId: 'p1', label: 'No. HP', inputType: 'tel' }), base({ controlId: 'p2', label: 'Kontak darurat' })],
    { aiText: ai({ controlId: 'p2', value: '{{phone}}' }) }
  )
  assert.equal(valueOf(res, 'p1'), '+6281234567890')
  assert.equal(valueOf(res, 'p2'), '+6281234567890')
})

// ---------- Kolom wajib tidak dibuang diam-diam ----------

test('kolom wajib tanpa label menjadi pertanyaan no_label; opsional tanpa label tetap tidak ditanyakan', async () => {
  const { res } = await plan([
    base({ controlId: 'u1', label: '', required: true }),
    base({ controlId: 'u2', label: '', required: false }),
    base({ controlId: 'u3', kind: 'select', label: '', required: true, options: ['A', 'B'] }),
  ])
  assert.deepEqual(
    res.pendingQuestions.map((q) => [q.label, q.kind, q.reason]),
    [
      ['Kolom wajib tanpa label 1', 'text', 'no_label'],
      ['Kolom wajib tanpa label 2', 'select', 'no_label'],
    ]
  )
})

test('kolom wajib yang nonaktif atau hanya-baca tetap muncul sebagai pertanyaan dengan alasannya', async () => {
  const { res } = await plan([
    base({ controlId: 'd1', label: 'Nomor pegawai', disabled: true }),
    base({ controlId: 'r1', label: 'Kode kampus', readOnly: true }),
  ])
  const reasons = Object.fromEntries(res.pendingQuestions.map((q) => [q.label, q.reason]))
  assert.deepEqual(reasons, { 'Nomor pegawai': 'disabled', 'Kode kampus': 'readonly' })
})

// ---------- Persetujuan dari panel: terikat pada persetujuan lamaran ini ----------

const NOW = new Date('2026-11-24T05:00:00Z')
const FUTURE = '2026-11-24T12:00:00Z'
const APPROVAL_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1'
const APPROVAL_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb2'
const TERMS_LABEL = 'Saya setuju dengan Syarat dan Ketentuan'

async function consentSetup() {
  const store = makeExtensionTestDb({
    approval_requests: [
      { id: APPROVAL_A, user_id: USER_ID, job_id: 'job-a', application_id: 'app-a', status: 'approved', expires_at: FUTURE },
      { id: APPROVAL_B, user_id: USER_ID, job_id: 'job-b', application_id: 'app-b', status: 'approved', expires_at: FUTURE },
    ],
    jobs: [
      { id: 'job-a', title: 'Backend', company: 'Acme', platform_source: 'kalibrr', external_url: 'https://www.kalibrr.com/c/acme/jobs/1', description: '', location: 'Jakarta' },
      { id: 'job-b', title: 'Frontend', company: 'Beta', platform_source: 'kalibrr', external_url: 'https://www.kalibrr.com/c/beta/jobs/2', description: '', location: 'Jakarta' },
    ],
    profiles: [{ id: USER_ID, full_name: 'Budi Santoso' }],
  })
  // Model yang berusaha mencentang semuanya tidak boleh berpengaruh pada persetujuan.
  const planner = new ExtensionPlanner(async () => ({ model: 'm', text: '{"actions":[{"controlId":"k1","value":true},{"controlId":"rg_1","value":"Saya setuju"}]}' }), () => NOW.getTime())
  const app = buildApp({ db: store.db, primaryUserId: USER_ID, planner, now: () => NOW.getTime() })
  const token = await issueToken(app)
  const headers = { authorization: `Bearer ${token}` }
  const answer = (approvalId: string, value: string, label = TERMS_LABEL) =>
    app.inject({ method: 'POST', url: '/api/extension/answers', headers, payload: { approvalId, answers: [{ key: 'x', label, value }] } as any })
  const planFor = async (approvalId: string, controls: unknown[]) => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/extension/plan-form',
      headers,
      payload: { approvalId, pageUrl: 'https://www.kalibrr.com/c/acme/jobs/1/apply', controls } as any,
    })
    assert.equal(res.statusCode, 200, res.body)
    return res.json() as { actions: Array<{ controlId: string; value: unknown; source: string }>; pendingQuestions: Array<{ label: string; reason?: string }> }
  }
  return { store, answer, planFor }
}

const termsBox = base({ controlId: 'k1', kind: 'checkbox', inputType: 'checkbox', label: TERMS_LABEL })

test('persetujuan panel: jawaban "Ya, saya setuju" untuk persetujuan ini mencentang kotak syarat saat isi ulang', async () => {
  const { answer, planFor, store } = await consentSetup()
  const before = await planFor(APPROVAL_A, [termsBox])
  assert.deepEqual(before.actions, [])
  assert.deepEqual(before.pendingQuestions.map((q) => [q.label, q.reason]), [[TERMS_LABEL, 'consent']])

  assert.equal((await answer(APPROVAL_A, 'Ya, saya setuju')).statusCode, 200)
  const after = await planFor(APPROVAL_A, [termsBox])
  assert.deepEqual(after.actions, [{ controlId: 'k1', kind: 'checkbox', value: true, source: 'saved' }])
  assert.deepEqual(after.pendingQuestions, [])
  // Tidak masuk bank umum: hanya baris terikat pada persetujuan ini.
  assert.deepEqual(store.tables.user_form_answers.map((r) => r.question_key), [consentAnswerKey(APPROVAL_A, 'saya setuju dengan syarat dan ketentuan')])
})

test('persetujuan panel: label yang sama di lowongan lain (persetujuan lain) tetap pertanyaan; tidak ada pemakaian ulang', async () => {
  const { answer, planFor } = await consentSetup()
  await answer(APPROVAL_A, 'Yes')
  assert.equal((await planFor(APPROVAL_A, [termsBox])).actions.length, 1)
  const other = await planFor(APPROVAL_B, [termsBox])
  assert.deepEqual(other.actions, [])
  assert.deepEqual(other.pendingQuestions.map((q) => [q.label, q.reason]), [[TERMS_LABEL, 'consent']])
})

test('persetujuan panel: jawaban menolak ("Tidak setuju", "No") tidak mencentang; baris bank umum lama tidak pernah mencentang', async () => {
  const { answer, planFor, store } = await consentSetup()
  await answer(APPROVAL_A, 'Tidak setuju')
  assert.deepEqual((await planFor(APPROVAL_A, [termsBox])).actions, [])
  // Baris bank umum (mis. dari halaman Persetujuan web) dengan kunci biasa tidak dipakai untuk persetujuan.
  store.tables.user_form_answers.push({ user_id: USER_ID, question_key: 'saya setuju dengan syarat dan ketentuan', question_label: TERMS_LABEL, answer: 'Yes' })
  assert.deepEqual((await planFor(APPROVAL_A, [termsBox])).actions, [])
})

test('persetujuan panel: radio persetujuan satu pilihan memilih pilihannya; opt-in pemasaran tetap tidak pernah dicentang', async () => {
  const { answer, planFor, store } = await consentSetup()
  const radio = base({ controlId: 'rg_1', kind: 'radio', inputType: 'radio', label: 'Saya setuju', groupLabel: 'Saya setuju', options: ['Saya setuju'] })
  const promo = base({ controlId: 'm1', kind: 'checkbox', inputType: 'checkbox', label: 'Saya setuju menerima newsletter', required: false })
  await answer(APPROVAL_A, 'Ya, saya setuju', 'Saya setuju')
  await answer(APPROVAL_A, 'Yes', 'Saya setuju menerima newsletter')
  const res = await planFor(APPROVAL_A, [radio, promo])
  assert.deepEqual(res.actions, [{ controlId: 'rg_1', kind: 'radio', value: 'Saya setuju', source: 'saved' }])
  // Pemasaran tidak diikat per persetujuan dan tidak pernah dipakai untuk mencentang.
  assert.ok(store.tables.user_form_answers.some((r) => r.question_key === 'saya setuju menerima newsletter'))
})

test('persetujuan panel: perencana tanpa approvalId tidak pernah mencentang, dan isAffirmativeConsent menolak penyangkalan', async () => {
  const { answer, store } = await consentSetup()
  await answer(APPROVAL_A, 'Yes')
  const planner = new ExtensionPlanner(async () => ({ model: 'm', text: '{"actions":[]}' }), () => NOW.getTime())
  const res = await planner.planForm({ db: store.db, userId: USER_ID, jobId: 'job-a', pageUrl: 'https://www.kalibrr.com/c/acme/jobs/1/apply', rawControls: [termsBox] })
  assert.deepEqual(res.actions, [])
  for (const yes of ['Yes', 'Ya', 'Ya, saya setuju', 'Saya setuju', 'I agree', 'Yes, I agree', 'iya']) assert.equal(isAffirmativeConsent(yes), true, yes)
  for (const no of ['No', 'Tidak', 'Tidak setuju', 'Saya tidak setuju', 'I do not agree', 'Belum', '', 'mungkin']) assert.equal(isAffirmativeConsent(no), false, no)
})
