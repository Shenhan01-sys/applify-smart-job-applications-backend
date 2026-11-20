import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import Fastify, { type FastifyInstance } from 'fastify'
import cors from '@fastify/cors'
import { readFileSync } from 'node:fs'
import { FakeDb } from './helpers/fakeDb.ts'
import { makePdf } from './helpers/makePdf.ts'
import { NOW, fixturePdf } from './helpers/linkedinFixture.ts'
import { AiGuardService, DEFAULT_IMPORT_LIMITS, PROFILE_IMPORT_ACTION, importLimitsFromEnv, type AiLimits } from '../services/ai-guard.service.ts'
import { LinkedInImportService } from '../services/linkedin-import.service.ts'
import { PDF_MAX_BYTES } from '../services/linkedin-pdf.ts'
import { profileImportRoutes } from '../api/routes/profile-import.ts'
import { isOriginAllowed, parseAllowedOrigins } from '../services/deploy-config.ts'

/**
 * POST /api/profile/import/linkedin-pdf pada Fastify sungguhan (app.inject, tanpa jaringan): login, validasi
 * berkas, batas laju, pratinjau, dan JAMINAN bahwa rute ini tidak menulis ke tabel profil maupun menyentuh kuota
 * draf AI. Model AI tiruan; database tiruan (FakeDb). PDF memakai tokoh sintetis.
 */

const LIMITS: AiLimits = { perMinute: 3, perHour: 5 }
const ago = (sec: number) => new Date(NOW.getTime() - sec * 1000).toISOString()

/** FakeDb + rpc() yang mencatat panggilan: rute impor tidak boleh memanggil get_quota_status. */
class GuardDb extends FakeDb {
  rpcCalls: Array<{ fn: string; args: any }> = []
  from(table: string) {
    const q: any = super.from(table)
    const insert = q.insert.bind(q)
    const stamp = (r: any) => ({ created_at: NOW.toISOString(), ...r })
    q.insert = (payload: any) => insert(Array.isArray(payload) ? payload.map(stamp) : stamp(payload))
    return q
  }
  async rpc(fn: string, args: any) {
    this.rpcCalls.push({ fn, args })
    return { data: [{ allowed: false, used: 10, limit_qty: 10, remaining: 0, period: 'monthly' }], error: null }
  }
}

const AI_JSON = {
  full_name: 'Rina Kusuma Wardhani',
  headline: 'Senior Data Analyst at Biru Langit Labs',
  location: 'Yogyakarta, Daerah Istimewa Yogyakarta, Indonesia',
  experiences: [{ company: 'Biru Langit Labs', title: 'Senior Data Analyst', date_range: 'January 2022 - Present (2 years 11 months)' }],
  education: [{ school: 'Universitas Fiktif Nusantara', degree: 'Bachelor of Engineering - BE', field: 'Information Systems', years: '2014 - 2018' }],
  certifications: [],
  skills: ['Python'],
  languages: [],
}

let app: FastifyInstance
let db: GuardDb
let llmCalls: number
let llm: (p: any) => Promise<{ text: string; model: string }>
let importerError: Error | null

beforeEach(async () => {
  db = new GuardDb()
  llmCalls = 0
  importerError = null
  llm = async () => {
    llmCalls++
    return { text: JSON.stringify(AI_JSON), model: 'test:model' }
  }
  const real = new LinkedInImportService({ llm: (p) => llm(p), now: () => NOW })
  const importer = {
    importFromPdf: async (body: unknown, ctx: any) => {
      if (importerError) throw importerError
      return real.importFromPdf(body, ctx)
    },
  }
  app = Fastify()
  // Di produksi authMiddleware (api/index.ts) memverifikasi token dan mengisi request.user.
  app.addHook('preHandler', async (req) => {
    ;(req as any).user = { id: (req.headers['x-test-user'] as string) || 'u1' }
  })
  await app.register(profileImportRoutes, { prefix: '/api/profile', guard: new AiGuardService(db as any, LIMITS, () => NOW), importer })
})
afterEach(async () => {
  await app.close()
})

const AUTH = { authorization: 'Bearer test-token' }
const upload = (payload: Buffer | string, headers: Record<string, string> = {}) =>
  app.inject({ method: 'POST', url: '/api/profile/import/linkedin-pdf', payload, headers: { 'content-type': 'application/pdf', ...AUTH, ...headers } })
const importRows = (userId = 'u1') => db.rows('application_logs').filter((r) => r.user_id === userId && r.action === PROFILE_IMPORT_ACTION)

test('tanpa header Authorization: 401 sebelum badan dibaca, model tidak dipanggil', async () => {
  const res = await app.inject({ method: 'POST', url: '/api/profile/import/linkedin-pdf', payload: fixturePdf(), headers: { 'content-type': 'application/pdf' } })
  assert.equal(res.statusCode, 401)
  assert.equal(llmCalls, 0)
  assert.equal(db.writes.length, 0)
})

test('PDF sah: 200 dengan pratinjau; model dipanggil sekali; metode ai', async () => {
  const res = await upload(fixturePdf())
  assert.equal(res.statusCode, 200)
  const body = res.json()
  assert.equal(body.success, true)
  assert.equal(body.preview.meta.method, 'ai')
  assert.equal(body.preview.profile.full_name, 'Rina Kusuma Wardhani')
  assert.equal(body.preview.profile.linkedin_url, 'https://www.linkedin.com/in/rina-kusuma-sintetis')
  assert.equal(body.preview.experiences[0].start_date, '2022-01-01')
  assert.equal(body.preview.education[0].start_year, 2014)
  assert.deepEqual(Object.keys(body).sort(), ['preview', 'success'])
  assert.equal(llmCalls, 1)
})

test('rute tidak menulis ke tabel profil dan tidak memakai kuota draf: satu-satunya tulisan adalah baris batas laju', async () => {
  const res = await upload(fixturePdf())
  assert.equal(res.statusCode, 200)
  assert.deepEqual(db.writes.map((w) => `${w.table}:${w.op}`), ['application_logs:insert'])
  assert.equal(importRows().length, 1)
  assert.equal(importRows()[0].status, 'success')
  assert.deepEqual(Object.keys(db.tables).sort(), ['application_logs'], 'tidak ada tabel lain yang disentuh')
  for (const t of ['profiles', 'work_experiences', 'education', 'certifications', 'user_skills']) assert.equal(db.tables[t], undefined, t)
  assert.equal(db.rows('application_logs').filter((r) => r.action === 'ai_draft').length, 0, 'tidak mencatat draf AI')
  assert.equal(db.rpcCalls.length, 0, 'get_quota_status tidak dipanggil: kuota draf bukan urusan impor')
})

test('pengguna yang kuota draf AI-nya habis tetap bisa mengimpor (kuota draf tidak diperiksa)', async () => {
  // GuardDb.rpc selalu menjawab kuota habis; impor tetap lolos karena tidak memanggilnya.
  assert.equal((await upload(fixturePdf())).statusCode, 200)
})

test('berkas bukan PDF: 400 not_pdf untuk teks, JSON, dan PDF palsu; kosong 400 empty_file; tidak ada jatah batas laju terpakai', async () => {
  const text = await upload('halo, bukan pdf', { 'content-type': 'application/pdf' })
  assert.equal(text.statusCode, 400)
  assert.equal(text.json().code, 'not_pdf')
  assert.equal(text.json().success, false)
  assert.match(text.json().error, /bukan PDF/)

  const json = await app.inject({ method: 'POST', url: '/api/profile/import/linkedin-pdf', payload: { a: 1 }, headers: AUTH })
  assert.equal(json.statusCode, 400)
  assert.equal(json.json().code, 'not_pdf')

  const fake = await upload(Buffer.from('MZ\x90\x00 ini sebenarnya program Windows'), { 'content-type': 'application/octet-stream' })
  assert.equal(fake.statusCode, 400)
  assert.equal(fake.json().code, 'not_pdf')

  const empty = await upload(Buffer.alloc(0))
  assert.equal(empty.statusCode, 400)
  assert.equal(empty.json().code, 'empty_file')

  assert.equal(llmCalls, 0)
  assert.equal(db.writes.length, 0, 'berkas yang ditolak tidak menulis apa pun')
})

test('multipart ditolak 415 not_pdf dengan pesan yang jelas (rute memakai badan PDF mentah)', async () => {
  const res = await upload('--x\r\ncontent-disposition: form-data; name="f"\r\n\r\ndata\r\n--x--', { 'content-type': 'multipart/form-data; boundary=x' })
  assert.equal(res.statusCode, 415)
  assert.equal(res.json().code, 'not_pdf')
  assert.equal(llmCalls, 0)
})

test('lebih dari 5 MB: 413 file_too_large, baik tepat 1 byte lewat maupun jauh lewat', async () => {
  const pdfHead = Buffer.from('%PDF-1.4\n')
  const over1 = Buffer.concat([pdfHead, Buffer.alloc(PDF_MAX_BYTES + 1 - pdfHead.length, 0x20)])
  assert.equal(over1.length, PDF_MAX_BYTES + 1)
  const a = await upload(over1)
  assert.equal(a.statusCode, 413)
  assert.equal(a.json().code, 'file_too_large')
  const b = await upload(Buffer.concat([pdfHead, Buffer.alloc(PDF_MAX_BYTES + 5000, 0x20)]))
  assert.equal(b.statusCode, 413)
  assert.equal(b.json().code, 'file_too_large')
  assert.match(b.json().error, /5 MB/)
  assert.equal(llmCalls, 0)
  assert.equal(db.writes.length, 0)
})

test('PDF pindai (tanpa teks): 422 pdf_no_text; PDF rusak: 422 pdf_unreadable', async () => {
  const scan = await upload(makePdf([[], []]))
  assert.equal(scan.statusCode, 422)
  assert.equal(scan.json().code, 'pdf_no_text')
  const broken = await upload(Buffer.from('%PDF-1.4\nrusak\n%%EOF'))
  assert.equal(broken.statusCode, 422)
  assert.equal(broken.json().code, 'pdf_unreadable')
  assert.equal(llmCalls, 0)
})

test('batas laju: permintaan ke-4 dalam semenit ditolak 429 rate_limited dengan Retry-After; tidak ada baris baru, model tidak dipanggil', async () => {
  db.rows('application_logs').push(...[10, 20, 30].map((s) => ({ user_id: 'u1', action: PROFILE_IMPORT_ACTION, status: 'success', created_at: ago(s) })))
  const res = await upload(fixturePdf())
  assert.equal(res.statusCode, 429)
  const body = res.json()
  assert.equal(body.code, 'rate_limited')
  assert.equal(body.success, false)
  assert.ok(body.retryAfterSec >= 1 && body.retryAfterSec <= 60)
  assert.equal(res.headers['retry-after'], String(body.retryAfterSec))
  assert.equal(llmCalls, 0)
  assert.equal(importRows().length, 3, 'permintaan yang ditolak tidak dicatat lagi')
})

test('batas laju per pengguna dan terpisah dari batas AI lain: pengguna lain dan baris ai_request tidak ikut terhitung', async () => {
  db.rows('application_logs').push(
    ...[10, 20, 30].map((s) => ({ user_id: 'u1', action: PROFILE_IMPORT_ACTION, status: 'success', created_at: ago(s) })),
    ...Array.from({ length: 20 }, () => ({ user_id: 'u2', action: 'ai_request', status: 'success', created_at: ago(5) })),
  )
  assert.equal((await upload(fixturePdf(), { 'x-test-user': 'u2' })).statusCode, 200, 'u2 hanya punya ai_request, impor tetap boleh')
  assert.equal((await upload(fixturePdf(), { 'x-test-user': 'u1' })).statusCode, 429)
  assert.equal(importRows('u2').length, 1)
})

test('batas per jam: 5 impor dalam sejam, di luar menit terakhir, tetap menolak yang ke-6', async () => {
  db.rows('application_logs').push(...[300, 600, 900, 1200, 1500].map((s) => ({ user_id: 'u1', action: PROFILE_IMPORT_ACTION, status: 'success', created_at: ago(s) })))
  const res = await upload(fixturePdf())
  assert.equal(res.statusCode, 429)
  assert.ok(res.json().retryAfterSec > 60)
})

test('batas laju tidak dapat diperiksa (database galat): 503 rate_limit_check_failed, ditolak demi keamanan', async () => {
  db.failOn('application_logs', 'select', 'db down')
  const res = await upload(fixturePdf())
  assert.equal(res.statusCode, 503)
  assert.equal(res.json().code, 'rate_limit_check_failed')
  assert.equal(llmCalls, 0)
})

test('galat tak terduga: 500 generik, pesan internal dan isi PDF tidak bocor', async () => {
  importerError = new Error('boom: Rina Kusuma Wardhani rina.sintetis@example.com')
  const res = await upload(fixturePdf())
  assert.equal(res.statusCode, 500)
  assert.equal(res.json().success, false)
  assert.ok(!res.body.includes('Rina') && !res.body.includes('example.com'))
})

test('CORS: preflight dari browser (Content-Type application/pdf + Authorization, tanpa token) lolos; POST tanpa token tetap 401', async () => {
  // Content-Type application/pdf bukan tipe aman CORS, jadi browser selalu mengirim OPTIONS lebih dulu, tanpa Authorization.
  // Hook 401 milik rute impor tidak boleh menghadang preflight itu.
  const origin = 'https://applify.example'
  const withCors = Fastify()
  await withCors.register(cors, { origin: (o, cb) => cb(null, isOriginAllowed(o, parseAllowedOrigins(origin))), credentials: true })
  withCors.addHook('preHandler', async (req) => {
    ;(req as any).user = { id: 'u1' }
  })
  await withCors.register(profileImportRoutes, { prefix: '/api/profile', guard: { checkImportRate: async () => {} } as any, importer: { importFromPdf: async () => ({}) } as any })
  const pre = await withCors.inject({
    method: 'OPTIONS',
    url: '/api/profile/import/linkedin-pdf',
    headers: { origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization,content-type' },
  })
  assert.equal(pre.statusCode, 204)
  assert.equal(pre.headers['access-control-allow-origin'], origin)
  assert.match(String(pre.headers['access-control-allow-headers']), /authorization/i)
  assert.match(String(pre.headers['access-control-allow-headers']), /content-type/i)
  const noToken = await withCors.inject({ method: 'POST', url: '/api/profile/import/linkedin-pdf', payload: fixturePdf(), headers: { origin, 'content-type': 'application/pdf' } })
  assert.equal(noToken.statusCode, 401)
  await withCors.close()
})

test('batas impor: bawaan 3 per menit dan 10 per jam; lingkungan hanya menerima bilangan bulat positif', () => {
  assert.deepEqual(DEFAULT_IMPORT_LIMITS, { perMinute: 3, perHour: 10 })
  assert.deepEqual(importLimitsFromEnv({}), { perMinute: 3, perHour: 10 })
  assert.deepEqual(importLimitsFromEnv({ PROFILE_IMPORT_RATE_LIMIT_PER_MINUTE: '5', PROFILE_IMPORT_RATE_LIMIT_PER_HOUR: '20' }), { perMinute: 5, perHour: 20 })
  assert.deepEqual(importLimitsFromEnv({ PROFILE_IMPORT_RATE_LIMIT_PER_MINUTE: '0', PROFILE_IMPORT_RATE_LIMIT_PER_HOUR: 'abc' }), { perMinute: 3, perHour: 10 })
})

// ───────────────────────────────────────────────────────────── pengaitan (teks sumber)

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8')

test('pengaitan: rute didaftarkan di bawah /api/profile DI DALAM lingkup authMiddleware', () => {
  const src = read('../api/index.ts')
  const authAt = src.indexOf("app.addHook('preHandler', authMiddleware)")
  const routeAt = src.indexOf("app.register(profileImportRoutes, { prefix: '/api/profile' })")
  const publicAt = src.indexOf('// Public routes')
  assert.ok(authAt > 0 && routeAt > authAt && routeAt < publicAt, 'rute impor harus terdaftar sesudah hook auth dan sebelum rute publik')
})

test('pengaitan: rute dan layanan impor tidak menulis ke database sama sekali (tulisan hanya lewat penjaga batas laju)', () => {
  for (const file of ['../api/routes/profile-import.ts', '../services/linkedin-import.service.ts', '../services/linkedin-import.ts', '../services/linkedin-pdf.ts']) {
    const src = read(file).replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')
    assert.doesNotMatch(src, /\bsupabase\b|\.insert\(|\.upsert\(|\.update\(|\.delete\(|\.from\(|writeFile|createWriteStream|\.storage\b/, `${file} tidak boleh menulis ke database, Storage, atau disk`)
  }
})

test('pengaitan: batas laju impor tidak memeriksa atau memakai kuota draf', () => {
  const src = read('../services/ai-guard.service.ts')
  const start = src.indexOf('async checkImportRate')
  const end = src.indexOf('async recordDraft')
  const body = src.slice(start, end)
  assert.ok(start > 0 && end > start)
  assert.doesNotMatch(body.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, ''), /get_quota_status|rpc\(|recordDraft|AI_DRAFT_ACTION|AI_REQUEST_ACTION/)
})
