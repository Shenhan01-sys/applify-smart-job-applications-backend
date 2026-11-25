import { test } from 'node:test'
import assert from 'node:assert/strict'
import { matchOptionStrict, optionAliases } from '../services/option-match.ts'

// Padanan Indonesia-Inggris (uji JobStreet dan Dealls 25 November 2026): jawaban profil dan pilihan situs beda bahasa.

test('padanan ID-EN: Ya/Yes, Tidak/No, jenis kelamin, bulan', () => {
  assert.equal(matchOptionStrict('Ya', ['Yes', 'No']), 'Yes')
  assert.equal(matchOptionStrict('No', ['Ya', 'Tidak']), 'Tidak')
  assert.equal(matchOptionStrict('Pria', ['Male', 'Female', 'Prefer not to say']), 'Male')
  assert.equal(matchOptionStrict('Female', ['Laki-laki', 'Perempuan']), 'Perempuan')
  assert.equal(matchOptionStrict('Agustus', ['Jan', 'Feb', 'Aug', 'Sep']), 'Aug')
  assert.equal(matchOptionStrict('October', ['Januari', 'Oktober', 'November']), 'Oktober')
  assert.equal(matchOptionStrict('Mei', ['April', 'May', 'June']), 'May')
})

test('padanan tetap mengikuti batas kata: Yes cocok dengan "Yes, I am authorized", No tidak cocok dengan None', () => {
  assert.equal(matchOptionStrict('Ya', ['Yes, I am authorized', 'No, I need sponsorship']), 'Yes, I am authorized')
  assert.equal(matchOptionStrict('Tidak', ['None', 'Non-binary']), null)
})

test('cocok langsung didahulukan; padanan yang menunjuk dua pilihan berbeda ditolak (ambigu)', () => {
  assert.equal(matchOptionStrict('Ya', ['Ya', 'Yes']), 'Ya')
  assert.equal(matchOptionStrict('Sekarang', ['Present', 'Current']), null)
  assert.equal(matchOptionStrict('Ya', ['Yes', 'Yes']), null)
})

test('tanpa padanan yang pasti, tetap null (tidak ada sinonim longgar)', () => {
  assert.equal(matchOptionStrict('Mungkin', ['Yes', 'No']), null)
  assert.equal(matchOptionStrict('Jakarta', ['Bandung', 'Surabaya']), null)
  assert.deepEqual(optionAliases('Jakarta'), [])
  assert.ok(optionAliases('YA').includes('yes'))
})
