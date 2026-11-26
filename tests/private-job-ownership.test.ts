import test from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import { jobRoutes } from '../api/routes/jobs.js'
import { ingestJobs } from '../services/job-ingest.service.js'

const OWNER_ID = '11111111-1111-4111-8111-111111111111'
const OTHER_ID = '22222222-2222-4222-8222-222222222222'

interface FakeJobRow {
  id: string
  title: string
  company: string
  location: string
  description: string
  platform_source: string
  external_url: string
  status: string
  visibility?: 'public' | 'private'
  created_by?: string | null
  salary_min?: number | null
  salary_max?: number | null
  salary_currency?: string | null
  salary_period?: string | null
  match_score?: number | null
  requirements?: string[]
}

function makeFakeJobsDb(rows: FakeJobRow[], opts: { preMigration?: boolean } = {}) {
  const inserted: Record<string, any>[] = []
  const updated: Array<{ id: string; patch: Record<string, any> }> = []

  const checkColumns = (cols: string) => {
    if (opts.preMigration && /\b(?:visibility|created_by)\b/.test(cols)) {
      return { code: '42703', message: 'column jobs.visibility does not exist' }
    }
    return null
  }

  const db: any = {
    from(table: string) {
      assert.equal(table, 'jobs')
      let selectedCols = '*'
      const filters: Array<(r: FakeJobRow) => boolean> = []
      let lim: number | null = null

      const chain: any = {
        select(cols: string) {
          selectedCols = cols
          return chain
        },
        eq(col: string, val: unknown) {
          filters.push((r: any) => r[col] === val)
          return chain
        },
        gt(col: string, val: number) {
          filters.push((r: any) => typeof r[col] === 'number' && r[col] > val)
          return chain
        },
        or() {
          return chain
        },
        limit(n: number) {
          lim = n
          return chain
        },
        maybeSingle: async () => {
          const colErr = checkColumns(selectedCols)
          if (colErr) return { data: null, error: colErr }
          const hit = rows.find((r) => filters.every((f) => f(r))) ?? null
          return { data: hit ? { ...hit } : null, error: null }
        },
        then(resolve: (v: any) => void, reject?: (e: any) => void) {
          const colErr = checkColumns(selectedCols)
          if (colErr) return Promise.resolve({ data: null, error: colErr }).then(resolve, reject)
          let out = rows.filter((r) => filters.every((f) => f(r))).map((r) => ({ ...r }))
          if (lim !== null) out = out.slice(0, lim)
          return Promise.resolve({ data: out, error: null }).then(resolve, reject)
        },
        insert(row: Record<string, any>) {
          inserted.push(row)
          rows.push({ id: `inserted-${inserted.length}`, ...row } as FakeJobRow)
          return Promise.resolve({ data: null, error: null })
        },
        update(patch: Record<string, any>) {
          return {
            eq(_col: string, id: string) {
              updated.push({ id, patch })
              const target = rows.find((r) => r.id === id)
              if (target) Object.assign(target, patch)
              return {
                select() {
                  return {
                    maybeSingle: async () => ({ data: target ? { ...target } : null, error: null }),
                  }
                },
                then(resolve: (v: any) => void, reject?: (e: any) => void) {
                  return Promise.resolve({ data: null, error: null }).then(resolve, reject)
                },
              }
            },
          }
        },
      }
      return chain
    },
  }
  return { db, inserted, updated }
}

async function buildApp(db: any, userId: string) {
  const app = Fastify()
  app.addHook('preHandler', async (req) => {
    ;(req as any).user = { id: userId }
  })
  await app.register(jobRoutes, {
    prefix: '/api/jobs',
    db,
    fetchImpl: (async () => new Response('<html></html>', { status: 200 })) as typeof fetch,
  })
  return app
}

test('Isolasi lowongan privat (service role): /:id/channel, /:id/enrich, /:id/salary-benchmark -> 404 untuk user lain, 200 untuk pemilik', async () => {
  const privateRow: FakeJobRow = {
    id: 'job-priv-owner',
    title: 'Backend Engineer',
    company: 'PT Rahasia Privat',
    location: 'Jakarta',
    description: 'Lowongan privat dari poster HR.',
    platform_source: 'off_portal_poster',
    external_url: 'https://docs.google.com/forms/d/e/1FAIpQLSePriv/viewform',
    status: 'active',
    visibility: 'private',
    created_by: OWNER_ID,
    salary_min: 18_000_000,
    salary_max: 22_000_000,
    salary_currency: 'IDR',
    salary_period: 'month',
  }
  const publicRow: FakeJobRow = {
    id: 'job-pub-1',
    title: 'Backend Engineer',
    company: 'PT Publik',
    location: 'Jakarta',
    description: 'Lowongan publik.',
    platform_source: 'greenhouse',
    external_url: 'https://boards.greenhouse.io/publik/jobs/1',
    status: 'active',
    visibility: 'public',
    created_by: null,
    salary_min: 15_000_000,
    salary_max: 19_000_000,
    salary_currency: 'IDR',
    salary_period: 'month',
  }

  const { db } = makeFakeJobsDb([privateRow, publicRow])
  const appOwner = await buildApp(db, OWNER_ID)
  const appOther = await buildApp(db, OTHER_ID)

  try {
    // 1. GET /:id/channel
    const chOther = await appOther.inject({ method: 'GET', url: '/api/jobs/job-priv-owner/channel' })
    assert.equal(chOther.statusCode, 404, 'user lain harus dapat 404 pada /:id/channel')
    const chOwner = await appOwner.inject({ method: 'GET', url: '/api/jobs/job-priv-owner/channel' })
    assert.equal(chOwner.statusCode, 200, 'pemilik harus dapat 200 pada /:id/channel')
    assert.equal(chOwner.json().platform, 'google_forms')

    // 2. POST /:id/enrich
    const enOther = await appOther.inject({ method: 'POST', url: '/api/jobs/job-priv-owner/enrich' })
    assert.equal(enOther.statusCode, 404, 'user lain harus dapat 404 pada /:id/enrich')
    const enOwner = await appOwner.inject({ method: 'POST', url: '/api/jobs/job-priv-owner/enrich' })
    assert.equal(enOwner.statusCode, 200, 'pemilik harus dapat 200 pada /:id/enrich')

    // 3. GET /:id/salary-benchmark (baik target maupun pool pembanding!)
    const sbOther = await appOther.inject({ method: 'GET', url: '/api/jobs/job-priv-owner/salary-benchmark' })
    assert.equal(sbOther.statusCode, 404, 'user lain harus dapat 404 pada /:id/salary-benchmark')
    const sbOwner = await appOwner.inject({ method: 'GET', url: '/api/jobs/job-priv-owner/salary-benchmark' })
    assert.equal(sbOwner.statusCode, 200, 'pemilik harus dapat 200 pada /:id/salary-benchmark')

    // Saat user lain meminta benchmark untuk lowongan publik, baris privat OWNER tidak ikut masuk sampel n!
    const sbPubOther = await appOther.inject({ method: 'GET', url: '/api/jobs/job-pub-1/salary-benchmark' })
    assert.equal(sbPubOther.statusCode, 200)
    assert.equal(sbPubOther.json().n, 0, 'baris privat milik user lain tidak boleh bocor ke sampel salary-benchmark')
  } finally {
    await appOwner.close()
    await appOther.close()
  }
})

test('Kompatibilitas pra-migrasi: seluruh rute tetap bekerja saat kolom visibility & created_by belum ada di DB', async () => {
  const preRow: FakeJobRow = {
    id: 'job-pre-1',
    title: 'Frontend Engineer',
    company: 'PT Lama',
    location: 'Bandung',
    description: 'Lowongan sebelum migrasi.',
    platform_source: 'greenhouse',
    external_url: 'https://boards.greenhouse.io/lama/jobs/1',
    status: 'active',
  }
  const { db } = makeFakeJobsDb([preRow], { preMigration: true })
  const app = await buildApp(db, OTHER_ID)
  try {
    assert.equal((await app.inject({ method: 'GET', url: '/api/jobs/job-pre-1/channel' })).statusCode, 200)
    assert.equal((await app.inject({ method: 'POST', url: '/api/jobs/job-pre-1/enrich' })).statusCode, 200)
    assert.equal((await app.inject({ method: 'GET', url: '/api/jobs/job-pre-1/salary-benchmark' })).statusCode, 200)
  } finally {
    await app.close()
  }
})

test('job-ingest dedupe via external_url: tidak pernah mencocokkan atau menimpa lowongan privat pengguna, tetap dedupe baris publik & pra-migrasi', async () => {
  const sharedUrl = 'https://boards.greenhouse.io/acme/jobs/777'
  const privateRow: FakeJobRow = {
    id: 'job-priv-777',
    title: 'Data Engineer (Catatan Pribadi)',
    company: 'PT Acme',
    location: 'Jakarta',
    description: 'Catatan pribadi user',
    platform_source: 'off_portal_link',
    external_url: sharedUrl,
    status: 'active',
    visibility: 'private',
    created_by: OWNER_ID,
    match_score: null,
  }

  const { db, inserted, updated } = makeFakeJobsDb([privateRow])
  const summary = await ingestJobs(db, [
    {
      id: 'ext-1',
      title: 'Data Engineer',
      company: 'PT Acme',
      location: 'Jakarta',
      description: 'Deskripsi resmi panjang dari papan publik Greenhouse.',
      platform: 'greenhouse',
      url: sharedUrl,
      apply_url: sharedUrl,
      match_score: 88,
    } as any,
  ])

  assert.equal(summary.inserted, 1, 'baris publik baru harus disisipkan, tidak dianggap duplikat dari baris privat')
  assert.equal(summary.duplicates, 0)
  assert.equal(updated.length, 0, 'baris privat milik pengguna tidak boleh diubah oleh job-ingest')
  assert.equal(inserted.length, 1)

  // Jalankan ulang: sekarang baris publik sudah ada -> terdeteksi sebagai duplikat (bukan insert ganda)
  const summary2 = await ingestJobs(db, [
    {
      id: 'ext-2',
      title: 'Data Engineer',
      company: 'PT Acme',
      location: 'Jakarta',
      description: 'Deskripsi resmi.',
      platform: 'greenhouse',
      url: sharedUrl,
      apply_url: sharedUrl,
      match_score: 90,
    } as any,
  ])
  assert.equal(summary2.inserted, 0)
  assert.equal(summary2.duplicates, 1)

  // Pra-migrasi (kolom visibility belum ada): dedupe tetap jalan normal tanpa galat
  const pre = makeFakeJobsDb([{ ...privateRow, visibility: undefined, created_by: undefined }], { preMigration: true })
  const summaryPre = await ingestJobs(pre.db, [
    {
      id: 'ext-3',
      title: 'Data Engineer',
      company: 'PT Acme',
      location: 'Jakarta',
      description: 'Deskripsi.',
      platform: 'greenhouse',
      url: sharedUrl,
      apply_url: sharedUrl,
      match_score: 80,
    } as any,
  ])
  assert.equal(summaryPre.duplicates, 1)
  assert.equal(summaryPre.inserted, 0)
})
