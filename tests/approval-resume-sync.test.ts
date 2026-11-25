import test from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import { FakeDb } from './helpers/fakeDb.ts'
import { approvalRoutes } from '../api/routes/approval.js'
import { MissingCvUnconfirmedError, guardQueuePayload, requireApprovedRow } from '../services/queue-guard.ts'
import { QueueService } from '../services/queue.service.ts'
import { currentResumeUrlForApproval, resumePathFromSignedUrl } from '../services/resume-file.service.ts'

/**
 * BS-U4-01 (audit 26 November 2026): CV pada approval_requests dibekukan saat draf diajukan, sedangkan CV profil
 * bisa diganti atau dihapus sesudahnya. Persetujuan, antrean email, dan antrean worker harus memakai CV profil saat ini.
 */

const U = '11111111-1111-4111-8111-111111111111'
const JOB_ID = '22222222-2222-4222-8222-222222222222'
const APPROVAL_ID = '44444444-4444-4444-8444-444444444444'
const NOW = new Date('2026-11-26T10:00:00.000Z')
const FUTURE = '2026-11-26T20:00:00.000Z'

const signedUrl = (path: string) => `https://x.supabase.co/storage/v1/object/sign/resumes/${path}?token=t`
const OLD_PATH = `${U}/cv-1.pdf`
const NEW_PATH = `${U}/cv-2.pdf`

function withStorage<T extends FakeDb>(db: T, sign: (path: string) => any = (p) => ({ data: { signedUrl: signedUrl(p) }, error: null })) {
  const calls: string[] = []
  ;(db as any).storage = {
    from: (_bucket: string) => ({
      createSignedUrl: async (path: string) => {
        calls.push(path)
        return sign(path)
      },
    }),
  }
  return calls
}

function approval(over: Record<string, any> = {}) {
  return {
    id: APPROVAL_ID,
    user_id: U,
    job_id: JOB_ID,
    application_id: null,
    status: 'approved',
    expires_at: FUTURE,
    resume_url: signedUrl(OLD_PATH),
    ...over,
  }
}

test('resumePathFromSignedUrl: mengambil path CV milik pengguna dari URL bertanda tangan, selain itu null', () => {
  assert.equal(resumePathFromSignedUrl(signedUrl(OLD_PATH), U), OLD_PATH)
  assert.equal(
    resumePathFromSignedUrl(`https://x.supabase.co/storage/v1/object/authenticated/resumes/${OLD_PATH}`, U),
    OLD_PATH
  )
  for (const bad of [
    null,
    undefined,
    '',
    'bukan-url',
    'https://x.supabase.co/storage/v1/object/sign/resumes/orang-lain/cv.pdf?token=t',
    `https://x.supabase.co/storage/v1/object/sign/resumes/${U}/sub/cv.pdf?token=t`,
    `https://x.supabase.co/storage/v1/object/sign/lain/${OLD_PATH}?token=t`,
    `https://x.supabase.co/storage/v1/object/sign/resumes/${U}/cv.exe?token=t`,
  ]) {
    assert.equal(resumePathFromSignedUrl(bad, U), null, String(bad))
  }
})

test('currentResumeUrlForApproval: CV profil sama dengan CV persetujuan tidak ditandatangani ulang', async () => {
  const db = new FakeDb({ profiles: [{ id: U, resume_url: OLD_PATH }] })
  const calls = withStorage(db)
  const out = await currentResumeUrlForApproval(db as any, U, signedUrl(OLD_PATH))
  assert.deepEqual(out, { url: signedUrl(OLD_PATH), changed: false })
  assert.equal(calls.length, 0)
})

test('currentResumeUrlForApproval: profil punya CV baru, URL persetujuan diganti dengan URL CV profil', async () => {
  const db = new FakeDb({ profiles: [{ id: U, resume_url: NEW_PATH }] })
  const calls = withStorage(db)
  const out = await currentResumeUrlForApproval(db as any, U, signedUrl(OLD_PATH))
  assert.deepEqual(out, { url: signedUrl(NEW_PATH), changed: true })
  assert.deepEqual(calls, [NEW_PATH])
})

test('currentResumeUrlForApproval: persetujuan tanpa CV tetapi profil sudah punya CV, URL terisi', async () => {
  const db = new FakeDb({ profiles: [{ id: U, resume_url: NEW_PATH }] })
  withStorage(db)
  assert.deepEqual(await currentResumeUrlForApproval(db as any, U, null), { url: signedUrl(NEW_PATH), changed: true })
})

test('currentResumeUrlForApproval: CV profil dihapus, URL persetujuan dikosongkan karena objeknya sudah hilang', async () => {
  const db = new FakeDb({ profiles: [{ id: U, resume_url: null }] })
  const calls = withStorage(db)
  assert.deepEqual(await currentResumeUrlForApproval(db as any, U, signedUrl(OLD_PATH)), { url: null, changed: true })
  assert.deepEqual(await currentResumeUrlForApproval(db as any, U, null), { url: null, changed: false })
  assert.equal(calls.length, 0)
})

test('currentResumeUrlForApproval: galat sementara (baca profil atau tanda tangan gagal) tidak menghapus CV persetujuan', async () => {
  const unreadable = new FakeDb({ profiles: [{ id: U, resume_url: NEW_PATH }] })
  withStorage(unreadable)
  unreadable.failOn('profiles', 'select')
  assert.deepEqual(await currentResumeUrlForApproval(unreadable as any, U, signedUrl(OLD_PATH)), { url: signedUrl(OLD_PATH), changed: false })

  const noProfile = new FakeDb()
  withStorage(noProfile)
  assert.deepEqual(await currentResumeUrlForApproval(noProfile as any, U, signedUrl(OLD_PATH)), { url: signedUrl(OLD_PATH), changed: false })

  for (const sign of [
    () => ({ data: null, error: { message: 'Object not found' } }),
    () => ({ data: { signedUrl: 'http://x/cv.pdf' }, error: null }),
    () => {
      throw new Error('net')
    },
  ]) {
    const db = new FakeDb({ profiles: [{ id: U, resume_url: NEW_PATH }] })
    withStorage(db, sign)
    assert.deepEqual(await currentResumeUrlForApproval(db as any, U, signedUrl(OLD_PATH)), { url: signedUrl(OLD_PATH), changed: false })
  }
})

test('requireApprovedRow: CV profil yang berganti ditulis ke baris persetujuan sebelum diantrekan', async () => {
  const db = new FakeDb({ profiles: [{ id: U, resume_url: NEW_PATH }], approval_requests: [approval()] })
  withStorage(db)
  const row = await requireApprovedRow(db, U, APPROVAL_ID, NOW)
  assert.equal(row.resume_url, signedUrl(NEW_PATH))
  assert.equal(db.rows('approval_requests')[0].resume_url, signedUrl(NEW_PATH))
})

test('requireApprovedRow: gagal menyimpan CV terbaru tidak menggagalkan antrean dan nilai lama tetap dipakai', async () => {
  const db = new FakeDb({ profiles: [{ id: U, resume_url: NEW_PATH }], approval_requests: [approval()] })
  withStorage(db)
  db.failOn('approval_requests', 'update')
  const row = await requireApprovedRow(db, U, APPROVAL_ID, NOW)
  assert.equal(row.resume_url, signedUrl(OLD_PATH))
})

test('guardQueuePayload: email_apply memakai CV baru di profil walau persetujuan lama tanpa CV, tanpa 409', async () => {
  const db = new FakeDb({ profiles: [{ id: U, resume_url: NEW_PATH }], approval_requests: [approval({ resume_url: null })] })
  withStorage(db)
  const out = await guardQueuePayload(db, U, 'email_apply', { approval_request_id: APPROVAL_ID, apply_email: 'hr@x.test' }, NOW)
  assert.equal(out.approved, true)
  assert.equal('allow_without_cv' in out, false)
  assert.equal(db.rows('approval_requests')[0].resume_url, signedUrl(NEW_PATH))
})

test('guardQueuePayload: email_apply sesudah CV profil dihapus ditolak 409 missing_cv_unconfirmed, bukan dikirim dengan URL mati', async () => {
  const db = new FakeDb({ profiles: [{ id: U, resume_url: null }], approval_requests: [approval()] })
  withStorage(db)
  await assert.rejects(
    guardQueuePayload(db, U, 'email_apply', { approval_request_id: APPROVAL_ID, apply_email: 'hr@x.test' }, NOW),
    MissingCvUnconfirmedError
  )
  assert.equal(db.rows('approval_requests')[0].resume_url, null)
  const confirmed = await guardQueuePayload(
    db,
    U,
    'email_apply',
    { approval_request_id: APPROVAL_ID, apply_email: 'hr@x.test', allow_without_cv: true },
    NOW
  )
  assert.equal(confirmed.allow_without_cv, true)
})

test('QueueService.addApprovedApplyJob: antrean worker memakai persetujuan yang CV-nya sudah diselaraskan', async () => {
  const db = new FakeDb({
    profiles: [{ id: U, resume_url: NEW_PATH }],
    approval_requests: [approval({ expires_at: new Date(Date.now() + 3_600_000).toISOString() })],
    jobs: [{ id: JOB_ID, title: 'Backend', platform_source: 'greenhouse' }],
  })
  withStorage(db)
  const queue = new QueueService(db as any)
  await queue.addApprovedApplyJob(U, APPROVAL_ID)
  assert.equal(db.rows('approval_requests')[0].resume_url, signedUrl(NEW_PATH))
  assert.equal(db.rows('automation_queue').length, 1)
})

async function approveRoute(db: FakeDb) {
  const queued: string[] = []
  const queue = {
    async addApprovedApplyJob(_userId: string, approvalId: string) {
      queued.push(approvalId)
      return { id: 'q-1' }
    },
    async addApprovedExtensionApplyJob(_userId: string, approvalId: string) {
      queued.push(approvalId)
      return { id: 'q-2' }
    },
  }
  const app = Fastify()
  app.addHook('preHandler', async (req: any) => {
    req.user = { id: U }
  })
  await app.register(approvalRoutes, {
    prefix: '/api/approvals',
    db: db as any,
    queue: queue as any,
    guard: { checkActionRateLimit: async () => {} },
  })
  const res = await app.inject({ method: 'POST', url: `/api/approvals/${APPROVAL_ID}/approve`, payload: {} })
  await app.close()
  return { res, queued }
}

function approveDb(resumeUrl: string | null, profileResume: string | null) {
  const db = new FakeDb({
    profiles: [{ id: U, resume_url: profileResume }],
    jobs: [{ id: JOB_ID, title: 'Backend', company: 'PT Contoh', platform_source: 'greenhouse', external_url: 'https://boards.greenhouse.io/acme/jobs/1', description: 'Apply via Greenhouse' }],
    approval_requests: [approval({ status: 'pending', resume_url: resumeUrl, expires_at: new Date(Date.now() + 3_600_000).toISOString(), job_title: 'Backend', company: 'PT Contoh', platform: 'greenhouse' })],
    user_automation_settings: [{ id: 's1', user_id: U, extension_auto_use: true }],
  })
  withStorage(db)
  return db
}

test('POST /:id/approve: CV profil yang sudah berganti disegarkan pada baris persetujuan saat disetujui', async () => {
  const db = approveDb(signedUrl(OLD_PATH), NEW_PATH)
  const { res } = await approveRoute(db)
  assert.equal(res.statusCode, 200)
  const row = db.rows('approval_requests')[0]
  assert.equal(row.status, 'approved')
  assert.equal(row.resume_url, signedUrl(NEW_PATH))
})

test('POST /:id/approve: CV profil sudah dihapus mengosongkan resume_url persetujuan, dan CV yang sama tidak ditulis ulang', async () => {
  const removed = approveDb(signedUrl(OLD_PATH), null)
  assert.equal((await approveRoute(removed)).res.statusCode, 200)
  assert.equal(removed.rows('approval_requests')[0].resume_url, null)

  const same = approveDb(signedUrl(OLD_PATH), OLD_PATH)
  assert.equal((await approveRoute(same)).res.statusCode, 200)
  assert.equal(same.rows('approval_requests')[0].resume_url, signedUrl(OLD_PATH))
  const patches = same.writes.filter((w) => w.table === 'approval_requests' && w.op === 'update')
  assert.ok(patches.every((w) => !('resume_url' in (w.payload ?? {}))), 'tidak menulis resume_url bila CV tidak berubah')
})
