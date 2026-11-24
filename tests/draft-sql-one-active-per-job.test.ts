import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// Uji E2E 24 November 2026: lamaran kembar untuk satu lowongan dan judul kartu "Lowongan" tanpa isi. Perbaikannya ada di
// Edge Function dan frontend (repo lain); dua berkas DRAFT di migrations/ adalah usulan untuk pemilik dan TIDAK dijalankan
// otomatis. Tes ini menjaga dua hal: draf tidak mengubah data bila dijalankan apa adanya, dan aturannya sama dengan kode
// (aktif = status selain 'closed').
const read = (name: string) => readFileSync(new URL(`../migrations/${name}`, import.meta.url), 'utf8')
const ACTIVE = 'DRAFT_2026-11-24_ai_applications_one_active_per_job.sql'
const POLICY = 'DRAFT_2026-11-24_jobs_read_own_applied.sql'

/** Teks SQL tanpa baris komentar `--`: yang tersisa adalah yang benar-benar dijalankan. */
const executable = (sql: string) => sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n')

test('kedua berkas ditandai belum dijalankan dan tidak punya perintah yang menghapus atau mengubah data', () => {
  for (const name of [ACTIVE, POLICY]) {
    const sql = read(name)
    assert.match(sql.split('\n')[0], /BELUM DIJALANKAN KE PRODUCTION/, `${name}: judul draf`)
    const run = executable(sql)
    assert.doesNotMatch(run, /\b(delete\s+from|truncate|drop\s+table|drop\s+column|alter\s+table)\b/i, `${name}: tanpa perintah merusak`)
    assert.doesNotMatch(run, /\bupdate\s+public\./i, `${name}: UPDATE data hanya sebagai komentar yang ditinjau pemilik`)
    assert.doesNotMatch(run, /\binsert\s+into\b/i, name)
  }
})

test('indeks unik parsial: satu baris aktif per (user_id, job_id); aktif = status selain closed, sama dengan Edge Function', () => {
  const sql = read(ACTIVE)
  const run = executable(sql)
  assert.match(run, /create unique index if not exists ai_applications_one_active_per_job\s+on public\.ai_applications \(user_id, job_id\)\s+where status <> 'closed';/)
  // Edge Function dan frontend memakai definisi yang sama (CLOSED_STATUS = "closed")
  const fnRule = readFileSync(new URL('../../applify-smart-job-applications/supabase/functions/_shared/active-application.ts', import.meta.url), 'utf8').toString()
  assert.match(fnRule, /export const CLOSED_STATUS = "closed"/)
})

test('indeks unik: langkah baca pasangan kembar ada sebelum indeks, dan langkah tutup kembaran tidak menyentuh baris ber-submitted_at', () => {
  const sql = read(ACTIVE)
  const step1 = sql.indexOf('-- Langkah 1 (')
  const step2 = sql.indexOf('-- Langkah 2 (')
  const step3 = sql.indexOf('create unique index')
  assert.ok(step1 > 0 && step1 < step2 && step2 < step3, 'urutan: baca, ubah (komentar), indeks')
  // langkah 1 hanya SELECT
  const select = executable(sql).slice(0, executable(sql).indexOf('create unique index'))
  assert.match(select, /having count\(\*\) > 1/)
  // langkah 2 (komentar) menutup, tidak menghapus, dan menyisakan baris yang sudah punya submitted_at untuk keputusan manual
  assert.match(sql, /--\s+set status = 'closed'/)
  assert.match(sql, /r\.rn > 1 and r\.submitted_at is null/)
  assert.match(sql, /Rollback:/)
})

test("kebijakan jobs: hanya SELECT, hanya lowongan yang dilamar pengguna sendiri, menambah akses tanpa menggeser kebijakan 'active'", () => {
  const sql = read(POLICY)
  const run = executable(sql)
  assert.match(run, /create policy "Users can read jobs they applied to"\s+on public\.jobs\s+for select\s+to authenticated/)
  assert.match(run, /exists \(\s*select 1\s+from public\.ai_applications a\s+where a\.job_id = jobs\.id\s+and a\.user_id = auth\.uid\(\)\s*\)/)
  assert.doesNotMatch(run, /drop policy[^;]*Anyone can read active jobs/i, 'kebijakan active yang ada tidak dihapus')
  assert.doesNotMatch(run, /for (all|insert|update|delete)/i)
  assert.match(sql, /drop policy if exists "Users can read jobs they applied to"/, 'dapat dijalankan ulang')
})
