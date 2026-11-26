/**
 * Penutupan server yang rapi (audit 48.3 BS-08).
 *
 * Tanpa penangan SIGTERM/SIGINT, Node langsung berhenti saat redeploy (Railway), `pm2 reload`, atau `docker stop`,
 * dan permintaan yang sedang jalan terputus. Rantai AI bisa memakan puluhan detik (surat, CV, penilaian), jadi
 * pengguna menerima galat jaringan padahal model sudah dipanggil dan jatah laju sudah tercatat.
 *
 * Alur: sinyal pertama menutup port (app.close() menunggu permintaan yang sedang jalan dan menutup koneksi
 * keep-alive yang menganggur), lalu proses keluar dengan kode 0. Bila penutupan melewati `timeoutMs`, proses
 * dipaksa keluar dengan kode 1. Sinyal berikutnya selama penutupan diabaikan.
 *
 * Batas waktu harus lebih kecil daripada `kill_timeout` PM2 (ecosystem.config.cjs) dan jeda henti penampung
 * (Railway), kalau tidak proses dimatikan paksa lebih dulu.
 */

export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 25_000

export interface ShutdownApp {
  close(): Promise<unknown>
  log: { info(message: string): void; error(message: string): void }
}

export interface ShutdownProcess {
  on(signal: NodeJS.Signals, handler: () => void): unknown
  exit(code: number): unknown
}

export interface GracefulShutdownOptions {
  signals?: NodeJS.Signals[]
  timeoutMs?: number
  proc?: ShutdownProcess
  /** Hanya tes yang mengganti ini. Pewaktu harus unref supaya tidak menahan proses. */
  setTimer?: (fn: () => void, ms: number) => { unref?: () => unknown }
}

/** Batas waktu dari lingkungan (`SHUTDOWN_TIMEOUT_MS`, 1000..120000 ms); nilai tidak sah memakai bawaan. */
export function shutdownTimeoutFromEnv(env: Record<string, string | undefined> = process.env): number {
  const n = Number(env.SHUTDOWN_TIMEOUT_MS)
  return Number.isInteger(n) && n >= 1000 && n <= 120_000 ? n : DEFAULT_SHUTDOWN_TIMEOUT_MS
}

/**
 * Pasang penangan sinyal. Mengembalikan fungsi penutupan yang sama dengan yang dipanggil sinyal (dipakai tes);
 * pemanggilan kedua mengembalikan janji yang sama.
 */
export function installGracefulShutdown(app: ShutdownApp, opts: GracefulShutdownOptions = {}): (signal: string) => Promise<void> {
  const proc = opts.proc ?? (process as unknown as ShutdownProcess)
  const timeoutMs = opts.timeoutMs ?? shutdownTimeoutFromEnv()
  const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
  let running: Promise<void> | null = null

  const shutdown = (signal: string): Promise<void> => {
    if (running) return running
    app.log.info(`[shutdown] ${signal} diterima, menutup server (maks ${timeoutMs} ms)`)
    const timer = setTimer(() => {
      app.log.error(`[shutdown] penutupan melewati ${timeoutMs} ms, proses dipaksa keluar`)
      proc.exit(1)
    }, timeoutMs)
    timer.unref?.()
    running = app
      .close()
      .then(() => {
        app.log.info('[shutdown] server tertutup')
        proc.exit(0)
      })
      .catch((err: unknown) => {
        app.log.error(`[shutdown] gagal menutup server: ${err instanceof Error ? err.message : String(err)}`)
        proc.exit(1)
      })
    return running
  }

  for (const signal of opts.signals ?? ['SIGTERM', 'SIGINT']) {
    proc.on(signal, () => {
      void shutdown(signal)
    })
  }
  return shutdown
}

/**
 * Penjaga error proses tak tertangani untuk backend (audit 48.5 H-08).
 * Mencatat pesan ringkas (maks 400 karakter, tanpa objek error mentah) agar mudah dicari di log Railway,
 * lalu keluar dengan kode 1 supaya orchestrator me-restart proses secara bersih.
 */
export function installProcessGuards(
  log: { error(message: string): void },
  proc: { on(event: string, listener: (err: unknown) => void): unknown; exit(code: number): unknown } = process as any
): void {
  const formatReason = (reason: unknown): string => {
    if (reason instanceof Error) return `${reason.name}: ${reason.message}`.slice(0, 400)
    try {
      return String(reason).slice(0, 400)
    } catch {
      return 'unknown_fatal_error'
    }
  }
  let exiting = false
  const handle = (source: string) => (err: unknown) => {
    log.error(`[backend] FATAL ${source}: ${formatReason(err)}`)
    if (!exiting) {
      exiting = true
      proc.exit(1)
    }
  }
  proc.on('unhandledRejection', handle('unhandledRejection'))
  proc.on('uncaughtException', handle('uncaughtException'))
}
