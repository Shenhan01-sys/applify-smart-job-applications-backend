/**
 * Penjaga anti-replay sekali pakai lintas-instans (BS-08.2 tiket OAuth & BS-05.2 webhook Kapso).
 *
 * Prioritas:
 *   1. Coba INSERT atomik ke `public.security_replay_tokens (scope, token_id, expires_at)`.
 *      - Bila sukses -> token sah & baru pertama kali dipakai (`consumed: true, duplicate: false`).
 *      - Bila melanggar kunci unik (`23505`) -> token sudah pernah dipakai (`consumed: false, duplicate: true`).
 *   2. Bila tabel belum dibuat di Supabase (`42P01`, `PGRST205`, `does not exist`, `schema cache`) atau
 *      `db` tidak memiliki tabel ini di tes tiruan -> jatuh ke `fallbackMap` in-memory berbatas ukuran
 *      agar layanan tetap jalan sebelum migrasi `DRAFT_2026-11-26_security_replay_tokens.sql` diterapkan.
 */

export type ReplayScope = 'oauth_start_ticket' | 'kapso_webhook'

export interface ReplayStoreDb {
  from(table: string): any
}

export interface ConsumeReplayResult {
  consumed: boolean
  duplicate: boolean
  store: 'db' | 'memory'
}

const MAX_MEMORY_ENTRIES = 5_000
const MISSING_TABLE_RE = /does not exist|schema cache|42P01|PGRST205|relation/i

function isMissingTableError(err: any): boolean {
  if (!err) return false
  const code = String(err.code ?? '')
  if (code === '42P01' || code === 'PGRST205') return true
  return MISSING_TABLE_RE.test(String(err.message ?? ''))
}

function isUniqueViolation(err: any): boolean {
  if (!err) return false
  const code = String(err.code ?? '')
  if (code === '23505') return true
  return /duplicate key|unique constraint/i.test(String(err.message ?? ''))
}

function consumeInMemory(map: Map<string, number>, key: string, expiresAtMs: number, nowMs: number): ConsumeReplayResult {
  for (const [k, exp] of map) {
    if (exp <= nowMs) map.delete(k)
  }
  if (map.has(key)) {
    return { consumed: false, duplicate: true, store: 'memory' }
  }
  if (map.size >= MAX_MEMORY_ENTRIES) {
    const oldest = map.keys().next().value
    if (oldest !== undefined) map.delete(oldest)
  }
  map.set(key, expiresAtMs)
  return { consumed: true, duplicate: false, store: 'memory' }
}

export async function consumeReplayToken(
  db: ReplayStoreDb | null | undefined,
  params: {
    scope: ReplayScope
    tokenId: string
    expiresAtMs: number
    nowMs?: number
    fallbackMap: Map<string, number>
  }
): Promise<ConsumeReplayResult> {
  const nowMs = params.nowMs ?? Date.now()
  const tokenId = String(params.tokenId ?? '').trim().slice(0, 256)
  if (!tokenId) return { consumed: false, duplicate: true, store: 'memory' }
  const memKey = `${params.scope}:${tokenId}`

  // Cek cepat di memori proses sendiri lebih dulu (hindari round-trip ganda untuk replay beruntun).
  const existingExp = params.fallbackMap.get(memKey)
  if (existingExp !== undefined && existingExp > nowMs) {
    return { consumed: false, duplicate: true, store: 'memory' }
  }

  if (db) {
    try {
      const table = db.from('security_replay_tokens')
      if (table && typeof table.insert === 'function') {
        const res = await table.insert({
          scope: params.scope,
          token_id: tokenId,
          expires_at: new Date(params.expiresAtMs).toISOString(),
        })
        const err = res?.error ?? null
        if (!err) {
          consumeInMemory(params.fallbackMap, memKey, params.expiresAtMs, nowMs)
          return { consumed: true, duplicate: false, store: 'db' }
        }
        if (isUniqueViolation(err)) {
          consumeInMemory(params.fallbackMap, memKey, params.expiresAtMs, nowMs)
          return { consumed: false, duplicate: true, store: 'db' }
        }
        if (!isMissingTableError(err)) {
          // Galat DB lain (mis. jaringan sesaat): tetap lindungi di memori agar proses tidak gagal terbuka.
          return consumeInMemory(params.fallbackMap, memKey, params.expiresAtMs, nowMs)
        }
      }
    } catch {
      // Tabel belum ada atau DB tiruan tanpa tabel ini -> fallback memori aman.
    }
  }

  return consumeInMemory(params.fallbackMap, memKey, params.expiresAtMs, nowMs)
}
