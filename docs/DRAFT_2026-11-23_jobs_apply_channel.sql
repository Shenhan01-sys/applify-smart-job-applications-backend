-- USULAN MIGRASI (BELUM DIJALANKAN KE PRODUCTION)
-- Promosi dari backend/docs/DRAFT_2026-11-23_jobs_apply_channel.sql (sesuai Catatan 16 section 4.5).
--
-- Catatan:
--   - Backend dan frontend sudah bekerja tanpa kolom ini via klasifikasi runtime (`apply-channel.ts`).
--   - Jalankan hanya setelah review & persetujuan integrasi oleh agent utama / operator.

ALTER TABLE public.jobs
  ADD COLUMN IF NOT EXISTS apply_channel TEXT
    CHECK (apply_channel IN ('public_ats', 'email_direct', 'auth_portal', 'external_web'));

ALTER TABLE public.jobs
  ADD COLUMN IF NOT EXISTS resolved_apply_url TEXT;

ALTER TABLE public.jobs
  ADD COLUMN IF NOT EXISTS apply_email TEXT;

CREATE INDEX IF NOT EXISTS idx_jobs_apply_channel
  ON public.jobs (apply_channel)
  WHERE apply_channel IS NOT NULL;

-- Rollback:
-- DROP INDEX IF EXISTS public.idx_jobs_apply_channel;
-- ALTER TABLE public.jobs DROP COLUMN IF EXISTS apply_email, DROP COLUMN IF EXISTS resolved_apply_url, DROP COLUMN IF EXISTS apply_channel;
