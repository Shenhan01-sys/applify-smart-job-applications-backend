import type { FastifyInstance } from 'fastify'

/**
 * Fastify menolak POST/PUT ber-`Content-Type: application/json` tanpa isi dengan 400 FST_ERR_CTP_EMPTY_JSON_BODY.
 * Beberapa tombol frontend (Hubungkan Gmail, Putuskan semua perangkat, tes WhatsApp) sempat mengirim permintaan
 * seperti itu, sehingga gagal di production (24 Nov 2026). Kait ini membuang header Content-Type bila badan
 * jelas kosong (Content-Length 0), jadi rute menerima badan `undefined` seperti permintaan tanpa isi biasa.
 * Pengurai JSON bawaan (dengan perlindungan __proto__) tetap dipakai untuk semua badan yang berisi.
 */
export function isEmptyJsonRequest(headers: Record<string, string | string[] | undefined>): boolean {
  const type = String(headers['content-type'] ?? '').toLowerCase()
  return type.startsWith('application/json') && headers['content-length'] === '0'
}

export function installEmptyJsonBodyGuard(app: FastifyInstance): void {
  app.addHook('onRequest', async (request) => {
    if (isEmptyJsonRequest(request.headers)) delete request.headers['content-type']
  })
}
