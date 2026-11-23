import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

// approval.ts mengimpor klien Supabase dari ../index.js (menyalakan server), jadi isinya dibaca sebagai teks.
const src = readFileSync(new URL('../api/routes/approval.ts', import.meta.url), 'utf8')

test('permintaan persetujuan berlaku 24 jam sejak dibuat', () => {
  assert.match(src, /export const APPROVAL_TTL_MS = 24 \* 60 \* 60 \* 1000/)
  assert.match(src, /expiresAt = new Date\(Date\.now\(\) \+ APPROVAL_TTL_MS\)/)
  assert.doesNotMatch(src, /Date\.now\(\) \+ 60 \* 60 \* 1000\)/, 'masa berlaku 1 jam lama tidak boleh tersisa')
})
