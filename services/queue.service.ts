import {
  ApprovalChannelConflictError,
  guardQueuePayload,
  InvalidPayloadError,
  PlatformLimitReachedError,
  requireApprovedRow,
  type GuardDb,
} from './queue-guard.js'
import { rateLimitService } from './rate-limit.service.js'

/** Bagian RateLimitService yang dipakai antrean apply (diganti di tes). */
export interface PlatformLimiter {
  checkPlatformLimit(platform: string, userId: string): Promise<{ allowed: boolean; remaining: number; resetAt: Date }>
}

/**
 * Queue Service — DATABASE-AS-QUEUE (tanpa Redis / BullMQ).
 *
 * ALASAN (Phase 2, 2026-08-03):
 *  - Sebelumnya file ini menginstansiasi BullMQ + ioredis SAAT MODULE DIMUAT
 *    (`new Redis('redis://localhost:6379')`), sehingga backend tidak bisa start
 *    tanpa Redis lokal dan ioredis hanya numpang transitif lewat bullmq (rapuh).
 *  - Pipeline otomasi yang AKTIF memakai database-as-queue via worker
 *    (`claim_automation_jobs`, lihat `worker/src/worker.ts`). Jalur BullMQ ini
 *    mubazir dan memaksa Redis.
 *  - Solusi: enqueue job langsung ke tabel `automation_queue` (Supabase).
 *    API yang dipakai `api/routes/queue.ts` TETAP SAMA (addScanJob/addApplyJob/
 *    addAnalyzeJob/getQueueStatus) sehingga tidak ada kode lain yang berubah.
 *
 * 2026-10-03: job_type diselaraskan dengan dispatcher worker (`worker/src/worker.ts`):
 * search | apply | email_apply | company_insight. Sebelumnya `scan_jobs` dan `analyze`
 * ditolak worker sebagai "unknown job_type".
 */

const JOB = {
  search: 'search',
  apply: 'apply',
  extensionApply: 'extension_apply',
  emailApply: 'email_apply',
  companyInsight: 'company_insight',
} as const;

/**
 * Job type yang boleh dimasukkan pengguna lewat POST /api/automation/queue, beserta prioritas bawaan dari server.
 * Prioritas tidak pernah diambil dari klien: worker mengklaim job berdasarkan `priority desc`, jadi prioritas
 * dari klien bisa dipakai menyerobot antrean. Nilai 0 sama dengan bawaan lama rute ini.
 *
 * Bukti pemakaian sah (dicek 2026-11-25):
 *  - email_apply: satu-satunya job_type yang dikirim frontend lewat rute ini
 *    (applify-smart-job-applications/src/services/emailApplyService.ts:257, `enqueueEmailApply`).
 *  - apply: kembaran POST /api/queue/apply (api/routes/queue.ts), payload lewat guard persetujuan yang sama.
 *  - search: kembaran POST /api/queue/scan (api/routes/queue.ts), isinya hanya keywords/location/platforms
 *    dan worker memprosesnya untuk `job.user_id` pemilik baris saja.
 *
 * Sengaja tidak masuk daftar: `company_insight` (payload `{all: true}` menilai semua lowongan aktif: biaya LLM
 * global, hanya untuk sistem) dan `extension_apply` (hanya dibuat oleh addApprovedExtensionApplyJob setelah
 * persetujuan dan kanal diperiksa).
 */
export const USER_JOB_PRIORITY = {
  [JOB.apply]: 0,
  [JOB.emailApply]: 0,
  [JOB.search]: 0,
} as const

export type UserJobType = keyof typeof USER_JOB_PRIORITY

/** Prioritas bawaan server untuk job type milik pengguna; undefined bila job type tidak diizinkan. */
function userJobPriority(jobType: unknown): number | undefined {
  if (typeof jobType !== 'string' || !Object.hasOwn(USER_JOB_PRIORITY, jobType)) return undefined
  return USER_JOB_PRIORITY[jobType as UserJobType]
}

/** Job type yang tidak punya handler di worker. */
export class UnsupportedJobTypeError extends Error {}

export class QueueService {
  /**
   * `client` hanya diisi di tes. Tanpa itu, klien Supabase milik server dimuat saat pertama dipakai
   * (bukan saat modul di-import, supaya modul ini bisa di-import tanpa menyalakan server).
   */
  constructor(
    private readonly client?: GuardDb,
    /** Tanpa `client` (produksi) dipakai rateLimitService. Dengan `client` tiruan tanpa limiter, batas platform dilewati. */
    private readonly limiter: PlatformLimiter | null = client ? null : rateLimitService
  ) {}

  private async db(): Promise<GuardDb> {
    return this.client ?? ((await import('../api/index.js')).supabase as unknown as GuardDb)
  }

  /**
   * @returns {Promise<{ id: string }>} id dari baris automation_queue yang dibuat.
   */
  async addScanJob(
    userId: string,
    params: { keywords?: string; location?: string; platforms?: string[] }
  ) {
    const supabase = await this.db()
    const { data, error } = await supabase
      .from('automation_queue')
      .insert({
        user_id: userId,
        job_type: JOB.search,
        payload: params ?? {},
        status: 'pending',
      })
      .select('id')
      .single();

    if (error) throw new Error(`addScanJob failed: ${error.message}`);
    return { id: data.id };
  }

  /**
   * Job apply dari klien (POST /api/queue/apply). Payload klien tidak dipercaya: `approved` dibuang,
   * dan `approval_request_id` hanya diterima bila baris persetujuannya sah (lihat queue-guard.ts).
   * Tanpa persetujuan, job tetap bisa masuk, tetapi hanya mengisi formulir dan tidak pernah mengirim.
   */
  async addApplyJob(userId: string, jobData: any) {
    const supabase = await this.db()
    const payload = await guardQueuePayload(supabase, userId, JOB.apply, jobData)
    const { data, error } = await supabase
      .from('automation_queue')
      .insert({
        user_id: userId,
        job_type: JOB.apply,
        payload,
        status: 'pending',
      })
      .select('id')
      .single();

    if (error) throw new Error(`addApplyJob failed: ${error.message}`);
    return { id: data.id };
  }

  /**
   * Eksklusi mutual sebelum memasukkan persetujuan ke antrean: satu persetujuan tidak boleh diklaim atau aktif
   * di worker (`apply`) dan ekstensi (`extension_apply`) sekaligus.
   */
  private async ensureMutualExclusion(
    supabase: GuardDb,
    userId: string,
    approvalId: string,
    targetChannel: 'worker' | 'extension',
    rowChannel?: string | null
  ): Promise<void> {
    if (rowChannel && rowChannel !== targetChannel) {
      throw new ApprovalChannelConflictError(
        `Approval belongs to channel '${rowChannel}', cannot queue to '${targetChannel}'`
      )
    }
    const [claimRes, activeRes] = await Promise.all([
      supabase.from('approval_submit_claims').select('approval_request_id').eq('approval_request_id', approvalId).limit(1),
      supabase
        .from('automation_queue')
        .select('id, job_type')
        .eq('user_id', userId)
        .in('job_type', [JOB.apply, JOB.extensionApply])
        .in('status', ['pending', 'processing'])
        .eq('payload->>approval_request_id', approvalId)
        .limit(1),
    ])
    if (claimRes.error && claimRes.error.code !== '42P01' && claimRes.error.code !== 'PGRST205') {
      throw new Error(`claim lookup failed: ${claimRes.error.message}`)
    }
    if (Array.isArray(claimRes.data) && claimRes.data.length > 0) {
      throw new ApprovalChannelConflictError('Approval submit claim is already active or consumed')
    }
    if (activeRes.error) {
      throw new Error(`active queue check failed: ${activeRes.error.message}`)
    }
    if (Array.isArray(activeRes.data) && activeRes.data.length > 0) {
      throw new ApprovalChannelConflictError('Approval already has an active queue job')
    }
  }

  /**
   * Batas per jam per pengguna per platform (rateLimitService.checkPlatformLimit) sebelum lamaran yang sudah disetujui
   * masuk antrean. Platform tanpa batas terdaftar, atau platform yang tidak tercatat di persetujuan, tidak dibatasi.
   * Jalur non-apply (search, analisis) tidak lewat sini.
   */
  private async assertPlatformLimit(supabase: GuardDb, userId: string, approvalId: string): Promise<void> {
    if (!this.limiter) return
    const { data } = await supabase
      .from('approval_requests')
      .select('platform')
      .eq('id', approvalId)
      .eq('user_id', userId)
      .maybeSingle()
    const platform = typeof data?.platform === 'string' ? data.platform.trim().toLowerCase() : ''
    if (!platform) return
    const limit = await this.limiter.checkPlatformLimit(platform, userId)
    if (!limit.allowed) throw new PlatformLimitReachedError(platform, limit.resetAt ?? null)
  }

  private async addApprovedChannelJob(
    userId: string,
    approvalId: string,
    jobType: typeof JOB.apply | typeof JOB.extensionApply
  ): Promise<{ id: string }> {
    const supabase = await this.db()
    const row = await requireApprovedRow(supabase, userId, approvalId)
    const targetChannel = jobType === JOB.extensionApply ? 'extension' : 'worker'
    await this.ensureMutualExclusion(supabase, userId, row.id, targetChannel, row.apply_channel ?? null)
    await this.assertPlatformLimit(supabase, userId, row.id)

    const { data, error } = await supabase
      .from('automation_queue')
      .insert({
        user_id: userId,
        job_type: jobType,
        payload: {
          job_id: row.job_id,
          application_id: row.application_id ?? null,
          approval_request_id: row.id,
          approved: true,
        },
        status: 'pending',
      })
      .select('id')
      .single();

    if (error) {
      if (error.code === '23505') {
        throw new ApprovalChannelConflictError('Approval already has an active queue job')
      }
      throw new Error(`${jobType === JOB.extensionApply ? 'addApprovedExtensionApplyJob' : 'addApprovedApplyJob'} failed: ${error.message}`)
    }
    return { id: data.id };
  }

  /**
   * Dipanggil hanya oleh POST /api/approvals/:id/approve (atau rerun) setelah pengguna menyetujui untuk kanal worker (`apply`).
   */
  async addApprovedApplyJob(userId: string, approvalId: string) {
    return this.addApprovedChannelJob(userId, approvalId, JOB.apply);
  }

  /**
   * Dipanggil untuk lowongan kanal ekstensi (`auth_portal` / `external_web`): memasukkan antrean `extension_apply`
   * yang diabaikan worker dan diklaim ekstensi browser.
   */
  async addApprovedExtensionApplyJob(userId: string, approvalId: string) {
    return this.addApprovedChannelJob(userId, approvalId, JOB.extensionApply);
  }

  /**
   * Batas antara klien dan antrean untuk POST /api/automation/queue. Hanya job type di USER_JOB_PRIORITY yang
   * diterima (selain itu InvalidPayloadError, jadi 400), dan `priority` kiriman klien diabaikan: yang dipakai
   * prioritas bawaan server per job type. Payload lalu lewat addGenericJob (guard persetujuan yang sama).
   */
  async addUserJob(userId: string, jobType: unknown, payload: unknown, _clientPriority?: unknown) {
    const priority = userJobPriority(jobType)
    if (priority === undefined) {
      throw new InvalidPayloadError(
        'Jenis pekerjaan tidak diizinkan. Jenis yang boleh dimasukkan ke antrean: ' +
          `${Object.keys(USER_JOB_PRIORITY).join(', ')}.`,
        'job_type_not_allowed'
      )
    }
    return this.addGenericJob(userId, jobType as UserJobType, payload, priority)
  }

  /**
   * Antrean generik, untuk pemanggil internal/sistem (penjadwal, skrip) yang boleh memilih job type dan
   * prioritas. JANGAN dipanggil dengan job_type atau priority yang berasal dari klien: rute HTTP harus lewat
   * addUserJob. Payload tetap lewat guard yang sama, jadi jalur ini tidak bisa dipakai untuk menyelundupkan
   * `approved: true` atau email_apply tanpa persetujuan.
   */
  async addGenericJob(userId: string, jobType: string, payload: unknown, priority = 0) {
    const supabase = await this.db()
    const safe = await guardQueuePayload(supabase, userId, jobType, payload)
    const { data, error } = await supabase
      .from('automation_queue')
      .insert({ user_id: userId, job_type: jobType, payload: safe, priority, status: 'pending' })
      .select()

    if (error) throw new Error(`addGenericJob failed: ${error.message}`);
    return data?.[0]
  }

  /**
   * Worker tidak punya handler `analyze`; analisis kecocokan dijalankan sinkron lewat
   * POST /api/ai/analyze-match. Menolak di sini lebih jujur daripada membuat baris antrean
   * yang pasti gagal.
   */
  async addAnalyzeJob(_userId: string, _jobDescription: string, _userSkills: string[]): Promise<{ id: string }> {
    throw new UnsupportedJobTypeError('analyze jobs are not processed by the worker; use POST /api/ai/analyze-match');
  }

  /**
   * Ringkasan status antrian per job-type worker. `scan` dipertahankan sebagai alias `search`.
   */
  async getQueueStatus(userId: string) {
    const supabase = await this.db()
    const { data, error } = await supabase
      .from('automation_queue')
      .select('job_type, status')
      .eq('user_id', userId);

    if (error) throw new Error(`getQueueStatus failed: ${error.message}`);

    const count = (rows: any[], type: string, status: string) =>
      rows.filter((r) => r.job_type === type && r.status === status).length;

    const group = (type: string) => ({
      waiting: count(data, type, 'pending'),
      active: count(data, type, 'processing'),
      completed: count(data, type, 'completed'),
      failed: count(data, type, 'failed'),
    });

    const search = group(JOB.search);
    return {
      search,
      scan: search,
      apply: group(JOB.apply),
      email_apply: group(JOB.emailApply),
      company_insight: group(JOB.companyInsight),
    };
  }
}

/**
 * Dipanggil bila ada pemanggil lama. Proses pekerjaan queue ditangani oleh
 * Worker TERPISAH (`worker/src/worker.ts`) via claim_automation_jobs, jadi
 * tidak perlu in-process worker di sini.
 */
export function initializeWorkers(): void {
  console.log('[queue.service] Workers dijalankan oleh proses Worker eksternal (DB-as-queue).');
}

export const queueService = new QueueService();
