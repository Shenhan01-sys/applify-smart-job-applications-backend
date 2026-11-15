import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeKalibrrJob } from '../kalibrr/index.js'
import { normalizeJobStreetItem } from '../jobstreet/index.js'
import { normalizeGlintsJob } from '../glints/index.js'
import { normalizeSmartRecruitersPosting, extractSmartRecruitersDescription } from '../smartrecruiters/index.js'
import { normalizeGreenhouseJob } from '../greenhouse/index.js'
import { normalizeLeverPosting } from '../lever/index.js'
import { normalizeAshbyJob } from '../ashby/index.js'
import { normalizeWorkableJob } from '../workable/index.js'
import { htmlToText, matchesKeywords, matchesLocation, relevanceScore } from '../shared/utils.js'

/**
 * Uji normalisasi dengan fixture yang meniru bentuk respons asli tiap sumber
 * (field-field yang dipakai sama dengan dokumentasi/verifikasi di header tiap klien).
 * Jalankan: npm run test:portals
 */

test('Kalibrr: URL kanonik, lokasi dari google_location, deskripsi HTML -> teks', () => {
  const j = normalizeKalibrrJob({
    id: 272750, name: 'Data Analyst', slug: 'data-analyst',
    company: { name: 'PT Contoh Data', code: 'pt-contoh-data' },
    google_location: { address_components: { city: 'Jakarta Selatan', region: 'DKI Jakarta', country: 'Indonesia' } },
    activation_date: '2026-09-30T01:15:55.510103+00:00', is_work_from_home: false,
    description: '<p>Analyze data with <b>SQL</b> &amp; Python</p>', qualifications: '<ul><li>S1</li></ul>',
  })!
  assert.equal(j.url, 'https://www.kalibrr.com/c/pt-contoh-data/jobs/272750/data-analyst')
  assert.equal(j.location, 'Jakarta Selatan, DKI Jakarta, Indonesia')
  assert.match(j.description, /SQL & Python/)
  assert.equal(j.platform, 'kalibrr')
  assert.equal(normalizeKalibrrJob({ id: 1 }), null)
})

test('JobStreet (SEEK v5): URL /id/job/<id>, perusahaan dari advertiser, tipe kerja', () => {
  const j = normalizeJobStreetItem({
    id: '92996157', title: 'Facility Engineer',
    advertiser: { id: '1', description: 'PT YOFC International Indonesia' }, companyName: 'YOFC',
    locations: [{ label: 'Karawang, Jawa Barat', countryCode: 'ID' }],
    listingDate: '2026-06-29T02:53:00Z', teaser: 'Maintain facility', bulletPoints: ['BPJS', 'Bonus'],
    workTypes: ['Kontrak/Temporer'], workArrangements: { data: [{ id: '1', label: { text: 'On-site' } }] },
  })!
  assert.equal(j.url, 'https://id.jobstreet.com/id/job/92996157')
  assert.equal(j.company, 'PT YOFC International Indonesia')
  assert.equal(j.job_type, 'contract')
  assert.equal(j.work_type, 'on-site')
})

test('Glints: URL opportunities, gaji terformat', () => {
  const j = normalizeGlintsJob({
    id: 'abc-123', title: 'Frontend Developer', company: { name: 'PT Glints Test', brandName: 'GT' },
    city: { name: 'Jakarta' }, country: { code: 'ID', name: 'Indonesia' },
    salaries: [{ salaryType: 'BASIC', salaryMode: 'MONTH', minAmount: 8000000, maxAmount: 12000000, CurrencyCode: 'IDR' }],
    createdAt: '2026-09-20T00:00:00Z',
  })!
  assert.equal(j.url, 'https://glints.com/id/opportunities/jobs/abc-123')
  assert.equal(j.location, 'Jakarta, Indonesia')
  assert.match(j.salary_range ?? '', /IDR 8\.000\.000 - 12\.000\.000/)
})

test('SmartRecruiters: URL publik & deskripsi dari jobAd.sections', () => {
  const j = normalizeSmartRecruitersPosting({
    id: '743999740452897', name: 'DevOps Engineer (Jakarta office)',
    company: { identifier: 'MCPayment', name: 'MCPayment' },
    location: { city: 'Jakarta', country: 'id', fullLocation: 'Jakarta, Indonesia', remote: false },
    releasedDate: '2026-09-01T00:00:00.000Z', typeOfEmployment: { label: 'Full-time' }, department: { label: 'Tech' },
  }, 'MCPayment')!
  assert.equal(j.url, 'https://jobs.smartrecruiters.com/MCPayment/743999740452897-devops-engineer-jakarta-office')
  assert.ok(matchesLocation(j.location, 'Indonesia'))
  const d = extractSmartRecruitersDescription({ jobAd: { sections: { jobDescription: { text: '<p>Kubernetes &amp; AWS</p>' } } } })
  assert.equal(d, 'Kubernetes & AWS')
})

test('Greenhouse: konten HTML ter-escape didekode', () => {
  const j = normalizeGreenhouseJob({
    id: 7641034, title: 'Lead - Content Planner', location: { name: 'Jakarta, Indonesia' },
    absolute_url: 'https://job-boards.greenhouse.io/acommerce/jobs/7641034', updated_at: '2026-09-01T00:00:00Z',
    content: '&lt;p&gt;Plan content &amp;amp; campaigns&lt;/p&gt;',
  }, 'acommerce', 'aCommerce')!
  assert.equal(j.description, 'Plan content & campaigns')
  assert.equal(j.company, 'aCommerce')
})

test('Lever / Ashby / Workable: field lokasi & URL benar', () => {
  const l = normalizeLeverPosting({
    id: 'b166560d', text: 'Solutions Consultant - Indonesia', categories: { location: 'Jakarta', commitment: 'Full-time' },
    descriptionPlain: 'Consult clients', lists: [{ text: 'Requirements', content: '<li>3 years SaaS</li>' }],
    hostedUrl: 'https://jobs.lever.co/insiderone/b166560d', applyUrl: 'https://jobs.lever.co/insiderone/b166560d/apply', createdAt: 1790000000000,
  }, 'insiderone')!
  assert.equal(l.apply_url, 'https://jobs.lever.co/insiderone/b166560d/apply')
  assert.deepEqual(l.requirements, ['3 years SaaS'])

  const a = normalizeAshbyJob({
    id: 'e4ca8151', title: 'Account Development Rep (Bahasa Indonesia)', location: 'Singapore',
    secondaryLocations: [{ location: 'Jakarta' }], workplaceType: 'Hybrid', employmentType: 'FullTime',
    descriptionPlain: 'Prospect accounts', publishedAt: '2026-09-10T00:00:00Z', jobUrl: 'https://jobs.ashbyhq.com/kong/e4ca8151',
  }, 'kong')!
  assert.equal(a.location, 'Singapore, Jakarta')
  assert.equal(a.work_type, 'hybrid')

  const w = normalizeWorkableJob({
    title: 'QA Engineer', shortcode: 'ABC123', shortlink: 'https://apply.workable.com/j/ABC123',
    city: 'Jakarta', country: 'Indonesia', telecommuting: false, published_on: '2026-09-01', description: '<p>Test apps</p>',
  }, 'contoh')!
  assert.equal(w.location, 'Jakarta, Indonesia')
  assert.equal(w.url, 'https://apply.workable.com/j/ABC123')
})

test('Filter & skor relevansi deterministik', () => {
  const job = { title: 'Senior Data Analyst', description: 'SQL, Python, Tableau dashboard untuk tim bisnis' }
  assert.ok(matchesKeywords(job, 'data analyst'))
  assert.ok(!matchesKeywords(job, 'frontend developer'))
  assert.ok(matchesLocation('Jakarta Selatan, DKI Jakarta', 'Indonesia'))
  assert.ok(!matchesLocation('Singapore', 'Indonesia'))
  const r = relevanceScore(job, 'data analyst', ['SQL', 'Excel'])
  // kata kunci di judul: 2 token x3 = 6; skill SQL cocok (2), Excel tidak (0) -> 8/10 = 80
  assert.equal(r.score, 80)
  assert.deepEqual(r.matchedSkills, ['sql'])
  assert.equal(htmlToText('<b>a</b>&nbsp;b'), 'a b')
})
