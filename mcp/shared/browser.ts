/**
 * Opsi peluncuran Chromium untuk Playwright.
 *
 * Playwright tidak membaca env PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH sendiri. Di image Docker (Alpine) browser
 * bawaan Playwright tidak bisa jalan karena musl, jadi Chromium sistem dipakai lewat executablePath.
 * Tanpa env itu (mesin lokal yang sudah menjalankan `npx playwright install`) opsi ini kosong dan
 * Playwright memakai browser unduhannya sendiri.
 */
export function chromiumExecutablePath(env: Record<string, string | undefined> = process.env): string | undefined {
  const p = (env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ?? '').trim()
  return p || undefined
}

export function chromiumLaunchOptions<T extends Record<string, unknown>>(
  base: T,
  env: Record<string, string | undefined> = process.env,
): T & { executablePath?: string } {
  const executablePath = chromiumExecutablePath(env)
  return executablePath ? { ...base, executablePath } : { ...base }
}
