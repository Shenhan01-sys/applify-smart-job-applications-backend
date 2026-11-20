import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { FakeDb } from './helpers/fakeDb.ts'
import { ownResumePath, resumeUrlForUser, RESUME_BUCKET, RESUME_URL_TTL_SECONDS } from '../services/resume-file.service.ts'

const U = '11111111-2222-3333-4444-555555555555'

function dbWith(resumeUrl: unknown, sign: (path: string, ttl: number) => any = (p) => ({ data: { signedUrl: `https://x.supabase.co/storage/v1/object/sign/resumes/${p}?token=t` }, error: null })) {
  const db = new FakeDb({ profiles: [{ id: U, resume_url: resumeUrl }] }) as any
  const calls: Array<{ bucket: string; path: string; ttl: number }> = []
  db.storage = {
    from: (bucket: string) => ({
      createSignedUrl: async (path: string, ttl: number) => {
        calls.push({ bucket, path, ttl })
        return sign(path, ttl)
      },
    }),
  }
  return { db, calls }
}

test('ownResumePath: hanya <user_id>/<berkas>.pdf|doc|docx milik pengguna itu', () => {
  assert.equal(ownResumePath(`${U}/cv-1.pdf`, U), `${U}/cv-1.pdf`)
  assert.equal(ownResumePath(` ${U}/CV_Hans.DOCX `, U), `${U}/CV_Hans.DOCX`)
  assert.equal(ownResumePath(`${U}/cv.doc`, U), `${U}/cv.doc`)
  for (const bad of [
    `other-user/cv.pdf`,
    `${U}/sub/cv.pdf`,
    `${U}/../x/cv.pdf`,
    `${U}/..pdf`,
    `${U}/.cv.pdf`,
    `${U}/cv.exe`,
    `${U}/cv`,
    `${U}/`,
    'https://example.com/resume/a.pdf',
    '',
    null,
    5,
  ]) assert.equal(ownResumePath(bad, U), null, String(bad))
  assert.equal(ownResumePath(`${U}/cv.pdf`, ''), null)
})

test('resumeUrlForUser: path sah ditandatangani di bucket resumes dengan TTL 7 hari', async () => {
  const { db, calls } = dbWith(`${U}/cv-1.pdf`)
  const url = await resumeUrlForUser(db, U)
  assert.match(url ?? '', /^https:\/\/.*\/resumes\/.*cv-1\.pdf\?token=t$/)
  assert.deepEqual(calls, [{ bucket: RESUME_BUCKET, path: `${U}/cv-1.pdf`, ttl: RESUME_URL_TTL_SECONDS }])
  assert.equal(RESUME_URL_TTL_SECONDS, 604800)
})

test('resumeUrlForUser: tanpa CV, path milik orang lain, URL lama, atau galat menghasilkan null tanpa menandatangani', async () => {
  for (const v of [null, '', 'https://example.com/resume/a.pdf', `other/cv.pdf`]) {
    const { db, calls } = dbWith(v)
    assert.equal(await resumeUrlForUser(db, U), null, String(v))
    assert.equal(calls.length, 0)
  }
  // profil tidak ada
  const none = dbWith(`${U}/cv.pdf`)
  assert.equal(await resumeUrlForUser(none.db, 'pengguna-lain'), null)
  // baca profil gagal
  const fail = dbWith(`${U}/cv.pdf`)
  fail.db.failOn('profiles', 'select')
  assert.equal(await resumeUrlForUser(fail.db, U), null)
  // penandatanganan gagal, melempar, atau bukan https
  assert.equal(await resumeUrlForUser(dbWith(`${U}/cv.pdf`, () => ({ data: null, error: { message: 'Object not found' } })).db, U), null)
  assert.equal(await resumeUrlForUser(dbWith(`${U}/cv.pdf`, () => { throw new Error('net') }).db, U), null)
  assert.equal(await resumeUrlForUser(dbWith(`${U}/cv.pdf`, () => ({ data: { signedUrl: 'http://x/cv.pdf' }, error: null })).db, U), null)
})

test('POST /api/approvals: resume_url diambil dari profil di server, bukan dari body klien', () => {
  const src = readFileSync(new URL('../api/routes/approval.ts', import.meta.url), 'utf8')
  const post = src.slice(src.indexOf("app.post('/'"), src.indexOf("app.post('/:id/approve'"))
  const destructure = post.slice(post.indexOf('const {'), post.indexOf('} = request.body as any'))
  assert.doesNotMatch(destructure, /resume_url/)
  assert.match(post, /const resume_url = await resumeUrlForUser\(supabase as any, userId\)/)
  assert.match(post, /\n\s+resume_url,\n/)
})
