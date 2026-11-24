import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { aiPipelineService } from '../services/ai-pipeline.service.ts'
import { formAutofillService, positiveSettingNumber } from '../services/form-autofill.service.ts'
import { buildApprovalAnswers } from '../services/approval-answers.service.ts'

/**
 * Gaji dan masa pemberitahuan tidak pernah dijawab "0" dan tidak diada-adakan (30 hari): hanya nilai yang tersimpan
 * yang dipakai, selain itu kosong dengan keyakinan 0 dan pengguna yang mengisi.
 */

;(aiPipelineService as any).generateAnswer = async () => {
  throw new Error('real AI call blocked in tests')
}
afterEach(() => {
  ;(aiPipelineService as any).generateAnswer = async () => {
    throw new Error('real AI call blocked in tests')
  }
})

const ctx = (userSettings: Record<string, unknown>) => ({ jobTitle: 'T', company: 'C', jobDescription: '', userSettings, userProfile: {} }) as any
const fill = (label: string, settings: Record<string, unknown>) => formAutofillService.fillField({ type: 'text', label }, ctx(settings))

test('positiveSettingNumber: hanya angka positif yang dihitung', () => {
  for (const v of [null, undefined, '', '  ', 0, '0', -1, '-5', Number.NaN, 'abc', Infinity]) {
    assert.equal(positiveSettingNumber(v), null, String(v))
  }
  assert.equal(positiveSettingNumber(9000000), 9000000)
  assert.equal(positiveSettingNumber('7500000'), 7500000)
  assert.equal(positiveSettingNumber(' 14 '), 14)
})

test('gaji diharapkan dan gaji sekarang: 0, kosong, atau tidak ada = kosong berkeyakinan 0', async () => {
  for (const label of ['Expected salary', 'Desired salary', 'Salary expectation', 'Current CTC', 'Current salary']) {
    for (const settings of [{}, { desired_salary: 0, current_ctc: 0 }, { desired_salary: null, current_ctc: null }, { desired_salary: '', current_ctc: '' }, { desired_salary: Number.NaN, current_ctc: Number.NaN }]) {
      const res = await fill(label, settings)
      assert.equal(res.value, '', `${label} ${JSON.stringify(settings)}`)
      assert.equal(res.confidence, 0, `${label} ${JSON.stringify(settings)}`)
    }
  }
})

test('gaji: nilai tersimpan dipakai apa adanya dengan keyakinan 0,9; gaji sekarang membaca current_ctc', async () => {
  const settings = { desired_salary: 9500000, current_ctc: '6000000' }
  const want = await fill('Expected salary', settings)
  assert.deepEqual([want.value, want.confidence], ['9500000', 0.9])
  const current = await fill('Current CTC', settings)
  assert.deepEqual([current.value, current.confidence], ['6000000', 0.9])
})

test('masa pemberitahuan tidak diada-adakan 30 hari: kosong, 0, atau tidak ada = kosong berkeyakinan 0', async () => {
  for (const label of ['Notice period', 'Notice period (days)', 'Notice period in months', 'Notice period in weeks', 'Availability to start']) {
    for (const settings of [{}, { notice_period: null }, { notice_period: 0 }, { notice_period: '' }, { notice_period: Number.NaN }]) {
      const res = await fill(label, settings)
      assert.equal(res.value, '', `${label} ${JSON.stringify(settings)}`)
      assert.equal(res.confidence, 0, `${label} ${JSON.stringify(settings)}`)
    }
  }
})

test('masa pemberitahuan: nilai tersimpan dipakai dalam hari, minggu, atau bulan; satuan yang jadi 0 dikosongkan', async () => {
  const days = await fill('Notice period', { notice_period: 45 })
  assert.deepEqual([days.value, days.confidence], ['45', 0.9])
  const months = await fill('Notice period in months', { notice_period: 60 })
  assert.deepEqual([months.value, months.confidence], ['2', 0.9])
  const weeks = await fill('Notice period in weeks', { notice_period: 21 })
  assert.deepEqual([weeks.value, weeks.confidence], ['3', 0.9])
  // 14 hari kurang dari satu bulan: jangan menjawab "0 bulan".
  const shortMonths = await fill('Notice period in months', { notice_period: 14 })
  assert.deepEqual([shortMonths.value, shortMonths.confidence], ['', 0])
})

test('jawaban persetujuan: gaji dan notice period bernilai 0 dikosongkan dan wajib dicek; nilai positif tetap dijawab', async () => {
  const job = { title: 'Backend Engineer', company: 'Contoh PT', description: 'Bangun API.' }
  const base = { first_name: 'Budi', last_name: 'Uji', phone_number: '+628111111111', current_city: 'Yogyakarta', years_of_experience: '3', require_visa: 'no', linkedin_url: 'https://linkedin.example/in/budi' }
  const find = (rows: any[], part: string) => rows.find((r) => r.question.includes(part))

  ;(aiPipelineService as any).generateAnswer = async () => 'x'
  const zero = await buildApprovalAnswers({ settings: { ...base, desired_salary: 0, notice_period: 0 }, profile: { email: 'a@b.test' }, job })
  for (const part of ['Ekspektasi gaji', 'notice period']) {
    const r = find(zero, part)
    assert.equal(r.answer, '', part)
    assert.equal(r.confidence, 0, part)
    assert.equal(r.needs_review, true, part)
  }

  const set = await buildApprovalAnswers({ settings: { ...base, desired_salary: 9000000, notice_period: 30 }, profile: { email: 'a@b.test' }, job })
  assert.equal(find(set, 'Ekspektasi gaji').answer, '9000000')
  assert.equal(find(set, 'notice period').answer, '30')
})
