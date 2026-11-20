import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FakeDb } from './helpers/fakeDb.ts'
import {
  descriptionToText,
  enrichJob,
  extractRequirements,
  fetchJobDetail,
  fetchJobDetailResult,
  hasRealRequirements,
  isClosedJobPage,
  parseJsonLdJobPosting,
  parseSeekReduxData,
} from '../services/job-detail.service.ts'

/**
 * Detail lowongan dengan fetch tiruan: fixture HTML yang dipangkas dari bentuk halaman asli (JobStreet:
 * baris `window.SEEK_REDUX_DATA = {...};`, Dealls: JSON-LD JobPosting). Tidak ada jaringan.
 */

const JOBSTREET_CONTENT =
  '<h2>About the Role</h2><p>Kami mencari Data Analyst untuk tim bisnis. Anda akan menyusun laporan mingguan &amp; dashboard.</p>' +
  '<h2>Requirements</h2><ul><li>Minimal S1 Statistik atau Teknik Informatika</li><li>Menguasai SQL dan Python</li><li>Pengalaman minimal 2 tahun sebagai analis data</li></ul>' +
  '<h2>Benefits</h2><ul><li>BPJS Kesehatan</li><li>Bonus tahunan</li></ul>'

const seekHtml = (job: Record<string, any>) =>
  `<!doctype html><html><head><title>Data Analyst</title></head><body><div id="root"></div>\n` +
  `<script>window.SEEK_REDUX_DATA = ${JSON.stringify({ config: { a: '{"not":"json"}' }, jobdetails: { result: { job } } })};</script>\n` +
  `<script>window.other = 1;</script></body></html>`

const SEEK_JOB = {
  content: JOBSTREET_CONTENT,
  salary: { label: 'Rp 9.000.000 – Rp 13.000.000 per month' },
  workTypes: { label: 'Full time' },
  location: { label: 'Jakarta Selatan' },
  classifications: [{ label: 'Information & Communication Technology' }],
  abstract: 'Data Analyst {curly} "quoted" teaser',
}

const DEALLS_DESC =
  '<p>Mengelola administrasi harian kantor.</p><p><strong>Kualifikasi:</strong></p>' +
  '<ul><li>Fresh graduate semua jurusan</li><li>Teliti dan mampu bekerja dalam tim</li></ul><p><strong>Benefit</strong></p><ul><li>Makan siang</li></ul>'

const deallsLd = (over: Record<string, any> = {}) => ({
  '@context': 'https://schema.org',
  '@type': 'JobPosting',
  title: 'Admin Staff',
  description: DEALLS_DESC,
  baseSalary: {
    '@type': 'MonetaryAmount', currency: 'IDR',
    value: { '@type': 'QuantitativeValue', unitText: 'MONTH', minValue: 2_800_000, maxValue: 3_000_000 },
  },
  employmentType: 'FULL_TIME',
  skills: 'Excel, Komunikasi, Excel',
  ...over,
})

const deallsHtml = (ld: any) =>
  `<html><head><script type="application/ld+json" data-next-head="">${JSON.stringify(ld)}</script></head><body><div id="__next"></div></body></html>`

/** fetch tiruan: peta URL -> Response (atau fungsi); mencatat setiap panggilan. */
function fakeFetch(routes: Record<string, () => Response | Promise<Response>>) {
  const calls: Array<{ url: string; init: any }> = []
  const impl = (async (input: any, init: any) => {
    const url = String(input)
    calls.push({ url, init })
    const handler = routes[url]
    if (!handler) return new Response('nope', { status: 404 })
    return handler()
  }) as unknown as typeof fetch
  return { impl, calls }
}

const html = (body: string, status = 200, headers: Record<string, string> = {}) => () => new Response(body, { status, headers })

const JS_URL = 'https://id.jobstreet.com/id/job/92996157'
const DL_URL = 'https://dealls.com/loker/admin-staff~pt-dealls-uji'

// ---- parsing halaman --------------------------------------------------------------------------------------

test('JobStreet: baris SEEK_REDUX_DATA -> deskripsi teks, syarat, gaji', async () => {
  const { impl, calls } = fakeFetch({ [JS_URL]: html(seekHtml(SEEK_JOB)) })
  const d = await fetchJobDetail('jobstreet', JS_URL, impl)
  assert.ok(d)
  assert.equal(calls.length, 1)
  assert.match(calls[0].init.headers['User-Agent'], /Mozilla\/5\.0/)
  assert.equal(calls[0].init.redirect, 'manual')
  assert.match(d.descriptionText, /^About the Role\nKami mencari Data Analyst/)
  assert.match(d.descriptionText, /dashboard\./)
  assert.match(d.descriptionText, /• Menguasai SQL dan Python/)
  assert.equal(d.descriptionHtml, JOBSTREET_CONTENT)
  assert.deepEqual(d.requirements, [
    'Minimal S1 Statistik atau Teknik Informatika',
    'Menguasai SQL dan Python',
    'Pengalaman minimal 2 tahun sebagai analis data',
  ])
  assert.deepEqual(d.salary, { min: 9_000_000, max: 13_000_000, currency: 'IDR', period: 'month' })
  assert.deepEqual(d.skills, [])
})

test('JobStreet: salary string polos, salary null, dan JSON dengan kurung kurawal di dalam string', async () => {
  assert.equal(
    (await fetchJobDetail('jobstreet', JS_URL, fakeFetch({ [JS_URL]: html(seekHtml({ ...SEEK_JOB, salary: 'Rp 5jt - 7jt' })) }).impl))!.salary?.max,
    7_000_000,
  )
  assert.equal((await fetchJobDetail('jobstreet', JS_URL, fakeFetch({ [JS_URL]: html(seekHtml({ ...SEEK_JOB, salary: null })) }).impl))!.salary, null)
  const parsed = parseSeekReduxData(seekHtml(SEEK_JOB))
  assert.equal(parsed.config.a, '{"not":"json"}')
  assert.equal(parseSeekReduxData('<html>tanpa data</html>'), null)
  assert.equal(parseSeekReduxData('window.SEEK_REDUX_DATA = {rusak'), null)
})

test('JobStreet: tanpa SEEK_REDUX_DATA memakai JSON-LD sebagai cadangan; tanpa keduanya -> null', async () => {
  const withLd = deallsHtml(deallsLd())
  const d = await fetchJobDetail('jobstreet', JS_URL, fakeFetch({ [JS_URL]: html(withLd) }).impl)
  assert.ok(d)
  assert.deepEqual(d.requirements, ['Fresh graduate semua jurusan', 'Teliti dan mampu bekerja dalam tim'])
  const r = await fetchJobDetailResult('jobstreet', JS_URL, fakeFetch({ [JS_URL]: html('<html><body>kosong</body></html>') }).impl)
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'not_found')
})

test('Dealls: JSON-LD JobPosting -> deskripsi, syarat, gaji bulanan, skills', async () => {
  const { impl } = fakeFetch({ [DL_URL]: html(deallsHtml(deallsLd())) })
  const d = await fetchJobDetail('dealls', DL_URL, impl)
  assert.ok(d)
  assert.match(d.descriptionText, /^Mengelola administrasi harian kantor\.\nKualifikasi:/)
  assert.deepEqual(d.requirements, ['Fresh graduate semua jurusan', 'Teliti dan mampu bekerja dalam tim'])
  assert.deepEqual(d.salary, { min: 2_800_000, max: 3_000_000, currency: 'IDR', period: 'month' })
  assert.deepEqual(d.skills, ['Excel', 'Komunikasi'])
})

/** Halaman Dealls asli: objek lowongan di __NEXT_DATA__ (dehydratedState), dan objek i18n yang juga punya `requirements`. */
const deallsNextHtml = (node: Record<string, any>, ld?: any) =>
  `<html><head>${ld ? `<script type="application/ld+json" data-next-head="">${JSON.stringify(ld)}</script>` : ''}</head><body>` +
  `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
    props: { pageProps: {
      _nextI18Next: { initialI18nStore: { idn: { jobDetail: { requirements: 'Kualifikasi', benefits: 'Benefit Perusahaan' } } } },
      dehydratedState: { queries: [{ state: { data: { id: 'x1', role: 'Admin Staff', ...node } } }] },
    } },
  })}</script></body></html>`

test('Dealls: __NEXT_DATA__ memisahkan tanggung jawab dan kualifikasi; syarat diambil langsung dari bidang requirements', async () => {
  const page = deallsNextHtml({
    responsibilities: '<ul><li>Mencatat administrasi harian</li><li>Menyiapkan laporan</li></ul>',
    requirements: '<p><br></p><ul><li>Pendidikan minimal S1 semua jurusan</li><li><strong>Teliti</strong> dan bertanggung jawab</li></ul>',
    salaryRange: { start: 3_000_000, end: 4_000_000 }, salaryType: 'paid',
  }, deallsLd())
  const d = await fetchJobDetail('dealls', DL_URL, fakeFetch({ [DL_URL]: html(page) }).impl)
  assert.ok(d)
  assert.equal(
    d.descriptionText,
    'Deskripsi Pekerjaan\n• Mencatat administrasi harian\n• Menyiapkan laporan\nKualifikasi\n• Pendidikan minimal S1 semua jurusan\n• Teliti dan bertanggung jawab',
  )
  assert.deepEqual(d.requirements, ['Pendidikan minimal S1 semua jurusan', 'Teliti dan bertanggung jawab'])
  assert.deepEqual(d.salary, { min: 3_000_000, max: 4_000_000, currency: 'IDR', period: 'month' })
  assert.deepEqual(d.skills, ['Excel', 'Komunikasi'], 'skills dari JSON-LD bila ada')
  // teks yang tersimpan tetap bisa diurai ulang menjadi syarat yang sama
  assert.deepEqual(extractRequirements(d.descriptionText), d.requirements)
})

test('Dealls: __NEXT_DATA__ tanpa syarat, atau syarat kosong, atau salaryRange null -> requirements [] dan gaji dari JSON-LD', async () => {
  const noReq = deallsNextHtml({ responsibilities: '<p>Mengelola administrasi harian kantor.</p>', requirements: '<p><br></p>', salaryRange: null }, deallsLd())
  const d = await fetchJobDetail('dealls', DL_URL, fakeFetch({ [DL_URL]: html(noReq) }).impl)
  assert.ok(d)
  assert.deepEqual(d.requirements, [])
  assert.equal(d.descriptionText, 'Deskripsi Pekerjaan\nMengelola administrasi harian kantor.')
  assert.deepEqual(d.salary, { min: 2_800_000, max: 3_000_000, currency: 'IDR', period: 'month' })

  const bare = deallsNextHtml({ responsibilities: '<p>Admin.</p>', requirements: '<ul><li>Teliti</li></ul>', salaryRange: null })
  assert.equal((await fetchJobDetail('dealls', DL_URL, fakeFetch({ [DL_URL]: html(bare) }).impl))!.salary, null)

  // hanya objek i18n (tanpa `role`) -> bukan lowongan; jatuh ke JSON-LD
  const i18nOnly = `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { jobDetail: { requirements: 'Kualifikasi' } } })}</script>${deallsHtml(deallsLd())}`
  assert.deepEqual((await fetchJobDetail('dealls', DL_URL, fakeFetch({ [DL_URL]: html(i18nOnly) }).impl))!.requirements, ['Fresh graduate semua jurusan', 'Teliti dan mampu bekerja dalam tim'])
})

test('Dealls: @graph, larik, deskripsi HTML ter-escape, baseSalary angka tunggal, @type larik', () => {
  const graph = { '@context': 'https://schema.org', '@graph': [{ '@type': 'WebSite', name: 'x' }, deallsLd()] }
  assert.equal(parseJsonLdJobPosting(deallsHtml(graph))?.title, 'Admin Staff')
  assert.equal(parseJsonLdJobPosting(deallsHtml([{ '@type': 'Organization' }, deallsLd({ '@type': ['Thing', 'JobPosting'] })]))?.title, 'Admin Staff')
  assert.equal(parseJsonLdJobPosting('<html><script type="application/ld+json">{"@type":"Organization"}</script></html>'), null)
  assert.equal(parseJsonLdJobPosting('<script type="application/ld+json">{rusak</script>'), null)

  const escaped = descriptionToText('&lt;p&gt;Tugas&lt;/p&gt;&lt;ul&gt;&lt;li&gt;Satu&lt;/li&gt;&lt;li&gt;Dua &amp;amp; tiga&lt;/li&gt;&lt;/ul&gt;')
  assert.equal(escaped, 'Tugas\n• Satu\n• Dua & tiga')
})

test('Dealls: baseSalary angka tunggal dan unit YEAR/HOUR', async () => {
  const one = deallsLd({ baseSalary: { currency: 'IDR', value: { unitText: 'MONTH', value: 4_500_000 } } })
  assert.deepEqual((await fetchJobDetail('dealls', DL_URL, fakeFetch({ [DL_URL]: html(deallsHtml(one)) }).impl))!.salary, {
    min: 4_500_000, max: 4_500_000, currency: 'IDR', period: 'month',
  })
  const yr = deallsLd({ baseSalary: { currency: 'USD', value: { unitText: 'YEAR', minValue: 60_000, maxValue: 80_000 } } })
  assert.equal((await fetchJobDetail('dealls', DL_URL, fakeFetch({ [DL_URL]: html(deallsHtml(yr)) }).impl))!.salary?.period, 'year')
  const none = deallsLd({ baseSalary: undefined })
  assert.equal((await fetchJobDetail('dealls', DL_URL, fakeFetch({ [DL_URL]: html(deallsHtml(none)) }).impl))!.salary, null)
})

// ---- keamanan fetch ---------------------------------------------------------------------------------------

test('allowlist: host lain, http, port khusus, kredensial, platform lain (Glints) ditolak tanpa fetch', async () => {
  const { impl, calls } = fakeFetch({})
  const bad: Array<[string, string]> = [
    ['jobstreet', 'https://evil.example/id/job/1'],
    ['jobstreet', 'https://id.jobstreet.com.evil.example/id/job/1'],
    ['jobstreet', 'http://id.jobstreet.com/id/job/1'],
    ['jobstreet', 'https://id.jobstreet.com:8443/id/job/1'],
    ['jobstreet', 'https://user:pw@id.jobstreet.com/id/job/1'],
    ['jobstreet', 'https://dealls.com/loker/x'], // host Dealls dengan platform JobStreet
    ['dealls', 'https://id.jobstreet.com/id/job/1'],
    ['glints', 'https://glints.com/id/opportunities/jobs/abc'],
    ['kalibrr', 'https://www.kalibrr.com/c/x/jobs/1/y'],
    ['jobstreet', 'http://169.254.169.254/latest/meta-data'],
    ['jobstreet', 'bukan url'],
    ['', ''],
  ]
  for (const [platform, url] of bad) {
    const r = await fetchJobDetailResult(platform, url, impl)
    assert.equal(r.ok, false, `${platform} ${url}`)
    assert.equal(r.reason, 'unsupported', `${platform} ${url}`)
    assert.equal(await fetchJobDetail(platform, url, impl), null)
  }
  assert.equal(calls.length, 0)
})

test('redirect: host tujuan dicek sebelum diikuti; redirect sah (host sama) diikuti', async () => {
  const evil = fakeFetch({ [JS_URL]: html('', 302, { location: 'https://evil.example/steal' }) })
  const r = await fetchJobDetailResult('jobstreet', JS_URL, evil.impl)
  assert.equal(r.reason, 'unsupported')
  assert.equal(evil.calls.length, 1, 'host asing tidak pernah diminta')

  const internal = fakeFetch({ [JS_URL]: html('', 301, { location: 'http://127.0.0.1:8080/x' }) })
  assert.equal((await fetchJobDetailResult('jobstreet', JS_URL, internal.impl)).reason, 'unsupported')
  assert.equal(internal.calls.length, 1)

  const ok = fakeFetch({
    [JS_URL]: html('', 302, { location: '/id/job/92996157?type=standard' }),
    'https://id.jobstreet.com/id/job/92996157?type=standard': html(seekHtml(SEEK_JOB)),
  })
  assert.ok(await fetchJobDetail('jobstreet', JS_URL, ok.impl))
  assert.equal(ok.calls.length, 2)

  const loop = fakeFetch({ [JS_URL]: html('', 302, { location: JS_URL }) })
  assert.equal((await fetchJobDetailResult('jobstreet', JS_URL, loop.impl)).reason, 'failed')
  assert.equal(loop.calls.length, 4, 'tiga redirect lalu menyerah')
})

test('status HTTP: 404/410 -> gone (lowongan dihapus); 403/500 -> failed; galat jaringan -> failed', async () => {
  const code = async (status: number) =>
    (await fetchJobDetailResult('jobstreet', JS_URL, fakeFetch({ [JS_URL]: html('x', status) }).impl)).reason
  assert.equal(await code(404), 'gone')
  assert.equal(await code(410), 'gone')
  assert.equal(await code(403), 'failed')
  assert.equal(await code(500), 'failed')
  const boom = (async () => {
    throw new TypeError('fetch failed')
  }) as unknown as typeof fetch
  assert.equal((await fetchJobDetailResult('jobstreet', JS_URL, boom)).reason, 'failed')
})

test('batas ukuran: content-length besar atau isi melebihi batas -> gagal; di bawah batas lolos', async () => {
  const big = 'x'.repeat(5000)
  const viaHeader = fakeFetch({ [JS_URL]: html(seekHtml(SEEK_JOB), 200, { 'content-length': '99999999' }) })
  assert.equal((await fetchJobDetailResult('jobstreet', JS_URL, viaHeader.impl)).reason, 'failed')

  const viaBody = fakeFetch({ [JS_URL]: html(big + seekHtml(SEEK_JOB)) })
  assert.equal((await fetchJobDetailResult('jobstreet', JS_URL, viaBody.impl, { maxBytes: 4000 })).reason, 'failed')
  assert.ok(await fetchJobDetail('jobstreet', JS_URL, viaBody.impl, { maxBytes: 1_000_000 }))
})

test('waktu tunggu: fetch yang menggantung dihentikan dan dianggap gagal', async () => {
  const hang = ((_url: any, init: any) =>
    new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(init.signal.reason ?? new Error('aborted')))
    })) as unknown as typeof fetch
  const t0 = Date.now()
  const r = await fetchJobDetailResult('jobstreet', JS_URL, hang, { timeoutMs: 30 })
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'failed')
  assert.ok(Date.now() - t0 < 2000)
})

// ---- extractRequirements ----------------------------------------------------------------------------------

test('extractRequirements: butir di bawah judul Indonesia/Inggris, awalan butir dibuang, berhenti di judul berikutnya', () => {
  const text = [
    'About the role', 'Kami mencari analis data.',
    'Kualifikasi:', '• Minimal S1', '- Menguasai SQL', '1. Mampu bekerja dalam tim', 'a) Domisili Jakarta',
    'Benefits', '• BPJS',
  ].join('\n')
  assert.deepEqual(extractRequirements(text), ['Minimal S1', 'Menguasai SQL', 'Mampu bekerja dalam tim', 'Domisili Jakarta'])

  for (const heading of ['Persyaratan', 'Syarat Umum', 'Requirements', 'Job Requirements', 'Minimum Qualifications', 'What you need', 'Skills & Qualifications', 'Skills:', 'Kualifikasi Pelamar']) {
    assert.deepEqual(extractRequirements(`${heading}\n• Satu\n• Dua`), ['Satu', 'Dua'], heading)
  }
})

test('extractRequirements: tanpa judul syarat -> kosong; judul lain berhenti; sub-judul dilewati; batas 15 butir dan 200 karakter', () => {
  assert.deepEqual(extractRequirements('Kami mencari analis data.\n• Menguasai SQL\n• Excel'), [])
  assert.deepEqual(extractRequirements(''), [])
  assert.deepEqual(extractRequirements(null), [])
  // butir yang kebetulan memuat kata "skills" bukan judul
  assert.deepEqual(extractRequirements('Responsibilities\n• Strong SQL skills\n• Skills in Python and R'), [])
  // sub-judul berakhiran titik dua tidak jadi butir; bagian berhenti di "Responsibilities"
  assert.deepEqual(
    extractRequirements('Requirements\nPengalaman:\n• 2 tahun\nPendidikan:\n• S1\nResponsibilities\n• Laporan'),
    ['2 tahun', 'S1'],
  )
  // paragraf tanpa penanda butir tetap diambil sampai judul berikutnya
  assert.deepEqual(extractRequirements('Kualifikasi\nMinimal lulusan S1 Akuntansi dengan IPK 3.0.\nMenguasai Excel tingkat lanjut.\nTentang kami\nPT Uji'), [
    'Minimal lulusan S1 Akuntansi dengan IPK 3.0.',
    'Menguasai Excel tingkat lanjut.',
  ])
  const many = `Requirements\n${Array.from({ length: 30 }, (_, i) => `• Butir ${i + 1}`).join('\n')}`
  assert.equal(extractRequirements(many).length, 15)
  const long = extractRequirements(`Requirements\n• ${'a'.repeat(500)}`)
  assert.equal(long[0].length, 200)
})

test('extractRequirements: butir pendek tanpa awalan setelah butir berawalan dianggap judul berikutnya', () => {
  assert.deepEqual(extractRequirements('Requirements\n• Satu\n• Dua\nHow we work\n• Remote'), ['Satu', 'Dua'])
})

test('hasRealRequirements: daftar tag (skill pendek) belum dianggap syarat', () => {
  assert.equal(hasRealRequirements([]), false)
  assert.equal(hasRealRequirements(['IT', 'Excel', 'Public Speaking']), false)
  assert.equal(hasRealRequirements(['IT', 'Minimal S1 Statistik atau Teknik Informatika']), true)
})

// ---- enrichJob --------------------------------------------------------------------------------------------

const NOW = new Date('2026-11-20T08:00:00.000Z')
const job = (over: Record<string, any> = {}) => ({
  id: 'j1', title: 'Data Analyst', company: 'PT Uji', location: 'Jakarta', type: 'full-time', status: 'active',
  platform_source: 'jobstreet', external_url: JS_URL, description: 'Maintain facility\nBPJS', requirements: [],
  salary_min: null, salary_max: null, salary_currency: null, salary_period: null, ...over,
})
const seekFetch = () => fakeFetch({ [JS_URL]: html(seekHtml(SEEK_JOB)) })

test('enrichJob: melengkapi deskripsi, syarat, dan gaji yang kosong; updated_at diisi; job utuh dikembalikan', async () => {
  const db = new FakeDb({ jobs: [job()] })
  const { impl } = seekFetch()
  const r = await enrichJob(db as any, 'j1', { fetchImpl: impl, now: () => NOW })
  assert.equal(r.status, 'ok')
  assert.equal(r.enriched, true)
  assert.equal(r.reason, 'detail lowongan diperbarui')
  assert.equal(r.job!.id, 'j1')
  assert.equal(r.job!.title, 'Data Analyst')
  assert.match(r.job!.description, /Kami mencari Data Analyst/)
  assert.equal(r.job!.requirements.length, 3)
  assert.equal(r.job!.salary_min, 9_000_000)
  assert.equal(r.job!.salary_max, 13_000_000)
  assert.equal(r.job!.salary_currency, 'IDR')
  assert.equal(r.job!.salary_period, 'month')
  assert.equal(r.job!.updated_at, NOW.toISOString())
  const stored = db.rows('jobs')[0]
  assert.equal(stored.salary_min, 9_000_000)
  assert.equal(db.writes.filter((w) => w.op === 'update').length, 1)
})

test('enrichJob: gaji yang sudah ada tidak ditimpa; deskripsi lebih panjang tidak diganti yang lebih pendek', async () => {
  const longDesc = 'Deskripsi panjang tulis tangan. '.repeat(40) // > isi halaman, tetapi syarat masih kosong -> tetap diambil
  const db = new FakeDb({ jobs: [job({ description: longDesc, salary_min: 7_000_000, salary_max: 8_000_000, salary_currency: 'IDR', salary_period: 'month' })] })
  const r = await enrichJob(db as any, 'j1', { fetchImpl: seekFetch().impl, now: () => NOW })
  assert.equal(r.enriched, true)
  const stored = db.rows('jobs')[0]
  assert.equal(stored.description, longDesc, 'deskripsi lebih panjang dipertahankan')
  assert.equal(stored.salary_min, 7_000_000, 'gaji lama dipertahankan')
  assert.equal(stored.salary_max, 8_000_000)
  assert.equal(stored.requirements.length, 3)
  assert.deepEqual(Object.keys(db.writes.find((w) => w.op === 'update')!.payload).sort(), ['requirements', 'updated_at'])
})

test('enrichJob: sudah lengkap (deskripsi >= 600 dan syarat ada) -> satu fetch untuk cek tutup, tanpa tulis', async () => {
  const row = job({
    description: 'x'.repeat(650),
    requirements: ['Minimal S1 Statistik atau Teknik Informatika', 'Menguasai SQL dan Python'],
  })
  const db = new FakeDb({ jobs: [row] })
  const { impl, calls } = seekFetch()
  const r = await enrichJob(db as any, 'j1', { fetchImpl: impl })
  assert.deepEqual({ enriched: r.enriched, reason: r.reason, status: r.status }, { enriched: false, reason: 'sudah lengkap', status: 'ok' })
  assert.equal(r.job!.description.length, 650)
  assert.equal(calls.length, 1)
  assert.equal(db.writes.length, 0)

  // Situs yang tidak didukung: tetap "sudah lengkap", tanpa fetch.
  const glints = new FakeDb({ jobs: [{ ...row, platform_source: 'glints', external_url: 'https://glints.com/id/opportunities/jobs/abc' }] })
  const g = seekFetch()
  assert.equal((await enrichJob(glints as any, 'j1', { fetchImpl: g.impl })).reason, 'sudah lengkap')
  assert.equal(g.calls.length, 0)
})

test('isClosedJobPage: hanya tanda tutup yang jelas dari JobStreet dan Dealls', () => {
  assert.equal(isClosedJobPage('jobstreet', seekHtml({ ...SEEK_JOB, isExpired: true, status: 'Expired' })), true)
  assert.equal(isClosedJobPage('jobstreet', seekHtml({ ...SEEK_JOB, status: 'Expired' })), true)
  assert.equal(isClosedJobPage('jobstreet', seekHtml({ ...SEEK_JOB, isExpired: false, status: 'Active' })), false)
  assert.equal(isClosedJobPage('jobstreet', seekHtml(SEEK_JOB)), false)
  assert.equal(isClosedJobPage('jobstreet', '<html>kosong</html>'), false)
  const dl = (node: Record<string, any>) => deallsNextHtml({ requirements: '<ul><li>Teliti</li></ul>', ...node })
  assert.equal(isClosedJobPage('dealls', dl({ closed: true, status: 'active' })), true)
  assert.equal(isClosedJobPage('dealls', dl({ closed: false, status: 'closed' })), true)
  assert.equal(isClosedJobPage('dealls', dl({ closed: false, status: 'active' })), false)
  assert.equal(isClosedJobPage('dealls', dl({})), false)
  assert.equal(isClosedJobPage('glints', seekHtml({ ...SEEK_JOB, isExpired: true })), false)
})

test('enrichJob: lowongan ditutup di situs asal (404 atau halaman Expired) -> status closed, hanya kolom status dan updated_at', async () => {
  const cases: Array<[string, Record<string, any>, typeof fetch]> = [
    ['404', job(), fakeFetch({ [JS_URL]: html('', 404) }).impl],
    ['JobStreet Expired', job(), fakeFetch({ [JS_URL]: html(seekHtml({ ...SEEK_JOB, isExpired: true, status: 'Expired' })) }).impl],
    ['lengkap tapi Expired', job({ description: 'x'.repeat(650), requirements: ['Minimal S1 Statistik atau Teknik Informatika', 'Menguasai SQL dan Python'] }),
      fakeFetch({ [JS_URL]: html(seekHtml({ ...SEEK_JOB, isExpired: true })) }).impl],
    ['Dealls closed', job({ platform_source: 'dealls', external_url: DL_URL }),
      fakeFetch({ [DL_URL]: html(deallsNextHtml({ requirements: '<ul><li>Teliti</li></ul>', closed: true, status: 'closed' })) }).impl],
  ]
  for (const [name, row, f] of cases) {
    const db = new FakeDb({ jobs: [row] })
    const r = await enrichJob(db as any, 'j1', { fetchImpl: f, now: () => NOW })
    assert.deepEqual({ status: r.status, enriched: r.enriched, reason: r.reason }, { status: 'ok', enriched: false, reason: 'lowongan sudah ditutup di situs asal' }, name)
    assert.equal(r.job!.status, 'closed', name)
    assert.equal(db.rows('jobs')[0].status, 'closed', name)
    const updates = db.writes.filter((w) => w.op === 'update')
    assert.equal(updates.length, 1, name)
    assert.deepEqual(updates[0].payload, { status: 'closed', updated_at: NOW.toISOString() }, name)
  }
})

test('enrichJob: baris yang sudah closed -> tanpa fetch, tanpa tulis', async () => {
  const db = new FakeDb({ jobs: [job({ status: 'closed' })] })
  const { impl, calls } = seekFetch()
  const r = await enrichJob(db as any, 'j1', { fetchImpl: impl })
  assert.equal(r.reason, 'lowongan sudah ditutup di situs asal')
  assert.equal(r.job!.status, 'closed')
  assert.equal(calls.length, 0)
  assert.equal(db.writes.length, 0)
})

test('enrichJob: daftar tag (skill Dealls) diganti butir syarat dari halaman; tag dipakai bila halaman tak punya judul syarat', async () => {
  const db = new FakeDb({ jobs: [job({ id: 'j2', platform_source: 'dealls', external_url: DL_URL, requirements: ['IT', 'Excel'] })] })
  const r = await enrichJob(db as any, 'j2', { fetchImpl: fakeFetch({ [DL_URL]: html(deallsHtml(deallsLd())) }).impl, now: () => NOW })
  assert.equal(r.enriched, true)
  assert.deepEqual(r.job!.requirements, ['Fresh graduate semua jurusan', 'Teliti dan mampu bekerja dalam tim'])
  assert.equal(r.job!.salary_min, 2_800_000)

  const noHeading = deallsLd({ description: '<p>Mengelola administrasi harian kantor dengan teliti dan rapi setiap hari.</p>' })
  const db2 = new FakeDb({ jobs: [job({ id: 'j3', platform_source: 'dealls', external_url: DL_URL, description: 'Admin Staff — PT Uji' })] })
  const r2 = await enrichJob(db2 as any, 'j3', { fetchImpl: fakeFetch({ [DL_URL]: html(deallsHtml(deallsLd(noHeading))) }).impl, now: () => NOW })
  assert.deepEqual(r2.job!.requirements, ['Excel', 'Komunikasi'], 'skills menjadi syarat hanya bila syarat masih kosong')
})

test('enrichJob: tidak ada yang lebih baik -> enriched false, tanpa tulis', async () => {
  const db = new FakeDb({ jobs: [job()] })
  const { impl } = seekFetch()
  await enrichJob(db as any, 'j1', { fetchImpl: impl, now: () => NOW })
  const writes = db.writes.length
  const again = await enrichJob(db as any, 'j1', { fetchImpl: impl, now: () => NOW })
  assert.equal(again.enriched, false)
  assert.equal(again.reason, 'tidak ada data baru')
  assert.equal(db.writes.length, writes)
})

test('enrichJob: alasan kegagalan berbahasa Indonesia; tidak pernah melempar', async () => {
  const run = async (row: Record<string, any>, f: typeof fetch) =>
    enrichJob(new FakeDb({ jobs: [row] }) as any, row.id, { fetchImpl: f })

  const glints = await run(job({ platform_source: 'glints', external_url: 'https://glints.com/id/opportunities/jobs/abc' }), seekFetch().impl)
  assert.equal(glints.reason, 'situs tidak didukung')
  assert.equal(glints.enriched, false)
  assert.equal(glints.status, 'ok')

  const noUrl = await run(job({ external_url: null }), seekFetch().impl)
  assert.equal(noUrl.reason, 'situs tidak didukung')

  const gone = await run(job(), fakeFetch({ [JS_URL]: html('', 404) }).impl)
  assert.equal(gone.reason, 'lowongan sudah ditutup di situs asal')

  const empty = await run(job(), fakeFetch({ [JS_URL]: html('<html>kosong</html>') }).impl)
  assert.equal(empty.reason, 'detail tidak ditemukan')

  const down = await run(job(), fakeFetch({ [JS_URL]: html('x', 503) }).impl)
  assert.equal(down.reason, 'gagal mengambil detail')

  const boom = await run(job(), (async () => {
    throw new Error('ECONNRESET')
  }) as unknown as typeof fetch)
  assert.equal(boom.reason, 'gagal mengambil detail')
  assert.equal(boom.enriched, false)
  assert.equal(boom.job!.id, 'j1', 'baris tetap dikembalikan')
})

test('enrichJob: lowongan tidak ada -> not_found; galat DB -> error; gagal simpan -> enriched false', async () => {
  const miss = await enrichJob(new FakeDb({ jobs: [] }) as any, 'nope', { fetchImpl: seekFetch().impl })
  assert.deepEqual({ status: miss.status, job: miss.job, enriched: miss.enriched }, { status: 'not_found', job: null, enriched: false })

  const broken = new FakeDb({ jobs: [job()] })
  broken.failOn('jobs', 'select')
  const err = await enrichJob(broken as any, 'j1', { fetchImpl: seekFetch().impl })
  assert.equal(err.status, 'error')
  assert.equal(err.job, null)

  const noSave = new FakeDb({ jobs: [job()] })
  noSave.failOn('jobs', 'update')
  const saved = await enrichJob(noSave as any, 'j1', { fetchImpl: seekFetch().impl })
  assert.equal(saved.status, 'ok')
  assert.equal(saved.enriched, false)
  assert.equal(saved.reason, 'gagal menyimpan detail')
  assert.equal(noSave.rows('jobs')[0].salary_min, null)
})
