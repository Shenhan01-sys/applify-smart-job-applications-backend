import test from 'node:test'
import assert from 'node:assert/strict'
import { assessJobSafety } from '../services/job-safety.service.js'

const NOW = new Date('2026-11-26T00:00:00Z')

test('P1-05: menandai pungutan biaya sebagai risiko tinggi, tetapi mengabaikan sanggahan resmi tidak dipungut biaya', () => {
  const scam = assessJobSafety(
    {
      title: 'Admin Gudang',
      company: 'CV Maju',
      description: 'Kandidat lolos wajib membayar biaya administrasi Rp 250.000 dan transfer uang seragam sebelum kerja.',
      posted_at: '2026-11-24T00:00:00Z',
    },
    NOW,
  )
  assert.equal(scam.riskLevel, 'high')
  assert.ok(scam.flags.some((f) => f.code === 'fee_requested'))

  const legit = assessJobSafety(
    {
      title: 'Backend Engineer',
      company: 'PT Teknologi Nusantara',
      description: 'Kualifikasi: Node.js, PostgreSQL. Waspada penipuan: seluruh proses rekrutmen tidak dipungut biaya apapun.',
      external_url: 'https://boards.greenhouse.io/nusantara/jobs/1',
      posted_at: '2026-11-20T00:00:00Z',
    },
    NOW,
  )
  assert.equal(legit.riskLevel, 'low')
  assert.equal(legit.flags.length, 0)
})

test('P1-05: menandai MLM, freemail HR, dan shortlink/wa.me sesuai tingkat risiko', () => {
  const mlm = assessJobSafety(
    {
      title: 'Bisnis Online',
      description: 'Tanpa ijazah gaji 20 jt per bulan, cukup rekrut downline dan modal awal Rp 500.000.',
      posted_at: '2026-11-25T00:00:00Z',
    },
    NOW,
  )
  assert.equal(mlm.riskLevel, 'high')
  assert.ok(mlm.flags.some((f) => f.code === 'mlm_or_unrealistic'))

  const freemail = assessJobSafety(
    {
      title: 'Kasir Cafe',
      description: 'Kirim CV ke hrd.kopilokal@gmail.com atau daftar lewat https://bit.ly/loker-kopi',
      posted_at: '2026-11-25T00:00:00Z',
    },
    NOW,
  )
  assert.equal(freemail.riskLevel, 'caution')
  assert.ok(freemail.flags.some((f) => f.code === 'freemail_recruiter'))
  assert.ok(freemail.flags.some((f) => f.code === 'shortlink_or_messaging'))
})

test('P2-05: menandai lowongan lama (>30 hari) sebagai stale dan posted_at kosong sebagai info unknown', () => {
  const stale = assessJobSafety(
    {
      title: 'Product Designer',
      description: 'Desain UI/UX aplikasi mobile.',
      posted_at: '2026-10-01T00:00:00Z',
    },
    NOW,
  )
  assert.equal(stale.freshness.status, 'stale')
  assert.equal(stale.riskLevel, 'caution')
  assert.ok(stale.flags.some((f) => f.code === 'stale_posting'))

  const unknown = assessJobSafety(
    {
      title: 'Staff Finance',
      description: 'Pembukuan harian perusahaan.',
      posted_at: null,
    },
    NOW,
  )
  assert.equal(unknown.freshness.status, 'unknown')
  assert.equal(unknown.riskLevel, 'low')
  assert.ok(unknown.flags.some((f) => f.code === 'missing_posted_date'))
})
