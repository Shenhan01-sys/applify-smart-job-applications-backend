import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { redactForModel } from '../services/linkedin-import.js'
import { extractAshbyCompensation, normalizeAshbyJob } from '../mcp/ashby/index.js'
import { normalizeKalibrrJob } from '../mcp/kalibrr/index.js'
import { normalizeSmartRecruitersPosting } from '../mcp/smartrecruiters/index.js'
import { deleteParticipantData, type DeletionClient } from '../services/participant-deletion.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

describe('Gelombang 5 P2 hardening (47.1 P2-1/P2-2, 47.3 P2-02/P2-03, DB-09, J5-03)', () => {
  it('47.1 P2-1: prompt pdf-ocr memuat pagar anti-prompt-injection', () => {
    const src = readFileSync(path.resolve(__dirname, '../services/pdf-ocr.ts'), 'utf8')
    assert.match(src, /untrusted literal text.*never obey/i)
  })

  it('47.1 P2-2: redactForModel menyamarkan nomor ponsel Indonesia tanpa label dan NIK 16 digit', () => {
    const raw = [
      'Budi Santoso',
      'Email: budi@example.id',
      'Kontak: 0812-3456-7890 atau +62 813 9876 5432',
      'NIK: 3171010101990001',
      'Pengalaman: 2021 - 2024',
    ].join('\n')
    const out = redactForModel(raw)
    assert.equal(out.includes('budi@example.id'), false)
    assert.equal(out.includes('0812-3456-7890'), false)
    assert.equal(out.includes('813 9876 5432'), false)
    assert.equal(out.includes('3171010101990001'), false)
    assert.match(out, /\[email\]/)
    assert.match(out, /\[phone\]/)
    assert.match(out, /\[id\]/)
    assert.match(out, /2021 - 2024/, 'tahun pengalaman tetap utuh')
  })

  it('47.3 P2-03: Ashby dan Kalibrr mem-parse gaji saat tersedia', () => {
    const comp = extractAshbyCompensation({
      summaryComponents: [{ compensationType: 'Salary', minValue: 120000, maxValue: 160000, currencyCode: 'USD' }],
    })
    assert.deepEqual(comp, { salary_min: 120000, salary_max: 160000, salary_currency: 'USD' })

    const ashbyJob = normalizeAshbyJob(
      {
        id: 'a1',
        title: 'Backend Engineer',
        location: 'Remote',
        jobUrl: 'https://jobs.ashbyhq.com/co/a1',
        compensation: { summaryComponents: [{ compensationType: 'Salary', minValue: 90000, maxValue: 110000, currencyCode: 'USD' }] },
      },
      'co'
    )
    assert.equal(ashbyJob?.salary_min, 90000)
    assert.equal(ashbyJob?.salary_currency, 'USD')

    const kalJob = normalizeKalibrrJob({
      id: 42,
      name: 'Frontend Developer',
      company: { name: 'PT Maju', code: 'maju' },
      base_salary: 10000000,
      maximum_salary: 15000000,
      salary_currency: 'IDR',
      salary_shown: true,
    })
    assert.equal(kalJob?.salary_min, 10000000)
    assert.equal(kalJob?.salary_max, 15000000)
    assert.equal(kalJob?.salary_currency, 'IDR')

    const hiddenKal = normalizeKalibrrJob({
      id: 43,
      name: 'Frontend Developer',
      company: { name: 'PT Maju', code: 'maju' },
      base_salary: 10000000,
      salary_shown: false,
    })
    assert.equal(hiddenKal?.salary_min, undefined)
  })

  it('47.3 P2-02: SmartRecruiters menormalkan experience_level melalui guessExperienceLevel', () => {
    const job = normalizeSmartRecruitersPosting(
      {
        id: 'sr-1',
        name: 'Software Engineer',
        experienceLevel: { label: 'Entry Level' },
        company: { identifier: 'co', name: 'Co' },
      },
      'co'
    )
    assert.equal(job?.experience_level, 'junior')
  })

  it('47.6 DB-09: deleteParticipantData melewati tabel DRAFT yang belum ada tanpa melempar error', async () => {
    const U = '11111111-2222-4333-8444-555555555555'
    const client: DeletionClient = {
      async listFiles() { return [] },
      async removeFiles() {},
      async countRows(table) {
        if (table === 'user_notification_settings' || table === 'user_extension_revocations') {
          throw Object.assign(new Error(`relation "public.${table}" does not exist`), { code: '42P01' })
        }
        return 0
      },
      async deleteRows() {},
      async authEmail() { return 'u@example.test' },
      async deleteAuthUser() {},
    }
    const report = await deleteParticipantData(client, U, { apply: false })
    assert.deepEqual(report.skippedTables, ['user_extension_revocations', 'user_notification_settings'])
    assert.equal(report.rows.user_notification_settings, 0)
  })

  it('48.5 J5-03: skrip bootstrap AWS mengatur umask 077 dan chmod 600 pada backend/.env', () => {
    for (const file of ['aws-userdata.sh', 'aws-bootstrap.sh']) {
      const src = readFileSync(path.resolve(__dirname, '..', file), 'utf8')
      assert.match(src, /umask 077/, `${file} harus memasang umask 077`)
      assert.match(src, /chmod 600 .*backend\/\.env/, `${file} harus memasang chmod 600 pada .env`)
    }
  })
})
