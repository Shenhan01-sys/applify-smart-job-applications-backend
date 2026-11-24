import test from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import { automationRoutes } from '../api/routes/automation.js'
import { coerceSettingsNumber, EDITABLE_SETTINGS_COLUMNS, sanitizeSettingsPatch } from '../services/automation-settings.js'
import { KEYWORDS_REQUIRED_MESSAGE, SearchInputError } from '../services/automation.service.js'
import { makeExtensionTestDb, OTHER_USER_ID, USER_ID } from './extension-test-db.js'

/**
 * PUT /api/automation/settings menulis dengan kunci service-role. Badan permintaan tidak boleh disebar ke
 * insert/update: `user_id` kiriman klien tidak boleh menimpa milik pemanggil, kolom tak dikenal dibuang.
 */

async function buildApp(db: any, userId: string | null = USER_ID) {
  const app = Fastify()
  app.addHook('preHandler', async (req) => {
    if (userId) (req as any).user = { id: userId }
  })
  await app.register(automationRoutes, { prefix: '/api/automation', db })
  return app
}

const put = (app: any, payload: unknown) => app.inject({ method: 'PUT', url: '/api/automation/settings', payload })

test('PUT /settings: user_id, id, created_at, kolom tak dikenal dibuang; baris selalu milik pemanggil', async () => {
  const store = makeExtensionTestDb({ user_automation_settings: [] })
  const app = await buildApp(store.db)

  const res = await put(app, {
    user_id: OTHER_USER_ID,
    id: 'id-sembarang',
    created_at: '2001-01-01T00:00:00Z',
    updated_at: '2001-01-01T00:00:00Z',
    is_admin: true,
    first_name: 'Budi',
  })
  assert.equal(res.statusCode, 200)
  const rows = store.tables.user_automation_settings
  assert.equal(rows.length, 1)
  assert.equal(rows[0].user_id, USER_ID)
  assert.equal(rows[0].first_name, 'Budi')
  assert.equal('is_admin' in rows[0], false)
  assert.notEqual(rows[0].id, 'id-sembarang')
  assert.notEqual(rows[0].created_at, '2001-01-01T00:00:00Z')
  assert.equal(res.json().user_id, USER_ID)
})

test('PUT /settings: update tidak menyentuh baris pengguna lain walau badan memuat user_id orang lain', async () => {
  const store = makeExtensionTestDb({
    user_automation_settings: [
      { id: 'row-a', user_id: USER_ID, first_name: 'Budi' },
      { id: 'row-b', user_id: OTHER_USER_ID, first_name: 'Sari' },
    ],
  })
  const app = await buildApp(store.db)

  const res = await put(app, { user_id: OTHER_USER_ID, id: 'row-b', first_name: 'Dimas' })
  assert.equal(res.statusCode, 200)
  const [a, b] = store.tables.user_automation_settings
  assert.equal(a.first_name, 'Dimas')
  assert.equal(a.user_id, USER_ID)
  assert.equal(b.first_name, 'Sari')
  assert.equal(b.user_id, OTHER_USER_ID)
})

test('PUT /settings: gaji, CTC, masa pemberitahuan kosong/0/NaN menjadi null; angka sah tetap', async () => {
  const store = makeExtensionTestDb({ user_automation_settings: [] })
  const app = await buildApp(store.db)

  await put(app, { desired_salary: 0, current_ctc: '', notice_period: 'abc' })
  let row = store.tables.user_automation_settings[0]
  assert.equal(row.desired_salary, null)
  assert.equal(row.current_ctc, null)
  assert.equal(row.notice_period, null)

  await put(app, { desired_salary: 8_500_000, current_ctc: '6000000', notice_period: 14 })
  row = store.tables.user_automation_settings[0]
  assert.equal(row.desired_salary, 8_500_000)
  assert.equal(row.current_ctc, 6_000_000)
  assert.equal(row.notice_period, 14)
})

test('coerceSettingsNumber: kosong, null, NaN, Infinity, 0, negatif, teks bukan angka: null', () => {
  for (const v of ['', '  ', null, undefined, Number.NaN, Infinity, 0, -5, 'abc', {}, [], true]) {
    assert.equal(coerceSettingsNumber(v), null, String(v))
  }
  assert.equal(coerceSettingsNumber(12), 12)
  assert.equal(coerceSettingsNumber(' 7.5 '), 7.5)
})

test('sanitizeSettingsPatch: tipe dipaksa ke kolom; boolean dan daftar yang salah bentuk dibuang', () => {
  const patch = sanitizeSettingsPatch({
    first_name: 'A',
    phone_number: 628123,
    cover_letter: { x: 1 },
    easy_apply_only: 'true',
    pause_before_submit: false,
    search_keywords: ['  data ', '', 'analis', 5],
    blacklist_words: 'a, b ,,c',
    work_type_filter: { bukan: 'daftar' },
    extension_auto_use: true,
  })
  assert.deepEqual(patch, {
    first_name: 'A',
    phone_number: '628123',
    pause_before_submit: false,
    search_keywords: ['data', 'analis'],
    blacklist_words: ['a', 'b', 'c'],
    extension_auto_use: true,
  })
})

test('sanitizeSettingsPatch: badan bukan objek menghasilkan patch kosong', () => {
  for (const body of [null, undefined, 'x', 5, [], [{ first_name: 'A' }]]) {
    assert.deepEqual(sanitizeSettingsPatch(body), {})
  }
})

test('daftar putih tidak memuat id, user_id, created_at, updated_at', () => {
  for (const col of ['id', 'user_id', 'created_at', 'updated_at']) {
    assert.equal(EDITABLE_SETTINGS_COLUMNS.includes(col), false, col)
  }
  assert.ok(EDITABLE_SETTINGS_COLUMNS.includes('extension_auto_use'))
})

test('PUT /settings: sebelum migrasi (kolom extension_auto_use belum ada) simpan diulang tanpa kolom itu', async () => {
  const store = makeExtensionTestDb(
    { user_automation_settings: [{ id: 'row-a', user_id: USER_ID, first_name: 'Budi' }] },
    { missingColumns: { user_automation_settings: ['extension_auto_use'] } }
  )
  const app = await buildApp(store.db)

  const res = await put(app, { first_name: 'Dimas', extension_auto_use: true })
  assert.equal(res.statusCode, 200)
  assert.equal(store.tables.user_automation_settings[0].first_name, 'Dimas')
  assert.equal('extension_auto_use' in store.tables.user_automation_settings[0], false)
  // GET tetap menjawab false untuk kolom yang belum ada.
  const got = await app.inject({ method: 'GET', url: '/api/automation/settings' })
  assert.equal(got.statusCode, 200)
  assert.equal(got.json().extension_auto_use, false)
})

test('PUT /settings: sesudah migrasi extension_auto_use tersimpan', async () => {
  const store = makeExtensionTestDb({ user_automation_settings: [{ id: 'row-a', user_id: USER_ID }] })
  const app = await buildApp(store.db)
  const res = await put(app, { extension_auto_use: true })
  assert.equal(res.statusCode, 200)
  assert.equal(store.tables.user_automation_settings[0].extension_auto_use, true)
  assert.equal(res.json().extension_auto_use, true)
})

test('PUT /settings: galat database tidak sampai ke klien (pesan umum Indonesia + kode)', async () => {
  const store = makeExtensionTestDb(
    {},
    { failTables: { user_automation_settings: { code: '42501', message: 'permission denied for table user_automation_settings (secret detail)' } } }
  )
  const app = await buildApp(store.db)
  const res = await put(app, { first_name: 'A' })
  assert.equal(res.statusCode, 500)
  assert.deepEqual(res.json(), { error: 'Pengaturan belum bisa disimpan. Coba lagi.', code: 'settings_save_failed' })
  assert.doesNotMatch(res.body, /permission denied|secret detail|42501/)

  const got = await app.inject({ method: 'GET', url: '/api/automation/settings' })
  assert.equal(got.statusCode, 500)
  assert.equal(got.json().code, 'settings_load_failed')
  assert.doesNotMatch(got.body, /permission denied|secret detail/)
})

test('PUT /settings tanpa login: 401, tidak menulis', async () => {
  const store = makeExtensionTestDb({ user_automation_settings: [] })
  const app = await buildApp(store.db, null)
  const res = await put(app, { first_name: 'A' })
  assert.equal(res.statusCode, 401)
  assert.equal(store.tables.user_automation_settings.length, 0)
})

test('POST /search: kata kunci kosong dan profil kosong dijawab 400 berpesan Indonesia, galat lain tetap 500', async () => {
  const run = async (service: any) => {
    const app = Fastify()
    app.addHook('preHandler', async (req) => {
      ;(req as any).user = { id: USER_ID }
    })
    await app.register(automationRoutes, { prefix: '/api/automation', db: makeExtensionTestDb().db, service })
    return app.inject({ method: 'POST', url: '/api/automation/search', payload: {} })
  }
  const missing = await run({ searchJobs: async () => { throw new SearchInputError(KEYWORDS_REQUIRED_MESSAGE, 'keywords_required') } })
  assert.equal(missing.statusCode, 400)
  assert.deepEqual(missing.json(), { error: KEYWORDS_REQUIRED_MESSAGE, code: 'keywords_required' })

  const broken = await run({ searchJobs: async () => { throw new Error('boom') } })
  assert.equal(broken.statusCode, 500)
})
