import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeCopiedPostText, splitCompanyBlocks } from '../services/off-portal-extract.js'
import { parseOffPortalPosting, type OffPortalParseResult } from '../services/off-portal-ingest.service.js'

const NOW = new Date('2026-11-27T12:00:00Z')

/**
 * Temuan production 27 Nov 2026: caption yang disalin dari halaman web X memecah teks di setiap mention dan tautan, karena
 * keduanya dirender sebagai elemen link. "1. @wirexapp" menjadi "1. " / "@wirexapp", dan "apply: https://t.co/x" menjadi
 * "apply: " / "https://t.co/x". Hasilnya 8 kandidat yang semuanya tercatat wirexapp. Tiga bentuk di bawah (rapi, satu baris,
 * terpecah) harus menghasilkan kandidat yang sama.
 */
const HEADER = '23 CRYPTO CARD PROJECTS. 100+ JOB OPPORTUNITIES.'

const TIDY = [
  HEADER,
  '',
  '1. @wirexapp',
  '- roles: Product, Engineering, Compliance, Commercial, Operations',
  '- location: Remote / Global',
  '- apply: https://t.co/72KMn8tXzJ',
  '',
  '2. @KASTxyz',
  '- roles: Product, Engineering, Legal, Sales',
  '- location: Global / Remote / US / Europe',
  '- apply: https://t.co/qBt13FOKRu',
  '',
  '3. @RedotPay',
  '- roles: Card Product Manager, Backend Engineer',
  '- location: Hong Kong / Remote',
  '- apply: https://t.co/abcDEF123',
].join('\n')

const ONE_LINE = `${HEADER}  1. @wirexapp - roles: Product, Engineering, Compliance, Commercial, Operations - location: Remote / Global - apply: https://t.co/72KMn8tXzJ  2. @KASTxyz - roles: Product, Engineering, Legal, Sales - location: Global / Remote / US / Europe - apply: https://t.co/qBt13FOKRu  3. @RedotPay - roles: Card Product Manager, Backend Engineer - location: Hong Kong / Remote - apply: https://t.co/abcDEF123`

/** Bentuk salinan asli: nomor, akun, dan tautan masing-masing di baris sendiri, dengan spasi sisa di ujung "1. " dan "apply: ". */
const SPLIT = [
  HEADER,
  '',
  '1. ',
  '@wirexapp',
  '',
  '- roles: Product, Engineering, Compliance, Commercial, Operations',
  '- location: Remote / Global',
  '- apply: ',
  'https://t.co/72KMn8tXzJ',
  '',
  '',
  '2. ',
  '@KASTxyz',
  '',
  '- roles: Product, Engineering, Legal, Sales',
  '- location: Global / Remote / US / Europe',
  '- apply: ',
  'https://t.co/qBt13FOKRu',
  '',
  '',
  '3. ',
  '@RedotPay',
  '',
  '- roles: Card Product Manager, Backend Engineer',
  '- location: Hong Kong / Remote',
  '- apply: ',
  'https://t.co/abcDEF123',
  '',
].join('\n')

const EXPECTED: Array<[company: string, title: string, location: string, applyUrl: string]> = [
  ['wirexapp', 'Product', 'Remote / Global', 'https://t.co/72KMn8tXzJ'],
  ['wirexapp', 'Engineering', 'Remote / Global', 'https://t.co/72KMn8tXzJ'],
  ['wirexapp', 'Compliance', 'Remote / Global', 'https://t.co/72KMn8tXzJ'],
  ['wirexapp', 'Commercial', 'Remote / Global', 'https://t.co/72KMn8tXzJ'],
  ['wirexapp', 'Operations', 'Remote / Global', 'https://t.co/72KMn8tXzJ'],
  ['KASTxyz', 'Product', 'Global / Remote / US / Europe', 'https://t.co/qBt13FOKRu'],
  ['KASTxyz', 'Engineering', 'Global / Remote / US / Europe', 'https://t.co/qBt13FOKRu'],
  ['KASTxyz', 'Legal', 'Global / Remote / US / Europe', 'https://t.co/qBt13FOKRu'],
  ['KASTxyz', 'Sales', 'Global / Remote / US / Europe', 'https://t.co/qBt13FOKRu'],
  ['RedotPay', 'Card Product Manager', 'Hong Kong / Remote', 'https://t.co/abcDEF123'],
  ['RedotPay', 'Backend Engineer', 'Hong Kong / Remote', 'https://t.co/abcDEF123'],
]

const rows = (res: OffPortalParseResult) => res.jobs.map((j) => [j.company, j.title, j.location, j.applyUrl])

function parse(rawText: string): OffPortalParseResult {
  return parseOffPortalPosting({ rawText, sourceType: 'off_portal_caption' }, NOW)
}

for (const [name, text] of [
  ['bentuk rapi', TIDY],
  ['bentuk satu baris', ONE_LINE],
  ['nomor, akun, dan tautan terpecah per baris', SPLIT],
] as const) {
  test(`salinan X (${name}): 11 kandidat, wirexapp 5, KASTxyz 4, RedotPay 2, lengkap dengan lokasi dan tautan`, () => {
    const res = parse(text)
    assert.deepEqual(rows(res), EXPECTED)
    assert.equal(res.needsCaption, false)
    assert.deepEqual(res.warnings, [])
    const perCompany = new Map<string, number>()
    for (const job of res.jobs) perCompany.set(job.company, (perCompany.get(job.company) ?? 0) + 1)
    assert.deepEqual([...perCompany], [['wirexapp', 5], ['KASTxyz', 4], ['RedotPay', 2]])
    for (const job of res.jobs) {
      assert.deepEqual(job.unreadFields, [], `${job.company} ${job.title}`)
      assert.equal(job.extraction, 'rules')
    }
  })
}

test('salinan terpecah menjadi teks yang sama dengan bentuk rapi, sampai deskripsi tiap kandidat', () => {
  assert.deepEqual(
    parse(SPLIT).jobs.map((j) => j.description),
    parse(TIDY).jobs.map((j) => j.description),
  )
  assert.equal(splitCompanyBlocks(normalizeCopiedPostText(SPLIT))?.length, 3)
  for (const job of parse(SPLIT).jobs) {
    const others = ['wirexapp', 'KASTxyz', 'RedotPay'].filter((c) => c !== job.company)
    for (const other of others) assert.doesNotMatch(job.description, new RegExp(other, 'i'), `${job.company} memuat ${other}`)
  }
})

test('normalisasi: bentuk rapi dan satu baris tidak berubah, idempoten untuk salinan terpecah', () => {
  assert.equal(normalizeCopiedPostText(TIDY), TIDY)
  assert.equal(normalizeCopiedPostText(ONE_LINE), ONE_LINE)
  const once = normalizeCopiedPostText(SPLIT)
  assert.equal(normalizeCopiedPostText(once), once)
  assert.ok(once.includes('1. @wirexapp\n- roles:'))
  assert.ok(once.includes('- apply: https://t.co/qBt13FOKRu'))
})

test('normalisasi: teks biasa, CRLF, dan kosong dikembalikan apa adanya', () => {
  const plain = 'Lowongan Admin\r\nPT Maju Jaya\r\nposisi: Admin\r\napply: https://maju.example/jobs\r\n'
  assert.equal(normalizeCopiedPostText(plain), plain)
  assert.equal(normalizeCopiedPostText(''), '')
})

test('salinan X: varian penomoran "1)", akun di baris kosong terpisah, dan label link: dan daftar: kosong', () => {
  const text = [
    HEADER,
    '1) ',
    '',
    '',
    '@wirexapp',
    'roles: Product, Engineering',
    'location: Remote',
    'link: ',
    '',
    'https://t.co/72KMn8tXzJ',
    '',
    '2) ',
    '@KASTxyz',
    'roles: Legal',
    'location: Global',
    'daftar: ',
    'kast.xyz/en/careers',
  ].join('\n')
  assert.deepEqual(rows(parse(text)), [
    ['wirexapp', 'Product', 'Remote', 'https://t.co/72KMn8tXzJ'],
    ['wirexapp', 'Engineering', 'Remote', 'https://t.co/72KMn8tXzJ'],
    ['KASTxyz', 'Legal', 'Global', 'https://kast.xyz/en/careers'],
  ])
})

test('salinan X: tanpa tanda "-" di depan kunci dan butir bernama tanpa akun ("N." lalu Kraken) tetap satu blok sendiri', () => {
  const text = ['1. ', 'Kraken', '', 'roles: Security Engineer', 'apply: ', 'kraken.com/careers', '', '2. ', 'Bitpanda', 'roles: Senior Backend Engineer', 'apply: bitpanda.com/careers'].join('\n')
  assert.deepEqual(rows(parse(text)), [
    ['Kraken', 'Security Engineer', 'Indonesia', 'https://kraken.com/careers'],
    ['Bitpanda', 'Senior Backend Engineer', 'Indonesia', 'https://bitpanda.com/careers'],
  ])
})

const AUTHOR_HEADER = ['Crypto Jobs Daily', '@cryptojobsdaily', '·', 'Nov 27']
const NOISE_FOOTER = ['Show more', 'Translate post', '5:03 PM · Nov 27, 2026 · 12.3K Views', '12', '34', '1.2K', '5.6K']

test('salinan X: nama tampilan, @akun penulis, "Show more", "Translate post", tanggal, dan hitungan views bukan perusahaan', () => {
  const text = [...AUTHOR_HEADER, ...SPLIT.split('\n'), ...NOISE_FOOTER].join('\n')
  const res = parse(text)
  assert.deepEqual(rows(res), EXPECTED)
  assert.equal(res.jobs.some((j) => /cryptojobsdaily|Crypto Jobs Daily/i.test(`${j.company} ${j.title} ${j.description}`)), false)
  for (const job of res.jobs) assert.doesNotMatch(job.description, /Show more|Translate|Views|12\.3K|5\.6K/)
  const last = res.jobs[res.jobs.length - 1]
  assert.equal(last.company, 'RedotPay')
  assert.match(last.description, /abcDEF123$/)
})

test('salinan X: kepala penulis sebaris ("Nama @akun · 2h") dan akun dengan waktu relatif di baris terpisah', () => {
  const body = TIDY.split('\n')
  assert.deepEqual(rows(parse(['Crypto Jobs Daily @cryptojobsdaily · 2h', ...body].join('\n'))), EXPECTED)
  assert.deepEqual(rows(parse(['Crypto Jobs Daily', 'Verified account', '@cryptojobsdaily', '· 2h', ...body].join('\n'))), EXPECTED)
  assert.deepEqual(rows(parse(['Crypto Jobs Daily', '@cryptojobsdaily', '·', '45m', ...body].join('\n'))), EXPECTED)
  assert.deepEqual(rows(parse(['Kripto Harian', '@kriptoharian', '·', '27 Nov 2026', ...body].join('\n'))), EXPECTED)
})

test('salinan X: hitungan dan labelnya terpisah baris ("12.3K" lalu "Views") dibuang berpasangan, termasuk sisa tombol Indonesia', () => {
  const text = [...TIDY.split('\n'), 'Tampilkan selengkapnya', 'Terjemahkan postingan', '12.3K', 'Views', '5', 'Reposts', '40', 'Likes', 'Read 7 replies'].join('\n')
  const res = parse(text)
  assert.deepEqual(rows(res), EXPECTED)
  for (const job of res.jobs) assert.doesNotMatch(job.description, /Tampilkan|Terjemahkan|Views|Reposts|Likes|replies/)
})

test('salinan X: lowongan satu perusahaan dengan kepala penulis dan tautan terpecah, penulis tidak dianggap perusahaan', () => {
  const text = ['Wirex', '@wirexapp', '· 2h', 'We are hiring!', 'roles: Product, Engineering', 'location: Remote', 'apply: ', 'https://wirexapp.com/careers', '1.2K Views'].join('\n')
  const res = parse(text)
  assert.deepEqual(
    res.jobs.map((j) => [j.title, j.location, j.applyUrl]),
    [
      ['Product', 'Remote', 'https://wirexapp.com/careers'],
      ['Engineering', 'Remote', 'https://wirexapp.com/careers'],
    ],
  )
  for (const job of res.jobs) {
    assert.doesNotMatch(job.description, /@wirexapp|Views|· 2h/)
    assert.notEqual(job.company, '@wirexapp')
  }
})

test('normalisasi tidak menyentuh teks biasa yang mirip: "Nama" lalu "@akun" tanpa penanda waktu tetap isi lowongan', () => {
  const text = ['Acme', '@acme', 'roles: Backend Engineer', 'location: Remote', 'apply: acme.com/jobs'].join('\n')
  assert.equal(normalizeCopiedPostText(text), text)
  const res = parse(text)
  assert.deepEqual(rows(res), [['acme', 'Backend Engineer', 'Remote', 'https://acme.com/jobs']])
})

test('normalisasi tidak membuang angka di akhir caption biasa, dan "N." lepas tanpa lanjutan tidak disambung', () => {
  const trailing = 'Dibutuhkan Admin di Sleman. Kuota\n10'
  assert.equal(normalizeCopiedPostText(trailing), trailing)
  const lone = ['Posisi:', '3.', 'roles: Admin'].join('\n')
  assert.equal(normalizeCopiedPostText(lone), lone)
})

test('daftar posisi bernomor yang terputus ("1." lalu "Admin") tetap daftar posisi biasa, bukan tempelan multi-perusahaan', () => {
  const text = ['Posisi:', '1.', 'Admin', '2.', 'Kasir', 'Lokasi: Sleman'].join('\n')
  assert.equal(normalizeCopiedPostText(text), ['Posisi:', '1. Admin', '2. Kasir', 'Lokasi: Sleman'].join('\n'))
  assert.equal(splitCompanyBlocks(normalizeCopiedPostText(text)), null)
  assert.deepEqual(
    parse(text).jobs.map((j) => [j.title, j.location]),
    [
      ['Admin', 'Sleman'],
      ['Kasir', 'Sleman'],
    ],
  )
})
