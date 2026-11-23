import type { FastifyRequest } from 'fastify'

/**
 * Pekerjaan sampingan (notifikasi) yang harus jalan SESUDAH balasan HTTP terkirim.
 *
 * Pengiriman WhatsApp, email, dan Telegram memanggil layanan luar. Menunggunya sebelum membalas membuat laporan
 * ekstensi atau tombol "tandai terkirim" ikut lambat, dan pengguna bisa menekan ulang sesudah aksi yang sebenarnya
 * sudah tercatat. Rute mendaftarkan tugas lewat `afterReplyFor(request)` dan menjalankannya di hook `onResponse`.
 * Galat tugas ditelan: notifikasi hanya pelengkap.
 */

export type AfterReplyTask = () => Promise<unknown>
export type AfterReply = (task: AfterReplyTask) => void

const KEY = '__applifyAfterReplyTasks'

export function afterReplyFor(request: FastifyRequest): AfterReply {
  return (task) => {
    const holder = request as unknown as Record<string, AfterReplyTask[] | undefined>
    ;(holder[KEY] ??= []).push(task)
  }
}

/** Hook `onResponse` rute: jalankan semua tugas yang didaftarkan, satu per satu, tanpa pernah melempar. */
export async function runAfterReplyTasks(request: FastifyRequest): Promise<void> {
  const holder = request as unknown as Record<string, AfterReplyTask[] | undefined>
  const tasks = holder[KEY]
  if (!tasks || tasks.length === 0) return
  holder[KEY] = []
  for (const task of tasks) {
    try {
      await task()
    } catch {
      // Best effort: aksi utamanya sudah selesai dan tercatat.
    }
  }
}

/** Cadangan untuk pemanggil tanpa konteks permintaan: jalankan terlepas dari alur pemanggil, galat ditelan. */
export const runDetached: AfterReply = (task) => {
  setImmediate(() => {
    Promise.resolve()
      .then(task)
      .catch(() => undefined)
  })
}
