import { buildCoverLetterPdf } from './cover-letter-pdf.js'
import { EXT_FILE_KINDS, type ExtFileKind } from './extension-file-targets.js'
import { ExtensionRunnerError } from './extension-runner.js'
import { ownResumePath, RESUME_BUCKET } from './resume-file.service.js'
import type { GuardDb } from './queue-guard.js'

/**
 * Berkas lamaran untuk Ekstensi Browser Applify (`GET /api/extension/documents/:approvalId/:kind`).
 *
 * Ekstensi tidak punya izin host Supabase, jadi berkas lewat backend. Server membaca bucket privat `resumes`
 * dengan service role (melewati RLS), karena itu sebuah path dipercaya hanya bila bentuknya persis yang ditulis
 * frontend dan berada di folder pengguna itu sendiri. Path lain tidak pernah diunduh (aturan yang sama dengan worker:
 * `worker/src/lib/profileDocuments.ts`, `worker/src/lib/resumeFile.ts`).
 *
 * Isi tiap jenis:
 *   - resume: CV di `profiles.resume_url` (pdf, doc, docx);
 *   - cover_letter: PDF dibuat dari `approval_requests.cover_letter` (teks yang disetujui), nol dependensi;
 *   - transcript / portfolio: `profiles.transcript_url` / `profiles.portfolio_file_url`.
 * Teks galat storage atau database tidak pernah ikut ke klien.
 */

export const EXT_DOCUMENT_MAX_BYTES = 5 * 1024 * 1024
const DOWNLOAD_TIMEOUT_MS = 20_000

export const isExtDocumentKind = (v: unknown): v is ExtFileKind => typeof v === 'string' && (EXT_FILE_KINDS as readonly string[]).includes(v)

export interface ExtensionDocument {
  bytes: Buffer
  contentType: string
  /** ASCII bersih (`[A-Za-z0-9._-]`), aman untuk `Content-Disposition`. */
  filename: string
}

const CONTENT_TYPE: Record<string, string> = {
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
}

/** Nama berkas yang terlihat perekrut: "Budi Santoso" -> "Budi-Santoso-<suffix>.<ext>". ASCII saja, tanpa karakter jalur. */
export function attachmentFileName(applicantName: unknown, suffix: string, ext: string): string {
  const name = String(applicantName ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '')
  return `${name ? `${name}-` : ''}${suffix}.${ext}`
}

/**
 * Path dokumen opsional profil: tepat dua segmen `<user_id>/<kind>-<angka>.<pdf|doc|docx>` untuk jenis yang diminta.
 * URL, subfolder, folder pengguna lain, `..`, atau jenis lain (CV di kolom transkrip) menghasilkan null.
 */
export function parseProfileDocumentPath(kind: 'transcript' | 'portfolio', value: unknown, userId: string): { path: string; ext: string } | null {
  if (typeof value !== 'string' || typeof userId !== 'string' || !userId) return null
  const parts = value.split('/')
  if (parts.length !== 2 || parts[0] !== userId) return null
  const m = new RegExp(`^${kind}-\\d{1,16}\\.(pdf|doc|docx)$`).exec(parts[1])
  return m ? { path: value, ext: m[1] } : null
}

type StorageDb = GuardDb & {
  storage?: {
    from(bucket: string): { download(path: string): Promise<{ data: Blob | null; error: any }> }
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error('timeout'), { name: 'TimeoutError' })), ms)
    }),
  ]).finally(() => clearTimeout(timer))
}

const notFound = () => new ExtensionRunnerError(404, 'document_not_found', 'Berkas tidak ditemukan')
const tooLarge = () => new ExtensionRunnerError(413, 'too_large', 'Berkas lebih besar dari 5 MB')

/** Objek storage tidak ada (404 dari Storage) atau galat lain. Teks galat tidak pernah diteruskan. */
const isStorageNotFound = (err: any): boolean =>
  String(err?.statusCode) === '404' || err?.status === 404 || /not.?found/i.test(String(err?.message ?? ''))

async function downloadOwnObject(db: StorageDb, bucket: string, objectPath: string): Promise<Buffer> {
  if (!db.storage || typeof db.storage.from !== 'function') {
    throw new ExtensionRunnerError(503, 'storage_unavailable', 'Penyimpanan berkas belum siap')
  }
  let data: Blob | null
  try {
    const res = await withTimeout(db.storage.from(bucket).download(objectPath), DOWNLOAD_TIMEOUT_MS)
    if (res.error) {
      if (isStorageNotFound(res.error)) throw notFound()
      throw new ExtensionRunnerError(502, 'storage_failed', 'Gagal mengambil berkas dari penyimpanan')
    }
    data = res.data
  } catch (err) {
    if (err instanceof ExtensionRunnerError) throw err
    throw new ExtensionRunnerError(502, 'storage_failed', 'Gagal mengambil berkas dari penyimpanan')
  }
  if (!data) throw notFound()
  // Blob.size diketahui sebelum byte dibaca: objek terlalu besar tidak pernah dimuat ke memori.
  const declared = Number(data.size)
  if (!Number.isFinite(declared)) throw new ExtensionRunnerError(502, 'storage_failed', 'Gagal mengambil berkas dari penyimpanan')
  if (declared <= 0) throw notFound()
  if (declared > EXT_DOCUMENT_MAX_BYTES) throw tooLarge()
  const buf = Buffer.from(await data.arrayBuffer())
  if (buf.length === 0) throw notFound()
  if (buf.length > EXT_DOCUMENT_MAX_BYTES) throw tooLarge()
  return buf
}

/**
 * Berkas `kind` untuk persetujuan yang sudah diverifikasi pemanggil (`verifyExtensionApproval`: pemilik, status approved).
 * `approval` adalah baris `approval_requests` milik pengguna itu.
 */
export async function loadExtensionDocument(
  db: StorageDb,
  args: { userId: string; kind: ExtFileKind; approval: Record<string, any> }
): Promise<ExtensionDocument> {
  const { userId, kind, approval } = args

  let profile: Record<string, any> | null = null
  try {
    const { data, error } = await db.from('profiles').select('*').eq('id', userId).maybeSingle()
    if (error) throw new Error('profile')
    profile = data ?? null
  } catch {
    // Nama pelamar hanya hiasan pada nama berkas surat lamaran; jenis lain butuh path dari profil.
    if (kind !== 'cover_letter') throw new ExtensionRunnerError(500, 'profile_lookup_failed', 'Gagal membaca profil')
  }
  const applicantName = profile?.full_name

  if (kind === 'cover_letter') {
    const text = typeof approval.cover_letter === 'string' ? approval.cover_letter.trim() : ''
    if (!text) throw notFound()
    const filename = attachmentFileName(applicantName, 'Cover-Letter', 'pdf')
    const title = filename === 'Cover-Letter.pdf' ? 'Cover Letter' : `Cover Letter - ${filename.replace(/-Cover-Letter\.pdf$/, '').replace(/-/g, ' ')}`
    const bytes = buildCoverLetterPdf(text, { title })
    if (bytes.length > EXT_DOCUMENT_MAX_BYTES) throw tooLarge()
    return { bytes, contentType: CONTENT_TYPE.pdf, filename }
  }

  if (kind === 'resume') {
    const path = ownResumePath(profile?.resume_url, userId)
    if (!path) throw notFound()
    const ext = /\.(pdf|doc|docx)$/i.exec(path)?.[1].toLowerCase() ?? 'pdf'
    const bytes = await downloadOwnObject(db, RESUME_BUCKET, path)
    return { bytes, contentType: CONTENT_TYPE[ext], filename: attachmentFileName(applicantName, 'Resume', ext) }
  }

  const stored = kind === 'transcript' ? profile?.transcript_url : profile?.portfolio_file_url
  const parsed = parseProfileDocumentPath(kind, stored, userId)
  if (!parsed) throw notFound()
  const bytes = await downloadOwnObject(db, RESUME_BUCKET, parsed.path)
  return {
    bytes,
    contentType: CONTENT_TYPE[parsed.ext],
    filename: attachmentFileName(applicantName, kind === 'transcript' ? 'Transcript' : 'Portfolio', parsed.ext),
  }
}
