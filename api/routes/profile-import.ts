import { FastifyInstance, FastifyPluginOptions } from 'fastify'
import { AiAccessError, aiGuardService, type AiGuardService } from '../../services/ai-guard.service.js'
import { LinkedInImportError, PDF_MAX_BYTES, assertPdfUpload } from '../../services/linkedin-pdf.js'
import { linkedInImportService, type LinkedInImportService } from '../../services/linkedin-import.service.js'

export interface ProfileImportRoutesOptions extends FastifyPluginOptions {
  /** Hanya tes yang mengisi ini (penjaga dengan database tiruan). */
  guard?: Pick<AiGuardService, 'checkImportRate'>
  /** Hanya tes yang mengisi ini (pengimpor dengan model tiruan). */
  importer?: Pick<LinkedInImportService, 'importFromPdf'>
}

/** Fastify menolak badan lebih besar dari ini sebelum sampai ke kode; lebihnya sedikit ditolak assertPdfUpload. */
const BODY_LIMIT = PDF_MAX_BYTES + 1

/**
 * Impor profil dari PDF LinkedIn. Rute ini hanya MEMBACA: mengembalikan pratinjau, tidak menulis ke tabel profil.
 * Penulisan dilakukan frontend sesudah pengguna menyetujui pratinjau.
 *
 *   POST /api/profile/import/linkedin-pdf
 *     Authorization: Bearer <JWT Supabase>   (dipasang oleh authMiddleware di api/index.ts)
 *     Content-Type: application/pdf          (isi PDF mentah di badan permintaan, maksimal 5 MB, bukan multipart)
 *   200 { success: true, preview: ImportPreview }
 *   400 not_pdf | empty_file   413 file_too_large   415 not_pdf   422 pdf_unreadable | pdf_too_long | pdf_no_text | nothing_found
 *   429 rate_limited (+ Retry-After)   503 rate_limit_check_failed
 *
 * Batas laju sendiri (action 'profile_import'), tanpa pemeriksaan atau pemakaian kuota draf AI. PDF diproses di
 * memori dan tidak disimpan. Satu-satunya tulisan ke database adalah baris application_logs untuk batas laju.
 */
export async function profileImportRoutes(app: FastifyInstance, opts: ProfileImportRoutesOptions) {
  const guard = opts.guard ?? aiGuardService
  const importer = opts.importer ?? linkedInImportService

  // PDF mentah sebagai badan permintaan: tidak butuh plugin multipart. Hanya berlaku di plugin ini.
  app.addContentTypeParser(['application/pdf', 'application/octet-stream'], { parseAs: 'buffer', bodyLimit: BODY_LIMIT }, (_req, body, done) => done(null, body))

  // Tolak permintaan tanpa token SEBELUM badan sebesar 5 MB dibaca. Token diverifikasi penuh oleh authMiddleware.
  app.addHook('onRequest', async (request, reply) => {
    if (!request.headers.authorization?.startsWith('Bearer ')) {
      return reply.status(401).send({ success: false, error: 'Unauthorized' })
    }
    return undefined
  })

  app.setErrorHandler((error: any, request, reply) => {
    if (error?.code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
      return reply.status(413).send({ success: false, code: 'file_too_large', error: 'Ukuran PDF terlalu besar, maksimal 5 MB.' })
    }
    if (error?.code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE') {
      return reply.status(415).send({ success: false, code: 'not_pdf', error: 'Kirim berkas sebagai PDF (Content-Type: application/pdf).' })
    }
    const status = typeof error?.statusCode === 'number' && error.statusCode >= 400 && error.statusCode < 500 ? error.statusCode : 500
    if (status >= 500) request.log.error({ code: error?.code, name: error?.name }, '[profile-import] galat tak terduga')
    return reply.status(status).send({ success: false, error: status >= 500 ? 'Impor PDF gagal. Coba lagi nanti.' : String(error?.message ?? 'Permintaan tidak valid.') })
  })

  app.post('/import/linkedin-pdf', { bodyLimit: BODY_LIMIT }, async (request, reply) => {
    const userId = (request as any).user?.id
    if (!userId) return reply.status(401).send({ success: false, error: 'Unauthorized' })

    try {
      // Periksa berkas lebih dulu (murah): berkas yang bukan PDF tidak menghabiskan jatah batas laju.
      const pdf = assertPdfUpload(request.body)
      await guard.checkImportRate(userId, request.routeOptions?.url ?? request.url)
      const preview = await importer.importFromPdf(pdf, { userId })
      return { success: true, preview }
    } catch (error: any) {
      if (error instanceof LinkedInImportError) {
        return reply.status(error.statusCode).send({ success: false, code: error.code, error: error.message })
      }
      if (error instanceof AiAccessError) {
        if (error.extra.retryAfterSec) reply.header('Retry-After', String(error.extra.retryAfterSec))
        return reply.status(error.statusCode).send({
          success: false,
          error: error.message,
          code: error.code,
          ...(error.extra.retryAfterSec ? { retryAfterSec: error.extra.retryAfterSec } : {}),
        })
      }
      request.log.error({ code: error?.code, name: error?.name }, '[profile-import] impor gagal')
      return reply.status(500).send({ success: false, error: 'Impor PDF gagal. Coba lagi nanti.' })
    }
  })
}
