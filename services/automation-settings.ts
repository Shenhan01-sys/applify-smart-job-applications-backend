/**
 * Daftar kolom `user_automation_settings` yang boleh diubah pengguna lewat PUT /api/automation/settings.
 *
 * Rute itu menulis dengan kunci service-role (melewati RLS). Dulu isi badan permintaan disebar langsung ke
 * insert/update, jadi `user_id` di badan bisa menimpa milik pemanggil dan kolom tak dikenal ikut tertulis.
 * Sekarang hanya kolom di bawah yang lolos, nilainya dipaksa ke tipe kolom, dan id, user_id, created_at,
 * updated_at selalu dibuang (user_id diisi server dari token).
 */

/** Kolom teks. Angka dan boolean dikonversi ke string, objek dibuang. */
const TEXT_COLUMNS = [
  'first_name', 'last_name', 'phone_number', 'current_city', 'street', 'state', 'zipcode', 'country',
  'ethnicity', 'gender', 'disability_status', 'veteran_status', 'years_of_experience', 'require_visa',
  'website', 'linkedin_url', 'us_citizenship', 'linkedin_headline', 'linkedin_summary', 'cover_letter',
  'recent_employer', 'confidence_level', 'search_location', 'ai_provider', 'ai_model',
] as const

/** Kolom numerik. Kosong, NaN, 0, negatif, dan nilai tak masuk akal menjadi null (kolom boleh null). */
const NUMERIC_COLUMNS = ['desired_salary', 'current_ctc', 'notice_period'] as const

/** Kolom jsonb berisi daftar string. */
const LIST_COLUMNS = [
  'search_keywords', 'experience_level_filter', 'job_type_filter', 'work_type_filter',
  'blacklist_companies', 'blacklist_words', 'whitelist_words',
] as const

/** Kolom boolean. Hanya `true` / `false` yang diterima; nilai lain membuat kunci dibuang (bukan ditebak). */
const BOOLEAN_COLUMNS = [
  'easy_apply_only', 'pause_before_submit', 'pause_at_failed_question', 'overwrite_previous_answers',
  'extension_auto_use',
] as const

/** Kolom yang baru ada setelah migrasi DRAFT_2026-11-24b. Bila database belum punya, simpan diulang tanpanya. */
export const OPTIONAL_SETTINGS_COLUMNS = ['extension_auto_use'] as const

export const EDITABLE_SETTINGS_COLUMNS: readonly string[] = [
  ...TEXT_COLUMNS, ...NUMERIC_COLUMNS, ...LIST_COLUMNS, ...BOOLEAN_COLUMNS,
]

const MAX_TEXT_LENGTH = 20_000
const MAX_LIST_ITEMS = 200
const MAX_LIST_ITEM_LENGTH = 300
const MAX_NUMBER = 1e12

const asTextColumn = (v: unknown): { keep: boolean; value?: string | null } => {
  if (v === null) return { keep: true, value: null }
  if (typeof v === 'string') return { keep: true, value: v.slice(0, MAX_TEXT_LENGTH) }
  if ((typeof v === 'number' && Number.isFinite(v)) || typeof v === 'boolean') return { keep: true, value: String(v) }
  return { keep: false }
}

/**
 * Angka dari formulir. Kolom kosong dikirim UI sebagai 0 (Number('') === 0), dan 0 gaji atau 0 hari tidak
 * pernah jawaban yang dimaksud pengguna, jadi semuanya menjadi null. Teks angka ("5000000") ikut dihitung.
 */
export function coerceSettingsNumber(v: unknown): number | null {
  if (v === null || v === undefined) return null
  if (typeof v === 'string') {
    const trimmed = v.trim()
    if (!trimmed) return null
    v = Number(trimmed)
  }
  if (typeof v !== 'number' || !Number.isFinite(v)) return null
  if (v <= 0 || v > MAX_NUMBER) return null
  return v
}

const asList = (v: unknown): string[] | null => {
  const source = Array.isArray(v) ? v : typeof v === 'string' ? v.split(',') : null
  if (!source) return null
  const out: string[] = []
  for (const item of source) {
    if (typeof item !== 'string') continue
    const text = item.trim().slice(0, MAX_LIST_ITEM_LENGTH)
    if (text) out.push(text)
    if (out.length >= MAX_LIST_ITEMS) break
  }
  return out
}

/**
 * Bentuk patch aman dari badan permintaan mentah. Kunci yang tidak ada di daftar, atau yang nilainya tidak
 * bisa dipaksa ke tipe kolom, tidak masuk patch (kolom itu tidak berubah).
 */
export function sanitizeSettingsPatch(body: unknown): Record<string, unknown> {
  const patch: Record<string, unknown> = {}
  if (!body || typeof body !== 'object' || Array.isArray(body)) return patch
  const src = body as Record<string, unknown>
  const has = (k: string) => Object.prototype.hasOwnProperty.call(src, k)

  for (const k of TEXT_COLUMNS) {
    if (!has(k)) continue
    const r = asTextColumn(src[k])
    if (r.keep) patch[k] = r.value
  }
  for (const k of NUMERIC_COLUMNS) {
    if (has(k)) patch[k] = coerceSettingsNumber(src[k])
  }
  for (const k of LIST_COLUMNS) {
    if (!has(k)) continue
    const list = asList(src[k])
    if (list) patch[k] = list
  }
  for (const k of BOOLEAN_COLUMNS) {
    if (has(k) && typeof src[k] === 'boolean') patch[k] = src[k]
  }
  return patch
}

/** Galat PostgREST/Postgres karena kolom belum ada di database (migrasi belum dijalankan). */
export function isMissingColumnError(err: { code?: string; message?: string } | null | undefined, column?: string): boolean {
  if (!err) return false
  if (err.code === '42703' || err.code === 'PGRST204') return true
  return Boolean(column) && new RegExp(String(column), 'i').test(String(err.message ?? ''))
}
