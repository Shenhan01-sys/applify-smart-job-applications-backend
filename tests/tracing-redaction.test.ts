import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildGenerationTracePayload,
  redactLangfuseText,
  sanitizeTraceMetadata,
} from '../services/tracing.service.js'

test('U6-P2-11 Langfuse redaction: bawaan hanya mengirim hash SHA-256 + panjang, tidak pernah teks prompt/output PII', () => {
  const secretPrompt = 'Nama: Budi Santoso, Email: budi@gmail.com, HP: +6281234567890, Gaji: Rp 15.000.000'
  const secretOutput = 'Kepada HRD PT Contoh, saya Budi Santoso ingin melamar...'

  const payload = buildGenerationTracePayload(
    {
      type: 'cover_letter',
      model: 'gemini-3.5-flash',
      prompt: secretPrompt,
      output: secretOutput,
      tokensUsed: 500,
      metadata: {
        jobId: 'job-1',
        email: 'budi@gmail.com',
        rawPrompt: secretPrompt,
        longText: 'x'.repeat(250),
      },
    },
    {}
  )

  const serialized = JSON.stringify(payload)
  assert.equal(serialized.includes('Budi Santoso'), false)
  assert.equal(serialized.includes('budi@gmail.com'), false)
  assert.equal(serialized.includes('+6281234567890'), false)
  assert.equal(typeof payload.input, 'object')
  assert.equal((payload.input as any).redacted, true)
  assert.equal((payload.input as any).chars, secretPrompt.length)
  assert.match((payload.input as any).sha256, /^[a-f0-9]{64}$/)
  assert.equal((payload.output as any).redacted, true)
  assert.equal((payload.output as any).chars, secretOutput.length)
  assert.equal(payload.metadata.contentRedacted, true)
  assert.equal((payload.metadata as any).email, undefined)
  assert.equal((payload.metadata as any).rawPrompt, undefined)
  assert.equal((payload.metadata as any).jobId, 'job-1')
  assert.deepEqual((payload.metadata as any).longText, { redacted: true, chars: 250 })
})

test('U6-P2-11 Langfuse redaction: konten mentah hanya diizinkan bila LANGFUSE_INCLUDE_CONTENT=true', () => {
  assert.equal(redactLangfuseText('halo', { LANGFUSE_INCLUDE_CONTENT: 'true' }), 'halo')
  assert.notEqual(redactLangfuseText('halo', { LANGFUSE_INCLUDE_CONTENT: 'false' }), 'halo')
  assert.deepEqual(sanitizeTraceMetadata({ ok: 1, phone: '0812', cvText: 'abc' }), { ok: 1 })
})
