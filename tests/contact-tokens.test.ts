import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fillContactTokens, maskContact, contactPromptValue, EMAIL_TOKEN } from '../services/contact-tokens.js'

test('token kontak diganti nilai asli', () => {
  assert.equal(fillContactTokens('Siti\n{{email}} | {{phone}} | Bogor', { email: 'a@b.test', phone: '0811' }), 'Siti\na@b.test | 0811 | Bogor')
})

test('token tanpa nilai dibuang beserta pemisah yang menggantung', () => {
  assert.equal(fillContactTokens('{{email}} | {{phone}} | Bogor', { email: 'a@b.test' }), 'a@b.test | Bogor')
  assert.equal(fillContactTokens('{{email}} | {{ phone }}', { email: 'a@b.test' }), 'a@b.test')
  assert.equal(fillContactTokens('Email: {{email}} | Phone: {{phone}}', { email: 'a@b.test' }), 'Email: a@b.test')
})

test('teks tanpa token tidak diubah sama sekali', () => {
  const t = 'Siti\n  - Membangun | fitur ,\n'
  assert.equal(fillContactTokens(t, { email: 'a@b.test' }), t)
})

test('penyamaran tidak menyentuh rentang tahun atau angka biasa', () => {
  const out = maskContact('a.b+c@mail.co.id | 0812 3456 7890 | +62 (21) 555-1234\n2019 - 2023, 11 tahun, Rp 10.000.000')
  assert.equal(out, '[email] | [telepon] | [telepon]\n2019 - 2023, 11 tahun, Rp 10.000.000')
})

test('nilai kosong ditulis (not provided), nilai ada ditulis sebagai token', () => {
  assert.equal(contactPromptValue('', EMAIL_TOKEN), '(not provided)')
  assert.match(contactPromptValue('a@b.test', EMAIL_TOKEN), /^\{\{email\}\} /)
  assert.doesNotMatch(contactPromptValue('a@b.test', EMAIL_TOKEN), /a@b\.test/)
})
