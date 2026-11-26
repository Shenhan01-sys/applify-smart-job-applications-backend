import crypto from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { isPublicHttpUrl } from './apply-channel.js'
import { isValidApplyEmail } from './email-address.js'
import {
  MAX_OFF_PORTAL_ROLES,
  MAX_OFF_PORTAL_TEXT_CHARS,
  buildPublicationFingerprint,
  type OffPortalSourceType,
} from './off-portal-ingest.service.js'

/**
 * Penyimpanan lowongan privat off-portal milik pengguna (`POST /api/jobs/off-portal/save`).
 *
 * Aturan keamanan & migrasi (Gelombang 3):
 *   - Hanya menulis ke tabel `jobs` apabila seluruh kolom dari `DRAFT_2026-11-26_private_offportal_jobs.sql`
 *     (`created_by`, `visibility`, `source_type`, `source_group_id`, `publication_fingerprint`) sudah ada.
 *   - Bila kolom belum ada di database, TIDAK pernah menyimpan sebagai lowongan publik dan TIDAK melempar error 500;
 *     mengembalikan `{ saved: false, migrationRequired: true, code: 'private_jobs_migration_required', message, jobs: [] }`.
 *   - Idempoten per `(created_by, publication_fingerprint)`: klik simpan ulang mengembalikan baris lama (`alreadySaved: true`).
 */

export const PRIVATE_JOBS_MIGRATION_FILE = 'DRAFT_2026-11-26_private_offportal_jobs.sql'
export const PRIVATE_JOBS_MIGRATION_MESSAGE =
  'Penyimpanan lowongan pribadi belum aktif di database karena migrasi DRAFT_2026-11-26_private_offportal_jobs.sql belum dijalankan. Pratinjau tetap bisa dibaca, tetapi lowongan belum disimpan ke daftar.'

const PRIVATE_COLUMNS = 'id, created_by, visibility, source_type, source_group_id, publication_fingerprint'
const MISSING_PRIVATE_COLUMN_RE =
  /created_by|visibility|source_type|source_group_id|publication_fingerprint|PGRST204|42703|does not exist|schema cache/i

export interface SaveOffPortalJobItemInput {
  title?: unknown
  company?: unknown
  location?: unknown
  description?: unknown
  sourceType?: unknown
  sourceGroupId?: unknown
  publicationFingerprint?: unknown
  applyUrl?: unknown
  applyEmail?: unknown
  whatsappUrl?: unknown
}

export interface SavedOffPortalJobRow {
  id: string
  title: string
  company: string
  location: string
  type: string
  workplace_type: string | null
  description: string
  platform_source: string
  external_url: string | null
  status: string
  posted_at: string | null
  created_by: string
  visibility: 'private'
  source_type: OffPortalSourceType
  source_group_id: string
  publication_fingerprint: string
  alreadySaved?: boolean
}

export interface SaveOffPortalResult {
  saved: boolean
  migrationRequired: boolean
  code?: 'private_jobs_migration_required' | 'invalid_items'
  message: string
  insertedCount: number
  duplicateCount: number
  jobs: SavedOffPortalJobRow[]
}

function isMissingPrivateColumnError(error: any): boolean {
  if (!error) return false
  const code = String(error.code ?? '')
  const msg = String(error.message ?? error.details ?? '')
  return code === '42703' || code === 'PGRST204' || MISSING_PRIVATE_COLUMN_RE.test(msg)
}

function normalizeSourceType(raw: unknown): OffPortalSourceType {
  if (raw === 'off_portal_poster' || raw === 'off_portal_caption' || raw === 'off_portal_link') return raw
  return 'off_portal_link'
}

function inferJobType(title: string, description: string): string {
  const hay = `${title} ${description}`.toLowerCase()
  if (/\b(magang|intern|internship|kerja praktik|pkl|msib)\b/.test(hay)) return 'internship'
  if (/\b(part[\s-]*time|paruh waktu)\b/.test(hay)) return 'part-time'
  if (/\b(freelance|lepas)\b/.test(hay)) return 'freelance'
  if (/\b(kontrak|contract)\b/.test(hay)) return 'contract'
  return 'full-time'
}

function inferWorkplaceType(location: string, description: string): 'remote' | 'hybrid' | 'on-site' | null {
  const hay = `${location} ${description}`.toLowerCase()
  if (/\bhybrid\b/.test(hay)) return 'hybrid'
  if (/\b(remote|wfh|work from home)\b/.test(hay)) return 'remote'
  if (/\b(on[\s-]*site|wfo|di kantor)\b/.test(hay)) return 'on-site'
  return null
}

function isUuid(raw: unknown): raw is string {
  return typeof raw === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw.trim())
}

/** Periksa apakah seluruh kolom migrasi privat sudah tersedia di tabel `jobs`. */
export async function checkPrivateJobsSchemaReady(db: Pick<SupabaseClient, 'from'>): Promise<{ ready: boolean; error?: any }> {
  const { error } = await db.from('jobs').select(PRIVATE_COLUMNS).limit(1)
  if (!error) return { ready: true }
  if (isMissingPrivateColumnError(error)) return { ready: false, error }
  throw new Error(`private jobs schema check failed: ${error.message ?? String(error)}`)
}

export async function savePrivateOffPortalJobs(
  db: Pick<SupabaseClient, 'from'>,
  userId: string,
  rawItems: unknown,
  now: Date = new Date(),
): Promise<SaveOffPortalResult> {
  if (!Array.isArray(rawItems) || rawItems.length === 0) {
    return {
      saved: false,
      migrationRequired: false,
      code: 'invalid_items',
      message: 'Pilih minimal satu kandidat lowongan untuk disimpan.',
      insertedCount: 0,
      duplicateCount: 0,
      jobs: [],
    }
  }

  const schema = await checkPrivateJobsSchemaReady(db)
  if (!schema.ready) {
    return {
      saved: false,
      migrationRequired: true,
      code: 'private_jobs_migration_required',
      message: PRIVATE_JOBS_MIGRATION_MESSAGE,
      insertedCount: 0,
      duplicateCount: 0,
      jobs: [],
    }
  }

  const items = (rawItems as SaveOffPortalJobItemInput[]).slice(0, MAX_OFF_PORTAL_ROLES)
  const fallbackGroupId = crypto.randomUUID()
  const savedRows: SavedOffPortalJobRow[] = []
  let insertedCount = 0
  let duplicateCount = 0

  for (const raw of items) {
    if (!raw || typeof raw !== 'object') continue
    const title = typeof raw.title === 'string' ? raw.title.trim().slice(0, 300) : ''
    if (!title) continue
    const company =
      (typeof raw.company === 'string' && raw.company.trim() ? raw.company.trim() : 'Perusahaan (Off-Portal)').slice(0, 200)
    const location = (typeof raw.location === 'string' && raw.location.trim() ? raw.location.trim() : 'Indonesia').slice(0, 120)
    const applyUrl = typeof raw.applyUrl === 'string' && isPublicHttpUrl(raw.applyUrl) ? raw.applyUrl.trim() : null
    const whatsappUrl = typeof raw.whatsappUrl === 'string' && isPublicHttpUrl(raw.whatsappUrl) ? raw.whatsappUrl.trim() : null
    const applyEmail = typeof raw.applyEmail === 'string' && isValidApplyEmail(raw.applyEmail.trim()) ? raw.applyEmail.trim() : null
    const rawDesc = typeof raw.description === 'string' ? raw.description.trim().slice(0, MAX_OFF_PORTAL_TEXT_CHARS) : ''
    // Pastikan alamat email HR yang terdeteksi tercantum di description agar classifyJobChannel & EmailApplyPanel membacanya konsisten.
    const descBase = rawDesc || `${title} — ${company}`
    const description =
      applyEmail && !descBase.toLowerCase().includes(applyEmail.toLowerCase())
        ? `${descBase}\n\nEmail rekruter: ${applyEmail}`
        : descBase
    const sourceType = normalizeSourceType(raw.sourceType)
    const sourceGroupId = isUuid(raw.sourceGroupId) ? raw.sourceGroupId.trim() : fallbackGroupId
    const publicationFingerprint =
      typeof raw.publicationFingerprint === 'string' && /^[a-f0-9]{64}$/i.test(raw.publicationFingerprint.trim())
        ? raw.publicationFingerprint.trim().toLowerCase()
        : buildPublicationFingerprint({ title, company, applyUrl, applyEmail, description })
    const externalUrl = applyUrl ?? whatsappUrl ?? null

    // Idempotensi: cek apakah lowongan privat dengan fingerprint ini sudah disimpan pengguna yang sama.
    const existingRes = await db
      .from('jobs')
      .select('*')
      .eq('created_by', userId)
      .eq('publication_fingerprint', publicationFingerprint)
      .limit(1)
    if (existingRes.error) {
      if (isMissingPrivateColumnError(existingRes.error)) {
        return {
          saved: false,
          migrationRequired: true,
          code: 'private_jobs_migration_required',
          message: PRIVATE_JOBS_MIGRATION_MESSAGE,
          insertedCount: 0,
          duplicateCount: 0,
          jobs: [],
        }
      }
      throw new Error(`private job lookup failed: ${existingRes.error.message}`)
    }
    const existing = Array.isArray(existingRes.data) ? existingRes.data[0] : null
    if (existing) {
      duplicateCount++
      savedRows.push({ ...(existing as SavedOffPortalJobRow), alreadySaved: true })
      continue
    }

    const rowPayload = {
      title,
      company,
      location,
      type: inferJobType(title, description),
      workplace_type: inferWorkplaceType(location, description),
      description,
      platform_source: sourceType,
      external_url: externalUrl,
      status: 'active',
      posted_at: now.toISOString(),
      created_by: userId,
      visibility: 'private' as const,
      source_type: sourceType,
      source_group_id: sourceGroupId,
      publication_fingerprint: publicationFingerprint,
    }

    const insertRes = await db.from('jobs').insert(rowPayload).select('*')
    if (insertRes.error) {
      if (isMissingPrivateColumnError(insertRes.error)) {
        return {
          saved: false,
          migrationRequired: true,
          code: 'private_jobs_migration_required',
          message: PRIVATE_JOBS_MIGRATION_MESSAGE,
          insertedCount: 0,
          duplicateCount: 0,
          jobs: [],
        }
      }
      throw new Error(`private job insert failed: ${insertRes.error.message}`)
    }
    const inserted = Array.isArray(insertRes.data) ? insertRes.data[0] : insertRes.data
    if (inserted) {
      insertedCount++
      savedRows.push({ ...(inserted as SavedOffPortalJobRow), alreadySaved: false })
    }
  }

  if (savedRows.length === 0) {
    return {
      saved: false,
      migrationRequired: false,
      code: 'invalid_items',
      message: 'Tidak ada kandidat lowongan valid yang bisa disimpan.',
      insertedCount: 0,
      duplicateCount: 0,
      jobs: [],
    }
  }

  const msg =
    insertedCount > 0 && duplicateCount > 0
      ? `${insertedCount} lowongan pribadi disimpan (${duplicateCount} sudah ada sebelumnya).`
      : insertedCount > 0
        ? `${insertedCount} lowongan pribadi berhasil disimpan.`
        : `${duplicateCount} lowongan pribadi ini sudah pernah kamu simpan sebelumnya.`

  return {
    saved: true,
    migrationRequired: false,
    message: msg,
    insertedCount,
    duplicateCount,
    jobs: savedRows,
  }
}
