/**
 * Mutex per kunci di dalam satu proses Node. Pemanggil dengan kunci yang sama dijalankan satu per satu menurut
 * urutan datang; kunci berbeda tidak saling menunggu.
 *
 * Hanya berlaku dalam SATU proses. Dua proses (PM2 mode cluster, dua replika) tidak saling melihat kunci ini.
 */
export class KeyedMutex {
  private readonly tails = new Map<string, Promise<void>>()

  /** Jumlah kunci yang sedang dipegang atau ditunggu; kembali ke 0 bila semua pemanggil selesai. */
  get size(): number {
    return this.tails.size
  }

  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve()
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    // `gate` hanya pernah di-resolve, tidak pernah ditolak, jadi rantai ini tidak putus walau `fn` melempar.
    const tail = prev.then(() => gate)
    this.tails.set(key, tail)
    await prev
    try {
      return await fn()
    } finally {
      release()
      if (this.tails.get(key) === tail) this.tails.delete(key)
    }
  }
}

/** Pengganti yang tidak menserialkan apa pun; hanya untuk tes yang memperagakan balapan tanpa kunci. */
export const NO_LOCK = { run: <T>(_key: string, fn: () => Promise<T>) => fn() } as const

/** Bentuk minimal yang dipakai penjaga: KeyedMutex asli atau NO_LOCK. */
export type KeyedLock = Pick<KeyedMutex, 'run'>
