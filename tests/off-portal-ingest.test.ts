import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Fastify from 'fastify'
import { buildPublicationFingerprint, parseOffPortalPosting } from '../services/off-portal-ingest.service.js'
import { jobRoutes } from '../api/routes/jobs.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DRAFT_SQL_PATH = path.resolve(__dirname, '..', '..', 'database', 'migrations', 'DRAFT_2026-11-26_private_offportal_jobs.sql')

test('BS-P3-08 & P0-01: poster multi-role menghasilkan beberapa posisi dengan source_group_id sama dan fingerprint deterministik', () => {
  const posterText = [
    'PT Nusantara Digital',
    'We Are Hiring:',
    '1. Frontend Engineer',
    '2. QA Automation Engineer',
    'Lokasi: Yogyakarta',
    'Kirim lamaran lewat Google Form atau WhatsApp https://wa.me/6281234567890',
  ].join('\n')

  const parsed = parseOffPortalPosting(
    {
      rawText: posterText,
      sourceType: 'off_portal_poster',
      qrUrls: ['https://forms.gle/abc123xyz', 'http://127.0.0.1/admin', 'javascript:alert(1)'],
      sourceGroupId: '11111111-1111-4111-8111-111111111111',
    },
    new Date('2026-11-26T00:00:00Z'),
  )

  assert.equal(parsed.sourceGroupId, '11111111-1111-4111-8111-111111111111')
  assert.equal(parsed.jobs.length, 2)
  assert.deepEqual(parsed.jobs.map((j) => j.title), ['Frontend Engineer', 'QA Automation Engineer'])
  assert.equal(parsed.jobs[0].sourceGroupId, parsed.jobs[1].sourceGroupId)
  assert.notEqual(parsed.jobs[0].publicationFingerprint, parsed.jobs[1].publicationFingerprint)
  assert.equal(parsed.jobs[0].applyUrl, 'https://forms.gle/abc123xyz')
  assert.equal(parsed.jobs[0].formProvider, 'google_forms')
  assert.equal(parsed.jobs[0].whatsappUrl, 'https://wa.me/6281234567890')
  assert.equal(parsed.jobs[0].location, 'Yogyakarta')
  assert.deepEqual(parsed.rejectedUrls, ['http://127.0.0.1/admin', 'javascript:alert(1)'])
  assert.equal(parsed.jobs[0].safety.riskLevel, 'caution')

  // Fingerprint identik untuk masukan yang sama (stabil untuk dedupe).
  const fp2 = buildPublicationFingerprint({
    title: '  frontend engineer ',
    company: parsed.jobs[0].company,
    applyUrl: parsed.jobs[0].applyUrl,
    applyEmail: parsed.jobs[0].applyEmail,
    description: parsed.jobs[0].description,
  })
  assert.equal(fp2, parsed.jobs[0].publicationFingerprint)
})

test('P0-01 rute POST /api/jobs/off-portal/parse: wajib auth, tolak input kosong, kembalikan pratinjau + deteksi anti-scam', async () => {
  const app = Fastify()
  app.addHook('preHandler', async (req) => {
    if (req.headers['x-test-user']) {
      ;(req as any).user = { id: String(req.headers['x-test-user']) }
    }
  })
  await app.register(jobRoutes, { prefix: '/api/jobs' })
  await app.ready()
  try {
    const unauth = await app.inject({ method: 'POST', url: '/api/jobs/off-portal/parse', payload: { rawText: 'Halo' } })
    assert.equal(unauth.statusCode, 401)

    const empty = await app.inject({
      method: 'POST',
      url: '/api/jobs/off-portal/parse',
      headers: { 'x-test-user': 'u1' },
      payload: {},
    })
    assert.equal(empty.statusCode, 400)

    const ok = await app.inject({
      method: 'POST',
      url: '/api/jobs/off-portal/parse',
      headers: { 'x-test-user': 'u1' },
      payload: {
        sourceType: 'off_portal_caption',
        rawText: 'Dibutuhkan Admin Gudang. Wajib bayar biaya administrasi Rp 200.000 ke hr@acme.id',
      },
    })
    assert.equal(ok.statusCode, 200)
    const body = ok.json()
    assert.equal(body.jobs.length, 1)
    assert.equal(body.jobs[0].applyEmail, 'hr@acme.id')
    assert.equal(body.jobs[0].safety.riskLevel, 'high')
  } finally {
    await app.close()
  }
})

function parseCompany(lines: string[]): string {
  return parseOffPortalPosting(
    { rawText: lines.join('\n'), sourceType: 'off_portal_poster' },
    new Date('2026-11-26T00:00:00Z'),
  ).jobs[0].company
}

test('extractCompany: baris "CV dan portofolio ke email" bukan nama perusahaan', () => {
  for (const sendLine of [
    'CV dan portofolio ke x@y.com',
    'CV & portofolio ke hrd@maju.co.id',
    'CV terbaru kirim ke HRD',
    'CV atau resume Anda',
    'CV lamaran ke hrd@maju.co.id',
    'CV Maju Jaya kirim ke hrd@maju.co.id',
  ]) {
    assert.equal(parseCompany(['Lowongan: Admin', sendLine]), 'Perusahaan (Off-Portal)', sendLine)
  }
  // Baris CV pengiriman dilewati, perusahaan sesungguhnya di baris berikutnya tetap terbaca.
  assert.equal(parseCompany(['CV dan portofolio ke x@y.com', 'PT Nusantara Digital']), 'PT Nusantara Digital')
})

test('extractCompany: CV sebagai badan usaha (CV Maju Jaya) tetap terbaca sebagai perusahaan', () => {
  assert.equal(parseCompany(['CV Maju Jaya', 'Lowongan: Admin']), 'CV Maju Jaya')
  assert.equal(parseCompany(['CV. Sinar Terang', 'Lokasi: Solo']), 'CV. Sinar Terang')
  assert.equal(parseCompany(['Perusahaan: CV Karya Bersama']), 'CV Karya Bersama')
  assert.equal(parseCompany(['PT Nusantara Digital', 'Kirim CV ke hrd@x.com']), 'PT Nusantara Digital')
})

test('P0-02 draf migrasi privat memuat kolom isolasi dan kebijakan RLS visibility=public OR created_by=auth.uid()', () => {
  const sql = readFileSync(DRAFT_SQL_PATH, 'utf8')
  assert.match(sql, /ADD COLUMN IF NOT EXISTS created_by UUID/)
  assert.match(sql, /visibility TEXT NOT NULL DEFAULT 'public'/)
  assert.match(sql, /source_group_id UUID/)
  assert.match(sql, /publication_fingerprint TEXT/)
  assert.match(sql, /ENABLE ROW LEVEL SECURITY/)
  assert.match(sql, /visibility = 'public'[\s\S]*created_by = auth\.uid\(\)/)
})
