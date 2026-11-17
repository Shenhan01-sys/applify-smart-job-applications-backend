import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FakeDb } from './helpers/fakeDb.ts'
import {
  AiFailedError,
  ApprovalExpiredError,
  ApprovalNotFoundError,
  DEFAULT_REGENERATE_INSTRUCTIONS,
  EmptyDraftError,
  cleanInstructions,
  regenerateApprovalCoverLetter,
  type RegenerateAI,
} from '../services/approval-regenerate.service.ts'

const NOW = new Date('2026-11-18T10:00:00.000Z')

const seed = (over: Record<string, any> = {}) =>
  new FakeDb({
    approval_requests: [
      {
        id: 'a1', user_id: 'u1', job_id: 'j1', job_title: 'Backend Engineer', company: 'Contoh PT',
        status: 'pending', expires_at: '2026-11-18T11:00:00.000Z', cover_letter: 'Surat lama yang panjang.',
        ...over,
      },
    ],
    jobs: [{ id: 'j1', description: 'Bangun API.' }],
  })

function fakeAI(reply: string | Error) {
  const calls: any[] = []
  const ai: RegenerateAI = {
    lastModelUsed: 'openrouter:model-uji',
    async regenerateCoverLetter(p) {
      calls.push(p)
      if (reply instanceof Error) throw reply
      return reply
    },
  }
  return { ai, calls }
}

test('regenerate memanggil pipeline AI dengan surat lama, instruksi, dan deskripsi lowongan, lalu menyimpan hasilnya', async () => {
  const db = seed()
  const { ai, calls } = fakeAI('Surat baru yang lebih ringkas.')
  const out = await regenerateApprovalCoverLetter(db, ai, {
    userId: 'u1', approvalId: 'a1', instructions: '  buat lebih singkat  ', now: NOW,
  })
  assert.equal(out.coverLetter, 'Surat baru yang lebih ringkas.')
  assert.equal(out.model, 'openrouter:model-uji')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].original, 'Surat lama yang panjang.')
  assert.equal(calls[0].instructions, 'buat lebih singkat')
  assert.equal(calls[0].jobTitle, 'Backend Engineer')
  assert.equal(calls[0].jobDescription, 'Bangun API.')
  assert.equal(db.rows('approval_requests')[0].cover_letter, 'Surat baru yang lebih ringkas.')
  assert.equal(db.rows('approval_requests')[0].status, 'pending', 'regenerate tidak menyetujui apa pun')
})

test('pagar kode ``` dari model dibuang', async () => {
  const { ai } = fakeAI('```text\nIsi surat.\n```')
  const out = await regenerateApprovalCoverLetter(seed(), ai, { userId: 'u1', approvalId: 'a1', now: NOW })
  assert.equal(out.coverLetter, 'Isi surat.')
})

test('instruksi kosong atau bukan string memakai instruksi bawaan; instruksi dibatasi 500 karakter', () => {
  assert.equal(cleanInstructions(undefined), DEFAULT_REGENERATE_INSTRUCTIONS)
  assert.equal(cleanInstructions('   '), DEFAULT_REGENERATE_INSTRUCTIONS)
  assert.equal(cleanInstructions({ x: 1 }), DEFAULT_REGENERATE_INSTRUCTIONS)
  assert.equal(cleanInstructions('a'.repeat(900)).length, 500)
})

test('permintaan tidak ada, milik user lain, atau sudah diproses: 404 dan AI tidak dipanggil', async () => {
  for (const over of [{ user_id: 'u2' }, { status: 'approved' }, { status: 'rejected' }]) {
    const { ai, calls } = fakeAI('x')
    await assert.rejects(
      regenerateApprovalCoverLetter(seed(over), ai, { userId: 'u1', approvalId: 'a1', now: NOW }),
      ApprovalNotFoundError
    )
    assert.equal(calls.length, 0)
  }
  const { ai } = fakeAI('x')
  await assert.rejects(regenerateApprovalCoverLetter(new FakeDb(), ai, { userId: 'u1', approvalId: 'zzz', now: NOW }), ApprovalNotFoundError)
})

test('permintaan kedaluwarsa: 410, AI tidak dipanggil', async () => {
  const { ai, calls } = fakeAI('x')
  await assert.rejects(
    regenerateApprovalCoverLetter(seed({ expires_at: '2026-11-18T09:00:00.000Z' }), ai, { userId: 'u1', approvalId: 'a1', now: NOW }),
    ApprovalExpiredError
  )
  assert.equal(calls.length, 0)
})

test('AI gagal: 502 dan surat lama tidak diubah', async () => {
  const db = seed()
  const { ai } = fakeAI(new Error('AI generation failed after 8 attempts'))
  await assert.rejects(regenerateApprovalCoverLetter(db, ai, { userId: 'u1', approvalId: 'a1', now: NOW }), AiFailedError)
  assert.equal(db.rows('approval_requests')[0].cover_letter, 'Surat lama yang panjang.')
})

test('AI membalas kosong: ditolak, surat lama tidak ditimpa', async () => {
  const db = seed()
  const { ai } = fakeAI('   ')
  await assert.rejects(regenerateApprovalCoverLetter(db, ai, { userId: 'u1', approvalId: 'a1', now: NOW }), EmptyDraftError)
  assert.equal(db.rows('approval_requests')[0].cover_letter, 'Surat lama yang panjang.')
})
