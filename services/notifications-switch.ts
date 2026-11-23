/**
 * Sakelar dan batas waktu untuk semua pengiriman notifikasi keluar (Kapso WhatsApp, Resend email, Telegram).
 *
 * Aturan:
 *   - Pengiriman ke pengguna (WhatsApp, email, OTP) HANYA berjalan bila `NOTIFICATIONS_ENABLED` persis bernilai
 *     `true`. Bawaannya mati: nilai kosong, `1`, `TRUE`, atau `yes` tidak mengaktifkan.
 *   - Saat `NODE_ENV=test`, atau saat berkas dijalankan oleh `node --test` memakai `process.env` sungguhan, tidak ada
 *     pengiriman sama sekali, apa pun isi `.env`. Uji yang menyuntikkan `env` sendiri tidak terkena aturan kedua.
 *   - Setiap `fetch` keluar memakai `AbortSignal.timeout(NOTIFY_FETCH_TIMEOUT_MS)` supaya penyedia yang macet tidak
 *     menahan permintaan pengguna.
 */

export const NOTIFY_FETCH_TIMEOUT_MS = 5000

type Env = Record<string, string | undefined>

/** True saat proses berjalan sebagai uji, sehingga tidak boleh mengirim apa pun ke jaringan. */
export function isTestRuntime(env: Env = process.env): boolean {
  if ((env.NODE_ENV ?? '').trim().toLowerCase() === 'test') return true
  return env === process.env && Boolean(process.env.NODE_TEST_CONTEXT)
}

/** True hanya bila `NOTIFICATIONS_ENABLED=true` dan proses bukan uji. */
export function notificationsEnabled(env: Env = process.env): boolean {
  if (isTestRuntime(env)) return false
  return (env.NOTIFICATIONS_ENABLED ?? '').trim() === 'true'
}

export function notifyTimeoutSignal(): AbortSignal {
  return AbortSignal.timeout(NOTIFY_FETCH_TIMEOUT_MS)
}

/** Kode galat generik untuk galat jaringan; isi galat penyedia tidak pernah diteruskan ke klien. */
export function networkErrorCode(provider: string, err: unknown): string {
  const name = (err as { name?: string } | null | undefined)?.name
  return name === 'TimeoutError' || name === 'AbortError' ? `${provider}_timeout` : `${provider}_network_error`
}
