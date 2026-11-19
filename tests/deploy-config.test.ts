import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import Fastify from 'fastify'
import cors from '@fastify/cors'
import {
  DEFAULT_FRONTEND_ORIGIN,
  deployConfigWarnings,
  isOriginAllowed,
  normalizeOrigin,
  parseAllowedOrigins,
  primaryFrontendUrl,
} from '../services/deploy-config.ts'
import { chromiumExecutablePath, chromiumLaunchOptions } from '../mcp/shared/browser.ts'

const read = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8')
/** Buang komentar baris supaya pemeriksaan teks tidak terkecoh oleh penjelasan. */
const noComments = (s: string, marker = '#') =>
  s
    .split('\n')
    .filter((l) => !l.trim().startsWith(marker))
    .join('\n')

// ---- CORS dari FRONTEND_URL --------------------------------------------------------------------------

test('parseAllowedOrigins: daftar dipisah koma, spasi dan "/" di ujung dibuang, entri kosong dibuang', () => {
  assert.deepEqual(parseAllowedOrigins('https://app.vercel.app, http://localhost:5173/ ,,'), [
    'https://app.vercel.app',
    'http://localhost:5173',
  ])
  assert.deepEqual(parseAllowedOrigins('https://a.example'), ['https://a.example'])
})

test('parseAllowedOrigins: kosong atau tidak diset memakai bawaan lokal', () => {
  assert.deepEqual(parseAllowedOrigins(undefined), [DEFAULT_FRONTEND_ORIGIN])
  assert.deepEqual(parseAllowedOrigins(''), [DEFAULT_FRONTEND_ORIGIN])
  assert.deepEqual(parseAllowedOrigins(' , '), [DEFAULT_FRONTEND_ORIGIN])
})

test('isOriginAllowed: origin di daftar lolos, yang lain ditolak, tanpa Origin lolos', () => {
  const allowed = parseAllowedOrigins('https://app.vercel.app,http://localhost:5173')
  assert.equal(isOriginAllowed('https://app.vercel.app', allowed), true)
  assert.equal(isOriginAllowed('http://localhost:5173', allowed), true)
  assert.equal(isOriginAllowed('https://evil.example', allowed), false)
  assert.equal(isOriginAllowed('https://app.vercel.app.evil.example', allowed), false)
  assert.equal(isOriginAllowed('*', allowed), false)
  assert.equal(isOriginAllowed(undefined, allowed), true)
})

test('primaryFrontendUrl: origin pertama, dinormalkan; kosong memakai cadangan', () => {
  assert.equal(primaryFrontendUrl('https://a.example/, https://b.example', 'http://x'), 'https://a.example')
  assert.equal(primaryFrontendUrl(undefined, 'http://localhost:5173'), 'http://localhost:5173')
  assert.equal(primaryFrontendUrl(' , ', 'http://localhost:5173'), 'http://localhost:5173')
  assert.equal(normalizeOrigin('  https://a.example// '), 'https://a.example')
})

test('CORS lewat Fastify: preflight dari origin Vercel diterima, dari origin asing tidak diberi header izin', async () => {
  const allowed = parseAllowedOrigins('https://app.vercel.app, http://localhost:5173')
  const app = Fastify()
  await app.register(cors, {
    origin: (origin, cb) => cb(null, isOriginAllowed(origin, allowed)),
    credentials: true,
  })
  app.get('/health', async () => ({ status: 'ok' }))
  try {
    const ok = await app.inject({
      method: 'OPTIONS',
      url: '/health',
      headers: { origin: 'https://app.vercel.app', 'access-control-request-method': 'GET' },
    })
    assert.equal(ok.headers['access-control-allow-origin'], 'https://app.vercel.app')
    assert.equal(ok.headers['access-control-allow-credentials'], 'true')

    const bad = await app.inject({
      method: 'OPTIONS',
      url: '/health',
      headers: { origin: 'https://evil.example', 'access-control-request-method': 'GET' },
    })
    assert.equal(bad.headers['access-control-allow-origin'], undefined)

    const health = await app.inject({ method: 'GET', url: '/health' })
    assert.equal(health.statusCode, 200)
  } finally {
    await app.close()
  }
})

// ---- Peringatan konfigurasi produksi ------------------------------------------------------------------

test('deployConfigWarnings: di luar production kosong', () => {
  assert.deepEqual(deployConfigWarnings({ NODE_ENV: 'development' }), [])
  assert.deepEqual(deployConfigWarnings({}), [])
})

test('deployConfigWarnings: production tanpa FRONTEND_URL atau hanya localhost diperingatkan', () => {
  const none = deployConfigWarnings({ NODE_ENV: 'production' })
  assert.ok(none.some((w) => w.includes('FRONTEND_URL belum diisi')))
  const local = deployConfigWarnings({ NODE_ENV: 'production', FRONTEND_URL: 'http://localhost:3000,http://127.0.0.1:5173' })
  assert.ok(local.some((w) => w.includes('hanya berisi alamat lokal')))
  const good = deployConfigWarnings({ NODE_ENV: 'production', FRONTEND_URL: 'https://app.vercel.app,http://localhost:5173' })
  assert.deepEqual(good, [])
})

test('deployConfigWarnings: Gmail aktif tanpa GOOGLE_REDIRECT_URI, secret, atau kunci enkripsi diperingatkan (F10)', () => {
  const w = deployConfigWarnings({
    NODE_ENV: 'production',
    FRONTEND_URL: 'https://app.vercel.app',
    GOOGLE_CLIENT_ID: 'id',
  })
  assert.ok(w.some((x) => x.includes('GOOGLE_REDIRECT_URI')))
  assert.ok(w.some((x) => x.includes('GOOGLE_CLIENT_SECRET')))
  assert.ok(w.some((x) => x.includes('OAUTH_TOKEN_ENCRYPTION_KEY')))
  const ok = deployConfigWarnings({
    NODE_ENV: 'production',
    FRONTEND_URL: 'https://app.vercel.app',
    GOOGLE_CLIENT_ID: 'id',
    GOOGLE_CLIENT_SECRET: 's',
    GOOGLE_REDIRECT_URI: 'https://api.example/api/oauth/google/callback',
    SESSION_ENCRYPTION_KEY: 'k'.repeat(40),
  })
  assert.deepEqual(ok, [])
})

test('deployConfigWarnings: tidak pernah memuat nilai variabel', () => {
  const secret = 'rahasia-yang-tidak-boleh-bocor-123'
  const all = deployConfigWarnings({
    NODE_ENV: 'production',
    FRONTEND_URL: 'http://localhost:3000',
    GOOGLE_CLIENT_ID: secret,
    SESSION_ENCRYPTION_KEY: '',
  }).join('\n')
  assert.ok(all.length > 0)
  assert.ok(!all.includes(secret))
})

// ---- Chromium untuk Playwright ------------------------------------------------------------------------

test('chromiumLaunchOptions: executablePath hanya ditambahkan bila env diisi, opsi lain utuh', () => {
  const base = { headless: true, args: ['--no-sandbox'] }
  assert.deepEqual(chromiumLaunchOptions(base, {}), base)
  assert.deepEqual(chromiumLaunchOptions(base, { PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH: '  ' }), base)
  assert.deepEqual(chromiumLaunchOptions(base, { PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH: '/usr/bin/chromium' }), {
    ...base,
    executablePath: '/usr/bin/chromium',
  })
  assert.equal(chromiumExecutablePath({}), undefined)
})

test('klien LinkedIn dan Glints meluncurkan Chromium lewat chromiumLaunchOptions', () => {
  assert.match(read('mcp/linkedin/index.ts'), /chromium\.launch\(chromiumLaunchOptions\(/)
  assert.match(read('mcp/glints/index.ts'), /chromium\.launch\(chromiumLaunchOptions\(/)
})

// ---- Berkas deploy -----------------------------------------------------------------------------------

test('Dockerfile: tahap build memasang devDependencies, tahap akhir hanya dependency produksi (F8a)', () => {
  const d = noComments(read('Dockerfile'))
  const [, afterBuild] = d.split(/FROM node:22-alpine AS build/)
  const buildStage = afterBuild.split(/FROM node:22-alpine AS prod-deps/)[0]
  assert.match(buildStage, /RUN npm ci\s*\n/)
  assert.doesNotMatch(buildStage, /--omit=dev|--only=production/)
  assert.match(buildStage, /RUN npm run build/)
  assert.match(d, /RUN npm ci --omit=dev/)
  // tahap akhir menyalin node_modules dari prod-deps, bukan dari build
  assert.match(d, /COPY --from=prod-deps[^\n]*\/app\/node_modules/)
  assert.doesNotMatch(d, /COPY --from=build[^\n]*node_modules/)
})

test('Dockerfile: config/job-boards.json ikut image, path Chromium benar, PORT dan CMD benar (F8c, F8d)', () => {
  const d = noComments(read('Dockerfile'))
  assert.match(d, /COPY [^\n]*\bconfig \.\/config/)
  assert.match(d, /PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=\/usr\/bin\/chromium\b/)
  assert.doesNotMatch(d, /chromium-browser/)
  assert.match(d, /CMD \["node", "dist\/api\/index\.js"\]/)
  assert.match(d, /process\.env\.PORT/)
})

test('.dockerignore membuang .env, node_modules, dist, .git (F8b)', () => {
  const lines = read('.dockerignore')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
  for (const need of ['.env', 'node_modules', 'dist', '.git']) {
    assert.ok(lines.includes(need), `.dockerignore harus memuat ${need}`)
  }
  assert.ok(!lines.includes('config'), 'config/ tidak boleh dibuang: dibaca saat jalan')
})

test('package-lock.json ikut di git supaya `npm ci` di Dockerfile bisa jalan', () => {
  const lines = read('.gitignore')
    .split('\n')
    .map((l) => l.trim())
  assert.ok(!lines.includes('package-lock.json'))
})

test('api/index.ts: listen di 0.0.0.0 dengan PORT dari env, /health ada, tanpa localhost ter-hardcode di Swagger (F9)', () => {
  const src = read('api/index.ts')
  const code = src
    .split('\n')
    .filter((l) => !l.trim().startsWith('//'))
    .join('\n')
  assert.match(code, /Number\(process\.env\.PORT\)/)
  assert.match(code, /host:\s*'0\.0\.0\.0'/)
  assert.match(code, /app\.get\('\/health'/)
  assert.match(code, /parseAllowedOrigins\(process\.env\.FRONTEND_URL\)/)
  assert.doesNotMatch(code, /url:\s*'http:\/\/localhost:4000'/)
})

test('docker-compose backend: tanpa layanan worker yang salah dan tanpa Redis terbuka (F6, F7)', () => {
  const c = noComments(read('docker-compose.yml'))
  assert.doesNotMatch(c, /queue\.service\.js/)
  assert.doesNotMatch(c, /6379/)
  assert.doesNotMatch(c, /redis/i)
})

test('ecosystem.config.cjs: tanpa worker queue.service.js, tanpa wait_ready, tanpa placeholder deploy (F6, F20)', () => {
  const e = noComments(read('ecosystem.config.cjs'), '//')
  assert.doesNotMatch(e, /queue\.service\.js/)
  assert.doesNotMatch(e, /wait_ready/)
  assert.doesNotMatch(e, /your-aws-ip/)
  assert.doesNotMatch(e, /deploy:/)
})
