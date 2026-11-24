/**
 * Alasan tugas `extension_apply` menunggu, dalam kode mesin.
 *
 * `automation_queue` tidak punya kolom alasan (dan tidak ada migrasi untuk itu), jadi alasannya dikodekan sebagai
 * awalan stabil di `error_message` saat ekstensi melepas tugas:
 *
 *   permission_required:<host> — Izin situs ATS belum diberikan di ekstensi.
 *
 * Web app membaca baris antrean langsung dari Supabase (RLS pemilik), jadi `src/lib/extensionWaitReason.ts` di
 * frontend memuat parser yang sama. Jaga keduanya tetap sama. Baris lama (sebelum awalan ini ada) tetap terbaca:
 * pesan lama persis dianggap `permission_required` tanpa host.
 */

export const PERMISSION_REQUIRED_CODE = 'permission_required'
export const LEGACY_PERMISSION_TEXT = 'Izin situs ATS belum diberikan di ekstensi.'

/** Tugas pending yang jatuh temponya terlewat sejauh ini belum pernah disentuh ekstensi mana pun (ekstensi poll tiap menit). */
export const NO_EXTENSION_SEEN_AFTER_MS = 5 * 60 * 1000

export type ExtensionWaitReason = 'permission_required' | 'no_extension_seen'

export interface ExtensionWait {
  extension_wait_reason: ExtensionWaitReason | null
  /** Host yang butuh izin; hanya terisi untuk `permission_required` yang membawa host. */
  extension_wait_host: string | null
}

const HOST_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/
const PREFIX = `${PERMISSION_REQUIRED_CODE}:`

/** Host valid (huruf kecil, label dipisah titik, tanpa port atau jalur) atau null. */
function cleanHost(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const host = raw.trim().toLowerCase()
  return host.length <= 253 && HOST_RE.test(host) ? host : null
}

/** Bersihkan teks error pelepasan: satu baris, paling banyak 240 karakter. */
export function cleanReleaseText(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const text = raw.replace(/[\r\n\t]+/g, ' ').trim().slice(0, 240)
  return text || null
}

/**
 * Baca kode `permission_required` dari `error_message`. Null bila bukan alasan itu. `host` null bila baris lama
 * (pesan lama tanpa awalan) atau hostnya tidak sah.
 */
export function parsePermissionRequired(errorMessage: unknown): { host: string | null } | null {
  const text = cleanReleaseText(errorMessage)
  if (!text) return null
  if (text === LEGACY_PERMISSION_TEXT) return { host: null }
  if (text === PERMISSION_REQUIRED_CODE) return { host: null }
  if (!text.startsWith(PREFIX)) return null
  const token = text.slice(PREFIX.length).split(/\s/, 1)[0]
  return { host: cleanHost(token) }
}

/**
 * Teks `error` yang boleh disimpan saat melepas tugas. Awalan `permission_required:` dengan host sah dipertahankan
 * (host dinormalkan huruf kecil); awalan dengan host rusak diganti pesan lama supaya kode tidak bisa dipalsukan
 * dengan isi bebas.
 */
export function sanitizeReleaseError(raw: unknown): string | null {
  const text = cleanReleaseText(raw)
  if (!text) return null
  if (text === PERMISSION_REQUIRED_CODE || text.startsWith(PREFIX)) {
    const parsed = parsePermissionRequired(text)
    if (!parsed?.host) return LEGACY_PERMISSION_TEXT
    const rest = text.slice(PREFIX.length).replace(/^\S+/, '')
    return cleanReleaseText(`${PREFIX}${parsed.host}${rest}`)
  }
  return text
}

export interface WaitRow {
  job_type?: string | null
  status?: string | null
  error_message?: string | null
  scheduled_at?: string | null
}

/**
 * Alasan satu baris antrean ekstensi menunggu.
 *  - `no_extension_seen`: pending dan jatuh temponya terlewat >= 5 menit. Tidak ada ekstensi aktif yang mengambilnya
 *    (belum terpasang, belum terhubung, token habis, peramban tertutup, atau saklar "Isi otomatis di latar" mati).
 *    Ini menang atas alasan lama: pesan "butuh izin" dari sebelum ekstensi berhenti tidak lagi benar.
 *  - `permission_required`: pending dan pelepasan terakhir membawa kode itu (ekstensi aktif tetapi izin situs belum ada).
 */
export function describeExtensionWait(row: WaitRow | null | undefined, now: number = Date.now()): ExtensionWait {
  const none: ExtensionWait = { extension_wait_reason: null, extension_wait_host: null }
  if (!row || row.job_type !== 'extension_apply' || row.status !== 'pending') return none
  const scheduled = typeof row.scheduled_at === 'string' ? Date.parse(row.scheduled_at) : NaN
  if (Number.isFinite(scheduled) && now - scheduled >= NO_EXTENSION_SEEN_AFTER_MS) {
    return { extension_wait_reason: 'no_extension_seen', extension_wait_host: null }
  }
  const permission = parsePermissionRequired(row.error_message)
  if (permission) return { extension_wait_reason: 'permission_required', extension_wait_host: permission.host }
  return none
}
