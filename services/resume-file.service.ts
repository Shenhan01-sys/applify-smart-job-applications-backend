/**
 * CV yang diunggah pengguna di Profil Saya disimpan di bucket Supabase Storage privat `resumes`.
 * `profiles.resume_url` berisi path objeknya, `<user_id>/<nama-berkas>`, bukan URL.
 *
 * Saat pengguna mengajukan draf ke Persetujuan, server membuat URL bertanda tangan (signed URL) dari path itu
 * dan menulisnya ke `approval_requests.resume_url`. Worker mengunduh URL itu lalu mengunggahnya ke formulir ATS.
 * URL dari klien tidak dipakai, supaya worker hanya mengunduh berkas milik pengguna itu sendiri.
 */
export const RESUME_BUCKET = 'resumes'

/**
 * Masa berlaku URL. Persetujuan kedaluwarsa dalam 24 jam, tetapi job apply bisa diulang sesudahnya,
 * jadi URL dibuat berlaku 7 hari. URL hanya tersimpan di baris approval milik pengguna itu (RLS).
 */
export const RESUME_URL_TTL_SECONDS = 7 * 24 * 60 * 60

// 47.1 Sup-5: izinkan spasi dan tanda kurung wajar pada nama berkas CV lama ("CV Budi (final).pdf"),
// sambil tetap menolak karakter kontrol, path separator, dan "..".
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._()\-]{0,119}$/
const RESUME_EXT = /\.(pdf|doc|docx)$/i

/** Path objek CV yang sah milik pengguna ini, atau null. Menolak folder lain, subfolder, `..`, dan ekstensi lain. */
export function ownResumePath(value: unknown, userId: string): string | null {
  if (typeof value !== 'string' || typeof userId !== 'string' || !userId) return null
  const v = value.trim()
  const parts = v.split('/')
  if (parts.length !== 2 || parts[0] !== userId) return null
  const name = parts[1]
  if (!FILE_NAME.test(name) || name.includes('..') || !RESUME_EXT.test(name)) return null
  return v
}

type StorageDb = {
  from(t: string): any
  storage: { from(bucket: string): { createSignedUrl(path: string, expiresIn: number): Promise<{ data: { signedUrl?: string } | null; error: { message: string } | null }> } }
}

/** Menandatangani path CV yang sudah tervalidasi. Null bila penandatanganan gagal atau hasilnya bukan https. */
async function signResumePath(db: StorageDb, path: string): Promise<string | null> {
  const signed = await db.storage.from(RESUME_BUCKET).createSignedUrl(path, RESUME_URL_TTL_SECONDS)
  const url = signed?.data?.signedUrl
  if (signed?.error || typeof url !== 'string' || !url.startsWith('https://')) return null
  return url
}

/** URL bertanda tangan untuk CV pengguna, atau null bila pengguna belum mengunggah CV atau penandatanganan gagal. */
export async function resumeUrlForUser(db: StorageDb, userId: string): Promise<string | null> {
  try {
    const { data, error } = await db.from('profiles').select('resume_url').eq('id', userId).maybeSingle()
    if (error) return null
    const path = ownResumePath(data?.resume_url, userId)
    if (!path) return null
    return await signResumePath(db, path)
  } catch (e) {
    console.warn('[resume-file] gagal membuat URL CV:', (e as Error)?.message)
    return null
  }
}

/**
 * Path objek CV yang tertanam di URL bertanda tangan (`.../storage/v1/object/sign/resumes/<user_id>/<berkas>?token=`),
 * atau null bila bentuknya lain atau path-nya bukan milik pengguna itu.
 */
export function resumePathFromSignedUrl(url: unknown, userId: string): string | null {
  if (typeof url !== 'string' || !url.trim()) return null
  try {
    const pathname = decodeURIComponent(new URL(url.trim()).pathname)
    const m = /\/storage\/v1\/object\/(?:sign|authenticated)\/resumes\/(.+)$/.exec(pathname)
    return m ? ownResumePath(m[1], userId) : null
  } catch {
    return null
  }
}

export interface ApprovalResumeSync {
  /** Nilai `approval_requests.resume_url` yang seharusnya dipakai sekarang. */
  url: string | null
  /** True bila berbeda dari nilai yang tersimpan di baris persetujuan, jadi baris itu perlu ditulis ulang. */
  changed: boolean
}

/**
 * Menyelaraskan `approval_requests.resume_url` dengan CV profil saat ini (audit 26 November 2026, BS-U4-01).
 * URL di baris persetujuan dibekukan saat draf diajukan, sedangkan pengguna bisa mengganti atau menghapus CV di
 * Profil sesudahnya (objek lama langsung dihapus, jadi URL lama mati). Hasilnya:
 * - path CV profil sama dengan path di URL persetujuan: tidak berubah;
 * - profil punya CV lain: URL baru yang ditandatangani dari CV profil;
 * - profil tidak punya CV sah: null, karena objek lama sudah dihapus bersama CV profilnya;
 * - profil tidak terbaca, atau penandatanganan gagal: tidak berubah (jangan menghapus CV karena galat sementara).
 * Tidak menulis apa pun; pemanggil yang menyimpan hasilnya.
 */
export async function currentResumeUrlForApproval(
  db: StorageDb,
  userId: string,
  approvalUrl: string | null | undefined
): Promise<ApprovalResumeSync> {
  const current = typeof approvalUrl === 'string' && approvalUrl.trim() ? approvalUrl : null
  const unchanged: ApprovalResumeSync = { url: current, changed: false }
  try {
    const { data, error } = await db.from('profiles').select('resume_url').eq('id', userId).maybeSingle()
    if (error || !data) return unchanged
    const profilePath = ownResumePath(data.resume_url, userId)
    if (!profilePath) return current ? { url: null, changed: true } : unchanged
    if (current && resumePathFromSignedUrl(current, userId) === profilePath) return unchanged
    const fresh = await signResumePath(db, profilePath)
    return fresh ? { url: fresh, changed: fresh !== current } : unchanged
  } catch (e) {
    console.warn('[resume-file] gagal menyelaraskan CV persetujuan:', (e as Error)?.message)
    return unchanged
  }
}
