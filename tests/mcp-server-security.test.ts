import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import {
  DEFAULT_MCP_HOST,
  MAX_MCP_BODY_BYTES,
  MAX_MCP_LIMIT_PER_SOURCE,
  MAX_MCP_PLATFORMS,
  buildServer,
  createMcpHttpServer,
  isAllowedHostHeader,
  isAllowedOriginHeader,
  isLoopbackHost,
} from '../mcp/server.js'

/**
 * BS-P1-01 & BS-P1-03 (audit 26 Nov 2026):
 *   - Default bind 127.0.0.1; bind non-loopback tanpa APPLIFY_JOBS_MCP_TOKEN ditolak saat start.
 *   - Token auth wajib saat dikonfigurasi (401 jika kosong/salah).
 *   - Header Origin eksternal dan Host non-internal ditolak (403).
 *   - Body > 256 KB ditolak (413), JSON rusak ditolak (400), dan rate limit mengembalikan 429 + Retry-After.
 *   - Skema tool search_all_platforms membatasi platforms <= 10 dan limitPerSource <= 25.
 */

function sendRawRequest(
  port: number,
  opts: {
    method?: string
    path?: string
    headers?: Record<string, string>
    body?: string
  } = {},
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method: opts.method ?? 'POST',
        path: opts.path ?? '/mcp',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          ...(opts.headers ?? {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c) => chunks.push(c as Buffer))
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          })
        })
      },
    )
    req.on('error', reject)
    if (opts.body !== undefined) req.write(opts.body)
    req.end()
  })
}

async function listenLocal(server: http.Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  return (server.address() as AddressInfo).port
}

async function closeServer(server: http.Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()))
}

test('BS-P1-01: default host 127.0.0.1 dan menolak bind non-loopback tanpa APPLIFY_JOBS_MCP_TOKEN', () => {
  assert.equal(DEFAULT_MCP_HOST, '127.0.0.1')
  assert.equal(isLoopbackHost('127.0.0.1'), true)
  assert.equal(isLoopbackHost('localhost'), true)
  assert.equal(isLoopbackHost('::1'), true)
  assert.equal(isLoopbackHost('0.0.0.0'), false)

  assert.throws(
    () => createMcpHttpServer({ host: '0.0.0.0', token: '' }),
    /APPLIFY_JOBS_MCP_TOKEN/,
  )

  const ok = createMcpHttpServer({ host: '0.0.0.0', token: 'rahasia-internal-kuat' })
  ok.close()

  assert.equal(isAllowedHostHeader('127.0.0.1:8090'), true)
  assert.equal(isAllowedHostHeader('localhost:8090'), true)
  assert.equal(isAllowedHostHeader('evil.example:8090'), false)
  assert.equal(isAllowedHostHeader('mcp.internal:8090', new Set(['mcp.internal'])), true)
  assert.equal(isAllowedOriginHeader(undefined), true)
  assert.equal(isAllowedOriginHeader('https://evil.example'), false)
  assert.equal(isAllowedOriginHeader('https://internal.local', new Set(['https://internal.local'])), true)
})

test('BS-P1-01: menolak Origin eksternal (403), Host asing (403), token hilang/salah (401), body > 256 KB (413), JSON rusak (400)', async () => {
  const srv = createMcpHttpServer({
    host: '127.0.0.1',
    token: 'internal-secret-token',
    rateLimit: { maxRequests: 50, windowMs: 60_000 },
  })
  const port = await listenLocal(srv)
  try {
    const health = await sendRawRequest(port, { method: 'GET', path: '/health' })
    assert.equal(health.status, 200)

    const badOrigin = await sendRawRequest(port, {
      headers: { origin: 'https://evil.example', authorization: 'Bearer internal-secret-token' },
      body: '{}',
    })
    assert.equal(badOrigin.status, 403)

    const badHost = await sendRawRequest(port, {
      headers: { host: 'attacker.example:8090', authorization: 'Bearer internal-secret-token' },
      body: '{}',
    })
    assert.equal(badHost.status, 403)

    const malformedHost = await sendRawRequest(port, {
      headers: { host: '127.0.0.1:notaport', authorization: 'Bearer internal-secret-token' },
      body: '{}',
    })
    assert.equal(malformedHost.status, 403)

    const noToken = await sendRawRequest(port, { body: '{}' })
    assert.equal(noToken.status, 401)

    const wrongToken = await sendRawRequest(port, {
      headers: { authorization: 'Bearer wrong-token' },
      body: '{}',
    })
    assert.equal(wrongToken.status, 401)

    const altHeaderBadJson = await sendRawRequest(port, {
      headers: { 'x-mcp-token': 'internal-secret-token' },
      body: '{invalid-json',
    })
    assert.equal(altHeaderBadJson.status, 400)

    const huge = await sendRawRequest(port, {
      headers: { authorization: 'Bearer internal-secret-token' },
      body: JSON.stringify({ pad: 'x'.repeat(MAX_MCP_BODY_BYTES + 1024) }),
    })
    assert.equal(huge.status, 413)
  } finally {
    await closeServer(srv)
  }
})

test('BS-P1-03: rate limit mengembalikan 429 dengan header Retry-After saat batas terlampaui', async () => {
  const srv = createMcpHttpServer({
    host: '127.0.0.1',
    token: 'rate-test-token',
    rateLimit: { maxRequests: 2, windowMs: 60_000 },
  })
  const port = await listenLocal(srv)
  try {
    const initPayload = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1.0.0' } },
    })
    const r1 = await sendRawRequest(port, {
      headers: { authorization: 'Bearer rate-test-token' },
      body: initPayload,
    })
    const r2 = await sendRawRequest(port, {
      headers: { authorization: 'Bearer rate-test-token' },
      body: initPayload,
    })
    const r3 = await sendRawRequest(port, {
      headers: { authorization: 'Bearer rate-test-token' },
      body: initPayload,
    })
    assert.notEqual(r1.status, 429)
    assert.notEqual(r2.status, 429)
    assert.equal(r3.status, 429)
    assert.ok(Number(r3.headers['retry-after']) >= 1)
  } finally {
    await closeServer(srv)
  }
})

test('BS-P1-03: skema search_all_platforms menolak platforms > 10 dan limitPerSource > 25', async () => {
  const server = buildServer()
  const client = new Client({ name: 'test-client', version: '1.0.0' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])

  try {
    const tooManyPlatforms = await client.callTool({
      name: 'search_all_platforms',
      arguments: {
        platforms: Array.from({ length: MAX_MCP_PLATFORMS + 1 }, (_, i) => `p${i}`),
      },
    })
    assert.equal(tooManyPlatforms.isError, true)
    assert.match(JSON.stringify(tooManyPlatforms.content), /at most|too_big|validation|<=|10/i)

    const tooManyPerSource = await client.callTool({
      name: 'search_all_platforms',
      arguments: {
        limitPerSource: MAX_MCP_LIMIT_PER_SOURCE + 1,
      },
    })
    assert.equal(tooManyPerSource.isError, true)
    assert.match(JSON.stringify(tooManyPerSource.content), /less than or equal|too_big|validation|<=|25/i)
  } finally {
    await client.close()
    await server.close()
  }
})
