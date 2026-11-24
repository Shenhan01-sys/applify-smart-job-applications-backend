import { test } from 'node:test'
import assert from 'node:assert/strict'
import { NOW } from './helpers/linkedinFixture.ts'
import { normalizeExtraction } from '../services/linkedin-import.ts'

/**
 * Gelar yang dijawab model dalam bentuk lain dari PDF ("Bachelor of Science" padahal PDF menulis "B.Sc.") tidak boleh
 * dikosongkan: padanan yang pasti dianggap ada di teks sumber. Gelar yang tidak ada padanannya di PDF tetap dibuang
 * (grounding). Semua teks SINTETIS. Tanpa jaringan.
 */

const norm = (degree: string, sourceText: string) =>
  normalizeExtraction(
    { education: [{ school: 'Universitas Contoh Nusantara', degree, field: 'Computer Science', years: '2019 - 2023' }] },
    { sourceText, now: NOW },
  )
const out = (degree: string, sourceText: string) => norm(degree, sourceText).education.map((e) => [e.degree, e.field_of_study])

const src = (degreeLine: string) => `Universitas Contoh Nusantara | ${degreeLine} Computer Science 2019 - 2023`

test('model menulis nama lengkap, PDF menulis singkatan: gelar dipertahankan dan bidang tidak naik jadi gelar', () => {
  assert.deepEqual(out('Bachelor of Science', src('B.Sc.')), [['Bachelor of Science', 'Computer Science']])
  assert.deepEqual(out('Bachelor of Science', src('BSc')), [['Bachelor of Science', 'Computer Science']])
  assert.deepEqual(out('Bachelor of Arts', src('B.A.')), [['Bachelor of Arts', 'Computer Science']])
  assert.deepEqual(out('Bachelor of Engineering', src('B.Eng.')), [['Bachelor of Engineering', 'Computer Science']])
  assert.deepEqual(out('Master of Science', src('M.Sc.')), [['Master of Science', 'Computer Science']])
  assert.deepEqual(out('Master of Business Administration', src('MBA')), [['Master of Business Administration', 'Computer Science']])
  assert.deepEqual(out('Sarjana Komputer', src('S.Kom.')), [['Sarjana Komputer', 'Computer Science']])
})

test('model menulis singkatan, PDF menulis nama lengkap, dan jenjang umum (S1, Sarjana, Bachelor)', () => {
  assert.deepEqual(out('B.Sc.', src('Bachelor of Science')), [['B.Sc.', 'Computer Science']])
  assert.deepEqual(out('S1', src('Sarjana')), [['S1', 'Computer Science']])
  assert.deepEqual(out('Sarjana', src('S1')), [['Sarjana', 'Computer Science']])
  assert.deepEqual(out('Bachelor', src('S1')), [['Bachelor', 'Computer Science']])
  assert.deepEqual(out('S2', src('Magister')), [['S2', 'Computer Science']])
  assert.deepEqual(out('Diploma III', src('D3')), [['Diploma III', 'Computer Science']])
})

test('tulisan yang persis sama di PDF tetap lolos seperti sebelumnya', () => {
  assert.deepEqual(out('Bachelor of Science', src('Bachelor of Science in')), [['Bachelor of Science', 'Computer Science']])
})

test('gelar tanpa padanan di PDF tetap dikosongkan: bidang naik menjadi gelar, tidak ada karangan', () => {
  // PDF B.Sc., model mengarang Master of Science
  assert.deepEqual(out('Master of Science', src('B.Sc.')), [['Computer Science', null]])
  // PDF B.Sc., model menulis Bachelor of Arts (gelar lain)
  assert.deepEqual(out('Bachelor of Arts', src('B.Sc.')), [['Computer Science', null]])
  // PDF tidak menyebut gelar sama sekali
  assert.deepEqual(out('Bachelor of Science', 'Universitas Contoh Nusantara\nComputer Science 2019 - 2023'), [['Computer Science', null]])
  // D3 bukan S1
  assert.deepEqual(out('D3', src('S1')), [['Computer Science', null]])
})

test('singkatan dua huruf yang juga kata biasa tidak dipakai sebagai bukti ("MS Office" bukan Master of Science)', () => {
  assert.deepEqual(out('Master of Science', 'Universitas Contoh Nusantara | Computer Science 2019 - 2023\nSkills: MS Office'), [['Computer Science', null]])
})
