import test from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import { jobRoutes } from '../api/routes/jobs.js'
import { approvalDispatchTarget, classifyJobChannel } from '../services/apply-channel.js'
import { PRIVATE_JOBS_MIGRATION_FILE, savePrivateOffPortalJobs } from '../services/off-portal-save.service.js'

const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+X2dIAAAAASUVORK5CYII='

/** Guard tiruan: izinkan semua (batas ai-guard diuji di off-portal-gel3-hardening.test.ts). */
const allowGuard = { checkActionRateLimit: async () => {} }

function makePrivateJobsFakeDb(opts: { migrationApplied: boolean }) {
  const rows: any[] = []
  let seq = 1
  const db = {
    from(table: string) {
      assert.equal(table, 'jobs')
      return {
        select(cols: string) {
          const filters: Array<[string, any]> = []
          const q: any = {
            eq(col: string, val: any) {
              filters.push([col, val])
              return q
            },
            limit(_n: number) {
              if (!opts.migrationApplied && /created_by|visibility|publication_fingerprint/.test(cols)) {
                return Promise.resolve({
                  data: null,
                  error: { code: '42703', message: 'column jobs.created_by does not exist' },
                })
              }
              const matched = rows.filter((r) => filters.every(([c, v]) => r[c] === v))
              return Promise.resolve({ data: matched, error: null })
            },
          }
          return q
        },
        insert(payload: any) {
          return {
            select() {
              if (!opts.migrationApplied) {
                return Promise.resolve({
                  data: null,
                  error: { code: 'PGRST204', message: "Could not find the 'visibility' column of 'jobs'" },
                })
              }
              const row = { id: `priv-job-${seq++}`, ...payload }
              rows.push(row)
              return Promise.resolve({ data: [row], error: null })
            },
          }
        },
      }
    },
  }
  return { db, rows }
}

test('Gelombang 3 parse poster: menggabungkan OCR teks + QR URL ke parser off-portal dengan laporan anti-scam', async () => {
  const app = Fastify()
  app.addHook('preHandler', async (req) => {
    if (req.headers['x-test-user']) (req as any).user = { id: String(req.headers['x-test-user']) }
  })
  await app.register(jobRoutes, {
    prefix: '/api/jobs',
    guard: allowGuard,
    posterOcr: async () => ({
      status: 'ok',
      text: 'PT Sinar Karya\nWe Are Hiring:\n1. Frontend Engineer\n2. UI/UX Designer\nLokasi: Bandung',
      truncated: false,
    }),
    qrDecoder: async () => ({
      rawTexts: ['https://forms.gle/SinarKaryaApply2026', 'http://127.0.0.1/secret'],
      urls: ['https://forms.gle/SinarKaryaApply2026'],
      rejectedUrls: ['http://127.0.0.1/secret'],
      method: 'png_native',
    }),
  })
  await app.ready()
  try {
    const res = await app.inject({
      method: 'POST',
      url: '/api/jobs/off-portal/parse',
      headers: { 'x-test-user': 'user-1' },
      payload: {
        imageBase64: `data:image/png;base64,${TINY_PNG_BASE64}`,
      },
    })
    assert.equal(res.statusCode, 200, res.body)
    const body = res.json()
    assert.equal(body.sourceType, 'off_portal_poster')
    assert.equal(body.jobs.length, 2)
    assert.equal(body.jobs[0].applyUrl, 'https://forms.gle/SinarKaryaApply2026')
    assert.equal(body.jobs[0].formProvider, 'google_forms')
    assert.equal(body.ocr.status, 'ok')
    assert.deepEqual(body.qr.decodedUrls, ['https://forms.gle/SinarKaryaApply2026'])
    assert.deepEqual(body.rejectedUrls, ['http://127.0.0.1/secret'])

    // Tolak gambar rusak dengan 400 invalid_image
    const bad = await app.inject({
      method: 'POST',
      url: '/api/jobs/off-portal/parse',
      headers: { 'x-test-user': 'user-1' },
      payload: { imageBase64: Buffer.from('not-an-image').toString('base64') },
    })
    assert.equal(bad.statusCode, 400)
    assert.equal(bad.json().code, 'invalid_image')
  } finally {
    await app.close()
  }
})

test('Gelombang 3 parse poster tanpa OCR & tanpa QR: tidak error 500, kembalikan warnings jelas', async () => {
  const app = Fastify()
  app.addHook('preHandler', async (req) => {
    ;(req as any).user = { id: 'user-1' }
  })
  await app.register(jobRoutes, {
    prefix: '/api/jobs',
    guard: allowGuard,
    posterOcr: async () => ({ status: 'unavailable', text: '', truncated: false }),
    qrDecoder: async () => ({ rawTexts: [], urls: [], rejectedUrls: [], method: 'png_native' }),
  })
  await app.ready()
  try {
    const res = await app.inject({
      method: 'POST',
      url: '/api/jobs/off-portal/parse',
      payload: { imageBase64: TINY_PNG_BASE64 },
    })
    assert.equal(res.statusCode, 200)
    const body = res.json()
    assert.equal(body.jobs.length, 0)
    assert.ok(body.warnings.some((w: string) => /GEMINI_API_KEY|OCR/i.test(w)))
  } finally {
    await app.close()
  }
})

test('Gelombang 3 save lowongan privat: saat kolom DRAFT belum ada -> pesan jelas, tidak error, 0 baris ditulis', async () => {
  const { db, rows } = makePrivateJobsFakeDb({ migrationApplied: false })
  const res = await savePrivateOffPortalJobs(db as any, 'user-1', [
    {
      title: 'Backend Engineer',
      company: 'PT Maju',
      location: 'Jakarta',
      description: 'Kirim CV ke hr@maju.id',
      sourceType: 'off_portal_poster',
      applyEmail: 'hr@maju.id',
    },
  ])
  assert.equal(res.saved, false)
  assert.equal(res.migrationRequired, true)
  assert.equal(res.code, 'private_jobs_migration_required')
  assert.ok(res.message.includes(PRIVATE_JOBS_MIGRATION_FILE))
  assert.equal(rows.length, 0, 'tidak boleh menyisipkan baris publik bila migrasi privat belum ada')
})

test('Gelombang 3 save lowongan privat: saat kolom migrasi ada -> simpan privat idempoten dan rute kanal persetujuan tepat', async () => {
  const { db, rows } = makePrivateJobsFakeDb({ migrationApplied: true })
  const items = [
    {
      title: 'Frontend Intern',
      company: 'PT Karya',
      location: 'Yogyakarta (Hybrid)',
      description: 'Kirim lamaran ke talent@karya.id',
      sourceType: 'off_portal_poster',
      applyEmail: 'talent@karya.id',
    },
    {
      title: 'Admin Operasional',
      company: 'CV Sejahtera',
      location: 'Bandung',
      description: 'Daftar via WhatsApp https://wa.me/6281234567890',
      sourceType: 'off_portal_caption',
      whatsappUrl: 'https://wa.me/6281234567890',
    },
  ]

  const first = await savePrivateOffPortalJobs(db as any, 'user-1', items)
  assert.equal(first.saved, true)
  assert.equal(first.migrationRequired, false)
  assert.equal(first.insertedCount, 2)
  assert.equal(first.duplicateCount, 0)
  assert.equal(rows.length, 2)
  assert.equal(rows[0].visibility, 'private')
  assert.equal(rows[0].created_by, 'user-1')
  assert.equal(rows[0].type, 'internship')
  assert.equal(rows[0].workplace_type, 'hybrid')

  // Klik simpan ulang = idempoten, tidak menambah duplikat.
  const second = await savePrivateOffPortalJobs(db as any, 'user-1', items)
  assert.equal(second.saved, true)
  assert.equal(second.insertedCount, 0)
  assert.equal(second.duplicateCount, 2)
  assert.equal(rows.length, 2)

  // Kanal persetujuan dari baris privat yang tersimpan:
  const emailClass = classifyJobChannel(rows[0])
  assert.equal(emailClass.channel, 'email_direct')
  assert.equal(approvalDispatchTarget(emailClass), 'email_direct')

  const waClass = classifyJobChannel(rows[1])
  assert.equal(waClass.platform, 'whatsapp')
  assert.equal(waClass.manualOnly, true)
  assert.equal(approvalDispatchTarget(waClass), 'manual')
})
