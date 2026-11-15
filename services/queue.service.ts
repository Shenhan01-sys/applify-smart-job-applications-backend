import { supabase } from '../api/index.js'

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
  emailApply: 'email_apply',
  companyInsight: 'company_insight',
} as const;

/** Job type yang tidak punya handler di worker. */
export class UnsupportedJobTypeError extends Error {}

export class QueueService {
  /**
   * @returns {Promise<{ id: string }>} id dari baris automation_queue yang dibuat.
   */
  async addScanJob(
    userId: string,
    params: { keywords?: string; location?: string; platforms?: string[] }
  ) {
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

  async addApplyJob(userId: string, jobData: any) {
    const { data, error } = await supabase
      .from('automation_queue')
      .insert({
        user_id: userId,
        job_type: JOB.apply,
        payload: jobData ?? {},
        status: 'pending',
      })
      .select('id')
      .single();

    if (error) throw new Error(`addApplyJob failed: ${error.message}`);
    return { id: data.id };
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
