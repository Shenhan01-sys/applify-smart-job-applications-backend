/**
 * Hapus data satu peserta UAT sesudah penelitian.
 *
 *   Lihat dulu (tidak menghapus apa pun):
 *     npx tsx scripts/hapus-data-peserta.ts --user <user_id>
 *   Hapus (tidak bisa dibatalkan):
 *     npx tsx scripts/hapus-data-peserta.ts --user <user_id> --apply --konfirmasi HAPUS-<8 karakter pertama user_id>
 *
 * Butuh SUPABASE_URL dan SUPABASE_SERVICE_ROLE_KEY di lingkungan. Keluaran hanya berisi jumlah.
 */
import { createClient } from '@supabase/supabase-js'
import { confirmationPhrase, deleteParticipantData, type DeletionClient } from '../services/participant-deletion.js'

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : undefined
}

const url = process.env.SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE_KEY
const userId = arg('--user') ?? ''
const apply = process.argv.includes('--apply')
if (!url || !key) {
  console.error('SUPABASE_URL dan SUPABASE_SERVICE_ROLE_KEY wajib diatur.')
  process.exit(2)
}
const sb = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })

const client: DeletionClient = {
  async listFiles(bucket, prefix) {
    const out: string[] = []
    const walk = async (dir: string) => {
      for (let offset = 0; ; offset += 100) {
        const { data, error } = await sb.storage.from(bucket).list(dir.replace(/\/$/, ''), { limit: 100, offset })
        if (error) throw new Error(`daftar berkas ${bucket} gagal: ${error.message}`)
        for (const item of data ?? []) {
          const full = `${dir}${item.name}`
          if (item.id === null) await walk(`${full}/`)
          else out.push(full)
        }
        if (!data || data.length < 100) break
      }
    }
    await walk(prefix)
    return out
  },
  async removeFiles(bucket, paths) {
    const { error } = await sb.storage.from(bucket).remove(paths)
    if (error) throw new Error(`hapus berkas ${bucket} gagal: ${error.message}`)
  },
  async countRows(table, column, value) {
    const { count, error } = await sb.from(table).select('*', { count: 'exact', head: true }).eq(column, value)
    if (error) throw new Error(`hitung ${table} gagal: ${error.message}`)
    return count ?? 0
  },
  async deleteRows(table, column, value) {
    const { error } = await sb.from(table).delete().eq(column, value)
    if (error) throw new Error(`hapus ${table} gagal: ${error.message}`)
  },
  async authEmail(id) {
    const { data, error } = await sb.auth.admin.getUserById(id)
    if (error || !data?.user) return null
    return data.user.email ?? ''
  },
  async deleteAuthUser(id) {
    const { error } = await sb.auth.admin.deleteUser(id)
    if (error) throw new Error(`hapus akun auth gagal: ${error.message}`)
  },
}

try {
  const report = await deleteParticipantData(client, userId, { apply, confirmation: arg('--konfirmasi') })
  const rows = Object.entries(report.rows).filter(([, n]) => n > 0)
  console.log(`user_id: ${report.userId}`)
  console.log(`mode: ${report.applied ? 'HAPUS' : 'lihat saja (tambahkan --apply --konfirmasi ' + confirmationPhrase(report.userId) + ')'}`)
  console.log(`akun auth: ${report.authUserFound ? 'ada' : 'tidak ada'}`)
  console.log(`berkas: ${Object.entries(report.files).map(([b, n]) => `${b}=${n}`).join(', ')}`)
  console.log(`baris: ${rows.length ? rows.map(([t, n]) => `${t}=${n}`).join(', ') : 'tidak ada'}`)
  console.log(`waitinglist: ${report.waitinglist}`)
  if (report.applied) console.log(report.leftovers.length ? `SISA: ${report.leftovers.join('; ')}` : 'Sisa: tidak ada. Data peserta sudah terhapus.')
  process.exit(report.leftovers.length ? 1 : 0)
} catch (e: any) {
  console.error(String(e?.message ?? e))
  process.exit(1)
}
