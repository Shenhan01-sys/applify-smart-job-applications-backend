/**
 * Hapus seluruh data satu peserta penelitian (formulir persetujuan UAT menjanjikan data dihapus sesudah penelitian).
 * Audit privasi 25 November 2026.
 *
 * Isi database produksi yang diperiksa 25 November 2026:
 *   - 28 tabel publik milik pengguna memakai FK ON DELETE CASCADE, jadi ikut terhapus saat akun auth dihapus.
 *   - `waitinglist` memakai SET NULL (baris tetap ada, termasuk email), jadi dihapus terpisah lewat user_id dan email.
 *   - Berkas di bucket `resumes` dan `agent-screenshots` disimpan di folder `<user_id>/...` dan tidak ikut CASCADE.
 *
 * Bawaan: hanya menghitung (dry-run). Penghapusan butuh `apply: true`. Laporan hanya berisi jumlah, tanpa email,
 * nama berkas, atau isi baris.
 */
export const USER_TABLES = [
  'achievements', 'activity_logs', 'agent_security_codes', 'ai_applications', 'application_logs', 'applications',
  'approval_requests', 'approval_submit_claims', 'automation_queue', 'certifications', 'education', 'events_activities',
  'green_career_assessments', 'green_career_passes', 'notification_verification_codes', 'platform_sessions', 'projects',
  'saved_jobs', 'subscriptions', 'user_automation_settings', 'user_extension_revocations', 'user_form_answers',
  'user_llm_keys', 'user_notification_settings', 'user_preferences', 'user_skills', 'work_experiences',
] as const
export const USER_BUCKETS = ['resumes', 'agent-screenshots'] as const

export interface DeletionClient {
  /** Semua path berkas di bawah `prefix` (rekursif). */
  listFiles(bucket: string, prefix: string): Promise<string[]>
  removeFiles(bucket: string, paths: string[]): Promise<void>
  countRows(table: string, column: string, value: string): Promise<number>
  deleteRows(table: string, column: string, value: string): Promise<void>
  /** Email akun auth, atau null bila akun tidak ada. Tidak pernah dicetak. */
  authEmail(userId: string): Promise<string | null>
  deleteAuthUser(userId: string): Promise<void>
}

export interface DeletionReport {
  userId: string
  applied: boolean
  authUserFound: boolean
  files: Record<string, number>
  rows: Record<string, number>
  waitinglist: number
  /** Sesudah apply: sisa baris atau berkas yang masih ada (harus kosong). */
  leftovers: string[]
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Frasa yang harus diketik untuk mode hapus: "HAPUS-" + 8 karakter pertama user_id. */
export const confirmationPhrase = (userId: string): string => `HAPUS-${userId.slice(0, 8)}`

async function inventory(client: DeletionClient, userId: string, email: string | null) {
  const files: Record<string, number> = {}
  const paths: Record<string, string[]> = {}
  for (const bucket of USER_BUCKETS) {
    paths[bucket] = await client.listFiles(bucket, `${userId}/`)
    files[bucket] = paths[bucket].length
  }
  const rows: Record<string, number> = { profiles: await client.countRows('profiles', 'id', userId) }
  for (const table of USER_TABLES) rows[table] = await client.countRows(table, 'user_id', userId)
  let waitinglist = await client.countRows('waitinglist', 'user_id', userId)
  if (email) waitinglist += await client.countRows('waitinglist', 'email', email)
  return { files, paths, rows, waitinglist }
}

export async function deleteParticipantData(
  client: DeletionClient,
  userId: string,
  opts: { apply?: boolean; confirmation?: string } = {}
): Promise<DeletionReport> {
  if (!UUID_RE.test(userId)) throw new Error('user_id harus UUID')
  const apply = opts.apply === true
  if (apply && opts.confirmation !== confirmationPhrase(userId)) {
    throw new Error(`mode hapus butuh konfirmasi ${confirmationPhrase(userId)}`)
  }
  const email = await client.authEmail(userId)
  const before = await inventory(client, userId, email)
  const report: DeletionReport = {
    userId,
    applied: apply,
    authUserFound: email !== null,
    files: before.files,
    rows: before.rows,
    waitinglist: before.waitinglist,
    leftovers: [],
  }
  if (!apply) return report

  // Urutan: berkas dulu (tidak ikut CASCADE), lalu waitinglist (SET NULL), lalu akun auth (CASCADE ke tabel publik).
  for (const bucket of USER_BUCKETS) {
    const list = before.paths[bucket]
    for (let i = 0; i < list.length; i += 100) await client.removeFiles(bucket, list.slice(i, i + 100))
  }
  await client.deleteRows('waitinglist', 'user_id', userId)
  if (email) await client.deleteRows('waitinglist', 'email', email)
  if (email !== null) await client.deleteAuthUser(userId)
  // Tabel tanpa CASCADE yang mungkin ditambahkan kemudian: dihapus langsung bila masih ada baris.
  for (const table of USER_TABLES) {
    if ((await client.countRows(table, 'user_id', userId)) > 0) await client.deleteRows(table, 'user_id', userId)
  }
  if ((await client.countRows('profiles', 'id', userId)) > 0) await client.deleteRows('profiles', 'id', userId)

  const after = await inventory(client, userId, email)
  for (const [bucket, n] of Object.entries(after.files)) if (n > 0) report.leftovers.push(`${bucket}: ${n} berkas`)
  for (const [table, n] of Object.entries(after.rows)) if (n > 0) report.leftovers.push(`${table}: ${n} baris`)
  if (after.waitinglist > 0) report.leftovers.push(`waitinglist: ${after.waitinglist} baris`)
  return report
}
