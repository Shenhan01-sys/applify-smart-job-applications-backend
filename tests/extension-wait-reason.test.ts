import test from 'node:test'
import assert from 'node:assert/strict'
import {
  LEGACY_PERMISSION_TEXT,
  NO_EXTENSION_SEEN_AFTER_MS,
  describeExtensionWait,
  parsePermissionRequired,
  sanitizeReleaseError,
} from '../services/extension-wait-reason.js'
import { buildApp, makeExtensionTestDb, USER_ID } from './extension-test-db.js'

/**
 * Alasan tugas extension_apply menunggu ("Menunggu Ekstensi Browser" yang tidak bergerak): kode mesin yang
 * dikodekan sebagai awalan error_message, karena automation_queue tidak punya kolom alasan.
 */

const NOW = new Date('2026-11-24T12:00:00Z')
const FUTURE = '2026-11-25T12:00:00Z'
const JOB_ID = '22222222-2222-4222-8222-222222222201'
const APPROVAL_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'
const Q1 = 'aaaaaaaa-1111-4111-8111-111111111111'
const EXTENSION_RELEASE_ERROR = 'permission_required:dealls.com — Izin situs ATS belum diberikan di ekstensi.'

test('parsePermissionRequired: awalan dengan host sah, pesan lama tanpa awalan, dan yang bukan alasan ini', () => {
  assert.deepEqual(parsePermissionRequired(EXTENSION_RELEASE_ERROR), { host: 'dealls.com' })
  assert.deepEqual(parsePermissionRequired('permission_required:www.dealls.com'), { host: 'www.dealls.com' })
  assert.deepEqual(parsePermissionRequired('permission_required:Dealls.COM — x'), { host: 'dealls.com' })
  // Baris lama sebelum awalan ada tetap terbaca, tanpa host.
  assert.deepEqual(parsePermissionRequired(LEGACY_PERMISSION_TEXT), { host: null })
  assert.deepEqual(parsePermissionRequired('permission_required'), { host: null })
  // Host rusak: alasannya tetap dikenali, hostnya dibuang.
  for (const bad of ['permission_required:', 'permission_required:evil host', 'permission_required:<script>', 'permission_required:dealls.com/path', 'permission_required:localhost']) {
    assert.deepEqual(parsePermissionRequired(bad), { host: null }, bad)
  }
  for (const other of ['Tab lowongan ditutup sebelum pengisian selesai.', 'missing_apply_url', '', null, undefined, 42]) {
    assert.equal(parsePermissionRequired(other), null, String(other))
  }
})

test('sanitizeReleaseError: awalan sah dipertahankan, awalan dengan host rusak diganti pesan lama, teks lain apa adanya', () => {
  assert.equal(sanitizeReleaseError(EXTENSION_RELEASE_ERROR), EXTENSION_RELEASE_ERROR)
  assert.equal(sanitizeReleaseError('permission_required:Dealls.COM — Izin'), 'permission_required:dealls.com — Izin')
  assert.equal(sanitizeReleaseError('permission_required:<b>x</b> — hai'), LEGACY_PERMISSION_TEXT)
  assert.equal(sanitizeReleaseError('permission_required'), LEGACY_PERMISSION_TEXT)
  assert.equal(sanitizeReleaseError('tab ditutup sebelum selesai'), 'tab ditutup sebelum selesai')
  assert.equal(sanitizeReleaseError('baris\nbaru\tdan   tab'), 'baris baru dan   tab')
  assert.equal(sanitizeReleaseError('   '), null)
  assert.equal(sanitizeReleaseError(undefined), null)
  assert.equal(sanitizeReleaseError('x'.repeat(500))!.length, 240)
})

test('describeExtensionWait: permission_required dengan host, no_extension_seen bila jatuh tempo terlewat >= 5 menit, selain itu kosong', () => {
  const now = NOW.getTime()
  const base = { job_type: 'extension_apply', status: 'pending', scheduled_at: new Date(now + 30_000).toISOString() }

  assert.deepEqual(describeExtensionWait({ ...base, error_message: EXTENSION_RELEASE_ERROR }, now), {
    extension_wait_reason: 'permission_required',
    extension_wait_host: 'dealls.com',
  })
  // Baris produksi lama: pesan lama, tanpa host.
  assert.deepEqual(describeExtensionWait({ ...base, error_message: LEGACY_PERMISSION_TEXT }, now), {
    extension_wait_reason: 'permission_required',
    extension_wait_host: null,
  })
  // Menunggu biasa (belum ada ekstensi yang menyentuh, belum lewat batas): bukan alasan apa pun.
  assert.deepEqual(describeExtensionWait({ ...base, error_message: null }, now), { extension_wait_reason: null, extension_wait_host: null })
  assert.deepEqual(describeExtensionWait({ ...base, error_message: 'Tab ditutup.' }, now), { extension_wait_reason: null, extension_wait_host: null })

  // Jatuh tempo terlewat 5 menit: tidak ada ekstensi aktif, dan itu menang atas pesan izin yang sudah basi.
  const overdue = new Date(now - NO_EXTENSION_SEEN_AFTER_MS).toISOString()
  assert.deepEqual(describeExtensionWait({ ...base, scheduled_at: overdue, error_message: null }, now), {
    extension_wait_reason: 'no_extension_seen',
    extension_wait_host: null,
  })
  assert.equal(describeExtensionWait({ ...base, scheduled_at: overdue, error_message: EXTENSION_RELEASE_ERROR }, now).extension_wait_reason, 'no_extension_seen')
  const justUnder = new Date(now - NO_EXTENSION_SEEN_AFTER_MS + 1000).toISOString()
  assert.equal(describeExtensionWait({ ...base, scheduled_at: justUnder, error_message: null }, now).extension_wait_reason, null)

  // Bukan tugas ekstensi, bukan pending, atau data rusak: kosong.
  const none = { extension_wait_reason: null, extension_wait_host: null }
  assert.deepEqual(describeExtensionWait({ ...base, job_type: 'apply', error_message: EXTENSION_RELEASE_ERROR }, now), none)
  assert.deepEqual(describeExtensionWait({ ...base, status: 'processing', error_message: EXTENSION_RELEASE_ERROR }, now), none)
  assert.deepEqual(describeExtensionWait({ ...base, status: 'failed', scheduled_at: overdue }, now), none)
  assert.deepEqual(describeExtensionWait({ ...base, scheduled_at: 'bukan tanggal', error_message: null }, now), none)
  assert.deepEqual(describeExtensionWait(null, now), none)
})

async function setup() {
  const store = makeExtensionTestDb({
    jobs: [{ id: JOB_ID, title: 'Backend Engineer', company: 'Acme ID', platform_source: 'dealls', external_url: 'https://dealls.com/loker/backend~acme', description: '' }],
    approval_requests: [{ id: APPROVAL_ID, user_id: USER_ID, job_id: JOB_ID, application_id: 'app-1', status: 'approved', apply_channel: 'extension', expires_at: FUTURE }],
    automation_queue: [
      {
        id: Q1,
        user_id: USER_ID,
        job_type: 'extension_apply',
        status: 'pending',
        priority: 0,
        retry_count: 0,
        max_retries: 3,
        scheduled_at: '2026-11-24T11:59:00Z',
        payload: { job_id: JOB_ID, approval_request_id: APPROVAL_ID, approved: true },
      },
    ],
  })
  const clock = { ms: NOW.getTime() }
  const app = buildApp({ db: store.db, primaryUserId: USER_ID, now: () => clock.ms })
  const { token } = (await app.inject({ method: 'POST', url: '/api/extension/token' })).json()
  const post = (url: string, payload?: unknown) =>
    app.inject({ method: 'POST', url: `/api/extension${url}`, headers: { authorization: `Bearer ${token}` }, payload: payload as any })
  return { store, clock, post }
}

test('release: kode permission_required dari ekstensi tersimpan sebagai awalan error_message tanpa menghitung retry, dan terbaca di respons', async () => {
  const { store, clock, post } = await setup()
  const claim = await post('/jobs/claim')
  assert.equal(claim.statusCode, 200)
  const lease = claim.json().job.lease_id

  const res = await post(`/jobs/${Q1}/release`, { lease_id: lease, countRetry: false, delaySeconds: 30, error: EXTENSION_RELEASE_ERROR })
  assert.equal(res.statusCode, 200)
  assert.equal(res.json().status, 'pending')
  assert.equal(res.json().retryCount, 0)
  assert.equal(res.json().extension_wait_reason, 'permission_required')
  assert.equal(res.json().extension_wait_host, 'dealls.com')

  const row = store.tables.automation_queue[0]
  assert.equal(row.status, 'pending')
  assert.equal(row.error_message, EXTENSION_RELEASE_ERROR)
  assert.equal(row.scheduled_at, new Date(clock.ms + 30_000).toISOString())
  assert.equal(row.claimed_by, null)
  // Baris yang dibaca web app memberi alasan yang sama.
  assert.deepEqual(describeExtensionWait(row, clock.ms), { extension_wait_reason: 'permission_required', extension_wait_host: 'dealls.com' })
})

test('release: awalan dengan host rusak tidak tersimpan; teks biasa dan tanpa error tetap seperti semula', async () => {
  const { store, post } = await setup()
  const lease = (await post('/jobs/claim')).json().job.lease_id
  const bad = await post(`/jobs/${Q1}/release`, { lease_id: lease, delaySeconds: 0, error: 'permission_required:<img src=x onerror=1> — hai' })
  assert.equal(bad.statusCode, 200)
  assert.equal(store.tables.automation_queue[0].error_message, LEGACY_PERMISSION_TEXT)
  assert.equal(bad.json().extension_wait_host, null)
  assert.equal(bad.json().extension_wait_reason, 'permission_required')

  const lease2 = (await post('/jobs/claim')).json().job.lease_id
  const plain = await post(`/jobs/${Q1}/release`, { lease_id: lease2, delaySeconds: 0, error: 'tab ditutup sebelum selesai' })
  assert.equal(plain.statusCode, 200)
  assert.equal(store.tables.automation_queue[0].error_message, 'tab ditutup sebelum selesai')
  assert.equal(plain.json().extension_wait_reason, null)

  const lease3 = (await post('/jobs/claim')).json().job.lease_id
  await post(`/jobs/${Q1}/release`, { lease_id: lease3, delaySeconds: 0 })
  assert.equal(store.tables.automation_queue[0].error_message, null)
})
