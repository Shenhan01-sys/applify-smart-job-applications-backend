import { test } from 'node:test'
import assert from 'node:assert/strict'
import { NOW } from './helpers/linkedinFixture.ts'
import { EDUCATION_DROP_REASONS, EXPERIENCE_DROP_REASONS, emptyDropReasons, mergeDropReasons, normalizeExtraction } from '../services/linkedin-import.ts'
import { LinkedInImportService } from '../services/linkedin-import.service.ts'

/**
 * Rincian alasan item terbuang saat validasi (kode dan hitungan saja, tanpa isi PDF), dicatat di log `import_done`
 * supaya impor yang kehilangan item bisa didiagnosis dari produksi. Jumlah semua alasan harus sama dengan
 * `dropped`. Semua teks SINTETIS. Tanpa jaringan. NOW = 2026-11-20.
 */

const SRC = [
  'Rina Contoh', 'Bandung',
  'EXPERIENCE', 'Backend Engineer | Contoh Labs | Mar 2016 - Present',
  'EDUCATION', 'Universitas Contoh Nusantara | S1 Sistem Informasi | 2019 - 2023',
].join('\n')
const norm = (raw: unknown) => normalizeExtraction(raw, { sourceText: SRC, now: NOW })
const sum = (r: Record<string, number>) => Object.values(r).reduce((a, b) => a + b, 0)

test('emptyDropReasons: semua kode ada dengan nilai 0, bentuk stabil untuk log', () => {
  const z = emptyDropReasons()
  assert.deepEqual(Object.keys(z.experiences), [...EXPERIENCE_DROP_REASONS])
  assert.deepEqual(Object.keys(z.education), [...EDUCATION_DROP_REASONS])
  assert.equal(sum(z.experiences) + sum(z.education) + sum(z.adjusted), 0)
})

test('pengalaman: tiap penyebab terbuang punya kode sendiri dan jumlahnya sama dengan dropped.experiences', () => {
  const ok = { company: 'Contoh Labs', title: 'Backend Engineer', date_range: 'Mar 2016 - Present' }
  const n = norm({
    experiences: [
      'bukan objek',
      { ...ok, company: '' },
      { ...ok, title: '' },
      { ...ok, company: 'C'.repeat(130) },
      { ...ok, company: 'Perusahaan Karangan' },
      { ...ok, title: 'Chief Imagination Officer' },
      { ...ok, date_range: 'tidak ada tanggal' },
      { ...ok, date_range: 'Jan 2027 - Present' },
      { ...ok, date_range: 'Jan 2026 - Dec 2027' },
      { ...ok, date_range: 'Dec 2025 - Aug 2025' },
      ok,
      ok, // duplikat persis
    ],
  })
  assert.equal(n.experiences.length, 1)
  assert.deepEqual(n.dropReasons.experiences, {
    not_object: 1, no_company: 1, no_title: 1, too_long: 1, not_grounded_company: 1, not_grounded_title: 1,
    date_unreadable: 1, date_start_future: 1, date_end_future: 1, date_end_before_start: 1, duplicate: 1, over_limit: 0,
  })
  assert.equal(sum(n.dropReasons.experiences), n.dropped.experiences)
})

test('pendidikan: tiap penyebab terbuang punya kode sendiri dan jumlahnya sama dengan dropped.education', () => {
  const ok = { school: 'Universitas Contoh Nusantara', degree: 'S1', field: 'Sistem Informasi', years: '2019 - 2023' }
  const n = norm({
    education: [
      'bukan objek',
      { ...ok, school: '' },
      { ...ok, school: 'U'.repeat(130) },
      { ...ok, school: 'Universitas Karangan Abadi' },
      { ...ok, degree: '', field: '' },
      { ...ok, years: null },
      { ...ok, years: '2030' }, // satu tahun di masa depan
      { ...ok, years: '2019 -' }, // rentang menggantung
      { ...ok, years: '2023 - 2019' },
      { ...ok, years: '2019 - 2090' },
      ok,
      ok, // duplikat persis
    ],
  })
  assert.equal(n.education.length, 1)
  assert.deepEqual(n.dropReasons.education, {
    not_object: 1, no_school: 1, school_too_long: 1, not_grounded_school: 1, no_degree: 1, degree_too_long: 0, no_years: 1,
    start_year_invalid: 1, single_year_unclear: 1, end_year_invalid: 2, duplicate: 1, over_limit: 0,
  })
  assert.equal(sum(n.dropReasons.education), n.dropped.education)
})

test('pendidikan: nilai yang diperbaiki tanpa membuang item dihitung terpisah (adjusted)', () => {
  const n = norm({
    education: [
      { school: 'Universitas Contoh Nusantara', degree: 'Master of Fiction', field: 'Sistem Informasi', years: '2019 - 2023' }, // gelar tidak ada di PDF
      { school: 'Universitas Contoh Nusantara', degree: 'S1', field: 'Bidang Karangan', years: '2018 - 2022' }, // bidang tidak ada di PDF
      { school: 'Universitas Contoh Nusantara', degree: '', field: 'Sistem Informasi', years: '2017 - 2021' }, // bidang naik jadi gelar
    ],
  })
  assert.equal(n.education.length, 3)
  assert.equal(n.dropped.education, 0)
  assert.deepEqual(n.dropReasons.adjusted, { degree_not_grounded: 1, field_not_grounded: 1, degree_from_field: 2 })
})

test('melebihi batas jumlah dihitung sebagai over_limit', () => {
  const experiences = Array.from({ length: 35 }, (_, i) => ({ company: 'Contoh Labs', title: 'Backend Engineer', date_range: `Jan ${1990 + i} - Dec ${1990 + i}` }))
  const n = norm({ experiences })
  assert.equal(n.experiences.length, 30)
  assert.equal(n.dropReasons.experiences.over_limit, 5)
  assert.equal(sum(n.dropReasons.experiences), n.dropped.experiences)
})

test('mergeDropReasons menjumlahkan tiap kode', () => {
  const a = emptyDropReasons()
  const b = emptyDropReasons()
  a.education.no_years = 2
  b.education.no_years = 1
  b.education.no_degree = 4
  b.adjusted.degree_from_field = 3
  const m = mergeDropReasons(a, b)
  assert.deepEqual([m.education.no_years, m.education.no_degree, m.adjusted.degree_from_field, m.experiences.duplicate], [3, 4, 3, 0])
})

test('log import_done memuat dropReasons: hanya kode dan angka, tanpa isi PDF', async () => {
  const lines: string[] = []
  const svc = new LinkedInImportService({
    now: () => NOW,
    log: (l) => lines.push(l),
    extractPages: async () => [SRC],
    llm: async () => ({
      text: JSON.stringify({
        full_name: 'Rina Contoh',
        experiences: [
          { company: 'Contoh Labs', title: 'Backend Engineer', date_range: 'Mar 2016 - Present' },
          { company: 'Perusahaan Karangan', title: 'Backend Engineer', date_range: 'Mar 2016 - Present' },
        ],
        education: [{ school: 'Universitas Contoh Nusantara', degree: 'S1', field: 'Sistem Informasi', years: '2019 -' }],
      }),
      model: 'tiruan',
    }),
  })
  await svc.importFromPdf(Buffer.from('%PDF-1.4 tiruan'))
  const done = lines.map((l) => JSON.parse(l.replace('[linkedin-import] ', ''))).find((e) => e.event === 'import_done')
  assert.ok(done, 'ada baris import_done')
  assert.equal(done.dropReasons.experiences.not_grounded_company, 1)
  assert.equal(done.dropReasons.education.single_year_unclear, 1)
  // hanya kode dikenal dan angka; tidak ada teks bebas dari PDF
  for (const group of ['experiences', 'education', 'adjusted'] as const) {
    for (const [k, v] of Object.entries(done.dropReasons[group])) {
      assert.match(k, /^[a-z_]+$/)
      assert.equal(typeof v, 'number')
    }
  }
  const raw = lines.join('\n')
  assert.doesNotMatch(raw, /Rina Contoh|Contoh Labs|Universitas Contoh/)
})
