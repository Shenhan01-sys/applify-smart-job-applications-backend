import type { FastifyCorsOptions } from '@fastify/cors'
import { isOriginAllowed } from './deploy-config.js'
import { isExtensionOriginAllowed } from './extension-token.js'

/**
 * Opsi CORS satu-satunya untuk seluruh API (didaftarkan di `api/index.ts`, juga dipakai tes).
 *
 *   - Origin web: daftar `FRONTEND_URL`.
 *   - Origin ekstensi (`chrome-extension://<id>`): aturan `EXTENSION_ORIGINS` (`isExtensionOriginAllowed`). Berlaku untuk
 *     SEMUA rute di bawah `/api/extension/*`, termasuk berkas dan jawaban, karena CORS didaftarkan di akar aplikasi.
 *   - `Content-Disposition` dan `Retry-After` bukan header respons yang boleh dibaca lintas origin secara bawaan.
 *     Ekstensi memakai `Content-Disposition` untuk nama berkas unduhan dan `Retry-After` untuk batas laju.
 */
export function buildCorsOptions(allowedOrigins: string[], env: Record<string, string | undefined> = process.env): FastifyCorsOptions {
  return {
    origin: (origin, cb) => {
      cb(null, isOriginAllowed(origin, allowedOrigins) || isExtensionOriginAllowed(origin, env))
    },
    credentials: true,
    exposedHeaders: ['Content-Disposition', 'Retry-After'],
  }
}
