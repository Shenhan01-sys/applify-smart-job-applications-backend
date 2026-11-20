import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { aiPipelineService } from '../services/ai-pipeline.service.ts'
import { formAutofillService } from '../services/form-autofill.service.ts'
import { UNCONFIRMED_DEFAULT_CONFIDENCE, isUnconfirmedVisaDefault } from '../services/applicant-fallbacks.ts'
import { buildApprovalAnswers, confidenceLevel } from '../services/approval-answers.service.ts'

// Semua data di berkas ini sintetis. AI selalu diganti: tidak ada permintaan jaringan.
;(aiPipelineService as any).generateAnswer = async () => 'Jawaban AI uji.'
afterEach(() => {
  ;(aiPipelineService as any).generateAnswer = async () => 'Jawaban AI uji.'
})

const job = { title: 'Backend Engineer', company: 'Contoh PT', description: 'Bangun API.' }
const profile = { email: 'budi@contoh.test', skills: ['TypeScript'] }
const row = (rows: Awaited<ReturnType<typeof buildApprovalAnswers>>, part: string) => {
  const r = rows.find((x) => x.question.includes(part))
  assert.ok(r, `pertanyaan "${part}" tidak ditemukan`)
  return r!
}

// Temuan 15 uji klik produksi 20 November 2026: sponsor visa "No" bawaan database tampil 95% tanpa "Perlu dicek".

test('isUnconfirmedVisaDefault: hanya "No" persis (nilai bawaan database); pilihan pengguna huruf kecil dan kosong bukan', () => {
  assert.equal(isUnconfirmedVisaDefault('No'), true)
  assert.equal(isUnconfirmedVisaDefault(' No '), true)
  for (const v of ['no', 'yes', 'Yes', 'NO', '', null, undefined, 0, false]) assert.equal(isUnconfirmedVisaDefault(v), false, String(v))
})

test('sponsor visa bernilai bawaan "No": jawaban tetap tampil tetapi keyakinan sedang, sumber "default", wajib dicek', async () => {
  const rows = await buildApprovalAnswers({ settings: { require_visa: 'No' }, profile, job })
  const v = row(rows, 'sponsor visa')
  assert.equal(v.answer, 'No')
  assert.equal(v.source, 'default')
  assert.equal(v.confidence, UNCONFIRMED_DEFAULT_CONFIDENCE)
  assert.equal(confidenceLevel(v.confidence), 'medium')
  assert.equal(v.needs_review, true)
})

test('sponsor visa pilihan pengguna ("no" atau "yes" huruf kecil): keyakinan tinggi, bersumber Pengaturan, tidak ditandai', async () => {
  for (const [stored, shown] of [['no', 'No'], ['yes', 'Yes']] as const) {
    const rows = await buildApprovalAnswers({ settings: { require_visa: stored }, profile, job })
    const v = row(rows, 'sponsor visa')
    assert.equal(v.answer, shown)
    assert.equal(v.source, 'rule')
    assert.equal(v.confidence, 0.95)
    assert.equal(v.needs_review, false)
  }
})

test('sponsor visa kosong: tetap kosong, keyakinan 0, wajib dicek (tidak diada-adakan "No")', async () => {
  const rows = await buildApprovalAnswers({ settings: { require_visa: '' }, profile, job })
  const v = row(rows, 'sponsor visa')
  assert.deepEqual([v.answer, v.confidence, v.needs_review], ['', 0, true])
})

test('FormAutofillService, label visa: kosong tidak diada-adakan, bawaan database tidak yakin, pilihan pengguna yakin', async () => {
  const ask = (settings: Record<string, unknown>) =>
    formAutofillService.fillField(
      { type: 'radio', label: 'Do you require visa sponsorship?', options: ['Yes', 'No'] },
      { jobTitle: 'X', company: 'Y', jobDescription: '', userSettings: settings, userProfile: {} }
    )
  const blank = await ask({})
  assert.deepEqual([blank.value, blank.confidence], ['', 0])
  const dbDefault = await ask({ require_visa: 'No' })
  assert.deepEqual([dbDefault.value, dbDefault.confidence], ['No', UNCONFIRMED_DEFAULT_CONFIDENCE])
  const chosen = await ask({ require_visa: 'no' })
  assert.deepEqual([chosen.value, chosen.confidence], ['No', 0.95])
  const yes = await ask({ require_visa: 'yes' })
  assert.deepEqual([yes.value, yes.confidence], ['Yes', 0.95])
})
