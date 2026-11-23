-- DRAFT SQL MIGRATION (DO NOT APPLY DIRECTLY TO PRODUCTION WITHOUT INTEGRATION REVIEW)
-- Date: 2026-11-23
-- Feature: Stage 1 Split-Channel Job Classification Metadata
--
-- Catatan koordinasi:
--   - Backend sudah bekerja tanpa kolom-kolom ini (fallback klasifikasi runtime dari external_url & description).
--   - Kolom-kolom ini bersifat opsional/additive agar backfill & query kanal di DB lebih cepat setelah direview
--     dan digabungkan oleh agent utama.

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
