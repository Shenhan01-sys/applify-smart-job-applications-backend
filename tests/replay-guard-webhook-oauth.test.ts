import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import Fastify from 'fastify'
import { readFileSync } from 'node:fs'
import { consumeReplayToken } from '../services/replay-guard.service.js'
import { extractKapsoWebhookDeliveryId, verifyKapsoWebhookTimestamp } from '../services/kapso-whatsapp.service.js'
import { whatsappWebhookRoutes } from '../api/routes/notifications.js'
import { oauthRoutes } from '../api/routes/oauth.js'

test('BS-08.2 & BS-05.2 replay-guard: memakai tabel DB lintas-instans bila tersedia, fallback ke memori bila tabel belum ada', async () => {
  const inserted = new Set<string>()
  const dbWithTable = {
    from(table: string) {
      assert.equal(table, 'security_replay_tokens')
      return {
        async insert(row: { scope: string; token_id: string }) {
          const k = `${row.scope}:${row.token_id}`
          if (inserted.has(k)) return { error: { code: '23505', message: 'duplicate key value violates unique constraint' } }
          inserted.add(k)
          return { error: null }
        },
      }
    },
  }

  // Instans A memakai token -> sukses lewat DB
  const r1 = await consumeReplayToken(dbWithTable, {
    scope: 'oauth_start_ticket',
    tokenId: 'jti-123',
    expiresAtMs: Date.now() + 60_000,
    fallbackMap: new Map(),
  })
  assert.deepEqual(r1, { consumed: true, duplicate: false, store: 'db' })

  // Instans B (fallbackMap kosong!) mencoba token yang sama -> ditolak oleh kunci unik DB!
  const r2 = await consumeReplayToken(dbWithTable, {
    scope: 'oauth_start_ticket',
    tokenId: 'jti-123',
    expiresAtMs: Date.now() + 60_000,
    fallbackMap: new Map(),
  })
  assert.deepEqual(r2, { consumed: false, duplicate: true, store: 'db' })

  // Tabel belum ada di DB (sebelum migrasi) -> fallback ke memori tanpa melempar
  const dbMissingTable = {
    from() {
      return {
        async insert() {
          return { error: { code: '42P01', message: 'relation "public.security_replay_tokens" does not exist' } }
        },
      }
    },
  }
  const sharedMem = new Map<string, number>()
  const m1 = await consumeReplayToken(dbMissingTable, {
    scope: 'kapso_webhook',
    tokenId: 'msg-1',
    expiresAtMs: Date.now() + 60_000,
    fallbackMap: sharedMem,
  })
  assert.deepEqual(m1, { consumed: true, duplicate: false, store: 'memory' })
  const m2 = await consumeReplayToken(dbMissingTable, {
    scope: 'kapso_webhook',
    tokenId: 'msg-1',
    expiresAtMs: Date.now() + 60_000,
    fallbackMap: sharedMem,
  })
  assert.deepEqual(m2, { consumed: false, duplicate: true, store: 'memory' })
})

test('BS-05.2 webhook Kapso: tolak timestamp basi (> 5 menit) dan deduplikasi replay payload yang sama', async () => {
  const now = new Date('2026-11-26T00:30:00Z')
  const freshTs = String(Math.floor(now.getTime() / 1000) - 30)
  const staleTs = String(Math.floor(now.getTime() / 1000) - 600)

  assert.equal(verifyKapsoWebhookTimestamp({ 'x-webhook-timestamp': freshTs }, now).ok, true)
  assert.deepEqual(verifyKapsoWebhookTimestamp({ 'x-webhook-timestamp': staleTs }, now), {
    ok: false,
    reason: 'timestamp_expired',
  })
  assert.deepEqual(verifyKapsoWebhookTimestamp({ 'x-webhook-timestamp': 'not-a-ts' }, now), {
    ok: false,
    reason: 'invalid_timestamp',
  })

  const secret = 'kapso-test-secret-0123456789'
  const rawBody = Buffer.from(
    JSON.stringify({
      type: 'whatsapp.message.received',
      message: { id: 'wamid-replay-1', from: '+6281234567890' },
    }),
    'utf8'
  )
  assert.equal(extractKapsoWebhookDeliveryId(rawBody, {}, JSON.parse(rawBody.toString('utf8'))), 'msg:wamid-replay-1')

  const sig = crypto.createHmac('sha256', secret).update(rawBody).digest('hex')
  let inboundUpdates = 0
  const fakeDb: any = {
    from(table: string) {
      if (table === 'security_replay_tokens') {
        return { async insert() { return { error: { code: '42P01', message: 'relation does not exist' } } } }
      }
      return {
        update() {
          inboundUpdates++
          return {
            eq() { return this },
            select: async () => ({ data: [{ id: 'pref-1' }], error: null }),
          }
        },
      }
    },
  }

  const app = Fastify()
  await app.register(whatsappWebhookRoutes, {
    prefix: '/api/notifications',
    db: fakeDb,
    env: { KAPSO_WEBHOOK_SECRET: secret },
    now: () => now,
  })

  // Timestamp basi -> 401
  const rStale = await app.inject({
    method: 'POST',
    url: '/api/notifications/whatsapp/webhook',
    headers: {
      'content-type': 'application/json',
      'x-webhook-signature': sig,
      'x-webhook-timestamp': staleTs,
    },
    payload: rawBody,
  })
  assert.equal(rStale.statusCode, 401)
  assert.equal(inboundUpdates, 0)

  // Pengiriman pertama -> 200 updated: 1
  const r1 = await app.inject({
    method: 'POST',
    url: '/api/notifications/whatsapp/webhook',
    headers: {
      'content-type': 'application/json',
      'x-webhook-signature': sig,
      'x-webhook-timestamp': freshTs,
    },
    payload: rawBody,
  })
  assert.equal(r1.statusCode, 200)
  assert.equal(r1.json().updated, 1)

  // Replay pengiriman kedua -> 200 duplicate: true, updated: 0 (tidak memperpanjang jendela 24 jam)
  const r2 = await app.inject({
    method: 'POST',
    url: '/api/notifications/whatsapp/webhook',
    headers: {
      'content-type': 'application/json',
      'x-webhook-signature': sig,
      'x-webhook-timestamp': freshTs,
    },
    payload: rawBody,
  })
  assert.equal(r2.statusCode, 200)
  assert.equal(r2.json().duplicate, true)
  assert.equal(r2.json().updated, 0)
  assert.equal(inboundUpdates, 1)
  await app.close()
})

test('BS-08.2 OAuth start ticket menolak replay lintas dua instans server lewat tabel security_replay_tokens', async () => {
  const prevKey = process.env.SESSION_ENCRYPTION_KEY
  process.env.SESSION_ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
  const sharedTokens = new Set<string>()
  const sharedDb: any = {
    from(table: string) {
      if (table === 'security_replay_tokens') {
        return {
          async insert(row: { scope: string; token_id: string }) {
            const k = `${row.scope}:${row.token_id}`
            if (sharedTokens.has(k)) return { error: { code: '23505', message: 'duplicate key' } }
            sharedTokens.add(k)
            return { error: null }
          },
        }
      }
      return { select() { return this }, eq() { return this }, maybeSingle: async () => ({ data: null, error: null }) }
    },
  }

  const env = {
    GOOGLE_CLIENT_ID: 'client-123',
    GOOGLE_CLIENT_SECRET: 'secret-123',
    GOOGLE_REDIRECT_URI: 'https://api.applify.test/api/oauth/google/callback',
    FRONTEND_URL: 'https://applify.test',
    SESSION_ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  }

  const appA = Fastify()
  const appB = Fastify()
  try {
    await appA.register(oauthRoutes, { prefix: '/api/oauth', db: sharedDb, env, resolveUserId: async () => 'user-1' })
    await appB.register(oauthRoutes, { prefix: '/api/oauth', db: sharedDb, env, resolveUserId: async () => 'user-1' })

    const initRes = await appA.inject({ method: 'POST', url: '/api/oauth/google/init' })
    assert.equal(initRes.statusCode, 200)
    const startUrl = new URL(initRes.json().url)
    const startPathAndQuery = `${startUrl.pathname}${startUrl.search}`

    // Instans A memakai tiket -> redirect ke Google
    const rA = await appA.inject({ method: 'GET', url: startPathAndQuery })
    assert.equal(rA.statusCode, 302)
    assert.match(String(rA.headers.location), /^https:\/\/accounts\.google\.com\//)

    // Instans B mencoba replay tiket yang sama -> ditolak ke invalid_state!
    const rB = await appB.inject({ method: 'GET', url: startPathAndQuery })
    assert.equal(rB.statusCode, 302)
    assert.match(String(rB.headers.location), /reason=invalid_state/)

    // Pastikan berkas draf SQL migrasi memuat tabel & RLS service_role only
    const sql = readFileSync(new URL('../../database/migrations/DRAFT_2026-11-26_security_replay_tokens.sql', import.meta.url), 'utf8')
    assert.match(sql, /CREATE TABLE IF NOT EXISTS public\.security_replay_tokens/)
    assert.match(sql, /ENABLE ROW LEVEL SECURITY/)
    assert.match(sql, /REVOKE ALL ON TABLE public\.security_replay_tokens FROM PUBLIC, anon, authenticated/)
  } finally {
    await appA.close()
    await appB.close()
    if (prevKey === undefined) delete process.env.SESSION_ENCRYPTION_KEY
    else process.env.SESSION_ENCRYPTION_KEY = prevKey
  }
})
