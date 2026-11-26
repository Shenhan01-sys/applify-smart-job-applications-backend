import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { matchOptionStrict } from '../services/option-match.js'

const workerUrl = new URL('../../worker/src/lib/numes-keys.ts', import.meta.url)
const edgeUrl = new URL('../../applify-smart-job-applications/supabase/functions/_shared/numes-keys.ts', import.meta.url)
// Repo saudara hanya ada pada tata letak monorepo/worktree; pada checkout backend sendirian (CI, Railway) tes dilewati.
const siblingsPresent = existsSync(workerUrl) && existsSync(edgeUrl)

test('J5-07: numes-keys.ts identik byte-for-byte antara backend, worker, dan Edge Function', { skip: !siblingsPresent && 'repo worker/frontend tidak ada di sebelah backend' }, () => {
  const backendCopy = readFileSync(new URL('../services/numes-keys.ts', import.meta.url), 'utf8')
  const workerCopy = readFileSync(workerUrl, 'utf8')
  const edgeCopy = readFileSync(edgeUrl, 'utf8')
  assert.equal(workerCopy, backendCopy, 'worker/src/lib/numes-keys.ts menyimpang dari backend')
  assert.equal(edgeCopy, backendCopy, 'supabase/functions/_shared/numes-keys.ts menyimpang dari backend')
})

test('U2B-10 (sisi backend): option-match mendukung alias ID-EN pendidikan, tipe kerja, lokasi kerja, dan waktu mulai', () => {
  assert.equal(matchOptionStrict('S1', ["High School", "Bachelor's Degree", "Master's Degree"]), "Bachelor's Degree")
  assert.equal(matchOptionStrict('Sarjana', ['Diploma', 'Bachelor', 'Master']), 'Bachelor')
  assert.equal(matchOptionStrict('Magang', ['Full-time', 'Internship', 'Contract']), 'Internship')
  assert.equal(matchOptionStrict('Jarak jauh', ['Onsite', 'Hybrid', 'Remote']), 'Remote')
  assert.equal(matchOptionStrict('Segera', ['Immediately', '30 days']), 'Immediately')
})
