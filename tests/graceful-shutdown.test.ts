import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import Fastify from 'fastify'
import {
  DEFAULT_SHUTDOWN_TIMEOUT_MS,
  installGracefulShutdown,
  shutdownTimeoutFromEnv,
  type ShutdownApp,
  type ShutdownProcess,
} from '../services/graceful-shutdown.js'

/** BS-08 (audit 48.3): SIGTERM/SIGINT menutup server dengan rapi. Tanpa sinyal sungguhan, tanpa proses.exit sungguhan. */

function fakeProc() {
  const handlers = new Map<string, () => void>()
  const exits: number[] = []
  const proc: ShutdownProcess = {
    on: (signal, handler) => void handlers.set(signal, handler),
    exit: (code) => void exits.push(code),
  }
  return { proc, handlers, exits }
}
const silentLog = { info: () => undefined, error: () => undefined }

test('sinyal SIGTERM dan SIGINT terpasang; menutup app lalu keluar kode 0; sinyal berulang tidak menutup dua kali', async () => {
  let closes = 0
  const app: ShutdownApp = { close: async () => void closes++, log: silentLog }
  const { proc, handlers, exits } = fakeProc()
  const shutdown = installGracefulShutdown(app, { proc, timeoutMs: 5000, setTimer: () => ({ unref() {} }) })
  assert.deepEqual([...handlers.keys()].sort(), ['SIGINT', 'SIGTERM'])

  handlers.get('SIGTERM')!()
  handlers.get('SIGINT')!()
  await shutdown('SIGTERM')
  assert.equal(closes, 1)
  assert.deepEqual(exits, [0])
})

test('app.close gagal: keluar kode 1', async () => {
  const errors: string[] = []
  const app: ShutdownApp = {
    close: async () => {
      throw new Error('boom')
    },
    log: { info: () => undefined, error: (m) => void errors.push(m) },
  }
  const { proc, exits } = fakeProc()
  await installGracefulShutdown(app, { proc, timeoutMs: 5000, setTimer: () => ({ unref() {} }) })('SIGTERM')
  assert.deepEqual(exits, [1])
  assert.match(errors.join('\n'), /gagal menutup server: boom/)
})

test('penutupan melewati batas waktu: proses dipaksa keluar kode 1, pewaktu di-unref', async () => {
  const app: ShutdownApp = { close: () => new Promise(() => undefined), log: silentLog }
  const { proc, exits } = fakeProc()
  let fire: (() => void) | undefined
  let unrefd = false
  let delay = 0
  const shutdown = installGracefulShutdown(app, {
    proc,
    timeoutMs: 1234,
    setTimer: (fn, ms) => {
      fire = fn
      delay = ms
      return { unref: () => void (unrefd = true) }
    },
  })
  void shutdown('SIGTERM')
  assert.equal(delay, 1234)
  assert.equal(unrefd, true)
  assert.deepEqual(exits, [])
  fire!()
  assert.deepEqual(exits, [1])
})

test('batas waktu dari lingkungan: nilai sah dipakai, nilai tidak sah memakai bawaan', () => {
  assert.equal(shutdownTimeoutFromEnv({}), DEFAULT_SHUTDOWN_TIMEOUT_MS)
  assert.equal(shutdownTimeoutFromEnv({ SHUTDOWN_TIMEOUT_MS: '8000' }), 8000)
  for (const bad of ['', '0', '-5', '999', '120001', 'abc', '1.5']) {
    assert.equal(shutdownTimeoutFromEnv({ SHUTDOWN_TIMEOUT_MS: bad }), DEFAULT_SHUTDOWN_TIMEOUT_MS, bad)
  }
})

test('Fastify sungguhan: permintaan yang sedang jalan selesai dulu, sesudahnya port tertutup', async () => {
  const app = Fastify()
  let release!: () => void
  const gate = new Promise<void>((r) => (release = r))
  let started!: () => void
  const startedP = new Promise<void>((r) => (started = r))
  app.get('/slow', async () => {
    started()
    await gate
    return { ok: true }
  })
  await app.listen({ port: 0, host: '127.0.0.1' })
  const port = (app.server.address() as { port: number }).port

  const { proc, exits } = fakeProc()
  const shutdown = installGracefulShutdown(app as unknown as ShutdownApp, { proc, timeoutMs: 5000, setTimer: () => ({ unref() {} }) })

  const inFlight = fetch(`http://127.0.0.1:${port}/slow`, { headers: { connection: 'close' } }).then((r) => r.json())
  await startedP
  const closing = shutdown('SIGTERM')
  await new Promise((r) => setTimeout(r, 30))
  assert.deepEqual(exits, [], 'belum keluar selama permintaan masih jalan')

  release()
  assert.deepEqual(await inFlight, { ok: true })
  await closing
  assert.deepEqual(exits, [0])
  await assert.rejects(fetch(`http://127.0.0.1:${port}/slow`), 'port sudah tertutup')
})

test('PM2 kill_timeout lebih besar daripada batas penutupan rapi bawaan', () => {
  const require = createRequire(import.meta.url)
  const eco = require('../ecosystem.config.cjs') as { apps: Array<{ kill_timeout: number }> }
  assert.ok(eco.apps[0].kill_timeout > DEFAULT_SHUTDOWN_TIMEOUT_MS, `kill_timeout=${eco.apps[0].kill_timeout}`)
})
