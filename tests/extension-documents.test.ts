import test from 'node:test'
import assert from 'node:assert/strict'
import { attachmentFileName, parseProfileDocumentPath } from '../services/extension-documents.js'
import { buildApp, issueToken, makeExtensionTestDb, OTHER_USER_ID, USER_ID, type FakeDbOptions } from './extension-test-db.js'

const NOW = new Date('2026-11-24T05:00:00Z')
const FUTURE = '2026-11-24T12:00:00Z'
const APPROVAL = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1'
const OTHER_APPROVAL = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb2'
const DRAFT_APPROVAL = 'cccccccc-cccc-cccc-cccc-ccccccccccc3'
const PDF_BYTES = Buffer.from('%PDF-1.4\nCV-BUDI-ASLI\n%%EOF')
const TRANSCRIPT_BYTES = Buffer.from('%PDF-1.4\nTRANSKRIP\n%%EOF')
const PORTFOLIO_BYTES = Buffer.from('%PDF-1.4\nPORTOFOLIO\n%%EOF')
const COVER_TEXT = 'Dengan hormat,\n\nSaya tertarik pada posisi Backend Engineer di Acme.\n\nHormat saya,\nBudi'

const RESUME_PATH = `${USER_ID}/cv-budi.pdf`
const TRANSCRIPT_PATH = `${USER_ID}/transcript-1732400000000.pdf`
const PORTFOLIO_PATH = `${USER_ID}/portfolio-1732400000001.docx`

function seed(extra: Partial<Record<string, any[]>> = {}) {
  return {
    approval_requests: [
      { id: APPROVAL, user_id: USER_ID, job_id: 'job-1', application_id: 'app-1', status: 'approved', expires_at: FUTURE, cover_letter: COVER_TEXT },
      { id: OTHER_APPROVAL, user_id: OTHER_USER_ID, job_id: 'job-1', application_id: 'app-2', status: 'approved', expires_at: FUTURE, cover_letter: 'RAHASIA PENGGUNA LAIN' },
      { id: DRAFT_APPROVAL, user_id: USER_ID, job_id: 'job-1', application_id: 'app-3', status: 'pending', expires_at: FUTURE, cover_letter: COVER_TEXT },
    ],
    jobs: [{ id: 'job-1', platform_source: 'kalibrr', title: 'Backend Engineer', company: 'Acme', external_url: 'https://www.kalibrr.com/c/acme/jobs/1' }],
    profiles: [
      { id: USER_ID, full_name: 'Budi Santoso', resume_url: RESUME_PATH, transcript_url: TRANSCRIPT_PATH, portfolio_file_url: PORTFOLIO_PATH },
      { id: OTHER_USER_ID, full_name: 'Siti Aminah', resume_url: `${OTHER_USER_ID}/cv-siti.pdf` },
    ],
    ...extra,
  }
}

const STORAGE = {
  [`resumes/${RESUME_PATH}`]: PDF_BYTES,
  [`resumes/${TRANSCRIPT_PATH}`]: TRANSCRIPT_BYTES,
  [`resumes/${PORTFOLIO_PATH}`]: PORTFOLIO_BYTES,
  [`resumes/${OTHER_USER_ID}/cv-siti.pdf`]: Buffer.from('%PDF-1.4\nCV-SITI-RAHASIA\n%%EOF'),
}

async function setup(extra: Partial<Record<string, any[]>> = {}, options: FakeDbOptions = {}) {
  const store = makeExtensionTestDb(seed(extra), { storageObjects: STORAGE, ...options })
  const app = buildApp({ db: store.db, primaryUserId: USER_ID, now: () => NOW.getTime() })
  const token = await issueToken(app)
  const get = (approvalId: string, kind: string, headers: Record<string, string> = { authorization: `Bearer ${token}` }) =>
    app.inject({ method: 'GET', url: `/api/extension/documents/${approvalId}/${kind}`, headers })
  return { store, app, token, get }
}

// -------------------------------------------------------------------------------------------------------------
// Isi dan header
// -------------------------------------------------------------------------------------------------------------

test('documents resume: byte CV pengguna, Content-Type PDF, attachment dengan nama aman, no-store', async () => {
  const { get, store } = await setup()
  const res = await get(APPROVAL, 'resume')
  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.rawPayload, PDF_BYTES)
  assert.equal(res.headers['content-type'], 'application/pdf')
  assert.equal(res.headers['content-disposition'], 'attachment; filename="Budi-Santoso-Resume.pdf"')
  assert.equal(res.headers['cache-control'], 'no-store')
  assert.equal(res.headers['x-content-type-options'], 'nosniff')
  assert.deepEqual(store.downloads, [`resumes/${RESUME_PATH}`])
})

test('documents cover_letter: PDF dibuat dari teks yang disetujui, tanpa membaca storage', async () => {
  const { get, store } = await setup()
  const res = await get(APPROVAL, 'cover_letter')
  assert.equal(res.statusCode, 200)
  assert.equal(res.headers['content-type'], 'application/pdf')
  assert.equal(res.headers['content-disposition'], 'attachment; filename="Budi-Santoso-Cover-Letter.pdf"')
  assert.equal(res.headers['cache-control'], 'no-store')
  const pdf = res.rawPayload
  assert.equal(pdf.subarray(0, 8).toString('latin1'), '%PDF-1.4')
  assert.ok(pdf.toString('latin1').includes('(Saya tertarik pada posisi Backend Engineer di Acme.) Tj'))
  assert.ok(pdf.toString('latin1').includes('/Title (Cover Letter - Budi Santoso)'))
  assert.deepEqual(store.downloads, [])
})

test('documents transcript dan portfolio: dari kolom profil, tipe MIME mengikuti ekstensi', async () => {
  const { get } = await setup()
  const t = await get(APPROVAL, 'transcript')
  assert.equal(t.statusCode, 200)
  assert.deepEqual(t.rawPayload, TRANSCRIPT_BYTES)
  assert.equal(t.headers['content-type'], 'application/pdf')
  assert.equal(t.headers['content-disposition'], 'attachment; filename="Budi-Santoso-Transcript.pdf"')

  const p = await get(APPROVAL, 'portfolio')
  assert.equal(p.statusCode, 200)
  assert.deepEqual(p.rawPayload, PORTFOLIO_BYTES)
  assert.equal(p.headers['content-type'], 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')
  assert.equal(p.headers['content-disposition'], 'attachment; filename="Budi-Santoso-Portfolio.docx"')
})

test('documents: nama berkas selalu ASCII aman walau nama pelamar berisi karakter jalur, tanda petik, atau non-Latin', async () => {
  const { get } = await setup({
    profiles: [{ id: USER_ID, full_name: 'José "Ñandú" O\'Brien/../x\r\nSet-Cookie: a=b', resume_url: RESUME_PATH }],
  })
  const res = await get(APPROVAL, 'resume')
  assert.equal(res.statusCode, 200)
  assert.match(String(res.headers['content-disposition']), /^attachment; filename="[A-Za-z0-9._-]+"$/)
  assert.equal(res.headers['set-cookie'], undefined)
  assert.equal(attachmentFileName('日本語', 'Resume', 'pdf'), 'Resume.pdf')
  assert.equal(attachmentFileName(null, 'Resume', 'pdf'), 'Resume.pdf')
})

test('parseProfileDocumentPath: hanya <user_id>/<kind>-<angka>.<pdf|doc|docx> milik pengguna itu', () => {
  assert.deepEqual(parseProfileDocumentPath('transcript', TRANSCRIPT_PATH, USER_ID), { path: TRANSCRIPT_PATH, ext: 'pdf' })
  for (const bad of [
    `${OTHER_USER_ID}/transcript-1.pdf`,
    `${USER_ID}/../${OTHER_USER_ID}/transcript-1.pdf`,
    `${USER_ID}/sub/transcript-1.pdf`,
    `${USER_ID}/portfolio-1.pdf`,
    `${USER_ID}/transcript-1.exe`,
    `${USER_ID}/transcript-abc.pdf`,
    `https://evil.example/${USER_ID}/transcript-1.pdf`,
    `transcript-1.pdf`,
    '',
    null,
    42,
  ]) {
    assert.equal(parseProfileDocumentPath('transcript', bad, USER_ID), null, String(bad))
  }
})

// -------------------------------------------------------------------------------------------------------------
// Pemilik dan keamanan
// -------------------------------------------------------------------------------------------------------------

test('documents: persetujuan dan berkas pengguna lain tidak bisa diambil (404 document_not_found), storage tidak disentuh', async () => {
  const { get, store } = await setup()
  for (const kind of ['resume', 'cover_letter', 'transcript', 'portfolio']) {
    const res = await get(OTHER_APPROVAL, kind)
    assert.equal(res.statusCode, 404, kind)
    assert.equal(res.json().code, 'document_not_found', kind)
    assert.ok(!res.body.includes('RAHASIA'), kind)
  }
  assert.deepEqual(store.downloads, [])
})

test('documents: path profil yang menunjuk folder pengguna lain tidak pernah diunduh (404)', async () => {
  const { get, store } = await setup({
    profiles: [
      {
        id: USER_ID,
        full_name: 'Budi',
        resume_url: `${OTHER_USER_ID}/cv-siti.pdf`,
        transcript_url: `${OTHER_USER_ID}/transcript-1.pdf`,
        portfolio_file_url: `${USER_ID}/../${OTHER_USER_ID}/portfolio-1.pdf`,
      },
    ],
  })
  for (const kind of ['resume', 'transcript', 'portfolio']) {
    const res = await get(APPROVAL, kind)
    assert.equal(res.statusCode, 404, kind)
    assert.equal(res.json().code, 'document_not_found', kind)
  }
  assert.deepEqual(store.downloads, [], 'tidak ada unduhan sama sekali')
})

test('documents: token dicabut ditolak (401 token_revoked), tanpa token 401, token rusak 401', async () => {
  const { get, app, token, store } = await setup()
  assert.equal((await get(APPROVAL, 'resume')).statusCode, 200)

  const rev = await app.inject({ method: 'POST', url: '/api/extension/revoke-all' })
  assert.equal(rev.statusCode, 200)
  const blocked = await get(APPROVAL, 'resume')
  assert.equal(blocked.statusCode, 401)
  assert.equal(blocked.json().code, 'token_revoked')
  assert.ok(!blocked.rawPayload.equals(PDF_BYTES))
  const downloadsBefore = store.downloads.length
  await get(APPROVAL, 'cover_letter')
  assert.equal(store.downloads.length, downloadsBefore)

  assert.equal((await get(APPROVAL, 'resume', {})).statusCode, 401)
  assert.equal((await get(APPROVAL, 'resume', { authorization: `Bearer ${token}x` })).statusCode, 401)
  assert.equal((await get(APPROVAL, 'resume', { authorization: 'Bearer ext_tok_v1.bukan.token' })).statusCode, 401)
})

test('documents: id persetujuan wajib UUID (400 invalid_id) dan jenis tak dikenal 400 invalid_kind', async () => {
  const { get } = await setup()
  for (const bad of ['123', 'not-a-uuid', '..%2F..%2Fetc', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaZ']) {
    const res = await get(bad, 'resume')
    assert.equal(res.statusCode, 400, bad)
    assert.equal(res.json().code, 'invalid_id', bad)
  }
  for (const kind of ['passport', 'RESUME', 'cv', 'resume.pdf', '..%2Fresume']) {
    const res = await get(APPROVAL, kind)
    assert.equal(res.statusCode, 400, kind)
    assert.equal(res.json().code, 'invalid_kind', kind)
  }
})

test('documents: persetujuan belum disetujui 409 not_approved, kedaluwarsa 410, sudah dipakai kirim 409 approval_already_used', async () => {
  const { get } = await setup({
    approval_requests: [
      { id: APPROVAL, user_id: USER_ID, job_id: 'job-1', status: 'approved', expires_at: FUTURE, cover_letter: COVER_TEXT },
      { id: DRAFT_APPROVAL, user_id: USER_ID, job_id: 'job-1', status: 'pending', expires_at: FUTURE, cover_letter: COVER_TEXT },
      { id: 'dddddddd-dddd-dddd-dddd-ddddddddddd4', user_id: USER_ID, job_id: 'job-1', status: 'approved', expires_at: '2026-11-23T00:00:00Z' },
      { id: 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeee5', user_id: USER_ID, job_id: 'job-1', status: 'approved', expires_at: FUTURE },
    ],
    application_logs: [
      { user_id: USER_ID, job_id: 'job-1', action: 'apply', status: 'success', details: { approval_request_id: 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeee5' } },
    ],
  })
  const pending = await get(DRAFT_APPROVAL, 'resume')
  assert.equal(pending.statusCode, 409)
  assert.equal(pending.json().code, 'not_approved')
  const expired = await get('dddddddd-dddd-dddd-dddd-ddddddddddd4', 'resume')
  assert.equal(expired.statusCode, 410)
  assert.equal(expired.json().code, 'approval_expired')
  const used = await get('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeee5', 'resume')
  assert.equal(used.statusCode, 409)
  assert.equal(used.json().code, 'approval_already_used')
})

// -------------------------------------------------------------------------------------------------------------
// Tidak ada berkas, terlalu besar, galat
// -------------------------------------------------------------------------------------------------------------

test('documents: tidak ada berkas -> 404 document_not_found (CV belum diunggah, surat kosong, objek hilang, kolom belum ada)', async () => {
  const noCv = await setup({ profiles: [{ id: USER_ID, full_name: 'Budi' }] })
  for (const kind of ['resume', 'transcript', 'portfolio']) {
    const res = await noCv.get(APPROVAL, kind)
    assert.equal(res.statusCode, 404, kind)
    assert.equal(res.json().code, 'document_not_found', kind)
  }

  const noLetter = await setup({
    approval_requests: [{ id: APPROVAL, user_id: USER_ID, job_id: 'job-1', status: 'approved', expires_at: FUTURE, cover_letter: '   ' }],
  })
  assert.equal((await noLetter.get(APPROVAL, 'cover_letter')).statusCode, 404)

  const missingObject = await setup({}, { storageObjects: {} })
  const res = await missingObject.get(APPROVAL, 'resume')
  assert.equal(res.statusCode, 404)
  assert.equal(res.json().code, 'document_not_found')

  const noProfile = await setup({ profiles: [] })
  assert.equal((await noProfile.get(APPROVAL, 'resume')).statusCode, 404)
  assert.equal((await noProfile.get(APPROVAL, 'cover_letter')).statusCode, 200, 'surat lamaran tidak butuh profil')
})

test('documents: lebih dari 5 MB -> 413 too_large; tepat 5 MB lolos; berkas kosong dianggap tidak ada', async () => {
  const MB5 = 5 * 1024 * 1024
  const big = await setup({}, { storageObjects: { [`resumes/${RESUME_PATH}`]: Buffer.alloc(MB5 + 1, 0x41) } })
  const tooBig = await big.get(APPROVAL, 'resume')
  assert.equal(tooBig.statusCode, 413)
  assert.equal(tooBig.json().code, 'too_large')

  const exact = await setup({}, { storageObjects: { [`resumes/${RESUME_PATH}`]: Buffer.alloc(MB5, 0x41) } })
  const ok = await exact.get(APPROVAL, 'resume')
  assert.equal(ok.statusCode, 200)
  assert.equal(ok.rawPayload.length, MB5)

  const empty = await setup({}, { storageObjects: { [`resumes/${RESUME_PATH}`]: Buffer.alloc(0) } })
  assert.equal((await empty.get(APPROVAL, 'resume')).statusCode, 404)
})

test('documents: gangguan storage -> 502 generik; teks galat storage dan database tidak pernah sampai ke klien', async () => {
  const storage = await setup({}, { storageDownloadErrors: { [`resumes/${RESUME_PATH}`]: { message: 'connect ECONNRESET 10.0.0.5:5432 secret-token-xyz', statusCode: '500' } } })
  const res = await storage.get(APPROVAL, 'resume')
  assert.equal(res.statusCode, 502)
  assert.equal(res.json().code, 'storage_failed')
  assert.ok(!res.body.includes('ECONNRESET') && !res.body.includes('secret-token-xyz') && !res.body.includes('10.0.0.5'))

  const db = await setup({}, { failTables: { profiles: { code: 'XX000', message: 'relation "profiles" kaput: password=hunter2 host=db.internal' } } })
  const dbRes = await db.get(APPROVAL, 'resume')
  assert.equal(dbRes.statusCode, 500)
  assert.equal(dbRes.json().code, 'profile_lookup_failed')
  assert.ok(!dbRes.body.includes('hunter2') && !dbRes.body.includes('db.internal') && !dbRes.body.includes('kaput'))
  // Surat lamaran tidak bergantung pada profil: tetap terkirim tanpa nama pelamar.
  const letter = await db.get(APPROVAL, 'cover_letter')
  assert.equal(letter.statusCode, 200)
  assert.equal(letter.headers['content-disposition'], 'attachment; filename="Cover-Letter.pdf"')

  const approvals = await setup({}, { failTables: { approval_requests: { code: 'XX000', message: 'boom internal-host' } } })
  const apRes = await approvals.get(APPROVAL, 'resume')
  assert.equal(apRes.statusCode, 500)
  assert.ok(!apRes.body.includes('internal-host') && !apRes.body.includes('boom'))
})
