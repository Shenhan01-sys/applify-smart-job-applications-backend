import crypto from 'crypto'
import type { GuardDb } from './queue-guard.js'
import { APPROVAL_CLAIM_TABLE } from './extension-runner.js'
import { APPROVAL_TTL_MS } from '../api/routes/approval.js'

/**
 * Penanganan klaim persetujuan yang macet (`approval_submit_claims`) — Catatan 16 section 4.4.
 *
 * Masalah: bila worker atau ekstensi crash/putus sesudah mengklaim `approval_submit_claims` sebelum sempat
 * menulis `application_logs`, baris persetujuan terkunci selamanya tanpa tanda yang jelas di UI.
 *
 * Prinsip keamanan mutlak:
 *   - JANGAN pernah menghapus klaim dari `approval_submit_claims` saat status pengiriman tidak pasti (tombol
 *     Submit mungkin sudah terklik di situs lowongan).
 *   - Sajikan status `locked_stuck` secara jujur beserta dua jalan pulih sadar sesudah pengguna memeriksa
 *     kotak masuk / portal lowongan:
 *       1) `mark_sent`: catat log `success` (`manual_recovery`) & majukan lamaran ke `submitted` (klaim tetap).
 *       2) `create_fresh_approval`: biarkan klaim lama tetap terkunci selamanya, catat log `incomplete`
 *          (`reason: abandoned_locked_claim`), dan buat `approval_requests` baru berstatus `pending`.
 *
 * Penjaga pemulihan (temuan keamanan review v2):
 *   - Kedua jalan hanya diterima bila status klaim SAAT ITU `locked_stuck`. Klaim `in_progress` (worker atau ekstensi
 *     masih mengirim) ditolak 409, supaya pemulihan tidak menimbulkan lamaran ganda.
 *   - Log `abandoned_locked_claim` dihitung sebagai klaim yang sudah diselesaikan (`abandoned`), jadi banner hilang
 *     dan klik ulang dijawab 409, bukan membuat persetujuan baru lagi.
 *   - Persetujuan baru memakai id turunan dari id lama, sehingga dua permintaan paralel tidak bisa membuat dua.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const EXTENSION_CLAIM_STALE_MS = 2 * 60 * 1000
export const MAX_CLAIM_STATUS_IDS = 50
/** Nilai `details.reason` pada log `incomplete` yang menandai klaim lama ditinggalkan oleh `create_fresh_approval`. */
export const ABANDONED_REASON = 'abandoned_locked_claim'

export type ClaimStatusKind = 'none' | 'in_progress' | 'submitted' | 'abandoned' | 'locked_stuck'

export interface ClaimStatusInfo {
  approvalId: string
  state: ClaimStatusKind
  channel: 'worker' | 'extension' | null
  claimedAt: string | null
  queueJobId: string | null
  runId: string | null
}

export type ClaimResolution = 'mark_sent' | 'create_fresh_approval'

export class ClaimRecoveryError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string
  ) {
    super(message)
  }
}

export async function getClaimStatuses(
  db: GuardDb,
  userId: string,
  rawIds: unknown,
  now: Date = new Date()
): Promise<Record<string, ClaimStatusInfo>> {
  const ids = (Array.isArray(rawIds) ? rawIds : [])
    .filter((id): id is string => typeof id === 'string' && UUID_RE.test(id))
    .slice(0, MAX_CLAIM_STATUS_IDS)

  const out: Record<string, ClaimStatusInfo> = {}
  if (ids.length === 0) return out

  const [claimsRes, logsRes, queueRes] = await Promise.all([
    db.from(APPROVAL_CLAIM_TABLE).select('approval_request_id, channel, queue_job_id, run_id, created_at').eq('user_id', userId).in('approval_request_id', ids),
    db.from('application_logs').select('status, details').eq('user_id', userId).in('status', ['success', 'submit_unverified', 'incomplete']).in('details->>approval_request_id', ids),
    db.from('automation_queue').select('id, status, payload').eq('user_id', userId).in('job_type', ['apply', 'extension_apply']).in('status', ['pending', 'processing']).in('payload->>approval_request_id', ids),
  ])

  if (claimsRes.error) {
    // Jika tabel klaim belum dimigrasi di DB tertentu, laporkan kosong tanpa melempar error ke UI riwayat.
    if (claimsRes.error.code === '42P01' || claimsRes.error.code === 'PGRST205') return out
    throw new ClaimRecoveryError(500, 'claims_lookup_failed', 'Gagal memeriksa status klaim pengiriman')
  }

  // Bukti tidak bisa dibaca (log atau antrean): jangan menyatakan `locked_stuck`, karena pengiriman mungkin sudah
  // terjadi atau masih berjalan. Status jatuh ke `in_progress` (tidak ada tombol pemulihan) sampai bukti terbaca.
  const evidenceUnknown = Boolean(logsRes.error) || Boolean(queueRes.error)

  const submittedIds = new Set<string>()
  const abandonedIds = new Set<string>()
  for (const row of Array.isArray(logsRes.data) ? logsRes.data : []) {
    const aid = row?.details?.approval_request_id
    if (typeof aid !== 'string') continue
    if (row.status === 'success' || row.status === 'submit_unverified') submittedIds.add(aid)
    else if (row.status === 'incomplete' && row.details?.reason === ABANDONED_REASON) abandonedIds.add(aid)
  }

  const activeQueueIds = new Set<string>()
  for (const row of Array.isArray(queueRes.data) ? queueRes.data : []) {
    const aid = row?.payload?.approval_request_id
    if (typeof aid === 'string') activeQueueIds.add(aid)
  }

  const claimByApproval = new Map<string, any>()
  for (const c of Array.isArray(claimsRes.data) ? claimsRes.data : []) {
    if (typeof c?.approval_request_id === 'string') claimByApproval.set(c.approval_request_id, c)
  }

  for (const id of ids) {
    const claim = claimByApproval.get(id)
    if (!claim) {
      out[id] = { approvalId: id, state: 'none', channel: null, claimedAt: null, queueJobId: null, runId: null }
      continue
    }
    const channel = claim.channel === 'extension' ? 'extension' : 'worker'
    if (submittedIds.has(id)) {
      out[id] = {
        approvalId: id,
        state: 'submitted',
        channel,
        claimedAt: claim.created_at ?? null,
        queueJobId: claim.queue_job_id ?? null,
        runId: claim.run_id ?? null,
      }
      continue
    }

    if (abandonedIds.has(id)) {
      out[id] = {
        approvalId: id,
        state: 'abandoned',
        channel,
        claimedAt: claim.created_at ?? null,
        queueJobId: claim.queue_job_id ?? null,
        runId: claim.run_id ?? null,
      }
      continue
    }

    const claimedMs = claim.created_at ? new Date(claim.created_at).getTime() : 0
    const staleExt = channel === 'extension' && (!Number.isFinite(claimedMs) || now.getTime() - claimedMs >= EXTENSION_CLAIM_STALE_MS)
    const workerStillRunning = channel === 'worker' && activeQueueIds.has(id)
    const isStuck = !evidenceUnknown && (channel === 'worker' ? !workerStillRunning : staleExt)

    out[id] = {
      approvalId: id,
      state: isStuck ? 'locked_stuck' : 'in_progress',
      channel,
      claimedAt: claim.created_at ?? null,
      queueJobId: claim.queue_job_id ?? null,
      runId: claim.run_id ?? null,
    }
  }

  return out
}

export async function resolveLockedClaim(
  db: GuardDb,
  userId: string,
  approvalId: string,
  resolution: ClaimResolution,
  now: Date = new Date()
): Promise<{ ok: true; resolution: ClaimResolution; newApprovalId: string | null }> {
  if (!UUID_RE.test(approvalId)) {
    throw new ClaimRecoveryError(400, 'invalid_approval_id', 'ID persetujuan tidak valid')
  }
  if (resolution !== 'mark_sent' && resolution !== 'create_fresh_approval') {
    throw new ClaimRecoveryError(400, 'invalid_resolution', 'Pilihan penyelesaian klaim tidak valid')
  }

  const { data: approval, error: appErr } = await db
    .from('approval_requests')
    .select('id, user_id, job_id, application_id, job_title, company, platform, cover_letter, answers, resume_url, status')
    .eq('id', approvalId)
    .eq('user_id', userId)
    .maybeSingle()

  if (appErr) throw new ClaimRecoveryError(500, 'approval_lookup_failed', 'Gagal membaca persetujuan')
  if (!approval) throw new ClaimRecoveryError(404, 'approval_not_found', 'Persetujuan tidak ditemukan')

  // Status klaim dihitung ulang di sini (bukan dipercaya dari klien): hanya `locked_stuck` yang boleh dipulihkan.
  const statuses = await getClaimStatuses(db, userId, [approvalId], now)
  const claim = statuses[approvalId]
  if (!claim) throw new ClaimRecoveryError(503, 'claim_unavailable', 'Tabel klaim persetujuan belum tersedia')
  if (claim.state !== 'locked_stuck') {
    switch (claim.state) {
      case 'in_progress':
        throw new ClaimRecoveryError(409, 'claim_in_progress', 'Pengiriman untuk persetujuan ini masih berjalan atau statusnya belum bisa dipastikan. Coba lagi nanti.')
      case 'submitted':
        throw new ClaimRecoveryError(409, 'already_logged', 'Persetujuan ini sudah memiliki catatan pengiriman.')
      case 'abandoned':
        throw new ClaimRecoveryError(409, 'already_resolved', 'Klaim ini sudah ditinggalkan dan persetujuan baru sudah dibuat.')
      default:
        throw new ClaimRecoveryError(409, 'claim_not_found', 'Persetujuan ini tidak sedang terkunci oleh klaim aktif')
    }
  }

  if (resolution === 'mark_sent') {
    const { error: logErr } = await db.from('application_logs').insert({
      user_id: userId,
      job_id: approval.job_id,
      job_title: approval.job_title ?? null,
      company: approval.company ?? null,
      action: 'apply',
      platform: String(approval.platform ?? 'web'),
      status: 'success',
      details: {
        approval_request_id: approvalId,
        channel: 'manual_recovery',
        recovered_from_claim: true,
        previous_channel: claim.channel,
      },
    })
    if (logErr) throw new ClaimRecoveryError(500, 'log_insert_failed', 'Gagal menyimpan catatan terkirim manual')

    if (approval.application_id) {
      await db
        .from('ai_applications')
        .update({
          status: 'submitted',
          submitted_at: now.toISOString(),
          follow_up_scheduled: new Date(now.getTime() + 4 * 86400 * 1000).toISOString(),
        })
        .eq('id', approval.application_id)
        .eq('user_id', userId)
    }
    return { ok: true, resolution, newApprovalId: null }
  }

  // `create_fresh_approval`: KLAIM LAMA TIDAK PERNAH DIHAPUS. Dibuat dulu permintaan persetujuan baru berstatus `pending`
  // (id turunan dari id lama: permintaan paralel kedua bentrok di kunci utama dan dijawab 409), baru log abandonment
  // eksplisit ditulis. Bila log gagal, klaim tetap `locked_stuck` (banner tetap ada) dan klik ulang dijawab 409.
  const newId = freshApprovalId(approvalId)
  const { data: insertedRows, error: insErr } = await db
    .from('approval_requests')
    .insert({
      id: newId,
      user_id: userId,
      job_id: approval.job_id,
      application_id: approval.application_id ?? null,
      job_title: approval.job_title,
      company: approval.company,
      platform: approval.platform,
      cover_letter: approval.cover_letter ?? null,
      answers: Array.isArray(approval.answers) ? approval.answers : [],
      resume_url: approval.resume_url ?? null,
      status: 'pending',
      expires_at: new Date(now.getTime() + APPROVAL_TTL_MS).toISOString(),
    })
    .select('id')

  if (insErr) {
    if (insErr.code === '23505') {
      throw new ClaimRecoveryError(409, 'already_resolved', 'Persetujuan baru untuk klaim ini sudah dibuat.')
    }
    throw new ClaimRecoveryError(500, 'fresh_approval_failed', 'Gagal membuat permintaan persetujuan baru')
  }
  const created = Array.isArray(insertedRows) ? insertedRows[0] : insertedRows

  const { error: abandonErr } = await db.from('application_logs').insert({
    user_id: userId,
    job_id: approval.job_id,
    job_title: approval.job_title ?? null,
    company: approval.company ?? null,
    action: 'apply',
    platform: String(approval.platform ?? 'web'),
    status: 'incomplete',
    details: {
      approval_request_id: approvalId,
      reason: ABANDONED_REASON,
      previous_channel: claim.channel,
      queue_job_id: claim.queueJobId ?? null,
      run_id: claim.runId ?? null,
      fresh_approval_id: String(created?.id ?? newId),
    },
  })
  if (abandonErr) {
    throw new ClaimRecoveryError(500, 'log_insert_failed', 'Persetujuan baru dibuat, tetapi catatan pelepasan klaim gagal disimpan')
  }

  return { ok: true, resolution, newApprovalId: String(created?.id ?? newId) }
}

/** UUID deterministik (bentuk v5) dari id persetujuan lama: satu klaim hanya bisa melahirkan satu persetujuan baru. */
function freshApprovalId(oldApprovalId: string): string {
  const bytes = crypto.createHash('sha256').update(`applify:fresh-approval:${oldApprovalId.toLowerCase()}`).digest().subarray(0, 16)
  bytes[6] = (bytes[6] & 0x0f) | 0x50
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = Buffer.from(bytes).toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
}
