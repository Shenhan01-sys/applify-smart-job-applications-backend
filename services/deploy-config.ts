/**
 * Pembacaan konfigurasi deploy yang murni (tanpa efek samping), supaya bisa diuji tanpa menjalankan server.
 * Dipakai oleh api/index.ts untuk CORS dan untuk peringatan konfigurasi saat start (Railway, EC2, lokal).
 */

type Env = Record<string, string | undefined>

export const DEFAULT_FRONTEND_ORIGIN = 'http://localhost:3000'

/** Buang spasi dan garis miring di ujung. Header Origin dari peramban tidak pernah berakhir dengan "/". */
export function normalizeOrigin(origin: string): string {
  return origin.trim().replace(/\/+$/, '')
}

/**
 * Daftar origin yang diizinkan CORS dari env FRONTEND_URL, dipisah koma.
 * Entri kosong dibuang. Bila hasilnya kosong, dipakai bawaan lokal.
 */
export function parseAllowedOrigins(raw: string | undefined): string[] {
  const list = (raw ?? '')
    .split(',')
    .map(normalizeOrigin)
    .filter(Boolean)
  return list.length > 0 ? list : [DEFAULT_FRONTEND_ORIGIN]
}

/** Permintaan tanpa header Origin (curl, server ke server) lolos. Selain itu harus ada di daftar. */
export function isOriginAllowed(origin: string | undefined, allowed: string[]): boolean {
  if (!origin) return true
  return allowed.includes(normalizeOrigin(origin))
}

/** Origin pertama dari FRONTEND_URL: tujuan redirect setelah Gmail OAuth. */
export function primaryFrontendUrl(raw: string | undefined, fallback: string): string {
  const first = (raw ?? '').split(',').map(normalizeOrigin).find(Boolean)
  return first || fallback
}

function isLocalOrigin(origin: string): boolean {
  try {
    const host = new URL(origin).hostname
    return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host.endsWith('.localhost')
  } catch {
    return false
  }
}

/**
 * Apakah dokumentasi Swagger `/docs` boleh dipublikasikan? (BS-08)
 * Di produksi (`NODE_ENV=production`), `/docs` mati secara bawaan kecuali `ENABLE_API_DOCS=true`.
 * Di pengembangan/uji, `/docs` aktif kecuali `ENABLE_API_DOCS=false`.
 */
export function shouldEnableApiDocs(env: Env = process.env): boolean {
  const flag = (env.ENABLE_API_DOCS ?? '').trim().toLowerCase()
  if (flag === 'true') return true
  if (flag === 'false') return false
  return (env.NODE_ENV ?? '').trim().toLowerCase() !== 'production'
}

/**
 * Peringatan konfigurasi untuk produksi. Setiap butir menyebut NAMA variabel, tidak pernah nilainya.
 * Di luar NODE_ENV=production daftar ini kosong, karena bawaan lokal memang dipakai di sana.
 */
export function deployConfigWarnings(env: Env = process.env): string[] {
  if (env.NODE_ENV !== 'production') return []
  const warnings: string[] = []

  const frontendRaw = (env.FRONTEND_URL ?? '').trim()
  if (!frontendRaw) {
    warnings.push('FRONTEND_URL belum diisi. CORS hanya menerima http://localhost:3000, jadi frontend produksi akan ditolak.')
  } else if (parseAllowedOrigins(frontendRaw).every(isLocalOrigin)) {
    warnings.push('FRONTEND_URL hanya berisi alamat lokal. CORS akan menolak frontend produksi.')
  }

  if ((env.GOOGLE_CLIENT_ID ?? '').trim()) {
    if (!(env.GOOGLE_CLIENT_SECRET ?? '').trim()) {
      warnings.push('GOOGLE_CLIENT_ID terisi tetapi GOOGLE_CLIENT_SECRET kosong. Gmail OAuth gagal saat menukar kode.')
    }
    if (!(env.GOOGLE_REDIRECT_URI ?? '').trim()) {
      warnings.push(
        'GOOGLE_REDIRECT_URI belum diisi. Bawaannya http://localhost:4000/api/oauth/google/callback, sehingga Gmail OAuth diarahkan ke localhost.',
      )
    }
    if (!(env.OAUTH_TOKEN_ENCRYPTION_KEY ?? '').trim() && !(env.SESSION_ENCRYPTION_KEY ?? '').trim()) {
      warnings.push('OAUTH_TOKEN_ENCRYPTION_KEY atau SESSION_ENCRYPTION_KEY wajib diisi agar token Gmail bisa disimpan.')
    }
  }

  return warnings
}
