import test, { mock } from 'node:test'
import assert from 'node:assert/strict'
import { sendTransactionalEmailNotification } from '../services/notification-dispatcher.service.js'

/** Kegagalan Resend dicatat (status atau nama galat) tanpa kunci API, alamat penerima, atau isi pesan. */

const SECRET_KEY = 're_secret_key_should_never_be_logged'
const RECIPIENT = 'penerima.rahasia@example.com'
const ENV = {
  NOTIFICATIONS_ENABLED: 'true',
  RESEND_API_KEY: SECRET_KEY,
  NOTIFY_FROM_EMAIL: 'Applify <noreply@applify.test>',
}
const args = { to: RECIPIENT, subject: 'Subjek rahasia', text: 'Isi pesan rahasia' }

function captureWarn() {
  const lines: string[] = []
  const spy = mock.method(console, 'warn', (...parts: unknown[]) => {
    lines.push(parts.map((p) => String(p)).join(' '))
  })
  return { lines, restore: () => spy.mock.restore() }
}

test('Resend menolak (403): dicatat dengan status, hasil tetap gagal, tidak ada rahasia di log', async () => {
  const cap = captureWarn()
  try {
    const fetchImpl = (async () => new Response(JSON.stringify({ message: 'domain belum terverifikasi', to: RECIPIENT }), { status: 403 })) as typeof fetch
    const res = await sendTransactionalEmailNotification(args, fetchImpl, ENV)
    assert.deepEqual(res, { ok: false, error: 'resend_http_403' })
    assert.equal(cap.lines.length, 1)
    assert.match(cap.lines[0], /status=403/)
    const all = cap.lines.join('\n')
    for (const secret of [SECRET_KEY, RECIPIENT, 'Subjek rahasia', 'Isi pesan rahasia', 'terverifikasi']) {
      assert.equal(all.includes(secret), false, secret)
    }
  } finally {
    cap.restore()
  }
})

test('Resend gagal jaringan: dicatat dengan nama galat saja', async () => {
  const cap = captureWarn()
  try {
    const boom = Object.assign(new Error(`connect ECONNREFUSED ${RECIPIENT} key=${SECRET_KEY}`), { name: 'TypeError' })
    const fetchImpl = (async () => {
      throw boom
    }) as typeof fetch
    const res = await sendTransactionalEmailNotification(args, fetchImpl, ENV)
    assert.equal(res.ok, false)
    assert.equal(cap.lines.length, 1)
    assert.match(cap.lines[0], /TypeError/)
    const all = cap.lines.join('\n')
    assert.equal(all.includes(SECRET_KEY), false)
    assert.equal(all.includes(RECIPIENT), false)
    assert.equal(all.includes('ECONNREFUSED'), false)
  } finally {
    cap.restore()
  }
})

test('Resend sukses: tidak ada catatan peringatan', async () => {
  const cap = captureWarn()
  try {
    const fetchImpl = (async () => new Response('{}', { status: 200 })) as typeof fetch
    assert.deepEqual(await sendTransactionalEmailNotification(args, fetchImpl, ENV), { ok: true })
    assert.equal(cap.lines.length, 0)
  } finally {
    cap.restore()
  }
})
