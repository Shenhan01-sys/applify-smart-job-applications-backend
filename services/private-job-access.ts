/**
 * Penjaga kepemilikan lowongan privat untuk rute & layanan backend yang membaca tabel `jobs` lewat service role.
 *
 * Prasyarat sebelum migrasi `DRAFT_2026-11-26_private_offportal_jobs.sql` boleh dijalankan:
 *   - Klien service role melewati RLS Supabase, jadi setiap rute/layanan wajib memastikan baris dengan
 *     `visibility = 'private'` hanya dapat dibaca/diubah oleh pemiliknya (`created_by === userId`).
 *   - Bila bukan pemiliknya -> dianggap tidak ditemukan (`404`, tidak membocorkan keberadaan baris).
 *   - Sebelum kolom `visibility` dan `created_by` ada di database, kode otomatis fallback tanpa galat
 *     (semua baris dianggap publik seperti perilaku lama).
 */

const MISSING_COL_RE = /visibility|created_by|column|schema cache|does not exist/i

export function isMissingVisibilityColumnError(err: any): boolean {
  if (!err) return false
  const code = String(err.code ?? '')
  const msg = String(err.message ?? '')
  if (code === '42703' || code === 'PGRST204') return true
  return MISSING_COL_RE.test(msg) && /visibility|created_by/i.test(msg)
}

/**
 * True bila baris `jobs` boleh diakses oleh `userId`:
 *   - Baris publik (`visibility` bukan `'private'`, termasuk `undefined`/`null` pra-migrasi): selalu boleh.
 *   - Baris privat (`visibility === 'private'`): hanya bila `userId` cocok persis dengan `created_by`.
 */
export function isJobAccessibleToUser(
  row: { visibility?: unknown; created_by?: unknown } | null | undefined,
  userId?: string | null
): boolean {
  if (!row) return false
  if (row.visibility !== 'private') return true
  return typeof userId === 'string' && userId.length > 0 && row.created_by === userId
}

/**
 * Ambil satu baris `jobs` berdasarkan `id` sambil menyertakan `visibility, created_by` bila kolomnya sudah ada.
 * Bila database belum menjalankan migrasi privat (galat kolom hilang), ulangi secara otomatis hanya dengan `baseCols`.
 */
export async function selectJobWithVisibility(
  db: { from(table: string): any },
  jobId: string,
  baseCols: string
): Promise<{ data: Record<string, any> | null; error: any }> {
  const first = await db
    .from('jobs')
    .select(`${baseCols}, visibility, created_by`)
    .eq('id', jobId)
    .maybeSingle()

  if (first?.error && isMissingVisibilityColumnError(first.error)) {
    return db.from('jobs').select(baseCols).eq('id', jobId).maybeSingle()
  }
  return first
}
