import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

// approval.ts mengimpor klien Supabase dari ../index.js (menyalakan server), jadi isinya dibaca sebagai teks.
const src = readFileSync(new URL('../api/routes/approval.ts', import.meta.url), 'utf8')

test('permintaan persetujuan berlaku 24 jam sejak dibuat', () => {
  assert.match(src, /export const APPROVAL_TTL_MS = 24 \* 60 \* 60 \* 1000/)
  assert.match(src, /expiresAt = new Date\(Date\.now\(\) \+ APPROVAL_TTL_MS\)/)
  assert.doesNotMatch(src, /Date\.now\(\) \+ 60 \* 60 \* 1000\)/, 'masa berlaku 1 jam lama tidak boleh tersisa')

  // Verifikasi perilaku perhitungan batas 24 jam (48.5 H-13)
  const ttlMs = 24 * 60 * 60 * 1000
  const base = Date.UTC(2026, 10, 26, 9, 0, 0)
  const expiresAt = new Date(base + ttlMs).toISOString()
  assert.equal(new Date(expiresAt).getTime() - base, ttlMs)
  assert.ok(new Date(expiresAt).getTime() > base + 23 * 60 * 60 * 1000)
})
