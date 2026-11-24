import test from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import { installEmptyJsonBodyGuard, isEmptyJsonRequest } from '../services/empty-json-body.js'

async function buildApp() {
  const app = Fastify()
  installEmptyJsonBodyGuard(app)
  app.post('/echo', async (request) => ({ body: request.body ?? null }))
  await app.ready()
  return app
}

test('POST JSON tanpa isi (pola tombol Hubungkan Gmail) diterima, bukan 400 FST_ERR_CTP_EMPTY_JSON_BODY', async () => {
  const app = await buildApp()
  const res = await app.inject({ method: 'POST', url: '/echo', headers: { 'content-type': 'application/json', 'content-length': '0' } })
  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.json(), { body: null })
  await app.close()
})

test('badan JSON berisi tetap diurai pengurai bawaan, JSON rusak tetap 400', async () => {
  const app = await buildApp()
  const ok = await app.inject({ method: 'POST', url: '/echo', headers: { 'content-type': 'application/json' }, payload: '{"a":1}' })
  assert.deepEqual(ok.json(), { body: { a: 1 } })
  const bad = await app.inject({ method: 'POST', url: '/echo', headers: { 'content-type': 'application/json' }, payload: '{rusak' })
  assert.equal(bad.statusCode, 400)
  const proto = await app.inject({ method: 'POST', url: '/echo', headers: { 'content-type': 'application/json' }, payload: '{"__proto__":{"x":1}}' })
  assert.equal(proto.statusCode, 400)
  await app.close()
})

test('isEmptyJsonRequest hanya untuk JSON dengan Content-Length 0', () => {
  assert.equal(isEmptyJsonRequest({ 'content-type': 'application/json; charset=utf-8', 'content-length': '0' }), true)
  assert.equal(isEmptyJsonRequest({ 'content-type': 'application/json', 'content-length': '2' }), false)
  assert.equal(isEmptyJsonRequest({ 'content-type': 'text/plain', 'content-length': '0' }), false)
  assert.equal(isEmptyJsonRequest({}), false)
})
