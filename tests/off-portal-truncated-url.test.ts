import test from 'node:test'
import assert from 'node:assert/strict'
import {
  isTruncatedUrlText,
  maskTruncatedUrls,
  normalizeCopiedPostText,
  repairTruncatedUrl,
  scanTextUrls,
  splitCaptionLines,
  scanApplyKeyUrls,
} from '../services/off-portal-extract.js'
import {
  LINKEDIN_MANUAL_APPLY_WARNING,
  TRUNCATED_URL_WARNING,
  parseOffPortalPosting,
  parseOffPortalPostingWithAi,
  truncatedUrlSummary,
  type OffPortalParseInput,
  type OffPortalParseResult,
} from '../services/off-portal-ingest.service.js'
import type { OffPortalAiExtractor } from '../services/off-portal-ai.service.js'

const NOW = new Date('2026-11-27T12:00:00Z')

/**
 * Temuan production 27 Nov 2026 04.55 WIB: teks yang disalin dari web X menampilkan tautan panjang dalam bentuk terpotong,
 * "wirexapp.com/company/career…" dan "linkedin.com/company/redotpay/jo…". Parser dulu menyimpannya apa adanya, jadi tautan lamaran
 * menjadi "https://wirexapp.com/company/career%E2%80%A6". Tautan seperti itu rusak dan tidak boleh disimpan utuh.
 */
const parse = (rawText: string, extra: Partial<OffPortalParseInput> = {}): OffPortalParseResult =>
  parseOffPortalPosting({ rawText, sourceType: 'off_portal_caption', ...extra }, NOW)

/** Semua bidang URL pada hasil, untuk memastikan tidak ada elipsis di mana pun. */
function urlFields(res: OffPortalParseResult): string[] {
  const out: Array<string | null> = [...res.acceptedUrls, ...res.rejectedUrls, ...res.socialPosts.map((p) => p.url)]
  for (const j of res.jobs) out.push(j.applyUrl, j.whatsappUrl, j.channel.applyUrl, j.channel.resolvedApplyUrl)
  return out.filter((u): u is string => typeof u === 'string')
}

function assertNoEllipsisInUrls(res: OffPortalParseResult): void {
  for (const u of urlFields(res)) {
    assert.doesNotMatch(u, /…|%E2%80%A6|\.{3}/i, `URL memuat elipsis: ${u}`)
  }
}

const HEADER = '23 CRYPTO CARD PROJECTS. 100+ JOB OPPORTUNITIES.'

// Bentuk salinan asli: nilai "apply:" di baris sendiri, tanpa skema, terpotong elipsis.
const X_COPY = [
  HEADER,
  '',
  '1. ',
  '@wirexapp',
  '',
  '- roles: Product, Engineering',
  '- location: Remote / Global',
  '- apply: ',
  'wirexapp.com/company/career…',
  '',
  '',
  '2. ',
  '@KASTxyz',
  '',
  '- roles: Product, Legal',
  '- location: Global / Remote',
  '- apply: ',
  'https://t.co/qBt13FOKRu',
  '',
  '',
  '3. ',
  '@RedotPay',
  '',
  '- roles: Card Product Manager',
  '- location: Hong Kong / Remote',
  '- apply: ',
  'linkedin.com/company/redotpay/jo…',
  '',
].join('\n')

test('salinan X: tautan terpotong dipotong ke "/" terakhir, tidak pernah memuat elipsis, dan kandidatnya diberi peringatan', () => {
  const res = parse(X_COPY)
  assert.deepEqual(
    res.jobs.map((j) => [j.company, j.title, j.applyUrl]),
    [
      ['wirexapp', 'Product', 'https://wirexapp.com/company/'],
      ['wirexapp', 'Engineering', 'https://wirexapp.com/company/'],
      ['KASTxyz', 'Product', 'https://t.co/qBt13FOKRu'],
      ['KASTxyz', 'Legal', 'https://t.co/qBt13FOKRu'],
      ['RedotPay', 'Card Product Manager', 'https://linkedin.com/company/redotpay/'],
    ],
  )
  assertNoEllipsisInUrls(res)
  assert.deepEqual(res.acceptedUrls, ['https://t.co/qBt13FOKRu', 'https://wirexapp.com/company/', 'https://linkedin.com/company/redotpay/'])
  assert.deepEqual(res.rejectedUrls, [])

  for (const job of res.jobs.filter((j) => j.company === 'wirexapp')) assert.deepEqual(job.warnings, [TRUNCATED_URL_WARNING])
  // Blok yang tautannya utuh tidak ikut diberi peringatan.
  for (const job of res.jobs.filter((j) => j.company === 'KASTxyz')) assert.deepEqual(job.warnings, [])
  assert.ok(res.warnings.includes(truncatedUrlSummary(3, 5)), res.warnings.join('\n'))
  assert.match(truncatedUrlSummary(3, 5), /3 dari 5 lowongan/)
})

test('LinkedIn terpotong: tetap lamar manual dan tidak didukung agen, ditambah peringatan terpotong', () => {
  const redot = parse(X_COPY).jobs.find((j) => j.company === 'RedotPay')
  assert.ok(redot)
  assert.equal(redot.applyUrl, 'https://linkedin.com/company/redotpay/')
  assert.deepEqual(redot.warnings, [LINKEDIN_MANUAL_APPLY_WARNING, TRUNCATED_URL_WARNING])
  assert.equal(redot.channel.manualOnly, true)
  assert.equal(redot.channel.autoWorkerSupported, false)
  assert.equal(redot.channel.extensionSupported, false)
})

test('tiga bentuk elipsis (U+2026, tiga titik, %E2%80%A6) pada tautan bersekema memberi hasil yang sama', () => {
  const forms = ['…', '...', '%E2%80%A6', '....']
  for (const tail of forms) {
    const res = parse(`Acme is hiring a Backend Engineer.\nLocation: Jakarta\nApply: https://acme.co.id/karir/lowongan/backend-eng${tail}`)
    assert.equal(res.jobs.length, 1, tail)
    assert.equal(res.jobs[0].applyUrl, 'https://acme.co.id/karir/lowongan/', tail)
    assert.deepEqual(res.jobs[0].warnings, [TRUNCATED_URL_WARNING], tail)
    assert.deepEqual(res.acceptedUrls, ['https://acme.co.id/karir/lowongan/'], tail)
    assert.ok(res.warnings.includes(truncatedUrlSummary(1, 1)), tail)
    assertNoEllipsisInUrls(res)
  }
})

test('tiga bentuk elipsis pada tautan tanpa skema di nilai "apply:" memberi hasil yang sama', () => {
  for (const tail of ['…', '...', '%E2%80%A6']) {
    const res = parse(`Acme is hiring a Backend Engineer.\nLocation: Jakarta\nApply: acme.co.id/karir/lowongan/backend-eng${tail}`)
    assert.equal(res.jobs[0].applyUrl, 'https://acme.co.id/karir/lowongan/', tail)
    assert.deepEqual(res.jobs[0].warnings, [TRUNCATED_URL_WARNING], tail)
    assertNoEllipsisInUrls(res)
  }
})

test('tiga titik di ujung tautan tidak lagi dipangkas diam-diam menjadi tautan yang tampak utuh', () => {
  const res = parse('Daftar sekarang di https://acme.co.id/karir/lowongan-backend...')
  assert.equal(res.jobs[0].applyUrl, 'https://acme.co.id/karir/')
  assert.notEqual(res.jobs[0].applyUrl, 'https://acme.co.id/karir/lowongan-backend')
  assert.ok(res.jobs[0].warnings.includes(TRUNCATED_URL_WARNING))
})

test('elipsis di query atau fragmen: jalur sudah utuh, hanya sisanya dibuang', () => {
  assert.equal(repairTruncatedUrl('https://acme.co.id/karir/backend?ref=ab…'), 'https://acme.co.id/karir/backend')
  assert.equal(repairTruncatedUrl('https://acme.co.id/karir/backend#bag…'), 'https://acme.co.id/karir/backend')
  assert.equal(repairTruncatedUrl('acme.co.id?ref=ab...'), 'https://acme.co.id/')
})

test('hanya domain yang tersisa: origin dipakai sebagai situs karier, dengan peringatan terpotong', () => {
  const res = parse('Acme is hiring a Backend Engineer.\nApply: wirexapp.com/care…')
  assert.equal(res.jobs[0].applyUrl, 'https://wirexapp.com/')
  assert.deepEqual(res.jobs[0].warnings, [TRUNCATED_URL_WARNING])
  assertNoEllipsisInUrls(res)
})

test('nama host sendiri mungkin terpotong: tidak ada tautan yang disimpan, hanya peringatan', () => {
  for (const value of ['wirexapp.co…', 'https://wirexapp.co…', 'wirexapp.com...']) {
    const res = parse(`Acme is hiring a Backend Engineer.\nApply: ${value}`)
    assert.equal(res.jobs[0].applyUrl, null, value)
    assert.deepEqual(res.acceptedUrls, [], value)
    assert.deepEqual(res.jobs[0].warnings, [TRUNCATED_URL_WARNING], value)
    assert.ok(res.warnings.includes(truncatedUrlSummary(1, 1)), value)
  }
})

test('tautan pendek, WhatsApp, dan formulir yang terpotong dibuang, bukan dipangkas ke origin yang menyesatkan', () => {
  for (const value of ['https://wa.me/62812345…', 'https://forms.gle/AbCdEfGh…', 'https://bit.ly/3xYz…', 'https://t.co/72KMn8…', 'https://docs.google.com/forms/d/e/1FAIpQLSf…', 'https://tally.so/r/wMd…']) {
    assert.equal(repairTruncatedUrl(value), null, value)
    const res = parse(`Acme is hiring a Backend Engineer.\nApply: ${value}`)
    assert.equal(res.jobs[0].applyUrl, null, value)
    assert.equal(res.jobs[0].whatsappUrl, null, value)
    assert.equal(res.jobs[0].formProvider, null, value)
    assert.deepEqual(res.jobs[0].warnings, [TRUNCATED_URL_WARNING], value)
  }
})

test('tautan ATS yang terpotong dipangkas ke papan perusahaannya', () => {
  assert.equal(repairTruncatedUrl('https://boards.greenhouse.io/acme/jobs/12345…'), 'https://boards.greenhouse.io/acme/jobs/')
  assert.equal(repairTruncatedUrl('https://jobs.lever.co/acme/8a7b…'), 'https://jobs.lever.co/acme/')
})

test('tautan utuh didahulukan atas bagian utuh dari tautan terpotong, dan peringatan tetap ada', () => {
  const res = parse('Acme is hiring a Backend Engineer.\nApply: acme.co.id/karir/backend…\nAtau lamar lewat https://boards.greenhouse.io/acme/jobs/12345')
  assert.equal(res.jobs[0].applyUrl, 'https://boards.greenhouse.io/acme/jobs/12345')
  assert.deepEqual(res.jobs[0].warnings, [TRUNCATED_URL_WARNING])
  assert.deepEqual(res.acceptedUrls, ['https://boards.greenhouse.io/acme/jobs/12345', 'https://acme.co.id/karir/'])
  assertNoEllipsisInUrls(res)
})

test('tautan yang sama utuh di satu tempat dan terpotong di tempat lain tetap dianggap tautan utuh', () => {
  const scan = scanTextUrls('Lamar: https://acme.co.id/karir/ dan https://acme.co.id/karir/backend…')
  assert.deepEqual(scan.urls, [{ url: 'https://acme.co.id/karir/', truncated: false }])
  assert.equal(scan.truncatedCount, 1)
})

test('URL normal tidak berubah: tanpa peringatan terpotong, titik akhir kalimat tetap dibuang seperti dulu', () => {
  const res = parse('Acme is hiring a Backend Engineer.\nLocation: Jakarta\nApply: https://acme.co.id/karir/lowongan/backend-engineer.')
  assert.equal(res.jobs[0].applyUrl, 'https://acme.co.id/karir/lowongan/backend-engineer')
  assert.deepEqual(res.jobs[0].warnings, [])
  assert.deepEqual(res.warnings, [])
  assert.deepEqual(res.acceptedUrls, ['https://acme.co.id/karir/lowongan/backend-engineer'])

  const bare = parse('Acme is hiring a Backend Engineer.\nApply: www.acme.co.id/karir')
  assert.equal(bare.jobs[0].applyUrl, 'https://www.acme.co.id/karir')
  assert.deepEqual(bare.jobs[0].warnings, [])

  const email = parse('Acme is hiring a Backend Engineer. Kirim CV ke hr@acme.co.id... segera!')
  assert.equal(email.jobs[0].applyEmail, 'hr@acme.co.id')
  assert.deepEqual(email.jobs[0].warnings, [])
  assert.deepEqual(email.warnings, [])
})

test('elipsis di teks biasa (bukan tautan) tidak memicu peringatan tautan terpotong', () => {
  const res = parse('Acme is hiring a Backend Engineer… cek detailnya ya...\nApply: https://acme.co.id/karir/backend-engineer')
  assert.equal(res.jobs[0].applyUrl, 'https://acme.co.id/karir/backend-engineer')
  assert.deepEqual(res.jobs[0].warnings, [])
  assert.deepEqual(res.warnings, [])
})

test('tautan terpotong di kolom sumber dan hasil baca QR tidak disimpan dengan elipsis', () => {
  const res = parse('Acme is hiring a Backend Engineer.', {
    sourceUrl: 'https://acme.co.id/karir/lowongan/backend-eng…',
    qrUrls: ['https://acme.co.id/qr/abc%E2%80%A6'],
  })
  assert.deepEqual(res.acceptedUrls, ['https://acme.co.id/karir/lowongan/', 'https://acme.co.id/qr/'])
  assert.equal(res.jobs[0].applyUrl, 'https://acme.co.id/karir/lowongan/')
  assert.deepEqual(res.jobs[0].warnings, [TRUNCATED_URL_WARNING])
  assertNoEllipsisInUrls(res)
})

test('tautan postingan sosial yang terpotong tetap hanya sumber, dan tidak menjadi tautan lamaran', () => {
  const res = parse('Acme is hiring a Backend Engineer.\nSumber: https://x.com/acme/status/178493…')
  assert.deepEqual(res.jobs[0].applyUrl, null)
  assertNoEllipsisInUrls(res)
})

test('tautan ATS terpotong di deskripsi tidak menjadi tautan lamaran hasil klasifikasi kanal', () => {
  const res = parse('Acme is hiring a Backend Engineer.\nApply: https://acme.co.id/karir\nBerkas lain: https://jobs.lever.co/acme/8a7b…')
  const job = res.jobs[0]
  assert.equal(job.applyUrl, 'https://acme.co.id/karir')
  assert.doesNotMatch(String(job.channel.resolvedApplyUrl ?? ''), /lever|…|%E2%80%A6/)
  assertNoEllipsisInUrls(res)
  // Deskripsi tersimpan apa adanya untuk pengguna; yang disaring hanya masukan klasifikasi kanal.
  assert.match(job.description, /8a7b…/)
  assert.equal(maskTruncatedUrls('a https://jobs.lever.co/acme/8a7b… b https://ok.example/x c'), 'a   b https://ok.example/x c')
})

test('isTruncatedUrlText dan repairTruncatedUrl: tabel kasus', () => {
  const truncated = ['wirexapp.com/company/career…', 'https://x.co/a…', 'https://x.co/a...', 'https://x.co/a%E2%80%A6', 'https://x.co/a%e2%80%a6', 'https://x.co/a…,', 'https://x.co/a....']
  for (const t of truncated) assert.equal(isTruncatedUrlText(t), true, t)
  const whole = ['https://x.co/a', 'https://x.co/a.', 'https://x.co/a..', 'https://x.co/a,', 'wirexapp.com/company/career', 'hr@acme.co.id']
  for (const t of whole) assert.equal(isTruncatedUrlText(t), false, t)

  const cases: Array<[string, string | null]> = [
    ['wirexapp.com/company/career…', 'https://wirexapp.com/company/'],
    ['https://wirexapp.com/company/career…', 'https://wirexapp.com/company/'],
    ['http://wirexapp.com/company/career…', 'http://wirexapp.com/company/'],
    ['linkedin.com/company/redotpay/jo…', 'https://linkedin.com/company/redotpay/'],
    ['https://www.linkedin.com/company/redotpay/jobs/?ref=a…', 'https://www.linkedin.com/company/redotpay/jobs/'],
    ['wirexapp.com/…', 'https://wirexapp.com/'],
    ['wirexapp.com…', null],
    ['wirexapp.co…', null],
    ['https://wirexapp.com…', null],
    ['…', null],
    ['%E2%80%A6', null],
    ['https://wa.me/62812345…', null],
    ['javascript:alert(1)//…', null],
    ['ftp://acme.co.id/a/b…', null],
  ]
  for (const [raw, expected] of cases) assert.equal(repairTruncatedUrl(raw), expected, raw)
})

test('tempelan multi-perusahaan satu baris: tautan terpotong tiap blok dibaca sendiri', () => {
  const text = `${HEADER}  1. @wirexapp - roles: Product - location: Remote - apply: wirexapp.com/company/career…  2. @KASTxyz - roles: Legal - location: Global - apply: https://t.co/qBt13FOKRu`
  const res = parse(text)
  assert.deepEqual(
    res.jobs.map((j) => [j.company, j.applyUrl, j.warnings]),
    [
      ['wirexapp', 'https://wirexapp.com/company/', [TRUNCATED_URL_WARNING]],
      ['KASTxyz', 'https://t.co/qBt13FOKRu', []],
    ],
  )
  assert.ok(res.warnings.includes(truncatedUrlSummary(1, 2)))
  assertNoEllipsisInUrls(res)
})

test('salinan X yang terpotong dan yang rapi menghasilkan kandidat yang sama', () => {
  const tidy = normalizeCopiedPostText(X_COPY)
  assert.ok(tidy.includes('- apply: wirexapp.com/company/career…'))
  assert.deepEqual(
    parse(tidy).jobs.map((j) => [j.company, j.title, j.applyUrl, j.warnings]),
    parse(X_COPY).jobs.map((j) => [j.company, j.title, j.applyUrl, j.warnings]),
  )
})

test('scanApplyKeyUrls: nilai "apply:" terpotong dicatat, dan yang utuh tidak berubah', () => {
  const lines = splitCaptionLines('apply: https://acme.co.id/a/b…\napply: acme.co.id/jobs\nlink: acme.co.id/x/y...')
  const scan = scanApplyKeyUrls(lines)
  assert.deepEqual(scan.urls, [
    { url: 'https://acme.co.id/a/', truncated: true },
    { url: 'https://acme.co.id/jobs', truncated: false },
    { url: 'https://acme.co.id/x/', truncated: true },
  ])
  assert.equal(scan.truncatedCount, 2)
})

test('ringkasan tingkat hasil: tanpa jumlah bila semua lowongan terkena, dengan jumlah bila sebagian', () => {
  assert.doesNotMatch(truncatedUrlSummary(4, 4), /dari/)
  assert.match(truncatedUrlSummary(1, 4), /1 dari 4 lowongan/)
  assert.doesNotMatch(truncatedUrlSummary(0, 0), /dari/)
})

test('hanya tautan sosial terpotong tanpa teks: pengguna diminta menempel caption, dan peringatan terpotong ikut tampil', () => {
  const res = parse('', { sourceUrl: 'https://www.instagram.com/p/Cxyz12…' })
  assert.equal(res.needsCaption, true)
  assert.ok(res.warnings.includes(truncatedUrlSummary(0, 0)))
  assertNoEllipsisInUrls(res)
})

// ---------------------------------------------------------------------------
// Cadangan AI
// ---------------------------------------------------------------------------

test('cadangan AI yang mengembalikan tautan terpotong dari teks tidak membuat tautan ber-elipsis tersimpan', async () => {
  const text = 'Kami butuh tenaga untuk bagian dapur di Kedai Senja. Daftar: https://kedai-senja.example/lowongan/dapur-ke… segera ya.'
  const extract: OffPortalAiExtractor = async () => ({
    is_job_posting: true,
    jobs: [{ title: 'bagian dapur', company: null, location: null, apply_url: 'https://kedai-senja.example/lowongan/dapur-ke…', apply_email: null }],
  })
  const res = await parseOffPortalPostingWithAi({ rawText: text, sourceType: 'off_portal_caption' }, NOW, { extract, userId: 'u1', log: () => {} })
  assert.equal(res.jobs[0].extraction, 'ai')
  assert.equal(res.jobs[0].title, 'bagian dapur')
  assert.equal(res.jobs[0].applyUrl, 'https://kedai-senja.example/lowongan/')
  assert.ok(res.jobs[0].warnings.includes(TRUNCATED_URL_WARNING))
  assert.ok(res.warnings.includes(truncatedUrlSummary(1, 1)))
  assertNoEllipsisInUrls(res)
})

test('cadangan AI: tautan terpotong yang tidak bisa dipulihkan jatuh ke tautan aturan, tanpa elipsis', async () => {
  const text = 'Kami butuh tenaga untuk bagian dapur di Kedai Senja. Info: https://example.org/tentang. Daftar: https://forms.gle/DaftarKed…'
  const extract: OffPortalAiExtractor = async () => ({
    is_job_posting: true,
    jobs: [{ title: 'bagian dapur', company: null, location: null, apply_url: 'https://forms.gle/DaftarKed…', apply_email: null }],
  })
  const res = await parseOffPortalPostingWithAi({ rawText: text, sourceType: 'off_portal_caption' }, NOW, { extract, userId: 'u1', log: () => {} })
  assert.equal(res.jobs[0].extraction, 'ai')
  assert.equal(res.jobs[0].applyUrl, 'https://example.org/tentang')
  assert.ok(res.jobs[0].warnings.includes(TRUNCATED_URL_WARNING))
  assertNoEllipsisInUrls(res)
})
