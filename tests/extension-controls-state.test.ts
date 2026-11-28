import test from 'node:test'
import assert from 'node:assert/strict'
import { EXT_ROLES, ExtensionPlanner, sanitizeExtensionControls } from '../services/extension-planner.js'
import { makeExtensionTestDb, USER_ID } from './extension-test-db.js'

const NOW = new Date('2026-11-24T05:00:00Z')

const base = (over: Record<string, unknown> = {}) => ({
  controlId: 'c1',
  kind: 'checkbox',
  label: 'Saya setuju',
  groupLabel: '',
  name: '',
  placeholder: '',
  inputType: 'checkbox',
  required: true,
  options: [],
  currentValue: '',
  ...over,
})

// -------------------------------------------------------------------------------------------------------------
// Keadaan kontrol (Paket B): role, disabled, readOnly, checked, expanded
// -------------------------------------------------------------------------------------------------------------

test('sanitizer: role dari daftar tertutup dan bendera boolean persis diteruskan', () => {
  const [c] = sanitizeExtensionControls([base({ role: 'switch', disabled: true, readOnly: false, checked: true })])
  assert.equal(c.role, 'switch')
  assert.equal(c.disabled, true)
  assert.equal(c.readOnly, false)
  assert.equal(c.checked, true)
  assert.ok(!('expanded' in c))

  const [combo] = sanitizeExtensionControls([base({ controlId: 'c2', kind: 'select', role: 'combobox', expanded: true })])
  assert.equal(combo.role, 'combobox')
  assert.equal(combo.expanded, true)
})

test('sanitizer: role dinormalkan huruf kecil; semua peran yang diizinkan diterima', () => {
  const [c] = sanitizeExtensionControls([base({ role: '  Checkbox ' })])
  assert.equal(c.role, 'checkbox')
  for (const role of EXT_ROLES) {
    const [x] = sanitizeExtensionControls([base({ role })])
    assert.equal(x.role, role)
  }
})

test('sanitizer: role asing, bersuntikan, terlalu panjang, atau bukan string dibuang; kontrolnya tetap diterima', () => {
  for (const role of ['evil', 'checkbox<script>', 'check box', 'x'.repeat(500), '', 5, null, { a: 1 }, ['checkbox']]) {
    const out = sanitizeExtensionControls([base({ role })])
    assert.equal(out.length, 1)
    assert.ok(!('role' in out[0]), `role ${JSON.stringify(role)} harus dibuang`)
  }
})

test('sanitizer: bendera hanya diterima bila boolean persis ("true", 1, null, objek dibuang)', () => {
  const [c] = sanitizeExtensionControls([base({ disabled: 'true', readOnly: 1, checked: null, expanded: {} })])
  for (const key of ['disabled', 'readOnly', 'checked', 'expanded']) assert.ok(!(key in c), `${key} harus dibuang`)
})

test('sanitizer: checked hanya untuk checkbox dan radio, expanded hanya untuk select, text, dan textarea', () => {
  const [text] = sanitizeExtensionControls([base({ kind: 'text', inputType: 'text', checked: true, expanded: true })])
  assert.ok(!('checked' in text))
  assert.equal(text.expanded, true)
  const [chk] = sanitizeExtensionControls([base({ kind: 'checkbox', checked: false, expanded: true })])
  assert.equal(chk.checked, false)
  assert.ok(!('expanded' in chk))
  const [radio] = sanitizeExtensionControls([base({ kind: 'radio', checked: true })])
  assert.equal(radio.checked, true)
  const [file] = sanitizeExtensionControls([base({ kind: 'file', checked: true, expanded: true, disabled: true })])
  assert.ok(!('checked' in file) && !('expanded' in file))
  assert.equal(file.disabled, true)
})

test('sanitizer: kontrol tanpa keadaan tidak mendapat kunci baru (bentuk lama tidak berubah)', () => {
  const [c] = sanitizeExtensionControls([base()])
  assert.deepEqual(Object.keys(c).sort(), [
    'controlId',
    'currentValue',
    'elementId',
    'groupLabel',
    'inputType',
    'kind',
    'label',
    'name',
    'options',
    'placeholder',
    'required',
  ])
})

test('sanitizer: kata sandi tetap dibuang walau membawa keadaan, dan batas 300 kontrol tetap berlaku', () => {
  const pw = sanitizeExtensionControls([base({ kind: 'text', inputType: 'password', role: 'textbox' })])
  assert.deepEqual(pw, [])
  const many = Array.from({ length: 350 }, (_, i) => base({ controlId: `k${i}`, role: 'checkbox', checked: false }))
  assert.equal(sanitizeExtensionControls(many).length, 300)
})

// -------------------------------------------------------------------------------------------------------------
// Perencana: widget ARIA tiba sebagai jenis yang sudah ada
// -------------------------------------------------------------------------------------------------------------

async function plan(rawControls: unknown[], ai: (user: string) => string = () => '{"actions":[]}') {
  const store = makeExtensionTestDb({
    jobs: [{ id: 'job-1', title: 'Backend', company: 'Acme', description: '', location: 'Jakarta' }],
    profiles: [{ id: USER_ID, full_name: 'Budi Santoso' }],
  })
  let prompt = ''
  const planner = new ExtensionPlanner(
    async (req) => {
      prompt = req.user
      return { model: 'm', text: ai(req.user) }
    },
    () => NOW.getTime()
  )
  const res = await planner.planForm({ db: store.db, userId: USER_ID, jobId: 'job-1', pageUrl: 'https://jobs.lever.co/acme/1/apply', rawControls })
  return { res, prompt }
}

test('planner: contenteditable (textarea, role textbox) tetap cocok dengan fakta nama; widget ARIA dipetakan ke penanganan biasa', async () => {
  const { res, prompt } = await plan(
    [
      { controlId: 'e1', kind: 'textarea', label: 'Full name', inputType: 'textarea', role: 'textbox', required: true },
      { controlId: 's1', kind: 'checkbox', label: 'Saya bisa mengikuti tes coding', inputType: 'checkbox', role: 'switch', checked: false, required: true },
      {
        controlId: 'rg_1',
        kind: 'radio',
        label: 'Nyaman dengan tes coding?',
        groupLabel: 'Nyaman dengan tes coding?',
        inputType: 'radio',
        role: 'radiogroup',
        options: ['Ya', 'Tidak'],
        required: true,
      },
    ],
    () => '{"actions":[{"controlId":"s1","value":true},{"controlId":"rg_1","value":"Ya"}]}'
  )

  assert.deepEqual(
    res.actions.map((a) => [a.controlId, a.kind, a.value, a.source]),
    [
      ['e1', 'textarea', 'Budi Santoso', 'fact'],
      ['s1', 'checkbox', true, 'ai'],
      ['rg_1', 'radio', 'Ya', 'ai'],
    ]
  )
  assert.equal(res.aiError, null)
  // Yang sampai ke AI hanya kolom yang sudah dikenal; keadaan dari halaman luar tidak ikut ke prompt.
  assert.ok(prompt.includes('"kind":"checkbox"') && prompt.includes('"kind":"radio"'))
  assert.ok(!prompt.includes('radiogroup') && !prompt.includes('switch'), 'role tidak diteruskan ke prompt AI')
})

test('planner: pertanyaan tertunda untuk widget ARIA memakai jenis check, radio, dan textarea yang sudah ada', async () => {
  const { res } = await plan([
    { controlId: 's1', kind: 'checkbox', label: 'Saya setuju dengan syarat', inputType: 'checkbox', role: 'checkbox', checked: false, required: true },
    {
      controlId: 'rg_1',
      kind: 'radio',
      label: 'Bersedia relokasi?',
      groupLabel: 'Bersedia relokasi?',
      inputType: 'radio',
      role: 'radiogroup',
      options: ['Ya', 'Tidak'],
      required: true,
    },
    { controlId: 'e2', kind: 'textarea', label: 'Ceritakan motivasi Anda', inputType: 'textarea', role: 'textbox', required: true },
  ])
  assert.deepEqual(
    res.pendingQuestions.map((q) => [q.label, q.kind, q.required]),
    [
      ['Saya setuju dengan syarat', 'check', true],
      ['Bersedia relokasi?', 'radio', true],
      ['Ceritakan motivasi Anda', 'textarea', true],
    ]
  )
  assert.deepEqual(res.pendingQuestions[1].options, ['Ya', 'Tidak'])
})

test('planner: kontrol bertipe tidak dikenal atau role bersuntikan tidak merusak perencanaan', async () => {
  const { res } = await plan([
    { controlId: 'x1', kind: 'contenteditable', label: 'Baru', role: 'textbox' },
    { controlId: 'x2', kind: 'text', label: 'Full name', role: '"><img src=x>', disabled: 'ya' },
  ])
  assert.deepEqual(res.actions.map((a) => [a.controlId, a.value]), [['x2', 'Budi Santoso']])
})
