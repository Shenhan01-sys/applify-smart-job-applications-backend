import net from 'node:net'

/**
 * Menutup jaringan keluar di proses uji ini pada tingkat soket: tiap sambungan TCP ke selain loopback gagal.
 * Ini menangkap fetch, axios, supabase-js, dan pustaka lain sekaligus (axios tidak memakai fetch, jadi
 * penjaga di globalThis.fetch saja tidak cukup; ditemukan di uji pertama: AI pipeline memanggil openrouter.ai lewat axios).
 * Lapisan kedua, di luar proses, adalah `sandbox-exec` di `npm run verify`.
 */
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '::ffff:127.0.0.1', '[::1]'])

const original = net.Socket.prototype.connect
;(net.Socket.prototype as any).connect = function patched(this: net.Socket, ...args: any[]) {
  const first = args[0]
  let host: string | undefined
  let isPath = false
  if (typeof first === 'object' && first !== null) {
    if ('path' in first && first.path) isPath = true
    else host = first.host ?? 'localhost'
  } else if (typeof first === 'string') {
    isPath = true // connect(path)
  } else if (typeof first === 'number') {
    host = typeof args[1] === 'string' ? args[1] : 'localhost'
  }
  if (!isPath && host !== undefined && !LOOPBACK.has(host)) {
    const err: NodeJS.ErrnoException = new Error(`offline guard: outbound connection to ${host} blocked in integration tests`)
    err.code = 'ECONNREFUSED'
    // Selesai secara asinkron, seperti kegagalan sambungan sungguhan, supaya penanganan galat pustaka berjalan normal.
    process.nextTick(() => this.destroy(err))
    return this
  }
  return original.apply(this, args as any)
}
