import test from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import { extensionRoutes } from '../api/routes/extension.js'
import { makeExtensionTestDb } from './extension-test-db.js'

const USER_ID = '11111111-2222-3333-4444-555555555555'
const ENV = { SESSION_ENCRYPTION_KEY: 'super_secret_session_key_minimum_32_characters_long' }

function buildApp(db: any, nowMs = Date.parse('2026-11-23T12:00:00Z')) {
  const app = Fastify()
  app.register(extensionRoutes, {
    prefix: '/api/extension',
    db,
    env: ENV,
    now: () => nowMs,
    authenticatePrimary: async (req: any) => {
      req.user = { id: USER_ID }
    },
  })
  return app
}

test('POST /api/extension/revoke-all mencabut seluruh token v1 lama dan menerbitkan ver baru', async () => {
  const store = makeExtensionTestDb({ user_extension_revocations: [] })
  const app = buildApp(store.db)

  const tok1 = (await app.inject({ method: 'POST', url: '/api/extension/token' })).json()
  assert.equal(tok1.tokenVersion, 1)

  const okBefore = await app.inject({
    method: 'GET',
    url: '/api/extension/pending-approvals',
    headers: { authorization: `Bearer ${tok1.token}` },
  })
  assert.equal(okBefore.statusCode, 200)

  const rev = await app.inject({ method: 'POST', url: '/api/extension/revoke-all' })
  assert.equal(rev.statusCode, 200)
  assert.deepEqual(rev.json(), { revoked: true, minTokenVersion: 2 })

  // Token v1 lama langsung ditolak (401 token_revoked)
  const blocked = await app.inject({
    method: 'GET',
    url: '/api/extension/pending-approvals',
    headers: { authorization: `Bearer ${tok1.token}` },
  })
  assert.equal(blocked.statusCode, 401)
  assert.equal(blocked.json().code, 'token_revoked')

  // Token baru (ver 2) tetap lolos
  const tok2 = (await app.inject({ method: 'POST', url: '/api/extension/token' })).json()
  assert.equal(tok2.tokenVersion, 2)
  const okAfter = await app.inject({
    method: 'GET',
    url: '/api/extension/pending-approvals',
    headers: { authorization: `Bearer ${tok2.token}` },
  })
  assert.equal(okAfter.statusCode, 200)
})

test('revoke-all gagal tertutup (503) bila tabel user_extension_revocations belum dimigrasi, sementara penerbitan token tetap aman', async () => {
  const store = makeExtensionTestDb({}, {
    failTables: { user_extension_revocations: { code: '42P01', message: 'relation "user_extension_revocations" does not exist' } },
  })
  const app = buildApp(store.db)

  const tok = await app.inject({ method: 'POST', url: '/api/extension/token' })
  assert.equal(tok.statusCode, 200)

  const list = await app.inject({
    method: 'GET',
    url: '/api/extension/pending-approvals',
    headers: { authorization: `Bearer ${tok.json().token}` },
  })
  assert.equal(list.statusCode, 200)

  const rev = await app.inject({ method: 'POST', url: '/api/extension/revoke-all' })
  assert.equal(rev.statusCode, 503)
  assert.equal(rev.json().code, 'revocation_unavailable')
})
