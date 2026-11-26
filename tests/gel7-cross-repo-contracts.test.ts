import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '../..')
const FIVE_MB = 5 * 1024 * 1024

test('47.1 P3-3: batas ukuran dokumen 5 MB (5242880 byte) konsisten lintas backend, worker, frontend, dan migrasi Storage', () => {
  const backendPdf = readFileSync(path.join(ROOT, 'backend/services/linkedin-pdf.ts'), 'utf8')
  assert.match(backendPdf, /export const PDF_MAX_BYTES = 5 \* 1024 \* 1024/)

  const backendRoute = readFileSync(path.join(ROOT, 'backend/api/routes/profile-import.ts'), 'utf8')
  assert.match(backendRoute, /const BODY_LIMIT = PDF_MAX_BYTES \+ 1/)

  const migrationPath = path.join(ROOT, 'database/migrations/2026-11-20_resume_storage.sql')
  if (existsSync(migrationPath)) {
    assert.match(readFileSync(migrationPath, 'utf8'), new RegExp(`file_size_limit[\\s\\S]{0,80}${FIVE_MB}`))
  }

  const workerResume = path.join(ROOT, 'worker/src/lib/resumeFile.ts')
  if (existsSync(workerResume)) {
    assert.match(readFileSync(workerResume, 'utf8'), /5 \* 1024 \* 1024/)
  }
  const workerDocs = path.join(ROOT, 'worker/src/lib/profileDocuments.ts')
  if (existsSync(workerDocs)) {
    assert.match(readFileSync(workerDocs, 'utf8'), /DOCUMENT_MAX_BYTES = 5 \* 1024 \* 1024/)
  }

  const feResume = path.join(ROOT, 'applify-smart-job-applications/src/lib/resumeUpload.ts')
  if (existsSync(feResume)) {
    assert.match(readFileSync(feResume, 'utf8'), /5 \* 1024 \* 1024/)
  }
  const feDocs = path.join(ROOT, 'applify-smart-job-applications/src/lib/profileDocuments.ts')
  if (existsSync(feDocs)) {
    assert.match(readFileSync(feDocs, 'utf8'), /5 \* 1024 \* 1024/)
  }
})

test('48.3 BS-10: berkas DRAFT SQL di backend/docs dan backend/migrations identik byte-for-byte dengan database/migrations', (t) => {
  const dbDir = path.join(ROOT, 'database/migrations')
  if (!existsSync(dbDir)) return t.skip('folder database/migrations tidak tersedia di samping backend')

  const pairs: Array<[string, string]> = [
    ['backend/docs/DRAFT_2026-11-23_jobs_apply_channel.sql', 'database/migrations/DRAFT_2026-11-23_jobs_apply_channel.sql'],
    ['backend/migrations/DRAFT_2026-11-24_ai_applications_one_active_per_job.sql', 'database/migrations/DRAFT_2026-11-24_ai_applications_one_active_per_job.sql'],
    ['backend/migrations/DRAFT_2026-11-24_jobs_read_own_applied.sql', 'database/migrations/DRAFT_2026-11-24_jobs_read_own_applied.sql'],
  ]
  for (const [copyRel, canonRel] of pairs) {
    assert.equal(
      readFileSync(path.join(ROOT, copyRel), 'utf8'),
      readFileSync(path.join(ROOT, canonRel), 'utf8'),
      `${copyRel} harus identik dengan ${canonRel}`
    )
  }
})

test('48.5 H-14: log galat service backend tidak membuang objek Error mentah langsung ke console.error', () => {
  for (const rel of [
    'backend/services/session-manager.service.ts',
    'backend/services/form-autofill.service.ts',
    'backend/services/automation.service.ts',
  ]) {
    const src = readFileSync(path.join(ROOT, rel), 'utf8')
    assert.doesNotMatch(src, /console\.error\([^)]*,\s*error\s*\)/, rel)
  }
})
