import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseSalaryLabel, periodFromMode, salaryOfPosting, sanitizeSalary, toDbSalary } from '../services/salary.ts'

/**
 * Parsing teks gaji portal dan normalisasi gaji terstruktur. Semua teks di bawah mengikuti bentuk yang dikirim
 * portal (JobStreet salaryLabel, Glints formatSalary, JSON-LD), tanpa jaringan.
 */

test('JobStreet: "Rp 9.000.000 – Rp 13.000.000 per month" dengan nbsp dan en dash', () => {
  assert.deepEqual(parseSalaryLabel('Rp 9.000.000 – Rp 13.000.000 per month'), {
    min: 9_000_000, max: 13_000_000, currency: 'IDR', period: 'month',
  })
  assert.deepEqual(parseSalaryLabel('Rp 9.000.000 – Rp 13.000.000 per month'), {
    min: 9_000_000, max: 13_000_000, currency: 'IDR', period: 'month',
  })
})

test('satu angka: min = max', () => {
  assert.deepEqual(parseSalaryLabel('Rp 5.000.000 per month'), { min: 5_000_000, max: 5_000_000, currency: 'IDR', period: 'month' })
})

test('pengali Indonesia: "Rp 5jt - 7jt", "5 - 7 juta", "Rp 6,5 jt", "Rp 500 rb"', () => {
  assert.deepEqual(parseSalaryLabel('Rp 5jt - 7jt'), { min: 5_000_000, max: 7_000_000, currency: 'IDR', period: 'month' })
  assert.deepEqual(parseSalaryLabel('Rp 5 - 7 juta'), { min: 5_000_000, max: 7_000_000, currency: 'IDR', period: 'month' })
  assert.deepEqual(parseSalaryLabel('Rp 6,5 jt'), { min: 6_500_000, max: 6_500_000, currency: 'IDR', period: 'month' })
  assert.deepEqual(parseSalaryLabel('Rp 6.5 jt / bulan'), { min: 6_500_000, max: 6_500_000, currency: 'IDR', period: 'month' })
  assert.deepEqual(parseSalaryLabel('Rp 500 rb per hari'), { min: 500_000, max: 500_000, currency: 'IDR', period: 'day' })
})

test('"IDR 8.000.000 - 12.000.000 / monthly" (format Glints) dan "Rp9.000.000"', () => {
  assert.deepEqual(parseSalaryLabel('IDR 8.000.000 - 12.000.000 / monthly'), { min: 8_000_000, max: 12_000_000, currency: 'IDR', period: 'month' })
  assert.deepEqual(parseSalaryLabel('Rp9.000.000'), { min: 9_000_000, max: 9_000_000, currency: 'IDR', period: 'month' })
})

test('dolar: "$80,000 – $100,000 per year", per jam, dan periode ditebak dari besarnya angka', () => {
  assert.deepEqual(parseSalaryLabel('$80,000 – $100,000 per year'), { min: 80_000, max: 100_000, currency: 'USD', period: 'year' })
  assert.deepEqual(parseSalaryLabel('US$25 - US$40 per hour'), { min: 25, max: 40, currency: 'USD', period: 'hour' })
  assert.deepEqual(parseSalaryLabel('$25.50 per hour'), { min: 25.5, max: 25.5, currency: 'USD', period: 'hour' })
  assert.deepEqual(parseSalaryLabel('$120k'), { min: 120_000, max: 120_000, currency: 'USD', period: 'year' })
  assert.equal(parseSalaryLabel('S$4,000 - S$5,500 per month')?.currency, 'SGD')
})

test('min > max ditukar; angka tak wajar dan teks sampah menghasilkan null', () => {
  assert.deepEqual(parseSalaryLabel('Rp 13.000.000 - Rp 9.000.000'), { min: 9_000_000, max: 13_000_000, currency: 'IDR', period: 'month' })
  for (const bad of ['', '   ', 'per hour', 'Gaji kompetitif', 'Negotiable', 'Rp 5', 'Rp 9.000.000.000.000', 'Rp 5.000 - Rp 99.000.000.000', '2026', null, undefined, 42]) {
    assert.equal(parseSalaryLabel(bad as any), null, `harus null: ${String(bad)}`)
  }
  // rasio min:max di atas 50x hampir pasti salah baca
  assert.equal(parseSalaryLabel('Rp 100.000 - Rp 900.000.000'), null)
})

test('angka tambahan seperti "13th month" tidak dibaca sebagai gaji', () => {
  assert.deepEqual(parseSalaryLabel('Rp 9.000.000 - 13.000.000 + 13th month'), { min: 9_000_000, max: 13_000_000, currency: 'IDR', period: 'month' })
})

test('tanpa penanda mata uang ditolak, kecuali pengali Indonesia', () => {
  assert.equal(parseSalaryLabel('9.000.000 per month'), null)
  assert.equal(parseSalaryLabel('5 - 7 juta')?.currency, 'IDR')
})

test('sanitizeSalary: nol dianggap kosong, sisi kosong diisi sisi lain, kode mata uang dinormalkan', () => {
  assert.deepEqual(sanitizeSalary({ min: 0, max: 5_000_000, currency: 'idr', period: 'month' }), { min: 5_000_000, max: 5_000_000, currency: 'IDR', period: 'month' })
  assert.deepEqual(sanitizeSalary({ min: '3000000', max: null }), { min: 3_000_000, max: 3_000_000, currency: 'IDR', period: 'month' })
  assert.equal(sanitizeSalary({ min: 0, max: 0 }), null)
  assert.equal(sanitizeSalary({ min: null, max: undefined }), null)
  assert.equal(sanitizeSalary({ min: 3, max: 4, currency: 'IDR', period: 'month' }), null)
})

test('periodFromMode: mode API Glints/JSON-LD', () => {
  assert.equal(periodFromMode('MONTH'), 'month')
  assert.equal(periodFromMode('YEAR'), 'year')
  assert.equal(periodFromMode('Hour'), 'hour')
  assert.equal(periodFromMode('DAY'), 'day')
  assert.equal(periodFromMode('WEEK'), 'week')
  assert.equal(periodFromMode('weird'), null)
  assert.equal(periodFromMode(undefined), null)
})

test('toDbSalary: bilangan bulat, terjepit ke int32', () => {
  assert.deepEqual(toDbSalary({ min: 6_500_000.4, max: 7_000_000.6, currency: 'IDR', period: 'month' }), {
    salary_min: 6_500_000, salary_max: 7_000_001, salary_currency: 'IDR', salary_period: 'month',
  })
  const big = toDbSalary({ min: 5e9, max: 9e9, currency: 'IDR', period: 'year' })
  assert.equal(big.salary_min, 2147483647)
  assert.equal(big.salary_max, 2147483647)
})

test('salaryOfPosting: angka terstruktur didahulukan, salary_range sebagai cadangan', () => {
  assert.deepEqual(salaryOfPosting({ salary_min: 8e6, salary_max: 12e6, salary_currency: 'IDR', salary_period: 'month', salary_range: 'ignored' }), {
    min: 8e6, max: 12e6, currency: 'IDR', period: 'month',
  })
  assert.deepEqual(salaryOfPosting({ salary_range: 'Rp 5jt - 7jt' }), { min: 5e6, max: 7e6, currency: 'IDR', period: 'month' })
  assert.equal(salaryOfPosting({}), null)
  assert.equal(salaryOfPosting({ salary_range: 'Gaji kompetitif' }), null)
})
