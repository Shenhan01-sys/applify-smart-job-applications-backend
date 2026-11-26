import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  parsePdfInWorker,
  reconstructPageTextFromItems,
  stripRepeatedHeadersFooters,
  type PdfTextItem,
} from '../services/linkedin-pdf.ts'

test('47.1 P2-3: reconstructPageTextFromItems membaca CV 2 kolom per kolom (kiri utuh lalu kanan), tidak bercampur per baris', () => {
  const items: PdfTextItem[] = [
    // Header lebar penuh di atas
    { str: 'BUDI SANTOSO', x: 50, y: 780, width: 320 },
    // Baris 1..4 terbelah kiri (x ~ 50) & kanan (x ~ 320)
    { str: 'KONTAK', x: 50, y: 730, width: 60 },
    { str: 'PENGALAMAN KERJA', x: 320, y: 730, width: 140 },
    { str: 'Jakarta, Indonesia', x: 50, y: 710, width: 110 },
    { str: 'Software Engineer — PT Nusantara', x: 320, y: 710, width: 200 },
    { str: 'KEAHLIAN', x: 50, y: 680, width: 70 },
    { str: '2022 - Sekarang', x: 320, y: 690, width: 90 },
    { str: 'TypeScript, PostgreSQL', x: 50, y: 660, width: 130 },
    { str: 'Membangun layanan backend', x: 320, y: 670, width: 160 },
  ]

  const out = reconstructPageTextFromItems(items)
  const lines = out.split('\n')
  assert.equal(lines[0], 'BUDI SANTOSO')
  // Seluruh kolom kiri selesai sebelum kolom kanan dimulai
  assert.ok(out.indexOf('TypeScript, PostgreSQL') < out.indexOf('PENGALAMAN KERJA'), out)
  assert.ok(out.indexOf('PENGALAMAN KERJA') < out.indexOf('Software Engineer — PT Nusantara'), out)
})

test('47.1 P2-3: stripRepeatedHeadersFooters membuang header/footer berulang >= 3 halaman tetapi menjaga heading seksi', () => {
  const pages = [
    'Curriculum Vitae — Budi\nPENGALAMAN KERJA\nPT Satu\nPage 1 of 3',
    'Curriculum Vitae — Budi\nPT Dua\nPage 2 of 3',
    'Curriculum Vitae — Budi\nPENDIDIKAN\nUniversitas Contoh\nPage 3 of 3',
  ]
  const cleaned = stripRepeatedHeadersFooters(pages)
  assert.equal(cleaned[0], 'PENGALAMAN KERJA\nPT Satu')
  assert.equal(cleaned[1], 'PT Dua')
  assert.equal(cleaned[2], 'PENDIDIKAN\nUniversitas Contoh')
})

test('47.1 P2-6: parsePdfInWorker menghentikan worker thread secara nyata saat timeout (worker.terminate)', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pdf-worker-timeout-'))
  try {
    const busyWorker = path.join(dir, 'busy-worker.mjs')
    // Loop sibuk selama worker belum di-terminate; bila tidak dihentikan, proses tes akan macet 5 detik.
    writeFileSync(
      busyWorker,
      `setInterval(() => {}, 50);\n`,
      'utf8'
    )
    const started = Date.now()
    await assert.rejects(
      () => parsePdfInWorker(Buffer.from('%PDF-1.4'), { timeoutMs: 120, workerUrl: pathToFileURL(busyWorker) }),
      /pdf_parse_timeout/
    )
    const elapsed = Date.now() - started
    assert.ok(elapsed < 1000, `worker timeout harus memutus cepat, bukan ${elapsed}ms`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
