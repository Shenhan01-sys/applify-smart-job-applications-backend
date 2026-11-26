import test from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import { jobRoutes } from '../api/routes/jobs.js'
import { detectSocialPostPlatform, isSocialPostUrl } from '../services/apply-channel.js'
import {
  LINKEDIN_MANUAL_APPLY_WARNING,
  parseOffPortalPosting,
  type OffPortalParseInput,
} from '../services/off-portal-ingest.service.js'
import { companyFromUrl, cleanLocationValue, extractRoleTitles, splitRoleList } from '../services/off-portal-extract.js'
import { savePrivateOffPortalJobs } from '../services/off-portal-save.service.js'

const NOW = new Date('2026-11-26T12:00:00Z')

function parse(input: OffPortalParseInput) {
  return parseOffPortalPosting({ sourceType: 'off_portal_caption', ...input }, NOW)
}

/**
 * Caption X dari uji E2E production 26 Nov 2026 (thread @Nikitont, laporan Gemini di Brave). Bentuknya
 * "N. @Handle - roles: ... - location: ... - apply: <url>". Akun, lokasi, dan tautan diambil dari laporan;
 * isi `roles` hanya contoh karena laporan tidak mencatat teks posisinya.
 */
const X_CAPTIONS: Array<{
  caption: string
  company: string
  titles: string[]
  location: string
  applyUrl: string | null
  channel: 'public_ats' | 'external_web' | 'auth_portal'
}> = [
  {
    caption: '2. @KASTxyz - roles: Software Engineer, Product Designer - location: Global / Remote / US / Europe - apply: https://www.kast.xyz/en/careers',
    company: 'KASTxyz',
    titles: ['Software Engineer', 'Product Designer'],
    location: 'Global / Remote / US / Europe',
    applyUrl: 'https://www.kast.xyz/en/careers',
    channel: 'external_web',
  },
  {
    caption: '4. @EthenaPay - roles: Smart Contract Engineer - location: Remote - apply: https://apply.ethena.fi/jobs',
    company: 'EthenaPay',
    titles: ['Smart Contract Engineer'],
    location: 'Remote',
    applyUrl: 'https://apply.ethena.fi/jobs',
    channel: 'external_web',
  },
  {
    caption: '6. @ether_fi - roles: Backend Engineer, Growth Lead - location: Global - apply: https://www.ether.fi/careers',
    company: 'ether_fi',
    titles: ['Backend Engineer', 'Growth Lead'],
    location: 'Global',
    applyUrl: 'https://www.ether.fi/careers',
    channel: 'external_web',
  },
  {
    caption: '8. @KoloHub - roles: Community Manager - location: Remote',
    company: 'KoloHub',
    titles: ['Community Manager'],
    location: 'Remote',
    applyUrl: null,
    channel: 'external_web',
  },
  {
    caption: '10. @AnodosFinance - roles: Quant Researcher - location: Remote - apply: https://anodos.finance/en/careers',
    company: 'AnodosFinance',
    titles: ['Quant Researcher'],
    location: 'Remote',
    applyUrl: 'https://anodos.finance/en/careers',
    channel: 'external_web',
  },
  {
    caption: '13. @falconfinance - roles: Protocol Engineer, Marketing Lead - location: Remote - apply: https://falcon.finance/careers',
    company: 'falconfinance',
    titles: ['Protocol Engineer', 'Marketing Lead'],
    location: 'Remote',
    applyUrl: 'https://falcon.finance/careers',
    channel: 'external_web',
  },
  {
    caption: '14. @Bitpanda - roles: Senior Backend Engineer - location: Europe / Dubai - apply: https://job-boards.greenhouse.io/bitpanda',
    company: 'Bitpanda',
    titles: ['Senior Backend Engineer'],
    location: 'Europe / Dubai',
    applyUrl: 'https://job-boards.greenhouse.io/bitpanda',
    channel: 'public_ats',
  },
  {
    caption: '16. @coinbase - roles: Software Engineer - location: Global - apply: https://www.coinbase.com/careers/positions',
    company: 'coinbase',
    titles: ['Software Engineer'],
    location: 'Global',
    applyUrl: 'https://www.coinbase.com/careers/positions',
    channel: 'external_web',
  },
  {
    caption: '18. Kraken / @Krak - roles: Security Engineer - location: Remote / Global - apply: https://jobs.ashbyhq.com/kraken.com/',
    company: 'Kraken',
    titles: ['Security Engineer'],
    location: 'Remote / Global',
    applyUrl: 'https://jobs.ashbyhq.com/kraken.com/',
    channel: 'public_ats',
  },
  {
    caption: '20. @eldoradoio - roles: Operations Associate - location: Bolivia / Argentina - apply: https://eldoradoio.notion.site/',
    company: 'eldoradoio',
    titles: ['Operations Associate'],
    location: 'Bolivia / Argentina',
    applyUrl: 'https://eldoradoio.notion.site/',
    channel: 'external_web',
  },
  {
    caption: '22. @BitgetWallet - roles: Product Manager - location: Global - apply: https://www.linkedin.com/company/bitget-wallet/jobs/',
    company: 'BitgetWallet',
    titles: ['Product Manager'],
    location: 'Global',
    applyUrl: 'https://www.linkedin.com/company/bitget-wallet/jobs/',
    channel: 'auth_portal',
  },
]

test('E2E 26 Nov: 11 caption X terbaca posisi, perusahaan, dan lokasinya, tanpa nilai bawaan "Off-Portal"', () => {
  for (const fx of X_CAPTIONS) {
    const res = parse({ rawText: fx.caption })
    const label = fx.caption.slice(0, 30)
    assert.deepEqual(res.jobs.map((j) => j.title), fx.titles, label)
    for (const job of res.jobs) {
      assert.equal(job.company, fx.company, label)
      assert.equal(job.location, fx.location, label)
      assert.equal(job.applyUrl, fx.applyUrl, label)
      assert.equal(job.channel.channel === 'auth_portal' || job.channel.channel === fx.channel, true, `${label} kanal ${job.channel.channel}`)
      assert.deepEqual(job.unreadFields, [], label)
      assert.notEqual(job.title, 'Lowongan Off-Portal', label)
      assert.notEqual(job.company, 'Perusahaan (Off-Portal)', label)
    }
  }
})

test('E2E 26 Nov: "- apply: <url>" tidak bocor ke lokasi pada 10 caption bertautan, dan tidak ada URL di bidang mana pun', () => {
  let withLink = 0
  for (const fx of X_CAPTIONS) {
    const res = parse({ rawText: fx.caption })
    for (const job of res.jobs) {
      assert.doesNotMatch(job.location, /apply|https?:|www\./i, fx.caption)
      assert.doesNotMatch(job.company, /https?:|apply/i, fx.caption)
      assert.doesNotMatch(job.title, /https?:|apply/i, fx.caption)
    }
    if (fx.applyUrl) withLink++
  }
  assert.equal(withLink, 10)
})

test('caption yang sama sebagai beberapa baris (disalin dengan Enter) terbaca sama dengan versi sebaris', () => {
  const multi = ['10. @AnodosFinance', 'roles: Quant Researcher', 'location: Remote', 'apply: https://anodos.finance/en/careers'].join('\n')
  const a = parse({ rawText: multi }).jobs[0]
  const b = parse({ rawText: X_CAPTIONS[4].caption }).jobs[0]
  assert.equal(a.title, b.title)
  assert.equal(a.company, b.company)
  assert.equal(a.location, b.location)
  assert.equal(a.applyUrl, b.applyUrl)
})

test('LinkedIn: tautan lowongan LinkedIn lolos sebagai tautan tetapi diberi peringatan lamar manual dan kanal manual-only', () => {
  const res = parse({ rawText: X_CAPTIONS[10].caption })
  assert.equal(res.jobs.length, 1)
  const job = res.jobs[0]
  assert.equal(job.applyUrl, 'https://www.linkedin.com/company/bitget-wallet/jobs/')
  assert.equal(job.channel.manualOnly, true)
  assert.equal(job.channel.autoWorkerSupported, false)
  assert.equal(job.channel.extensionSupported, false)
  assert.deepEqual(job.warnings, [LINKEDIN_MANUAL_APPLY_WARNING])
  assert.match(LINKEDIN_MANUAL_APPLY_WARNING, /manual/i)
  // Tidak digandakan di tingkat hasil.
  assert.equal(res.warnings.includes(LINKEDIN_MANUAL_APPLY_WARNING), false)
  // Lowongan non-LinkedIn tidak diberi peringatan itu.
  assert.deepEqual(parse({ rawText: X_CAPTIONS[1].caption }).jobs[0].warnings, [])
})

test('Instagram: hanya link postingan -> tidak ada kandidat, needsCaption, pesan jelas, link bukan tautan lamaran', () => {
  const res = parse({ sourceUrl: 'https://www.instagram.com/p/DgH95gJmZos/', sourceType: 'off_portal_link' })
  assert.equal(res.needsCaption, true)
  assert.deepEqual(res.jobs, [])
  assert.equal(res.socialPosts.length, 1)
  assert.equal(res.socialPosts[0].platform, 'instagram')
  assert.equal(res.warnings.length, 1)
  assert.match(res.warnings[0], /Instagram/)
  assert.match(res.warnings[0], /login/)
  assert.match(res.warnings[0], /tempel/i)
  assert.match(res.warnings[0], /bukan tautan lamaran/)
})

test('X: hanya link postingan x.com / twitter.com -> needsCaption, bukan tautan lamaran', () => {
  for (const url of ['https://x.com/Nikitont/status/2125539436477792758?a=eAWn3mU7OqAnqPf0rXo&s=19', 'https://twitter.com/Nikitont/status/2125539436477792758']) {
    const res = parse({ sourceUrl: url, sourceType: 'off_portal_link' })
    assert.equal(res.needsCaption, true, url)
    assert.equal(res.jobs.length, 0, url)
    assert.match(res.warnings[0], /X \(Twitter\)/, url)
  }
})

test('postingan sosial + caption: caption dibaca, link postingan hanya sumber (tidak jadi applyUrl), tautan apply dari caption dipakai', () => {
  const res = parse({
    sourceUrl: 'https://www.instagram.com/p/DgH95gJmZos/',
    rawText: [
      '🚀 PT Maju Digital sedang membuka lowongan!',
      '📍 Lokasi: Bandung (Hybrid)',
      'Posisi:',
      '1. UI/UX Designer',
      '2. Frontend Developer',
      'Daftar di https://forms.gle/MajuDigital2026',
      '#loker #lowongankerja',
    ].join('\n'),
  })
  assert.equal(res.needsCaption, false)
  assert.deepEqual(res.jobs.map((j) => j.title), ['UI/UX Designer', 'Frontend Developer'])
  for (const job of res.jobs) {
    assert.equal(job.company, 'PT Maju Digital')
    assert.equal(job.location, 'Bandung (Hybrid)')
    assert.equal(job.applyUrl, 'https://forms.gle/MajuDigital2026')
    assert.equal(job.formProvider, 'google_forms')
  }
  assert.equal(res.socialPosts[0].platform, 'instagram')
  assert.match(res.warnings[0], /sumber saja/)
  // Link IG tetap tercatat di acceptedUrls sebagai sumber, tetapi bukan tautan lamaran job mana pun.
  assert.equal(res.jobs.some((j) => j.applyUrl?.includes('instagram.com')), false)
})

test('postingan sosial + caption tanpa tautan: applyUrl kosong, bukan link postingan', () => {
  const res = parse({
    sourceUrl: 'https://x.com/Nikitont/status/2125539436477792758',
    rawText: 'Acme Labs is hiring a Backend Engineer. Kirim CV ke hr@acmelabs.id',
  })
  assert.equal(res.jobs.length, 1)
  assert.equal(res.jobs[0].applyUrl, null)
  assert.equal(res.jobs[0].applyEmail, 'hr@acmelabs.id')
  assert.equal(res.jobs[0].title, 'Backend Engineer')
  assert.equal(res.jobs[0].company, 'Acme Labs')
})

test('link postingan LinkedIn (linkedin.com/posts) tanpa caption: needsCaption + peringatan LinkedIn; dengan caption: peringatan sekali di tingkat hasil', () => {
  const url = 'https://www.linkedin.com/posts/acme_hiring-activity-123456'
  const bare = parse({ sourceUrl: url, sourceType: 'off_portal_link' })
  assert.equal(bare.needsCaption, true)
  assert.equal(bare.socialPosts[0].platform, 'linkedin_post')
  assert.equal(bare.warnings.includes(LINKEDIN_MANUAL_APPLY_WARNING), true)

  const withText = parse({ sourceUrl: url, rawText: 'Acme is hiring a Data Analyst\nLocation: Jakarta' })
  assert.equal(withText.needsCaption, false)
  assert.equal(withText.jobs[0].applyUrl, null)
  assert.equal(withText.jobs[0].title, 'Data Analyst')
  assert.equal(withText.warnings.filter((w) => w === LINKEDIN_MANUAL_APPLY_WARNING).length, 1)
})

test('detectSocialPostPlatform: Instagram, X, Twitter, Facebook, LinkedIn posts; bukan situs karier atau halaman jobs LinkedIn', () => {
  assert.equal(detectSocialPostPlatform('https://www.instagram.com/p/abc/'), 'instagram')
  assert.equal(detectSocialPostPlatform('https://instagram.com/reel/abc/'), 'instagram')
  assert.equal(detectSocialPostPlatform('https://x.com/a/status/1'), 'x')
  assert.equal(detectSocialPostPlatform('https://mobile.twitter.com/a/status/1'), 'x')
  assert.equal(detectSocialPostPlatform('https://www.facebook.com/groups/1/posts/2'), 'facebook')
  assert.equal(detectSocialPostPlatform('https://fb.watch/abc'), 'facebook')
  assert.equal(detectSocialPostPlatform('https://www.linkedin.com/posts/x_y'), 'linkedin_post')
  assert.equal(detectSocialPostPlatform('https://www.linkedin.com/feed/update/urn:li:activity:1'), 'linkedin_post')
  assert.equal(detectSocialPostPlatform('https://www.linkedin.com/jobs/view/123'), null)
  assert.equal(detectSocialPostPlatform('https://www.linkedin.com/company/acme/jobs/'), null)
  assert.equal(detectSocialPostPlatform('https://www.kast.xyz/en/careers'), null)
  assert.equal(detectSocialPostPlatform('https://notx.com/a'), null)
  assert.equal(detectSocialPostPlatform('javascript:alert(1)'), null)
  assert.equal(isSocialPostUrl('https://jobs.lever.co/acme'), false)
})

test('ekstraksi: kalimat umum Indonesia dan Inggris tanpa label', () => {
  const idn = parse({ rawText: 'PT Maju membuka lowongan Data Analyst. Kirim CV ke hr@maju.id\nPenempatan Surabaya' })
  assert.equal(idn.jobs[0].title, 'Data Analyst')
  assert.equal(idn.jobs[0].company, 'PT Maju')

  const en = parse({ rawText: '@acme is hiring a Senior Backend Engineer (remote) 🌍\nApply here: https://jobs.lever.co/acme/123' })
  assert.equal(en.jobs[0].title, 'Senior Backend Engineer (remote)')
  assert.equal(en.jobs[0].company, 'acme')
  assert.equal(en.jobs[0].location, 'Remote')
  assert.equal(en.jobs[0].applyUrl, 'https://jobs.lever.co/acme/123')

  const phrase = parse({ rawText: 'Nusantara Studio is hiring!\nWe are looking for a Game Artist\nLocation: Yogyakarta' })
  assert.equal(phrase.jobs[0].company, 'Nusantara Studio')
  assert.equal(phrase.jobs[0].title, 'Game Artist')
  assert.equal(phrase.jobs[0].location, 'Yogyakarta')
})

test('ekstraksi: PT di tengah kalimat, "join X as Role", dan baris tanpa kata jabatan tidak dijadikan judul', () => {
  const pt = parse({ rawText: 'Hi guys, PT Kreasi Nusantara lagi buka lowongan buat Fresh Graduate!\nPosisi: Marketing Staff\nLokasi: Jakarta Barat\nKirim CV ke recruitment@kreasi.co.id' }).jobs[0]
  assert.equal(pt.company, 'PT Kreasi Nusantara')
  assert.equal(pt.title, 'Marketing Staff')
  assert.equal(pt.location, 'Jakarta Barat')

  const join = parse({ rawText: "We're hiring! Join Tokopedia as Data Scientist\nRemote friendly\nhttps://careers.tokopedia.com/data-scientist" }).jobs[0]
  assert.equal(join.title, 'Data Scientist')
  assert.equal(join.company, 'Tokopedia')

  const greeting = parse({ rawText: 'Halo semuanya' }).jobs[0]
  assert.equal(greeting.title, 'Lowongan Off-Portal')
  assert.deepEqual(greeting.unreadFields, ['title', 'company', 'location'])
})

test('ekstraksi: bagian Posisi dengan butir bernomor tetap jalan, butir "Hiring Manager" tidak dianggap header', () => {
  const res = parse({
    rawText: ['PT Sinar Karya', 'Posisi:', '1. Hiring Manager', '2. Staff Admin', 'Lokasi: Solo', 'Kirim CV ke hr@sinar.id'].join('\n'),
  })
  assert.deepEqual(res.jobs.map((j) => j.title), ['Hiring Manager', 'Staff Admin'])
  assert.equal(res.jobs[0].company, 'PT Sinar Karya')
  assert.equal(res.jobs[0].location, 'Solo')
})

test('splitRoleList: koma di dalam kurung dan "UI/UX" tidak memecah; singkatan Sr. tidak memotong kalimat', () => {
  assert.deepEqual(splitRoleList('Backend Engineer (Rust, Go), UI/UX Designer; Sr. Product Manager'), [
    'Backend Engineer (Rust, Go)',
    'UI/UX Designer',
    'Sr. Product Manager',
  ])
  assert.deepEqual(splitRoleList('Admin Gudang. Wajib bayar biaya administrasi'), ['Admin Gudang'])
  assert.deepEqual(splitRoleList('and Designer, dan Analyst'), ['Designer', 'Analyst'])
})

test('extractRoleTitles: sepuluh posisi paling banyak, duplikat dibuang', () => {
  const many = `roles: ${Array.from({ length: 14 }, (_, i) => `Role Number ${i + 1}`).join(', ')}, Role Number 1`
  const titles = extractRoleTitles(many)
  assert.equal(titles.length, 10)
  assert.equal(new Set(titles).size, 10)
})

test('cleanLocationValue: membuang URL, ekor apply, email, dan tagar', () => {
  assert.equal(cleanLocationValue('Remote - apply: https://x.example/jobs'), 'Remote')
  assert.equal(cleanLocationValue('Global / Remote / US / Europe - apply: https://www.kast.xyz/en/careers'), 'Global / Remote / US / Europe')
  assert.equal(cleanLocationValue('Jakarta, apply via https://acme.id'), 'Jakarta')
  assert.equal(cleanLocationValue('Remote (apply via link)'), 'Remote')
  assert.equal(cleanLocationValue('Bandung #loker'), 'Bandung')
  assert.equal(cleanLocationValue('apply: https://acme.id'), '')
})

test('lokasi: sebaris dengan koma, kota dikenal, dan nilai bawaan Indonesia ditandai belum terbaca', () => {
  assert.equal(parse({ rawText: 'Acme is hiring a Cashier. Location: Jakarta, apply: https://acme.id/jobs' }).jobs[0].location, 'Jakarta')
  const city = parse({ rawText: 'Dibutuhkan Kasir segera di Surabaya' }).jobs[0]
  assert.equal(city.location, 'Surabaya')
  const none = parse({ rawText: 'Kirim lamaran ke hr@acme.id' }).jobs[0]
  assert.equal(none.location, 'Indonesia')
  assert.deepEqual(none.unreadFields.sort(), ['company', 'location', 'title'].sort())
})

test('perusahaan: nama dari tautan lamaran hanya cadangan terakhir; host generik tidak dipakai', () => {
  assert.equal(companyFromUrl('https://job-boards.greenhouse.io/bitpanda'), 'Bitpanda')
  assert.equal(companyFromUrl('https://jobs.ashbyhq.com/kraken.com/'), 'Kraken')
  assert.equal(companyFromUrl('https://eldoradoio.notion.site/'), 'Eldoradoio')
  assert.equal(companyFromUrl('https://apply.ethena.fi/jobs'), 'Ethena')
  assert.equal(companyFromUrl('https://www.acme.co.id/karir'), 'Acme')
  assert.equal(companyFromUrl('https://forms.gle/abc'), null)
  assert.equal(companyFromUrl('https://bit.ly/abc'), null)
  assert.equal(companyFromUrl('https://www.instagram.com/p/abc/'), null)
  assert.equal(companyFromUrl('https://www.linkedin.com/company/x/jobs/'), null)

  const linkOnly = parse({ sourceUrl: 'https://www.coinbase.com/careers/positions', sourceType: 'off_portal_link' })
  assert.equal(linkOnly.jobs[0].company, 'Coinbase')
  assert.deepEqual(linkOnly.jobs[0].unreadFields, ['title', 'location'])
  // Teks eksplisit selalu menang atas tautan.
  assert.equal(parse({ rawText: 'Perusahaan: PT Contoh Jaya\nPosisi: Admin\napply: https://www.coinbase.com/careers' }).jobs[0].company, 'PT Contoh Jaya')
})

test('perusahaan: "lowongan di Surabaya" tidak menjadikan kota sebagai perusahaan', () => {
  const res = parse({ rawText: 'Lowongan kerja di Surabaya\nPosisi: Kasir' })
  assert.equal(res.jobs[0].company, 'Perusahaan (Off-Portal)')
  assert.equal(res.jobs[0].location, 'Surabaya')
})

test('rute POST /off-portal/parse: link IG saja -> 200 needsCaption tanpa kandidat; peringatan rute dan parser digabung', async () => {
  const app = Fastify()
  app.addHook('preHandler', async (req) => {
    if (req.headers['x-test-user']) (req as any).user = { id: String(req.headers['x-test-user']) }
  })
  await app.register(jobRoutes, { prefix: '/api/jobs' })
  await app.ready()
  try {
    const ig = await app.inject({
      method: 'POST',
      url: '/api/jobs/off-portal/parse',
      headers: { 'x-test-user': 'u1' },
      payload: { sourceUrl: 'https://www.instagram.com/p/DgH95gJmZos/' },
    })
    assert.equal(ig.statusCode, 200, ig.body)
    const body = ig.json()
    assert.equal(body.needsCaption, true)
    assert.deepEqual(body.jobs, [])
    assert.equal(body.socialPosts[0].platform, 'instagram')
    assert.match(body.warnings[0], /Instagram/)

    const cap = await app.inject({
      method: 'POST',
      url: '/api/jobs/off-portal/parse',
      headers: { 'x-test-user': 'u1' },
      payload: { sourceUrl: 'https://x.com/Nikitont/status/2125539436477792758', rawText: X_CAPTIONS[0].caption },
    })
    assert.equal(cap.statusCode, 200, cap.body)
    const capBody = cap.json()
    assert.equal(capBody.needsCaption, false)
    assert.deepEqual(capBody.jobs.map((j: any) => j.title), ['Software Engineer', 'Product Designer'])
    assert.equal(capBody.jobs[0].applyUrl, 'https://www.kast.xyz/en/careers')
    assert.equal(capBody.warnings.length, 1)
    assert.match(capBody.warnings[0], /sumber saja/)
  } finally {
    await app.close()
  }
})

test('save: tautan postingan sosial dari klien lama tidak pernah disimpan sebagai external_url', async () => {
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
          return { select: () => Promise.resolve({ data: [{ id: 'priv-1', ...payload }], error: null }) }
        },
      }
    },
  }
  const res = await savePrivateOffPortalJobs(
    db,
    'user-1',
    [
      { title: 'Backend Engineer', company: 'Acme', location: 'Remote', description: 'x', sourceType: 'off_portal_caption', applyUrl: 'https://www.instagram.com/p/DgH95gJmZos/' },
      { title: 'Data Analyst', company: 'Acme', location: 'Remote', description: 'y', sourceType: 'off_portal_caption', applyUrl: 'https://jobs.lever.co/acme/1' },
    ],
    NOW,
  )
  assert.equal(res.saved, true)
  assert.equal(inserted.length, 2)
  assert.equal(inserted[0].external_url, null)
  assert.equal(inserted[1].external_url, 'https://jobs.lever.co/acme/1')
})
