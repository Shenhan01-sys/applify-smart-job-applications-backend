import test from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import cors from '@fastify/cors'
import { extensionRoutes } from '../api/routes/extension.js'
import { buildCorsOptions } from '../services/cors-options.js'
import { ENV, makeExtensionTestDb, USER_ID } from './extension-test-db.js'

const NOW = new Date('2026-11-24T05:00:00Z')
const APPROVAL = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1'
const EXT_ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop'
const OTHER_EXT_ORIGIN = 'chrome-extension://ponmlkjihgfedcbaponmlkjihgfedcba'
const WEB_ORIGIN = 'https://applify.example'
const ROUTES = [
  { method: 'GET', url: `/api/extension/documents/${APPROVAL}/resume` },
  { method: 'POST', url: '/api/extension/answers' },
  { method: 'POST', url: '/api/extension/plan-form' },
  { method: 'POST', url: '/api/extension/report-run' },
]

async function build(corsEnv: Record<string, string | undefined>) {
  const store = makeExtensionTestDb({
    approval_requests: [{ id: APPROVAL, user_id: USER_ID, job_id: 'job-1', status: 'approved', expires_at: '2026-11-24T12:00:00Z', cover_letter: 'Halo' }],
    profiles: [{ id: USER_ID, full_name: 'Budi' }],
  })
  const app = Fastify()
  await app.register(cors, buildCorsOptions([WEB_ORIGIN], corsEnv))
  await app.register(extensionRoutes, {
    prefix: '/api/extension',
    db: store.db,
    env: ENV,
    now: () => NOW.getTime(),
    authenticatePrimary: async (req: any) => {
      req.user = { id: USER_ID }
    },
  })
  const token = (await app.inject({ method: 'POST', url: '/api/extension/token' })).json().token as string
  return { app, token }
}

const preflight = (app: Awaited<ReturnType<typeof build>>['app'], route: (typeof ROUTES)[number], origin: string) =>
  app.inject({
    method: 'OPTIONS',
    url: route.url,
    headers: { origin, 'access-control-request-method': route.method, 'access-control-request-headers': 'authorization,content-type' },
  })

test('CORS rute ekstensi baru: origin ekstensi resmi lolos preflight di semua rute (berkas, jawaban, rencana, laporan)', async () => {
  const { app } = await build({})
  for (const route of ROUTES) {
    const res = await preflight(app, route, EXT_ORIGIN)
    assert.equal(res.statusCode, 204, route.url)
    assert.equal(res.headers['access-control-allow-origin'], EXT_ORIGIN, route.url)
    assert.match(String(res.headers['access-control-allow-headers']), /authorization/i, route.url)
  }
})

test('CORS: aturan EXTENSION_ORIGINS dipakai untuk rute baru (ID lain dan origin web asing tidak diberi izin), produksi tanpa daftar menolak semua', async () => {
  const pinned = await build({ EXTENSION_ORIGINS: EXT_ORIGIN })
  for (const route of ROUTES) {
    assert.equal((await preflight(pinned.app, route, EXT_ORIGIN)).headers['access-control-allow-origin'], EXT_ORIGIN, route.url)
    assert.equal((await preflight(pinned.app, route, OTHER_EXT_ORIGIN)).headers['access-control-allow-origin'], undefined, route.url)
    assert.equal((await preflight(pinned.app, route, 'https://evil.example')).headers['access-control-allow-origin'], undefined, route.url)
    assert.equal((await preflight(pinned.app, route, WEB_ORIGIN)).headers['access-control-allow-origin'], WEB_ORIGIN, 'origin web sah tetap jalan')
  }
  const prod = await build({ NODE_ENV: 'production' })
  for (const route of ROUTES) {
    assert.equal((await preflight(prod.app, route, EXT_ORIGIN)).headers['access-control-allow-origin'], undefined, route.url)
  }
})

test('CORS: respons berkas dari origin ekstensi mengekspos Content-Disposition (nama berkas dapat dibaca); origin lain tidak mendapat izin', async () => {
  const { app, token } = await build({ EXTENSION_ORIGINS: EXT_ORIGIN })
  const ok = await app.inject({
    method: 'GET',
    url: `/api/extension/documents/${APPROVAL}/cover_letter`,
    headers: { origin: EXT_ORIGIN, authorization: `Bearer ${token}` },
  })
  assert.equal(ok.statusCode, 200)
  assert.equal(ok.headers['access-control-allow-origin'], EXT_ORIGIN)
  assert.match(String(ok.headers['access-control-expose-headers']), /Content-Disposition/i)
  assert.match(String(ok.headers['access-control-expose-headers']), /Retry-After/i)
  assert.match(String(ok.headers['content-disposition']), /^attachment; filename="/)

  const foreign = await app.inject({
    method: 'GET',
    url: `/api/extension/documents/${APPROVAL}/cover_letter`,
    headers: { origin: OTHER_EXT_ORIGIN, authorization: `Bearer ${token}` },
  })
  assert.equal(foreign.headers['access-control-allow-origin'], undefined)
})
