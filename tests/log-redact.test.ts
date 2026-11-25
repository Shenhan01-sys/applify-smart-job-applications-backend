import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import Fastify from 'fastify'
import { REDACTED, redactUrlForLog, requestLogSerializers } from '../services/log-redact.js'

/**
 * H-01 (audit 26 Nov 2026): Fastify mencatat `req.url` lengkap, jadi ?code=, ?state=, ?ticket=, dan ?token= masuk
 * stdout produksi. `logger.serializers.req` menyamarkan nilainya. Tes ini mengirim permintaan sungguhan ke app
 * Fastify dengan stream penangkap, lalu memastikan rahasia tidak muncul di log mana pun.
 */

const SECRET = 'SUPER-SECRET-VALUE-123'

async function captureLogs(url: string) {
  const lines: string[] = []
  const stream = { write: (chunk: string) => void lines.push(chunk) }
  const app = Fastify({ logger: { level: 'info', stream, serializers: requestLogSerializers } })
  app.get('/api/oauth/google/callback', async () => ({ ok: true }))
  app.get('/api/oauth/google/start', async () => ({ ok: true }))
  app.get('/api/extension/poll', async () => ({ ok: true }))
  const res = await app.inject({ method: 'GET', url })
  await app.close()
  return { res, text: lines.join('') }
}

test('callback OAuth: code, state, dan ticket tidak pernah masuk log, parameter lain tetap', async () => {
  const { res, text } = await captureLogs(
    `/api/oauth/google/callback?code=${SECRET}&state=${SECRET}&ticket=${SECRET}&scope=email&error=access_denied`,
  )
  assert.equal(res.statusCode, 200)
  assert.match(text, /incoming request/)
  assert.equal(text.includes(SECRET), false, 'rahasia bocor ke log')
  assert.match(text, /code=\[REDACTED\]/)
  assert.match(text, /state=\[REDACTED\]/)
  assert.match(text, /ticket=\[REDACTED\]/)
  assert.match(text, /scope=email/)
  assert.match(text, /error=access_denied/)
  assert.match(text, /\/api\/oauth\/google\/callback/)
})

test('token ekstensi di query tidak masuk log, termasuk nama parameter berhuruf besar dan terenkode', async () => {
  const { text: a } = await captureLogs(`/api/extension/poll?token=${SECRET}`)
  assert.equal(a.includes(SECRET), false)
  const { text: b } = await captureLogs(`/api/extension/poll?TOKEN=${SECRET}&Ticket=${SECRET}`)
  assert.equal(b.includes(SECRET), false)
  const { text: c } = await captureLogs(`/api/extension/poll?%74oken=${SECRET}`)
  assert.equal(c.includes(SECRET), false)
})

test('redactUrlForLog: tanpa query tetap sama, nilai ganda dan fragment ikut ditangani', () => {
  assert.equal(redactUrlForLog('/api/health'), '/api/health')
  assert.equal(redactUrlForLog('/a?page=2&limit=50'), '/a?page=2&limit=50')
  assert.equal(redactUrlForLog('/a?code=x&code=y&keep=1'), `/a?code=${REDACTED}&code=${REDACTED}&keep=1`)
  assert.equal(redactUrlForLog('/a?code=x#frag'), `/a?code=${REDACTED}`)
  assert.equal(redactUrlForLog('/a?access_token=x&refresh_token=y&id_token=z'), `/a?access_token=${REDACTED}&refresh_token=${REDACTED}&id_token=${REDACTED}`)
  assert.equal(redactUrlForLog('/a?code'), `/a?code=${REDACTED}`)
  assert.equal(redactUrlForLog('/a?%E0%A4%A=1&state=s'), `/a?%E0%A4%A=1&state=${REDACTED}`)
  assert.equal(redactUrlForLog(undefined as any), undefined)
})

test('api/index.ts memasang requestLogSerializers di logger produksi maupun lokal', () => {
  const src = readFileSync(new URL('../api/index.ts', import.meta.url), 'utf8')
  assert.match(src, /import \{ requestLogSerializers \} from '..\/services\/log-redact\.js'/)
  assert.equal((src.match(/serializers: requestLogSerializers/g) ?? []).length, 2)
  assert.doesNotMatch(src, /\? true\b/, 'logger produksi tidak boleh kembali ke `true` tanpa serializer')
})
