import { test } from 'node:test'
import assert from 'node:assert/strict'
import { USER_TABLES, confirmationPhrase, deleteParticipantData, type DeletionClient } from '../services/participant-deletion.js'

const U = '11111111-2222-4333-8444-555555555555'
const OTHER = '99999999-2222-4333-8444-555555555555'

/** Basis data tiruan: tabel CASCADE ikut hilang saat akun auth dihapus, waitinglist tidak (SET NULL). */
function fakeDb() {
  const rows: Array<{ table: string; user_id?: string | null; id?: string; email?: string }> = []
  for (const owner of [U, OTHER]) {
    rows.push({ table: 'profiles', id: owner })
    for (const t of ['applications', 'approval_requests', 'user_skills']) rows.push({ table: t, user_id: owner })
  }
  rows.push({ table: 'waitinglist', user_id: U, email: 'peserta@contoh.test' })
  rows.push({ table: 'waitinglist', user_id: null, email: 'peserta@contoh.test' })
  rows.push({ table: 'waitinglist', user_id: OTHER, email: 'lain@contoh.test' })
  const files: Record<string, string[]> = {
    resumes: [`${U}/cv.pdf`, `${OTHER}/cv.pdf`],
    'agent-screenshots': [`${U}/job1/a.png`, `${U}/ext-x/b.png`, `${OTHER}/job2/c.png`],
  }
  const auth = new Map([[U, 'peserta@contoh.test'], [OTHER, 'lain@contoh.test']])
  const calls: string[] = []
  const match = (r: any, column: string, value: string) => r[column] === value
  const client: DeletionClient = {
    async listFiles(bucket, prefix) { return files[bucket].filter((p) => p.startsWith(prefix)) },
    async removeFiles(bucket, paths) { calls.push(`rm:${bucket}`); files[bucket] = files[bucket].filter((p) => !paths.includes(p)) },
    async countRows(table, column, value) { return rows.filter((r) => r.table === table && match(r, column, value)).length },
    async deleteRows(table, column, value) {
      calls.push(`del:${table}`)
      for (let i = rows.length - 1; i >= 0; i--) if (rows[i].table === table && match(rows[i], column, value)) rows.splice(i, 1)
    },
    async authEmail(id) { return auth.get(id) ?? null },
    async deleteAuthUser(id) {
      calls.push('auth')
      auth.delete(id)
      for (let i = rows.length - 1; i >= 0; i--) {
        const r = rows[i]
        if (r.table === 'waitinglist') { if (r.user_id === id) r.user_id = null; continue }
        if (r.user_id === id || (r.table === 'profiles' && r.id === id)) rows.splice(i, 1)
      }
    },
  }
  return { rows, files, calls, client }
}

test('bawaan hanya menghitung: tidak ada yang dihapus, laporan tanpa email', async () => {
  const db = fakeDb()
  const r = await deleteParticipantData(db.client, U)
  assert.equal(r.applied, false)
  assert.deepEqual(r.files, { resumes: 1, 'agent-screenshots': 2 })
  assert.equal(r.rows.applications, 1)
  assert.equal(r.rows.profiles, 1)
  assert.equal(r.waitinglist, 3, 'baris user_id dan email dihitung (satu baris terhitung dua kali)')
  assert.deepEqual(db.calls, [])
  assert.doesNotMatch(JSON.stringify(r), /@/)
})

test('hapus: berkas, waitinglist, akun auth; peserta lain utuh; tanpa sisa', async () => {
  const db = fakeDb()
  const r = await deleteParticipantData(db.client, U, { apply: true, confirmation: confirmationPhrase(U) })
  assert.deepEqual(r.leftovers, [])
  assert.ok(db.calls.indexOf('rm:resumes') < db.calls.indexOf('auth'), 'berkas dihapus sebelum akun')
  assert.ok(db.calls.indexOf('del:waitinglist') < db.calls.indexOf('auth'), 'waitinglist dihapus sebelum email hilang')
  assert.ok(!db.rows.some((x) => x.user_id === U || x.id === U || x.email === 'peserta@contoh.test'))
  assert.deepEqual(db.files.resumes, [`${OTHER}/cv.pdf`])
  assert.deepEqual(db.files['agent-screenshots'], [`${OTHER}/job2/c.png`])
  assert.equal(db.rows.filter((x) => x.user_id === OTHER || x.id === OTHER).length, 5)
})

test('hapus tanpa frasa konfirmasi yang benar ditolak sebelum menyentuh apa pun', async () => {
  const db = fakeDb()
  await assert.rejects(deleteParticipantData(db.client, U, { apply: true }), /HAPUS-11111111/)
  await assert.rejects(deleteParticipantData(db.client, U, { apply: true, confirmation: confirmationPhrase(OTHER) }), /konfirmasi/)
  assert.deepEqual(db.calls, [])
})

test('user_id bukan UUID ditolak (tidak ada hapus massal lewat string kosong atau pola)', async () => {
  const db = fakeDb()
  for (const bad of ['', '%', `${U}/..`, 'u1']) await assert.rejects(deleteParticipantData(db.client, bad), /UUID/)
})

test('daftar tabel mencakup tabel produksi yang memuat data pribadi', () => {
  for (const t of ['approval_requests', 'application_logs', 'user_form_answers', 'user_llm_keys', 'work_experiences', 'education']) {
    assert.ok((USER_TABLES as readonly string[]).includes(t), t)
  }
})
