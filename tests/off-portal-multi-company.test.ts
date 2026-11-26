import test from 'node:test'
import assert from 'node:assert/strict'
import {
  MAX_OFF_PORTAL_CANDIDATES,
  parseOffPortalPosting,
  parseOffPortalPostingWithAi,
  type OffPortalParseResult,
} from '../services/off-portal-ingest.service.js'
import { savePrivateOffPortalJobs } from '../services/off-portal-save.service.js'
import { splitCompanyBlocks } from '../services/off-portal-extract.js'

const NOW = new Date('2026-11-27T12:00:00Z')

/**
 * Temuan E2E production 27 Nov 2026: utas X "23 CRYPTO CARD PROJECTS" hanya menghasilkan 8 kandidat, semuanya atas nama
 * wirexapp, dan judul KASTxyz serta RedotPay ikut tertempel ke wirexapp. Tiga baris pertama mengikuti laporan (akun, daftar
 * posisi, lokasi, dan tautan tanpa skema). Isi `roles` RedotPay dan baris 4 sampai 5 hanya contoh bentuk, bukan data nyata.
 */
const THREAD_LINES = [
  '1. @wirexapp - roles: Product, Engineering, Compliance, Commercial, Operations - location: Remote / Global - apply: wirexapp.com/company/career',
  '2. @KASTxyz - roles: Product, Engineering, Legal, Sales - location: Global / Remote / US / Europe - apply: kast.xyz/en/careers',
  '3. @RedotPay - roles: Card Product Manager, Backend Engineer, Compliance Analyst - location: Hong Kong / Remote - apply: redotpay.com/careers',
  '4. Kraken / @Krak - roles: Security Engineer - location: Remote / Global - apply: https://jobs.lever.co/kraken/1',
  '5. Bitpanda - roles: Senior Backend Engineer - location: Europe / Remote - apply: bitpanda.com/careers',
]
const THREAD_HEADER = '23 CRYPTO CARD PROJECTS. 100+ JOB OPPORTUNITIES.'
const THREAD = [THREAD_HEADER, ...THREAD_LINES].join('\n')

const EXPECTED: Array<[company: string, title: string, location: string, applyUrl: string]> = [
  ['wirexapp', 'Product', 'Remote / Global', 'https://wirexapp.com/company/career'],
  ['wirexapp', 'Engineering', 'Remote / Global', 'https://wirexapp.com/company/career'],
  ['wirexapp', 'Compliance', 'Remote / Global', 'https://wirexapp.com/company/career'],
  ['wirexapp', 'Commercial', 'Remote / Global', 'https://wirexapp.com/company/career'],
  ['wirexapp', 'Operations', 'Remote / Global', 'https://wirexapp.com/company/career'],
  ['KASTxyz', 'Product', 'Global / Remote / US / Europe', 'https://kast.xyz/en/careers'],
  ['KASTxyz', 'Engineering', 'Global / Remote / US / Europe', 'https://kast.xyz/en/careers'],
  ['KASTxyz', 'Legal', 'Global / Remote / US / Europe', 'https://kast.xyz/en/careers'],
  ['KASTxyz', 'Sales', 'Global / Remote / US / Europe', 'https://kast.xyz/en/careers'],
  ['RedotPay', 'Card Product Manager', 'Hong Kong / Remote', 'https://redotpay.com/careers'],
  ['RedotPay', 'Backend Engineer', 'Hong Kong / Remote', 'https://redotpay.com/careers'],
  ['RedotPay', 'Compliance Analyst', 'Hong Kong / Remote', 'https://redotpay.com/careers'],
  ['Kraken', 'Security Engineer', 'Remote / Global', 'https://jobs.lever.co/kraken/1'],
  ['Bitpanda', 'Senior Backend Engineer', 'Europe / Remote', 'https://bitpanda.com/careers'],
]

const rows = (res: OffPortalParseResult) => res.jobs.map((j) => [j.company, j.title, j.location, j.applyUrl])

function parse(rawText: string): OffPortalParseResult {
  return parseOffPortalPosting({ rawText, sourceType: 'off_portal_caption' }, NOW)
}

test('multi-perusahaan: tiap butir bernomor menjadi kelompok sendiri dengan perusahaan, posisi, lokasi, dan tautannya sendiri', () => {
  const res = parse(THREAD)
  assert.deepEqual(rows(res), EXPECTED)
  assert.equal(res.needsCaption, false)
  assert.deepEqual(res.warnings, [])
  for (const job of res.jobs) {
    assert.deepEqual(job.unreadFields, [], `${job.company} ${job.title}`)
    assert.equal(job.extraction, 'rules')
    assert.doesNotMatch(job.company, /@/)
    assert.equal(job.sourceGroupId, res.sourceGroupId)
  }
  assert.equal(new Set(res.jobs.map((j) => j.publicationFingerprint)).size, EXPECTED.length)
})

test('multi-perusahaan: baris pembuka utas bukan perusahaan, posisi, atau bagian blok mana pun', () => {
  const res = parse(THREAD)
  assert.equal(res.jobs.some((j) => /CRYPTO|OPPORTUNIT/i.test(`${j.company} ${j.title}`)), false)
  for (const job of res.jobs) assert.doesNotMatch(job.description, /CRYPTO CARD PROJECTS/)
})

test('multi-perusahaan: deskripsi tiap kandidat hanya teks blok perusahaannya, tidak membawa perusahaan lain', () => {
  const res = parse(THREAD)
  for (const job of res.jobs) {
    const others = EXPECTED.map((e) => e[0]).filter((c) => c !== job.company)
    for (const other of others) assert.doesNotMatch(job.description, new RegExp(other, 'i'), `${job.company} memuat ${other}`)
    assert.match(job.description, new RegExp(job.company, 'i'))
  }
})

test('multi-perusahaan: tautan tanpa skema (kast.xyz/en/careers) dikenali sebagai situs karier dan kanal web, bukan hilang', () => {
  const res = parse(THREAD)
  const kast = res.jobs.filter((j) => j.company === 'KASTxyz')
  assert.equal(kast.length, 4)
  for (const job of kast) {
    assert.equal(job.applyUrl, 'https://kast.xyz/en/careers')
    assert.equal(job.channel.applyUrl, 'https://kast.xyz/en/careers')
    assert.notEqual(job.channel.channel, 'email_direct')
  }
  assert.ok(res.acceptedUrls.includes('https://kast.xyz/en/careers'))
  assert.ok(res.acceptedUrls.includes('https://wirexapp.com/company/career'))
})

test('multi-perusahaan: baris KASTxyz yang ditempel sendirian terbaca sama dengan di dalam utas', () => {
  const alone = parse(THREAD_LINES[1])
  assert.deepEqual(rows(alone), EXPECTED.filter((e) => e[0] === 'KASTxyz'))
  const inThread = parse(THREAD).jobs.filter((j) => j.company === 'KASTxyz')
  assert.deepEqual(alone.jobs.map((j) => [j.company, j.title, j.location, j.applyUrl]), inThread.map((j) => [j.company, j.title, j.location, j.applyUrl]))
})

test('multi-perusahaan: butir berbaris-baris ("kunci:" di baris berikutnya) dan baris kosong antarbutir terbaca sama', () => {
  const multiline = [
    THREAD_HEADER,
    '',
    '1. @wirexapp',
    'roles: Product, Engineering, Compliance, Commercial, Operations',
    'location: Remote / Global',
    'apply: wirexapp.com/company/career',
    '',
    '2. @KASTxyz',
    'roles: Product, Engineering, Legal, Sales',
    'location: Global / Remote / US / Europe',
    'apply: kast.xyz/en/careers',
    '',
    '3. @RedotPay',
    'roles: Card Product Manager, Backend Engineer, Compliance Analyst',
    'location: Hong Kong / Remote',
    'apply: redotpay.com/careers',
    '',
    'Ikuti akun ini untuk utas berikutnya.',
  ].join('\n')
  assert.deepEqual(rows(parse(multiline)), EXPECTED.slice(0, 12))
})

test('multi-perusahaan: tempelan satu baris tanpa Enter dipecah per "N. @akun" dan hasilnya sama', () => {
  assert.deepEqual(rows(parse(THREAD_LINES.slice(0, 3).join(' '))), EXPECTED.slice(0, 12))
  assert.deepEqual(rows(parse(`${THREAD_HEADER} ${THREAD_LINES.slice(0, 3).join(' ')}`)), EXPECTED.slice(0, 12))
})

test('multi-perusahaan: "N. Perusahaan" tanpa akun juga satu kelompok, dengan nama pada baris butir sebagai perusahaannya', () => {
  const res = parse(['1. Studio Kreasi - roles: Admin Operasional, Social Media Specialist - location: Sleman', '2. Kopi Ruang Kerja - roles: Barista - location: Bantul'].join('\n'))
  assert.deepEqual(
    res.jobs.map((j) => [j.company, j.title, j.location]),
    [
      ['Studio Kreasi', 'Admin Operasional', 'Sleman'],
      ['Studio Kreasi', 'Social Media Specialist', 'Sleman'],
      ['Kopi Ruang Kerja', 'Barista', 'Bantul'],
    ],
  )
})

test('multi-perusahaan: blok tanpa tautan atau email tidak meminjam milik blok lain, dan lokasi hilang ditandai belum terbaca', () => {
  const res = parse(
    [
      '1. @alpha - roles: Backend Engineer - location: Jakarta - apply: alpha.example.org/careers',
      '2. @beta - roles: Data Analyst',
      '3. @gamma - roles: Designer - location: Remote - apply: hr@gamma-studio.co.id',
    ].join('\n'),
  )
  const [a, b, g] = res.jobs
  assert.equal(a.applyUrl, 'https://alpha.example.org/careers')
  assert.equal(b.company, 'beta')
  assert.equal(b.applyUrl, null)
  assert.equal(b.applyEmail, null)
  assert.deepEqual(b.unreadFields, ['location'])
  assert.equal(g.applyUrl, null)
  assert.equal(g.applyEmail, 'hr@gamma-studio.co.id')
  assert.equal(g.channel.channel, 'email_direct')
  assert.equal(a.applyEmail, null)
})

test('multi-perusahaan: tautan LinkedIn satu blok memberi peringatan manual hanya pada kandidat blok itu', () => {
  const res = parse(
    ['1. @alpha - roles: Backend Engineer - apply: https://www.linkedin.com/jobs/view/123456', '2. @beta - roles: Data Analyst - apply: beta.id/karir'].join('\n'),
  )
  assert.equal(res.jobs[0].warnings.length, 1)
  assert.match(res.jobs[0].warnings[0], /LinkedIn/)
  assert.deepEqual(res.jobs[1].warnings, [])
  assert.equal(res.jobs[1].applyUrl, 'https://beta.id/karir')
})

test('multi-perusahaan: lebih dari 50 kandidat dipotong jujur, peringatan memuat jumlah asli, dan tidak ada kandidat salah perusahaan', () => {
  const companies = 23
  const perCompany = 4
  const text = [
    '23 CRYPTO CARD PROJECTS. 100+ JOB OPPORTUNITIES.',
    ...Array.from({ length: companies }, (_, c) => {
      const roles = Array.from({ length: perCompany }, (_, r) => `Role${c + 1}x${r + 1} Engineer`).join(', ')
      return `${c + 1}. @company${c + 1} - roles: ${roles} - location: City${c + 1} - apply: company${c + 1}.com/careers`
    }),
  ].join('\n')
  const res = parse(text)
  const total = companies * perCompany
  assert.equal(total > MAX_OFF_PORTAL_CANDIDATES, true)
  assert.equal(res.jobs.length, MAX_OFF_PORTAL_CANDIDATES)
  // Setiap kandidat yang tampil milik perusahaan yang namanya tertulis di judulnya.
  for (const job of res.jobs) {
    const m = /^Role(\d+)x(\d+) Engineer$/.exec(job.title)
    assert.ok(m, job.title)
    const n = Number(m![1])
    assert.equal(job.company, `company${n}`, job.title)
    assert.equal(job.location, `City${n}`, job.title)
    assert.equal(job.applyUrl, `https://company${n}.com/careers`, job.title)
  }
  // 50 kandidat = 12 perusahaan penuh + 2 posisi perusahaan ke-13.
  const warning = res.warnings.find((w) => /memuat/.test(w))
  assert.ok(warning, res.warnings.join(' | '))
  assert.match(warning!, new RegExp(`${total} lowongan dari ${companies} perusahaan`))
  assert.match(warning!, new RegExp(`${MAX_OFF_PORTAL_CANDIDATES} pertama`))
  assert.match(warning!, /sampai perusahaan ke-13/)
  assert.match(warning!, /tempel sisanya/i)
})

test('multi-perusahaan: tepat 50 kandidat tidak memberi peringatan pemotongan', () => {
  const text = Array.from({ length: 10 }, (_, c) => `${c + 1}. @firm${c + 1} - roles: A${c + 1}1 Engineer, A${c + 1}2 Engineer, A${c + 1}3 Engineer, A${c + 1}4 Engineer, A${c + 1}5 Engineer`).join('\n')
  const res = parse(text)
  assert.equal(res.jobs.length, 50)
  assert.equal(res.warnings.some((w) => /memuat/.test(w)), false)
})

test('daftar posisi bernomor biasa dan butir kualifikasi bernomor bukan tempelan multi-perusahaan', () => {
  assert.equal(splitCompanyBlocks('Posisi:\n1. Backend Engineer\n2. Data Analyst\nLokasi: Jakarta\nApply: https://acme.id/jobs'), null)
  assert.equal(splitCompanyBlocks('PT Maju membuka lowongan:\n1. Admin\nLokasi: Solo\n2. Kasir\nLokasi: Solo'), null)
  const res = parse('PT Maju Jaya membuka lowongan:\n1. Backend Engineer\n2. Data Analyst\nLokasi: Jakarta\nApply: https://acme.id/jobs')
  assert.deepEqual(res.jobs.map((j) => [j.company, j.title]), [['PT Maju Jaya', 'Backend Engineer'], ['PT Maju Jaya', 'Data Analyst']])
  // Satu butir akun saja bukan tempelan multi-perusahaan: jalur lama (satu perusahaan) tetap dipakai.
  assert.equal(splitCompanyBlocks(THREAD_LINES[0]), null)
})

test('multi-perusahaan: cadangan AI tidak pernah dipanggil, termasuk bila ada blok yang belum terbaca', async () => {
  let calls = 0
  const extract = async () => {
    calls++
    return { is_job_posting: true, jobs: [{ title: 'Product', company: 'wirexapp', location: null, apply_url: null, apply_email: null }] }
  }
  const complete = await parseOffPortalPostingWithAi({ rawText: THREAD, sourceType: 'off_portal_caption' }, NOW, { extract, userId: 'u1' })
  assert.deepEqual(rows(complete), EXPECTED)
  const withGap = await parseOffPortalPostingWithAi(
    { rawText: ['Lowongan terbaru!', '1. @alpha - roles: Backend Engineer - location: Jakarta', '2. @beta'].join('\n'), sourceType: 'off_portal_caption' },
    NOW,
    { extract, userId: 'u1' },
  )
  assert.deepEqual(withGap.jobs.map((j) => [j.company, j.title, j.unreadFields.join('+')]), [
    ['alpha', 'Backend Engineer', ''],
    ['beta', 'Lowongan Off-Portal', 'title+location'],
  ])
  assert.equal(calls, 0)
})

test('simpan: batas simpan sama dengan batas pratinjau, jadi 12 kandidat tidak dipotong diam-diam menjadi 10', async () => {
  const inserted: any[] = []
  const db: any = {
    from() {
      return {
        select() {
          const q: any = { eq: () => q, limit: () => Promise.resolve({ data: [], error: null }) }
          return q
        },
        insert(payload: any) {
          inserted.push(payload)
          return { select: () => Promise.resolve({ data: [{ id: `priv-${inserted.length}`, ...payload }], error: null }) }
        },
      }
    },
  }
  const parsed = parse(THREAD)
  assert.equal(parsed.jobs.length, 14)
  const res = await savePrivateOffPortalJobs(db, 'user-1', parsed.jobs, NOW)
  assert.equal(res.saved, true)
  assert.equal(inserted.length, 14)
  assert.deepEqual(inserted.map((r) => r.company), parsed.jobs.map((j) => j.company))
})
