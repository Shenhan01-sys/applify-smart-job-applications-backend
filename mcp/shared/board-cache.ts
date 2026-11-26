/**
 * Cache in-memory ringan ber-TTL singkat untuk payload papan ATS publik (Greenhouse, Lever, Ashby, Workable)
 * agar pencarian serentak dengan kata kunci berbeda tidak mengunduh ulang 1–1,5 MB JSON setiap kali (47.3 P2-07).
 * Berbatas jumlah entri agar memori proses tetap aman.
 */
export const ATS_BOARD_CACHE_TTL_MS = 5 * 60 * 1000
export const ATS_BOARD_CACHE_MAX_ENTRIES = 100

interface CacheEntry<T> {
  value: T
  expiresAt: number
}

const store = new Map<string, CacheEntry<unknown>>()

export async function getOrFetchBoardPayload<T>(
  key: string,
  fetcher: () => Promise<T>,
  opts: { ttlMs?: number; nowMs?: number } = {}
): Promise<T> {
  const ttlMs = opts.ttlMs ?? ATS_BOARD_CACHE_TTL_MS
  const now = opts.nowMs ?? Date.now()
  if (ttlMs > 0) {
    const hit = store.get(key)
    if (hit && hit.expiresAt > now) {
      return hit.value as T
    }
    if (hit) store.delete(key)
  }
  const value = await fetcher()
  if (ttlMs > 0) {
    if (store.size >= ATS_BOARD_CACHE_MAX_ENTRIES) {
      const oldest = store.keys().next().value
      if (oldest !== undefined) store.delete(oldest)
    }
    store.set(key, { value, expiresAt: now + ttlMs })
  }
  return value
}

export function clearBoardCache(): void {
  store.clear()
}
