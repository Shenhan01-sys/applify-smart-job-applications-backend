import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeJobStreetItem } from '../jobstreet/index.js'
import { normalizeGlintsJob, glintsSalary } from '../glints/index.js'
import { normalizeDeallsJob } from '../dealls/index.js'

/**
 * Gaji terstruktur dari tiap sumber portal. Fixture meniru respons asli (dibuktikan 2026-11-20 untuk JobStreet
 * `salaryLabel`, Glints `salaries[]`, dan Dealls `salaryRange` + `skills`); tanpa jaringan.
 */

const jobstreetItem = (over: Record<string, any> = {}) => ({
  id: '92996157', title: 'Facility Engineer',
  advertiser: { id: '1', description: 'PT YOFC International Indonesia' },
  locations: [{ label: 'Karawang, Jawa Barat' }],
  teaser: 'Maintain facility', bulletPoints: ['BPJS'], workTypes: ['Full time'],
  ...over,
})

test('JobStreet: salaryLabel dibaca jadi salary_min/max/currency/period; salary_range tetap teks asli', () => {
  const label = 'Rp 9.000.000 – Rp 13.000.000 per month'
  const j = normalizeJobStreetItem(jobstreetItem({ salaryLabel: label }))!
  assert.equal(j.salary_range, label)
  assert.equal(j.salary_min, 9_000_000)
  assert.equal(j.salary_max, 13_000_000)
  assert.equal(j.salary_currency, 'IDR')
  assert.equal(j.salary_period, 'month')
})

test('JobStreet: salaryLabel kosong atau tak terbaca -> tanpa bidang gaji terstruktur', () => {
  for (const salaryLabel of ['', undefined, 'Gaji kompetitif']) {
    const j = normalizeJobStreetItem(jobstreetItem({ salaryLabel }))!
    assert.equal(j.salary_min, undefined)
    assert.equal(j.salary_max, undefined)
    assert.equal('salary_currency' in j, false)
  }
})

const glintsItem = (salaries: any) => ({
  id: 'abc-123', title: 'Frontend Developer', company: { name: 'PT Glints Test' },
  city: { name: 'Jakarta' }, country: { code: 'ID', name: 'Indonesia' }, salaries,
})

test('Glints: salaries[] BASIC -> angka terstruktur, salaryMode menjadi periode', () => {
  const j = normalizeGlintsJob(glintsItem([
    { salaryType: 'ADDITIONAL', salaryMode: 'MONTH', minAmount: 100, maxAmount: 200, CurrencyCode: 'IDR' },
    { salaryType: 'BASIC', salaryMode: 'MONTH', minAmount: 8_000_000, maxAmount: 12_000_000, CurrencyCode: 'IDR' },
  ]))!
  assert.equal(j.salary_min, 8_000_000)
  assert.equal(j.salary_max, 12_000_000)
  assert.equal(j.salary_currency, 'IDR')
  assert.equal(j.salary_period, 'month')
  assert.match(j.salary_range ?? '', /IDR \d/)
})

test('Glints: mode YEAR/HOUR, satu sisi kosong, mata uang lain, dan data kosong', () => {
  assert.equal(glintsSalary([{ salaryType: 'BASIC', salaryMode: 'YEAR', minAmount: 120_000_000, maxAmount: 180_000_000, CurrencyCode: 'IDR' }])?.period, 'year')
  assert.equal(glintsSalary([{ salaryMode: 'HOUR', minAmount: 25, maxAmount: 40, CurrencyCode: 'USD' }])?.currency, 'USD')
  assert.deepEqual(glintsSalary([{ salaryType: 'BASIC', salaryMode: 'MONTH', minAmount: 6_000_000, maxAmount: null, CurrencyCode: 'IDR' }]), {
    min: 6_000_000, max: 6_000_000, currency: 'IDR', period: 'month',
  })
  assert.equal(glintsSalary([]), null)
  assert.equal(glintsSalary(null), null)
  assert.equal(glintsSalary([{ minAmount: 0, maxAmount: 0 }]), null)
  const j = normalizeGlintsJob(glintsItem([]))!
  assert.equal(j.salary_min, undefined)
})

const deallsItem = (over: Record<string, any> = {}) => ({
  id: '6af5a981178a2d0012976e9e', slug: 'admin-staff', role: 'Admin Staff', status: 'active',
  country: { name: 'Indonesia' }, city: { name: 'Jakarta Selatan' },
  company: { name: 'PT Dealls Uji', slug: 'pt-dealls-uji' }, employmentTypes: ['fullTime'],
  ...over,
})

test('Dealls: salaryRange -> IDR per bulan; skills -> daftar nama tanpa duplikat', () => {
  const j = normalizeDeallsJob(deallsItem({
    salaryRange: { start: 2_800_000, end: 3_000_000 }, salaryType: 'paid',
    skills: [{ name: 'IT' }, { name: 'Excel' }, { name: 'IT' }, { name: '  ' }, { id: 'x' }, 'Komunikasi'],
  }))!
  assert.equal(j.salary_min, 2_800_000)
  assert.equal(j.salary_max, 3_000_000)
  assert.equal(j.salary_currency, 'IDR')
  assert.equal(j.salary_period, 'month')
  assert.match(j.salary_range ?? '', /^IDR 2\.800\.000 - 3\.000\.000 \/ month$/)
  assert.deepEqual(j.skills, ['IT', 'Excel', 'Komunikasi'])
})

test('Dealls: salaryRange null/nol dan tanpa skills -> tanpa bidang gaji maupun skills', () => {
  for (const salaryRange of [null, undefined, { start: 0, end: 0 }]) {
    const j = normalizeDeallsJob(deallsItem({ salaryRange, skills: [] }))!
    assert.equal(j.salary_min, undefined)
    assert.equal(j.salary_range, undefined)
    assert.equal('skills' in j, false)
  }
})
