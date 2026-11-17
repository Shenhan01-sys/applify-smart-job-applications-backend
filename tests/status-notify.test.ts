import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FakeDb } from './helpers/fakeDb.ts'
import { notifyApplicationStatus, statusMessage, escapeHtml } from '../services/application-status.service.ts'

// ---- Telegram status notice (Telegram itself is always a fake) --------------------------------------

function notifier(ok = true) {
  const sent: string[] = []
  return {
    sent,
    n: {
      async sendTelegram(m: string) {
        sent.push(m)
        return ok ? { ok: true } : { ok: false, error: 'telegram 500' }
      },
    },
  }
}

const seedApp = (status: string, over: Record<string, any> = {}) =>
  new FakeDb({
    ai_applications: [{ id: 'app1', user_id: 'u1', job_id: 'j1', status, follow_up_scheduled: '2026-11-22T10:00:00.000Z', ...over }],
    jobs: [{ id: 'j1', title: 'R&D Lead', company: 'PT <Uji>' }],
  })

test('statusMessage: judul per status dan HTML di-escape', () => {
  const m = statusMessage({ status: 'submitted', title: 'R&D <x>', company: 'A&B', followUpAt: '2026-11-22T10:00:00.000Z' })
  assert.match(m, /Terkirim/)
  assert.match(m, /R&amp;D &lt;x&gt; @ A&amp;B/)
  assert.match(m, /2026-11-22/)
  assert.equal(escapeHtml(undefined), '')
  assert.match(statusMessage({ status: 'follow_up' }), /Waktunya follow-up/)
  assert.match(statusMessage({ status: 'responded' }), /respons/)
  assert.match(statusMessage({ status: 'closed' }), /Ditutup/)
})

test('notifyApplicationStatus: status dibaca dari database dan dikirim lewat Telegram tiruan', async () => {
  for (const status of ['ready', 'submitted', 'follow_up', 'responded', 'closed']) {
    const db = seedApp(status)
    const { sent, n } = notifier()
    const out = await notifyApplicationStatus(db, n, { userId: 'u1', applicationId: 'app1' })
    assert.deepEqual(out, { sent: true, status })
    assert.equal(sent.length, 1, status)
    assert.match(sent[0], /R&amp;D Lead @ PT &lt;Uji&gt;/)
    const log = db.rows('application_logs')[0]
    assert.equal(log.action, 'status_notify')
    assert.equal(log.status, status)
  }
})

test('notifyApplicationStatus: draft tidak diumumkan; aplikasi orang lain atau tidak ada: not_found', async () => {
  const { sent, n } = notifier()
  assert.deepEqual(await notifyApplicationStatus(seedApp('draft'), n, { userId: 'u1', applicationId: 'app1' }), { sent: false, reason: 'draft' })
  assert.deepEqual(await notifyApplicationStatus(seedApp('submitted'), n, { userId: 'u2', applicationId: 'app1' }), { sent: false, reason: 'not_found' })
  assert.deepEqual(await notifyApplicationStatus(seedApp('submitted'), n, { userId: 'u1', applicationId: 'nope' }), { sent: false, reason: 'not_found' })
  assert.equal(sent.length, 0)
})

test('notifyApplicationStatus: status yang sama dengan pengumuman terakhir tidak diulang', async () => {
  const db = seedApp('submitted')
  const { sent, n } = notifier()
  await notifyApplicationStatus(db, n, { userId: 'u1', applicationId: 'app1' })
  const again = await notifyApplicationStatus(db, n, { userId: 'u1', applicationId: 'app1' })
  assert.deepEqual(again, { sent: false, reason: 'duplicate' })
  assert.equal(sent.length, 1)

  // status berubah -> diumumkan lagi
  db.rows('ai_applications')[0].status = 'responded'
  db.rows('application_logs')[0].created_at = '2026-11-18T09:00:00.000Z'
  const next = await notifyApplicationStatus(db, n, { userId: 'u1', applicationId: 'app1' })
  assert.equal(next.sent, true)
  assert.equal(sent.length, 2)
})

test('notifyApplicationStatus: Telegram gagal -> tidak dicatat sebagai terkirim, bisa dicoba lagi', async () => {
  const db = seedApp('submitted')
  const bad = notifier(false)
  const out = await notifyApplicationStatus(db, bad.n, { userId: 'u1', applicationId: 'app1' })
  assert.equal(out.sent, false)
  assert.equal(db.rows('application_logs').length, 0)
  const good = notifier(true)
  assert.equal((await notifyApplicationStatus(db, good.n, { userId: 'u1', applicationId: 'app1' })).sent, true)
})

