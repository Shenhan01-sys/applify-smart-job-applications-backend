import crypto from 'crypto'

/**
 * Nilai yang dipakai bersama oleh rute persetujuan, pemulihan klaim, dan penjaga kirim manual. Berkas ini sengaja
 * tidak mengimpor apa pun dari proyek, supaya tidak membuat impor melingkar antara rute dan layanan.
 */

/** Masa berlaku permintaan persetujuan sejak dibuat: 24 jam. Frontend menyebutnya lewat `APPROVAL_VALID_HOURS`. */
export const APPROVAL_TTL_MS = 24 * 60 * 60 * 1000

/** Klaim kirim ekstensi yang lebih muda dari ini dianggap masih berjalan; yang lebih tua dianggap macet. */
export const EXTENSION_CLAIM_STALE_MS = 2 * 60 * 1000

/** `details.reason` pada log `incomplete` yang menandai klaim lama dilepas oleh `create_fresh_approval`. */
export const ABANDONED_REASON = 'abandoned_locked_claim'
/** Pengguna menyatakan lamaran belum terkirim dan meminta persetujuan baru ("Belum terkirim, ulangi"). */
export const USER_NOT_SENT_REASON = 'user_not_sent'
/** Pengguna menutup persetujuan yang hasil kirimnya tidak pasti ("Tutup"). */
export const USER_CLOSED_REASON = 'user_closed'
/** Alasan log yang berarti persetujuan ini sudah diselesaikan pengguna tanpa terkirim. */
export const RESOLVED_UNSENT_REASONS: ReadonlySet<string> = new Set([ABANDONED_REASON, USER_NOT_SENT_REASON, USER_CLOSED_REASON])

/** `details.confirmed_by` pada log success yang ditulis atas pernyataan pengguna, bukan konfirmasi sistem. */
export const CONFIRMED_BY_USER = 'user'

/** UUID deterministik (bentuk v5) dari id persetujuan lama: satu persetujuan hanya bisa melahirkan satu persetujuan baru. */
export function freshApprovalId(oldApprovalId: string): string {
  const bytes = crypto.createHash('sha256').update(`applify:fresh-approval:${oldApprovalId.toLowerCase()}`).digest().subarray(0, 16)
  bytes[6] = (bytes[6] & 0x0f) | 0x50
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = Buffer.from(bytes).toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
}
