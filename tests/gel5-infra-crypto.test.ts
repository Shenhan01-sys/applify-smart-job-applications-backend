import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Fastify from 'fastify'
import { decrypt, encrypt, signState } from '../services/token-crypto.js'
import { DEFAULT_SECURITY_HEADERS, installSecurityHeaders, trustProxyFromEnv } from '../services/security-headers.js'
import { REDACTED, serializeRequestForLog } from '../services/log-redact.js'
import { installProcessGuards } from '../services/graceful-shutdown.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

describe('Gelombang 5 infra & crypto hardening (BS-U4-05, BS-08.1, J5-10, J5-18, H-08, H-16)', () => {
  it('BS-U4-05 & BS-U4-08: token-crypto menolak payload < 28 byte, mendukung kunci rotasi, dan pesan galat akurat', () => {
    const prevKey = process.env.OAUTH_TOKEN_ENCRYPTION_KEY
    const prevSess = process.env.SESSION_ENCRYPTION_KEY
    const prevOld = process.env.OAUTH_TOKEN_ENCRYPTION_KEY_PREVIOUS
    try {
      delete process.env.OAUTH_TOKEN_ENCRYPTION_KEY
      delete process.env.SESSION_ENCRYPTION_KEY
      delete process.env.OAUTH_TOKEN_ENCRYPTION_KEY_PREVIOUS
      assert.throws(() => signState({ a: 1 }), /OAUTH_TOKEN_ENCRYPTION_KEY/)

      process.env.OAUTH_TOKEN_ENCRYPTION_KEY = 'old-secret-0123456789abcdef0123456789'
      const encryptedOld = encrypt('gmail-refresh-token-v1')

      process.env.OAUTH_TOKEN_ENCRYPTION_KEY = 'new-secret-0123456789abcdef0123456789'
      process.env.OAUTH_TOKEN_ENCRYPTION_KEY_PREVIOUS = 'old-secret-0123456789abcdef0123456789'
      assert.equal(decrypt(encryptedOld), 'gmail-refresh-token-v1')
      assert.throws(() => decrypt(Buffer.from('tiny').toString('base64')), /invalid encrypted token payload/)
    } finally {
      if (prevKey === undefined) delete process.env.OAUTH_TOKEN_ENCRYPTION_KEY
      else process.env.OAUTH_TOKEN_ENCRYPTION_KEY = prevKey
      if (prevSess === undefined) delete process.env.SESSION_ENCRYPTION_KEY
      else process.env.SESSION_ENCRYPTION_KEY = prevSess
      if (prevOld === undefined) delete process.env.OAUTH_TOKEN_ENCRYPTION_KEY_PREVIOUS
      else process.env.OAUTH_TOKEN_ENCRYPTION_KEY_PREVIOUS = prevOld
    }
  })

  it('BS-08.1 & J5-18: installSecurityHeaders memasang semua header keamanan tanpa menimpa header rute', async () => {
    const app = Fastify({ logger: false })
    installSecurityHeaders(app)
    app.get('/ping', async () => ({ ok: true }))
    app.get('/custom', async (_req, reply) => {
      reply.header('x-frame-options', 'SAMEORIGIN')
      return { ok: true }
    })

    const r1 = await app.inject({ method: 'GET', url: '/ping' })
    for (const [k, v] of Object.entries(DEFAULT_SECURITY_HEADERS)) {
      assert.equal(r1.headers[k], v)
    }
    const r2 = await app.inject({ method: 'GET', url: '/custom' })
    assert.equal(r2.headers['x-frame-options'], 'SAMEORIGIN')
    assert.equal(r2.headers['x-content-type-options'], 'nosniff')
    await app.close()
  })

  it('BS-08.1: trustProxyFromEnv aktif di produksi/Railway dan mematuhi TRUST_PROXY', () => {
    assert.equal(trustProxyFromEnv({ NODE_ENV: 'production' }), true)
    assert.equal(trustProxyFromEnv({ RAILWAY_ENVIRONMENT: 'production' }), true)
    assert.equal(trustProxyFromEnv({ NODE_ENV: 'development' }), false)
    assert.equal(trustProxyFromEnv({ NODE_ENV: 'production', TRUST_PROXY: 'false' }), false)
    assert.equal(trustProxyFromEnv({ NODE_ENV: 'development', TRUST_PROXY: '2' }), 2)
  })

  it('H-16: serializeRequestForLog menyamarkan IP klien (remoteAddress)', () => {
    const out = serializeRequestForLog({ method: 'GET', url: '/health', ip: '203.0.113.42', headers: {} })
    assert.equal(out.remoteAddress, REDACTED)
    assert.equal(JSON.stringify(out).includes('203.0.113.42'), false)
  })

  it('H-08: installProcessGuards mencatat pesan FATAL dan memanggil exit(1)', () => {
    const handlers = new Map<string, (err: unknown) => void>()
    const logs: string[] = []
    let exitCode: number | null = null
    installProcessGuards(
      { error: (msg) => logs.push(msg) },
      {
        on: (ev, fn) => handlers.set(ev, fn),
        exit: (code) => {
          exitCode = code
        },
      }
    )
    assert.ok(handlers.has('unhandledRejection'))
    assert.ok(handlers.has('uncaughtException'))
    handlers.get('unhandledRejection')!(new Error('boom-db'))
    assert.equal(exitCode, 1)
    assert.match(logs[0], /FATAL unhandledRejection: Error: boom-db/)
  })

  it('J5-10: salinan cover-letter PDF backend dan worker identik pada seluruh isi logika', () => {
    const backendPath = path.resolve(__dirname, '../services/cover-letter-pdf.ts')
    const workerPath = path.resolve(__dirname, '../../worker/src/lib/coverLetterPdf.ts')
    assert.ok(existsSync(backendPath), 'backend cover-letter-pdf.ts harus ada')
    if (existsSync(workerPath)) {
      const stripHeader = (s: string) => s.replace(/^(?:\/\/[^\n]*\n)+/, '').trim()
      assert.equal(stripHeader(readFileSync(backendPath, 'utf8')), stripHeader(readFileSync(workerPath, 'utf8')))
    }
  })
})
