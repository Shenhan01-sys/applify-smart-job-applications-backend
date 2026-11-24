-- USULAN MIGRASI (BELUM DIJALANKAN KE PRODUCTION)
--
-- Satu lowongan, satu lamaran aktif per pengguna.
--
-- Latar belakang (uji E2E 24 November 2026): papan Lamaran Saya menampilkan "Lamaran ke-1 dari 2" dan
-- "ke-2 dari 2" untuk lowongan yang sama. Data production (hanya dibaca) memastikan itu baris kembar di
-- ai_applications: 12 pasangan (user_id, job_id) yang sama, 24 baris, semuanya berstatus draft atau ready.
-- Penjaga di kode sudah ada (Edge Function generate-application, supabase/functions/_shared/active-application.ts:
-- mengembalikan lamaran aktif yang ada dan tidak membuat baris baru). Indeks ini penjaga kedua di basis data untuk
-- dua permintaan yang datang bersamaan; Edge Function menangkap kode 23505 dan mengembalikan baris pemenang.
--
-- "Aktif" = status selain 'closed'. Lamaran yang ditutup pengguna membuka jalan untuk draf baru.
--
-- URUTAN (jangan balik): langkah 1 hanya membaca. Langkah 2 mengubah data dan harus ditinjau pemilik dulu.
-- Langkah 3 GAGAL selama masih ada pasangan aktif kembar.
--
-- Catatan:
--   - Kode sudah bekerja tanpa indeks ini (penjaga tingkat aplikasi). Indeks hanya menutup celah balapan.
--   - Jalankan langkah 3 di jam sepi; CREATE UNIQUE INDEX biasa mengunci tulis tabel sebentar. Tabelnya kecil
--     (38 baris saat dicek), jadi aman. Untuk tabel besar pakai CREATE UNIQUE INDEX CONCURRENTLY (di luar transaksi).

-- ---------------------------------------------------------------------------------------------
-- Langkah 1 (hanya baca): pasangan aktif kembar yang menghalangi indeks.
-- ---------------------------------------------------------------------------------------------
select user_id, job_id, count(*) as jumlah, array_agg(id order by created_at) as ids,
       array_agg(status order by created_at) as statuses,
       array_agg(submitted_at is not null order by created_at) as ada_submitted_at
from public.ai_applications
where status <> 'closed'
group by user_id, job_id
having count(*) > 1
order by jumlah desc;

-- ---------------------------------------------------------------------------------------------
-- Langkah 2 (MENGUBAH DATA, tinjau dulu; tidak ada baris yang dihapus): tutup kembaran yang lebih lama.
-- Per pasangan dipertahankan satu baris: status paling maju, lalu yang paling baru dibuat. Hanya baris yang
-- submitted_at-nya kosong yang ditutup, karena closed + submitted_at dihitung "terkirim" oleh Lamaran Saya.
-- Hapus tanda komentar setelah daftar dari langkah 1 diperiksa.
-- Dicek hanya-baca pada 24 November 2026: 12 pasangan, 11 baris akan ditutup, 1 baris perlu keputusan manual (lihat di bawah).
-- ---------------------------------------------------------------------------------------------
-- with ranked as (
--   select id, submitted_at,
--          row_number() over (
--            partition by user_id, job_id
--            order by case status when 'responded' then 5 when 'follow_up' then 4 when 'submitted' then 3
--                                 when 'ready' then 2 else 1 end desc,
--                     created_at desc
--          ) as rn
--   from public.ai_applications
--   where status <> 'closed'
-- )
-- update public.ai_applications a
--    set status = 'closed', updated_at = now()
--   from ranked r
--  where a.id = r.id and r.rn > 1 and r.submitted_at is null;
--
-- Baris berstatus draft atau ready yang submitted_at-nya TERISI (ada 1 di production, 24 November 2026: draf yang
-- pernah ditandai terkirim lalu dipindah balik) tidak disentuh langkah di atas. Putuskan manual: bila memang tidak
-- pernah terkirim, kosongkan dulu submitted_at dan follow_up_scheduled pada baris itu, lalu ulangi langkah 2.
-- Bila memang sudah terkirim, ubah statusnya menjadi 'submitted' dan tutup kembarannya.

-- ---------------------------------------------------------------------------------------------
-- Langkah 3: indeks unik parsial. Gagal bila langkah 1 masih mengembalikan baris.
-- ---------------------------------------------------------------------------------------------
create unique index if not exists ai_applications_one_active_per_job
  on public.ai_applications (user_id, job_id)
  where status <> 'closed';

-- Rollback:
-- drop index if exists public.ai_applications_one_active_per_job;
-- (Baris yang ditutup di langkah 2 dapat dibuka lagi dengan: update public.ai_applications set status = 'draft' where id = '<id>';
--  catat id-nya dari hasil langkah 1 sebelum menjalankan langkah 2.)
