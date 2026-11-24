-- USULAN MIGRASI (BELUM DIJALANKAN KE PRODUCTION)
--
-- Pengguna boleh membaca lowongan yang menjadi tujuan lamarannya sendiri, walau lowongannya sudah tidak aktif.
--
-- Latar belakang (uji E2E 24 November 2026): kartu Lamaran Saya bertuliskan "Lowongan" dan "Perusahaan" untuk lamaran
-- yang sudah terkirim. Penyebabnya kebijakan RLS tabel jobs satu-satunya adalah
--   "Anyone can read active jobs"  FOR SELECT USING (status = 'active')
-- sehingga lamaran ke lowongan berstatus 'closed' (1 baris di production, 24 November 2026) kembali dari
-- select("*, jobs(*)") dengan jobs = null. Frontend sudah menampilkan "Lowongan tanpa judul" sebagai cadangan
-- (src/lib/applicationCards.ts jobDisplay). Kebijakan ini membuat judul dan perusahaan aslinya kembali tampil.
--
-- Kebijakan RLS bersifat OR: yang ini menambah akses, tidak mengurangi kebijakan active yang sudah ada.
-- Hanya baris jobs yang punya ai_applications milik pengguna itu sendiri yang terbuka.
--
-- Catatan:
--   - Jalankan hanya setelah review pemilik. Tidak mengubah data.
--   - Subquery memakai indeks ai_applications_user_idx (user_id); tabelnya kecil.

drop policy if exists "Users can read jobs they applied to" on public.jobs;

create policy "Users can read jobs they applied to"
  on public.jobs
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.ai_applications a
      where a.job_id = jobs.id
        and a.user_id = auth.uid()
    )
  );

-- Rollback:
-- drop policy if exists "Users can read jobs they applied to" on public.jobs;
