import test from 'node:test'
import assert from 'node:assert/strict'
import { buildApp, issueToken, makeExtensionTestDb, USER_ID, VALID_PNG_BASE64, type FakeDbOptions } from './extension-test-db.js'

const NOW = new Date('2026-11-23T12:00:00Z')
const FUTURE = '2026-11-24T12:00:00Z'
const APPROVAL = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1'
const APPROVAL_2 = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2'
const JOB_URL = 'https://www.kalibrr.com/c/acme/jobs/1'
const PAGE_URL = 'https://www.kalibrr.com/c/acme/jobs/1/apply'

function seedRows(extra: Partial<Record<string, any[]>> = {}) {
  return {
    approval_requests: [
      { id: APPROVAL, user_id: USER_ID, job_id: 'job-1', application_id: 'app-1', status: 'approved', expires_at: FUTURE, job_title: 'Backend', company: 'Acme' },
    ],
    jobs: [{ id: 'job-1', platform_source: 'kalibrr', title: 'Backend Engineer', company: 'Acme', external_url: JOB_URL }],
    ai_applications: [{ id: 'app-1', user_id: USER_ID, job_id: 'job-1', status: 'draft' }],
    subscriptions: [{ user_id: USER_ID, ai_model_tier: 'free' }],
    ...extra,
  }
}

async function setup(extra: Partial<Record<string, any[]>> = {}, options: FakeDbOptions = {}) {
  const store = makeExtensionTestDb(seedRows(extra), options)
  const app = buildApp({ db: store.db, primaryUserId: USER_ID, now: () => NOW.getTime() })
  const token = await issueToken(app)
  const post = (url: string, payload: Record<string, unknown>) =>
    app.inject({ method: 'POST', url: `/api/extension/${url}`, headers: { authorization: `Bearer ${token}` }, payload })
  const authorize = (payload: Record<string, unknown> = {}) =>
    post('authorize-submit', { approvalId: APPROVAL, jobId: 'job-1', pageUrl: PAGE_URL, missingRequiredCount: 0, ...payload })
  const report = (payload: Record<string, unknown>) =>
    post('report-run', { approvalId: APPROVAL, jobId: 'job-1', pageUrl: PAGE_URL, ...payload })
  const pending = () => app.inject({ method: 'GET', url: '/api/extension/pending-approvals', headers: { authorization: `Bearer ${token}` } })
  return { store, app, token, post, authorize, report, pending }
}

// --------------------------------------------------------------------------------------------------------------
// Klaim atomik (temuan keamanan 2)
// --------------------------------------------------------------------------------------------------------------

test('authorize-submit: menyisipkan klaim {approval, user, channel extension, run_id} dan mengembalikan runId', async () => {
  const { store, authorize } = await setup()
  const res = await authorize()
  assert.equal(res.statusCode, 200)
  const body = res.json()
  assert.equal(body.authorized, true)
  assert.match(body.runId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  assert.equal(store.tables.approval_submit_claims.length, 1)
  const claim = store.tables.approval_submit_claims[0]
  assert.equal(claim.approval_request_id, APPROVAL)
  assert.equal(claim.user_id, USER_ID)
  assert.equal(claim.channel, 'extension')
  assert.equal(claim.run_id, body.runId)
})

test('authorize-submit: runId buatan klien dipakai bila sah, bentuk tidak sah ditolak 400 tanpa klaim', async () => {
  const { store, authorize } = await setup()
  const bad = await authorize({ runId: '../../etc/passwd' })
  assert.equal(bad.statusCode, 400)
  assert.equal(bad.json().code, 'invalid_run_id')
  assert.equal(store.tables.approval_submit_claims.length, 0)

  const ok = await authorize({ runId: 'client_run-0001' })
  assert.equal(ok.statusCode, 200)
  assert.equal(ok.json().runId, 'client_run-0001')
  assert.equal(store.tables.approval_submit_claims[0].run_id, 'client_run-0001')
})

test('authorize-submit: dua otorisasi bersamaan (dua tab / klik ganda) -> tepat satu lolos, satu 409 already_claimed', async () => {
  const { store, authorize } = await setup()
  const [a, b] = await Promise.all([authorize(), authorize()])
  const codes = [a.statusCode, b.statusCode].sort()
  assert.deepEqual(codes, [200, 409])
  const loser = a.statusCode === 409 ? a : b
  assert.equal(loser.json().code, 'already_claimed')
  assert.equal(store.tables.approval_submit_claims.length, 1)

  const third = await authorize()
  assert.equal(third.statusCode, 409)
  assert.equal(third.json().code, 'already_claimed')
})

test('authorize-submit: klaim milik worker (channel worker) membuat ekstensi ditolak already_claimed', async () => {
  const { authorize, store } = await setup({
    approval_submit_claims: [{ approval_request_id: APPROVAL, user_id: USER_ID, channel: 'worker', queue_job_id: 'q-1', run_id: null }],
  })
  const res = await authorize()
  assert.equal(res.statusCode, 409)
  assert.equal(res.json().code, 'already_claimed')
  assert.equal(store.tables.approval_submit_claims.length, 1)
  assert.equal(store.tables.approval_submit_claims[0].channel, 'worker')
})

test('authorize-submit: tabel klaim hilang (42P01, PGRST205) atau galat lain -> 503 claim_unavailable, fail closed', async () => {
  for (const code of ['42P01', 'PGRST205', '08006']) {
    const { authorize, store } = await setup({}, { failTables: { approval_submit_claims: { code, message: 'relation "approval_submit_claims" does not exist' } } })
    const res = await authorize()
    assert.equal(res.statusCode, 503, `kode ${code}`)
    assert.equal(res.json().code, 'claim_unavailable')
    assert.equal(res.json().authorized, undefined)
    assert.equal(store.tables.approval_submit_claims.length, 0)
  }
})

test('authorize-submit: klaim dibuat paling akhir, pemeriksaan lain yang gagal tidak meninggalkan klaim', async () => {
  const { authorize, store } = await setup()
  assert.equal((await authorize({ missingRequiredCount: 2 })).statusCode, 409)
  assert.equal((await authorize({ pageUrl: 'https://evil.example/apply' })).json().code, 'page_mismatch')
  assert.equal((await authorize({ jobId: 'job-lain' })).json().code, 'approval_job_mismatch')
  assert.equal((await authorize({ pageUrl: 'https://www.linkedin.com/jobs/view/1' })).statusCode, 403)
  assert.equal(store.tables.approval_submit_claims.length, 0)

  // Kuota harian penuh (free = 10) -> 429, tanpa klaim.
  const full = await setup({
    application_logs: Array.from({ length: 10 }, (_, i) => ({ user_id: USER_ID, action: 'apply', status: 'success', job_id: `j${i}`, details: {}, created_at: '2026-11-23T08:00:00Z' })),
  })
  const res = await full.authorize()
  assert.equal(res.statusCode, 429)
  assert.equal(res.json().code, 'daily_quota_exceeded')
  assert.equal(full.store.tables.approval_submit_claims.length, 0)
})

// --------------------------------------------------------------------------------------------------------------
// pending-approvals: klaim, antrian worker, urutan pencarian
// --------------------------------------------------------------------------------------------------------------

test('pending-approvals: menyembunyikan persetujuan yang sudah diklaim atau sedang diantre worker (pending/processing)', async () => {
  const mk = (id: string, jobId: string) => ({ id, user_id: USER_ID, job_id: jobId, application_id: null, status: 'approved', expires_at: FUTURE, reviewed_at: '2026-11-23T10:00:00Z' })
  const ids = ['b1', 'b2', 'b3', 'b4', 'b5'].map((s) => `bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbb${s.padStart(2, '0')}`)
  const { pending, store } = await setup({
    approval_requests: ids.map((id, i) => mk(id, `job-${i}`)),
    jobs: ids.map((_, i) => ({ id: `job-${i}`, platform_source: 'kalibrr', title: `T${i}`, company: 'Acme', external_url: `https://www.kalibrr.com/c/acme/jobs/${i}` })),
    approval_submit_claims: [{ approval_request_id: ids[0], user_id: USER_ID, channel: 'worker' }],
    automation_queue: [
      { id: 'q1', user_id: USER_ID, job_type: 'apply', status: 'pending', payload: { approval_request_id: ids[1] } },
      { id: 'q2', user_id: USER_ID, job_type: 'apply', status: 'processing', payload: { approval_request_id: ids[2] } },
      { id: 'q3', user_id: USER_ID, job_type: 'apply', status: 'completed', payload: { approval_request_id: ids[3] } },
      { id: 'q4', user_id: USER_ID, job_type: 'search', status: 'pending', payload: { approval_request_id: ids[4] } },
    ],
  })
  const res = await pending()
  assert.equal(res.statusCode, 200)
  const listed = res.json().items.map((i: any) => i.approvalId).sort()
  assert.deepEqual(listed, [ids[3], ids[4]].sort())
  assert.ok(store.calls.some((c) => c.table === 'approval_submit_claims'))
})

test('pending-approvals: persetujuan yang sudah terkirim tetap tersembunyi walau ada ratusan log kirim lain yang lebih baru', async () => {
  const noise = Array.from({ length: 250 }, (_, i) => ({
    user_id: USER_ID,
    action: 'apply',
    status: 'success',
    job_id: `x${i}`,
    details: { approval_request_id: `cccccccc-cccc-cccc-cccc-${String(i).padStart(12, '0')}` },
    created_at: `2026-11-22T${String(i % 24).padStart(2, '0')}:00:00Z`,
  }))
  const target = { user_id: USER_ID, action: 'apply', status: 'success', job_id: 'job-1', details: { approval_request_id: APPROVAL }, created_at: '2026-11-01T00:00:00Z' }
  const { pending } = await setup({ application_logs: [target, ...noise] })
  const res = await pending()
  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.json().items, [])
})

test('pending-approvals: tabel klaim tidak ada atau pencarian pendukung gagal -> daftar ditolak (fail closed), bukan daftar penuh', async () => {
  const missing = await setup({}, { failTables: { approval_submit_claims: { code: '42P01', message: 'missing' } } })
  const r1 = await missing.pending()
  assert.equal(r1.statusCode, 503)
  assert.equal(r1.json().code, 'claim_unavailable')

  const noQueue = await setup({}, { failTables: { automation_queue: { code: 'XX000', message: 'boom' } } })
  const r2 = await noQueue.pending()
  assert.equal(r2.statusCode, 500)
  assert.equal(r2.json().code, 'queue_lookup_failed')

  const noLogs = await setup({}, { failTables: { application_logs: { code: 'XX000', message: 'boom' } } })
  const r3 = await noLogs.pending()
  assert.equal(r3.statusCode, 500)
  assert.equal(r3.json().code, 'approval_usage_lookup_failed')
})

test('pending-approvals: membaca kolom jobs yang nyata (platform_source) dan menyembunyikan lowongan LinkedIn', async () => {
  const { pending } = await setup({
    approval_requests: [
      { id: APPROVAL, user_id: USER_ID, job_id: 'job-1', status: 'approved', expires_at: FUTURE, reviewed_at: '2026-11-23T10:00:00Z' },
      { id: APPROVAL_2, user_id: USER_ID, job_id: 'job-li', status: 'approved', expires_at: FUTURE, reviewed_at: '2026-11-23T09:00:00Z' },
    ],
    jobs: [
      { id: 'job-1', platform_source: 'kalibrr', title: 'Backend', company: 'Acme', external_url: JOB_URL },
      { id: 'job-li', platform_source: 'linkedin', title: 'Staff', company: 'Beta', external_url: 'https://www.linkedin.com/jobs/view/9' },
    ],
  })
  const res = await pending()
  assert.equal(res.statusCode, 200)
  const items = res.json().items
  assert.equal(items.length, 1)
  assert.equal(items[0].platform, 'kalibrr')
})

// --------------------------------------------------------------------------------------------------------------
// Pelepasan klaim
// --------------------------------------------------------------------------------------------------------------

test('report-run: not_submitted / incomplete / validation_error / cancelled dengan runId yang cocok melepas klaim dan persetujuan bisa diklaim lagi', async () => {
  const { authorize, report, store } = await setup()
  const cases: Array<{ outcome: string; reason: string }> = [
    { outcome: 'not_submitted', reason: 'not_submitted' },
    { outcome: 'incomplete', reason: 'partly_filled' },
    { outcome: 'validation_error', reason: 'validation_failed' },
    { outcome: 'cancelled', reason: 'cancelled' },
  ]
  for (const c of cases) {
    const auth = await authorize()
    assert.equal(auth.statusCode, 200, c.outcome)
    assert.equal(store.tables.approval_submit_claims.length, 1)

    const res = await report({ outcome: c.outcome, runId: auth.json().runId, filledCount: 3 })
    assert.equal(res.statusCode, 200, c.outcome)
    assert.equal(res.json().claimReleased, true, c.outcome)
    assert.equal(res.json().runId, auth.json().runId)
    assert.equal(res.json().logStatus, 'incomplete')
    assert.equal(store.tables.approval_submit_claims.length, 0, c.outcome)

    const row = store.tables.application_logs.at(-1)
    assert.equal(row.status, 'incomplete')
    assert.equal(row.details.reason, c.reason)
    assert.equal(row.details.run_id, auth.json().runId)
  }
  // 4 percobaan gagal, persetujuan tetap bisa dipakai.
  assert.equal((await authorize()).statusCode, 200)
})

test('report-run: validation_error mencatat submit_check validation_error dan submit_clicked true', async () => {
  const { authorize, report, store } = await setup()
  const auth = await authorize()
  await report({
    outcome: 'validation_error',
    runId: auth.json().runId,
    filledCount: 4,
    submitCheck: { validationMessages: 2, controlPresent: true, urlChanged: false, afterUrl: `${PAGE_URL}?x=1#y` },
  })
  const d = store.tables.application_logs[0].details
  assert.equal(d.submit_clicked, true)
  assert.deepEqual(d.submit_check, {
    verdict: 'validation_error',
    confirmation_phrase: null,
    validation_messages: 2,
    control_present: true,
    url_changed: false,
    before_path: null,
    after_path: '/c/acme/jobs/1/apply',
  })
})

test('report-run: submitted dan submit_unverified mempertahankan klaim', async () => {
  for (const outcome of ['submitted', 'submit_unverified']) {
    const { authorize, report, store } = await setup()
    const auth = await authorize()
    const res = await report({ outcome, runId: auth.json().runId, filledCount: 5 })
    assert.equal(res.statusCode, 200, outcome)
    assert.equal(res.json().claimReleased, false, outcome)
    assert.equal(store.tables.approval_submit_claims.length, 1, outcome)
    // Kirim ulang otorisasi tetap ditolak.
    assert.equal((await authorize()).statusCode, 409, outcome)
  }
})

test('report-run: pelepasan hanya untuk klaim run itu sendiri (runId salah, tanpa runId, klaim worker, ada log kirim)', async () => {
  // runId salah atau tidak ada -> klaim tetap
  const a = await setup()
  const auth = await a.authorize()
  const wrong = await a.report({ outcome: 'not_submitted', runId: 'some-other-run' })
  assert.equal(wrong.statusCode, 200)
  assert.equal(wrong.json().claimReleased, false)
  const none = await a.report({ outcome: 'incomplete', filledCount: 1 })
  assert.equal(none.json().claimReleased, false)
  assert.equal(a.store.tables.approval_submit_claims.length, 1)
  assert.equal(a.store.tables.approval_submit_claims[0].run_id, auth.json().runId)

  // klaim worker tidak pernah dilepas ekstensi
  const w = await setup({ approval_submit_claims: [{ approval_request_id: APPROVAL, user_id: USER_ID, channel: 'worker', run_id: 'wrk-run-0001' }] })
  const rw = await w.report({ outcome: 'not_submitted', runId: 'wrk-run-0001' })
  assert.equal(rw.json().claimReleased, false)
  assert.equal(w.store.tables.approval_submit_claims.length, 1)

  // ada log kirim untuk persetujuan ini -> klaim tidak dilepas walau runId cocok
  const s = await setup({
    approval_submit_claims: [{ approval_request_id: APPROVAL, user_id: USER_ID, channel: 'extension', run_id: 'ext-run-0001' }],
    application_logs: [{ user_id: USER_ID, action: 'apply', status: 'submit_unverified', job_id: 'job-1', details: { approval_request_id: APPROVAL } }],
  })
  const rs = await s.report({ outcome: 'not_submitted', runId: 'ext-run-0001' })
  assert.equal(rs.json().claimReleased, false)
  assert.equal(s.store.tables.approval_submit_claims.length, 1)
})

test('report-run: ready (tahap isi) tidak menyentuh klaim', async () => {
  const { authorize, report, store } = await setup()
  const auth = await authorize()
  const res = await report({ outcome: 'ready', runId: auth.json().runId, filledCount: 2 })
  assert.equal(res.statusCode, 200)
  assert.equal(res.json().claimReleased, false)
  assert.equal(store.tables.approval_submit_claims.length, 1)
})

// --------------------------------------------------------------------------------------------------------------
// Laporan kirim selalu tercatat (temuan keamanan 3, bagian server)
// --------------------------------------------------------------------------------------------------------------

test('report-run: badan ~6,5 MB (dua PNG besar) diterima, di atas 8 MiB ditolak 413', async () => {
  const { authorize, report, store } = await setup()
  const auth = await authorize()
  const big = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(2_400_000, 7)]).toString('base64')
  assert.ok(big.length * 2 > 6_000_000)
  const res = await report({ outcome: 'submitted', runId: auth.json().runId, filledCount: 3, filledScreenshot: big, afterScreenshot: big })
  assert.equal(res.statusCode, 200)
  assert.equal(store.uploads.length, 2)
  assert.ok(res.json().screenshots.filledPath.startsWith(`${USER_ID}/ext-`))

  const huge = await report({ outcome: 'ready', filledScreenshot: 'A'.repeat(9 * 1024 * 1024) })
  assert.equal(huge.statusCode, 413)
})

test('rute lain tetap memakai batas bawaan 1 MiB (batas besar hanya di report-run)', async () => {
  const { post } = await setup()
  const res = await post('authorize-submit', { approvalId: APPROVAL, jobId: 'job-1', pageUrl: PAGE_URL, pad: 'A'.repeat(2 * 1024 * 1024) })
  assert.equal(res.statusCode, 413)
})

test('report-run submitted: kuota penuh dan persetujuan kedaluwarsa hanya ditandai late_*, log dan status kartu tetap tertulis', async () => {
  const { authorize, report, store } = await setup({
    application_logs: Array.from({ length: 10 }, (_, i) => ({ user_id: USER_ID, action: 'apply', status: 'success', job_id: `j${i}`, details: {}, created_at: '2026-11-23T08:00:00Z' })),
    approval_requests: [
      // kedaluwarsa dan statusnya sudah bukan approved saat laporan masuk
      { id: APPROVAL, user_id: USER_ID, job_id: 'job-1', application_id: 'app-1', status: 'expired', expires_at: '2026-11-23T11:00:00Z', job_title: 'Backend', company: 'Acme' },
    ],
  })
  // Otorisasi sebenarnya ditolak sekarang; klaim dibuat langsung seolah otorisasi terjadi sebelum kuota/kedaluwarsa.
  assert.equal((await authorize()).statusCode, 409)
  store.tables.approval_submit_claims.push({ approval_request_id: APPROVAL, user_id: USER_ID, channel: 'extension', run_id: 'ext-run-0002' })

  const res = await report({ outcome: 'submitted', runId: 'ext-run-0002', filledCount: 6 })
  assert.equal(res.statusCode, 200)
  assert.equal(res.json().logStatus, 'success')
  assert.equal(res.json().applicationStatus, 'submitted')
  assert.equal(res.json().lateQuotaExceeded, true)
  assert.equal(res.json().lateExpired, true)
  const row = store.tables.application_logs.at(-1)
  assert.equal(row.status, 'success')
  assert.equal(row.details.late_quota_exceeded, true)
  assert.equal(row.details.late_expired, true)
  assert.equal(row.details.late_not_approved, true)
  assert.equal(store.tables.ai_applications[0].status, 'submitted')
  assert.equal(store.tables.approval_submit_claims.length, 1)
})

test('report-run submitted tepat waktu: late_* false; submit_unverified menandai status kartu ready', async () => {
  const a = await setup()
  const auth = await a.authorize()
  const ok = await a.report({ outcome: 'submitted', runId: auth.json().runId, filledCount: 2 })
  assert.equal(ok.statusCode, 200)
  const d = a.store.tables.application_logs[0].details
  assert.equal(d.late_quota_exceeded, false)
  assert.equal(d.late_expired, false)
  assert.equal('late_not_approved' in d, false)

  const b = await setup()
  const authB = await b.authorize()
  const un = await b.report({ outcome: 'submit_unverified', runId: authB.json().runId, filledCount: 2 })
  assert.equal(un.json().logStatus, 'submit_unverified')
  assert.equal(un.json().applicationStatus, 'ready')
})

test('report-run submitted: PNG tidak sah dibuang dan ditandai, log tetap tertulis (bukan 400)', async () => {
  const { authorize, report, store } = await setup()
  const auth = await authorize()
  const res = await report({
    outcome: 'submitted',
    runId: auth.json().runId,
    filledCount: 1,
    filledScreenshot: Buffer.from('<script>alert(1)</script>').toString('base64'),
    afterScreenshot: VALID_PNG_BASE64,
  })
  assert.equal(res.statusCode, 200)
  const row = store.tables.application_logs[0]
  assert.equal(row.status, 'success')
  assert.equal(row.details.screenshot_rejected, 'invalid_screenshot_png')
  assert.equal(row.details.screenshots.filled, null)
  assert.ok(row.details.screenshots.after.path.endsWith('/after.png'))
  assert.equal(store.uploads.length, 1)
})

test('report-run submitted: laporan ulang tetap 409 approval_already_used (log sudah tertulis), persetujuan lain/baris hilang tetap ditolak', async () => {
  const { authorize, report, store } = await setup()
  const auth = await authorize()
  assert.equal((await report({ outcome: 'submitted', runId: auth.json().runId })).statusCode, 200)
  const again = await report({ outcome: 'submitted', runId: auth.json().runId })
  assert.equal(again.statusCode, 409)
  assert.equal(again.json().code, 'approval_already_used')
  assert.equal(store.tables.application_logs.length, 1)

  const missing = await report({ outcome: 'submitted', approvalId: 'dddddddd-dddd-dddd-dddd-dddddddddddd' })
  assert.equal(missing.statusCode, 404)
  const mismatch = await setup()
  const mm = await mismatch.report({ outcome: 'submitted', jobId: 'job-lain' })
  assert.equal(mm.statusCode, 409)
  assert.equal(mm.json().code, 'approval_job_mismatch')
})

// --------------------------------------------------------------------------------------------------------------
// Halaman terikat ke lowongan (temuan keamanan 4)
// --------------------------------------------------------------------------------------------------------------

test('authorize-submit: host halaman harus sama dengan lowongan atau host ATS yang dikenal, selain itu 409 page_mismatch', async () => {
  // Lowongan di Kalibrr (non-ATS)
  const k = await setup()
  const evil = await k.authorize({ pageUrl: 'https://kalibrr.com.evil.example/apply' })
  assert.equal(evil.statusCode, 409)
  assert.equal(evil.json().code, 'page_mismatch')
  assert.equal(k.store.tables.approval_submit_claims.length, 0)
  const sameSite = await k.authorize({ pageUrl: 'https://apply.kalibrr.com/form' })
  assert.equal(sameSite.statusCode, 200)

  // Tombol Apply agregator -> ATS yang dikenal: boleh
  const viaAts = await setup()
  const ats = await viaAts.authorize({ pageUrl: 'https://boards.greenhouse.io/acme/jobs/1' })
  assert.equal(ats.statusCode, 200)

  // Lowongan sudah di Greenhouse: vendor ATS lain ditolak, subdomain Greenhouse lain boleh
  const gh = { id: 'job-1', platform_source: 'greenhouse', title: 'BE', company: 'Acme', external_url: 'https://boards.greenhouse.io/acme/jobs/1' }
  const g1 = await setup({ jobs: [gh] })
  const lever = await g1.authorize({ pageUrl: 'https://jobs.lever.co/acme/1' })
  assert.equal(lever.statusCode, 409)
  assert.equal(lever.json().code, 'page_mismatch')
  const g2 = await setup({ jobs: [gh] })
  assert.equal((await g2.authorize({ pageUrl: 'https://job-boards.greenhouse.io/acme/jobs/1' })).statusCode, 200)

  // Lowongan tanpa URL sama sekali, atau baris lowongan hilang: tidak bisa diikat -> ditolak
  const noUrl = await setup({ jobs: [{ id: 'job-1', platform_source: 'kalibrr', title: 'BE', company: 'Acme', external_url: null }] })
  assert.equal((await noUrl.authorize()).json().code, 'page_mismatch')
  const noJob = await setup({ jobs: [] })
  assert.equal((await noJob.authorize()).json().code, 'page_mismatch')
  assert.equal(noJob.store.tables.approval_submit_claims.length, 0)
})

test('authorize-submit: lowongan LinkedIn ditolak 403 walau halaman bukan LinkedIn', async () => {
  const li = await setup({ jobs: [{ id: 'job-1', platform_source: 'linkedin', title: 'BE', company: 'Acme', external_url: 'https://www.linkedin.com/jobs/view/1' }] })
  const res = await li.authorize({ pageUrl: 'https://boards.greenhouse.io/acme/jobs/1' })
  assert.equal(res.statusCode, 403)
  assert.equal(res.json().code, 'linkedin_manual_only')
  assert.equal(li.store.tables.approval_submit_claims.length, 0)
})

// --------------------------------------------------------------------------------------------------------------
// Bentuk baris log ekstensi = bentuk worker (temuan keamanan 7)
// --------------------------------------------------------------------------------------------------------------

test('report-run: baris application_logs memakai kolom dan kunci details yang sama dengan worker', async () => {
  const { authorize, report, store } = await setup()
  const auth = await authorize()
  const filledFields = [
    { label: 'Full Name', kind: 'text', value: 'Budi Santoso' },
    { label: 'Password', kind: 'text', value: 'rahasia123' },
    { label: 'Willing to relocate?', kind: 'check', value: 'true' },
    { label: 'Resume', kind: 'upload', value: 'C:\\Users\\budi\\Documents\\cv-budi.pdf' },
    { label: 'Cover letter', kind: 'select', value: 'x'.repeat(200) },
    { label: 'Aneh', kind: 'bogus', value: 'v' },
    'bukan objek',
    { label: '', kind: 'text', value: 'tanpa label' },
  ]
  const res = await report({
    outcome: 'submitted',
    runId: auth.json().runId,
    filledCount: 9,
    filledFields,
    remainingRequired: ['Expected salary', 'Expected salary', '  ', 42],
    questions: [{ key: 'x', label: 'Ignored', kind: 'text' }],
    submitCheck: { confirmationPhrase: 'Thank you for applying', validationMessages: 0, controlPresent: false, urlChanged: true, beforeUrl: PAGE_URL, afterUrl: 'https://www.kalibrr.com/thanks?token=1' },
    filledScreenshot: VALID_PNG_BASE64,
    afterScreenshot: `data:image/png;base64,${VALID_PNG_BASE64}`,
  })
  assert.equal(res.statusCode, 200)

  const row = store.tables.application_logs[0]
  assert.equal(row.user_id, USER_ID)
  assert.equal(row.action, 'apply')
  assert.equal(row.job_id, 'job-1')
  assert.equal(row.job_title, 'Backend Engineer')
  assert.equal(row.company, 'Acme')
  assert.equal(row.platform, 'kalibrr')
  assert.equal(row.status, 'success')

  const d = row.details
  assert.equal(d.channel, 'extension')
  assert.equal(d.run_id, auth.json().runId)
  assert.equal(d.approval_request_id, APPROVAL)
  assert.equal(d.reason, null)
  assert.equal(d.application_status, 'submitted')
  assert.equal(d.fields_filled, 9) // jumlah sebenarnya; daftar filled_fields hanya contoh paling banyak 40
  assert.equal(typeof d.fields_filled, 'number')
  assert.deepEqual(d.fields_by_kind, { text: 4, select: 1, check: 1, upload: 1 })
  assert.deepEqual(d.filled_fields, [
    { label: 'Full Name', kind: 'text', value: 'Budi Santoso' },
    { label: 'Password', kind: 'text' },
    { label: 'Willing to relocate?', kind: 'check' },
    { label: 'Resume', kind: 'upload', value: 'cv-budi.pdf' },
    { label: 'Cover letter', kind: 'select', value: `${'x'.repeat(79)}…` },
    { label: 'Aneh', kind: 'text', value: 'v' },
    { label: '(tanpa label)', kind: 'text', value: 'tanpa label' },
  ])
  assert.deepEqual(d.remaining_required, ['Expected salary']) // duplikat, kosong, dan bukan string dibuang
  assert.equal('questions' in d, false) // pertanyaan hanya untuk percobaan yang belum terkirim
  assert.equal(d.submit_clicked, true)
  assert.deepEqual(d.submit_check, {
    verdict: 'confirmed',
    confirmation_phrase: 'Thank you for applying',
    validation_messages: 0,
    control_present: false,
    url_changed: true,
    before_path: '/c/acme/jobs/1/apply',
    after_path: '/thanks',
  })
  assert.equal(d.final_url, PAGE_URL)
  // Bentuk screenshots = EvidenceRef worker: { path, url } per kunci
  assert.equal(d.screenshots.filled.path, `${USER_ID}/ext-${auth.json().runId}/filled.png`)
  assert.match(d.screenshots.filled.url, /^https:\/\/storage\.test\//)
  assert.equal(d.screenshots.after.path, `${USER_ID}/ext-${auth.json().runId}/after.png`)
  // Kunci lama yang dibaca frontend sebagai bentuk lain tidak boleh muncul
  for (const legacy of ['filled', 'remaining_required_count']) assert.equal(legacy in d, false)
})

test('report-run incomplete: questions divalidasi seperti keluaran perencana, remaining_required berupa array label', async () => {
  const { report, store } = await setup()
  const res = await report({
    outcome: 'incomplete',
    filledCount: 0,
    remainingRequired: 2,
    questions: [
      { key: 'FORGED KEY', label: 'Why do you want to join? *', kind: 'textarea' },
      { key: 'x', label: 'Pick a team', kind: 'select', options: ['A', 'A', 'B', ' ', 'C'.repeat(300)] },
      { key: 'x', label: 'Pick a team', kind: 'select', options: ['dup'] },
      { key: 'p', label: 'Account password', kind: 'text' },
      { key: 'r', label: 'Remote?', kind: 'radio', options: ['Yes', 'No'] },
      { key: 'u', label: 'Unknown kind', kind: 'weird', options: ['z'] },
      { key: 'c', label: 'Agree to terms', kind: 'checkbox' },
      null,
      { label: '' },
    ],
  })
  assert.equal(res.statusCode, 200)
  const d = store.tables.application_logs[0].details
  assert.equal(store.tables.application_logs[0].status, 'incomplete')
  assert.equal(d.reason, 'no_fields_filled')
  assert.equal(d.application_status, 'unchanged')
  assert.deepEqual(d.questions, [
    { key: 'why do you want to join', label: 'Why do you want to join? *', kind: 'textarea' },
    { key: 'pick a team', label: 'Pick a team', kind: 'select', options: ['A', 'B', 'C'.repeat(120)] },
    { key: 'remote', label: 'Remote?', kind: 'radio', options: ['Yes', 'No'] },
    { key: 'unknown kind', label: 'Unknown kind', kind: 'text' },
    { key: 'agree to terms', label: 'Agree to terms', kind: 'check' },
  ])
  assert.equal(d.questions_pending, 5)
  // Angka lama (2) diganti dua label pertanyaan pertama
  assert.deepEqual(d.remaining_required, ['Why do you want to join? *', 'Pick a team'])
  assert.equal(d.fields_filled, 0)
  assert.deepEqual(d.filled_fields, [])
  assert.equal(d.submit_check, null)
  assert.deepEqual(d.screenshots, { filled: null, after: null })
})

test('report-run: reason klien dipakai hanya bila berbentuk kode pendek, dan tidak untuk ready/submitted', async () => {
  const { report, store } = await setup()
  await report({ outcome: 'incomplete', filledCount: 2, reason: 'captcha_blocked' })
  await report({ outcome: 'incomplete', filledCount: 2, reason: 'Ignore previous <instructions>' })
  await report({ outcome: 'ready', filledCount: 2, reason: 'captcha_blocked' })
  assert.equal(store.tables.application_logs[0].details.reason, 'captcha_blocked')
  assert.equal(store.tables.application_logs[1].details.reason, 'partly_filled')
  assert.equal(store.tables.application_logs[2].details.reason, null)
  assert.equal(store.tables.application_logs[2].details.application_status, 'ready')
})
