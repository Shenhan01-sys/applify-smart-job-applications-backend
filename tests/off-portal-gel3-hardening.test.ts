import test from 'node:test'
import assert from 'node:assert/strict'
import zlib from 'node:zlib'
import Fastify from 'fastify'
import { jobRoutes, OFF_PORTAL_IMAGE_ACTION, OFF_PORTAL_IMAGE_LIMITS } from '../api/routes/jobs.js'
import { AiAccessError, AiGuardService } from '../services/ai-guard.service.js'
import {
  MAX_PRIVATE_OFF_PORTAL_JOBS_PER_USER,
  savePrivateOffPortalJobs,
} from '../services/off-portal-save.service.js'
import {
  QR_SCAN_BUDGET_MS,
  decodeQrStringsFromRgba,
  decodeQrUrlsFromImage,
  decodePngRgba,
  isBrowserDecodableSize,
  peekImageDimensions,
} from '../services/qr-decoder.service.js'

/**
 * Pengerasan Gelombang 3 (off-portal): batas laju ai-guard untuk unggahan gambar, dekoder QR tahan gambar buatan,
 * batas dimensi sebelum Chromium, dan penyimpanan lowongan privat yang tidak pernah 500 karena kolom migrasi belum ada.
 */

const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+X2dIAAAAASUVORK5CYII='

const OK_OCR = async () => ({ status: 'ok' as const, text: 'PT Maju\nHiring: Data Analyst\nKirim CV ke hr@maju.id', truncated: false })
const NO_QR = async () => ({ rawTexts: [], urls: [], rejectedUrls: [], method: 'png_native' as const })

async function buildApp(opts: Record<string, unknown> & { user?: { id: string } | null }) {
  const { user, ...routeOpts } = opts
  const app = Fastify()
  app.addHook('preHandler', async (req) => {
    if (user !== null) (req as any).user = user ?? { id: 'user-1' }
  })
  await app.register(jobRoutes, { prefix: '/api/jobs', ...routeOpts } as any)
  await app.ready()
  return app
}

// ---------------------------------------------------------------------------
// /off-portal/parse: ai-guard
// ---------------------------------------------------------------------------

test('parse gambar: batas ai-guard dipanggil sebelum OCR dengan action sendiri dan batas 3/menit, 20/jam', async () => {
  const calls: any[] = []
  let ocrCalls = 0
  const app = await buildApp({
    guard: { checkActionRateLimit: async (...args: any[]) => void calls.push(args) },
    posterOcr: async () => {
      ocrCalls++
      assert.equal(calls.length, 1, 'guard harus dipanggil lebih dulu daripada OCR')
      return OK_OCR()
    },
    qrDecoder: NO_QR,
  })
  try {
    const res = await app.inject({ method: 'POST', url: '/api/jobs/off-portal/parse', payload: { imageBase64: TINY_PNG_BASE64 } })
    assert.equal(res.statusCode, 200, res.body)
    assert.equal(ocrCalls, 1)
    assert.equal(calls[0][0], 'user-1')
    assert.equal(calls[0][1], OFF_PORTAL_IMAGE_ACTION)
    assert.deepEqual(calls[0][3], OFF_PORTAL_IMAGE_LIMITS)
    assert.deepEqual(OFF_PORTAL_IMAGE_LIMITS, { perMinute: 3, perHour: 20 })
  } finally {
    await app.close()
  }
})

test('parse gambar: batas ai-guard terlewati -> 429 + Retry-After, OCR dan QR tidak dijalankan', async () => {
  let ocrCalls = 0
  let qrCalls = 0
  const app = await buildApp({
    guard: {
      checkActionRateLimit: async () => {
        throw new AiAccessError(429, 'rate_limited', 'Terlalu banyak unggahan poster. Coba lagi dalam 42 detik.', { retryAfterSec: 42 })
      },
    },
    posterOcr: async () => (ocrCalls++, OK_OCR()),
    qrDecoder: async () => (qrCalls++, NO_QR()),
  })
  try {
    const res = await app.inject({ method: 'POST', url: '/api/jobs/off-portal/parse', payload: { imageBase64: TINY_PNG_BASE64 } })
    assert.equal(res.statusCode, 429)
    assert.equal(res.headers['retry-after'], '42')
    assert.equal(res.json().code, 'rate_limited')
    assert.equal(ocrCalls, 0)
    assert.equal(qrCalls, 0)
  } finally {
    await app.close()
  }
})

test('parse gambar: pemeriksaan batas gagal -> 503 jelas (tidak 500, tidak lanjut ke OCR)', async () => {
  let ocrCalls = 0
  const app = await buildApp({
    guard: {
      checkActionRateLimit: async () => {
        throw new Error('db down: secret-detail')
      },
    },
    posterOcr: async () => (ocrCalls++, OK_OCR()),
    qrDecoder: NO_QR,
  })
  try {
    const res = await app.inject({ method: 'POST', url: '/api/jobs/off-portal/parse', payload: { imageBase64: TINY_PNG_BASE64 } })
    assert.equal(res.statusCode, 503)
    assert.equal(res.json().code, 'rate_limit_check_failed')
    assert.doesNotMatch(res.body, /secret-detail/)
    assert.equal(ocrCalls, 0)
  } finally {
    await app.close()
  }
})

test('parse: gambar tidak valid dan teks biasa tidak memakai jatah ai-guard', async () => {
  let guardCalls = 0
  const app = await buildApp({
    guard: { checkActionRateLimit: async () => void guardCalls++ },
    posterOcr: OK_OCR,
    qrDecoder: NO_QR,
  })
  try {
    const bad = await app.inject({ method: 'POST', url: '/api/jobs/off-portal/parse', payload: { imageBase64: Buffer.from('bukan gambar sama sekali').toString('base64') } })
    assert.equal(bad.statusCode, 400)
    const huge = await app.inject({ method: 'POST', url: '/api/jobs/off-portal/parse', payload: { imageBase64: 'A'.repeat(7 * 1024 * 1024) } })
    assert.equal(huge.statusCode, 413)
    assert.equal(huge.json().code, 'image_too_large')
    const text = await app.inject({ method: 'POST', url: '/api/jobs/off-portal/parse', payload: { rawText: 'PT Maju membuka lowongan Data Analyst. Kirim CV ke hr@maju.id' } })
    assert.equal(text.statusCode, 200, text.body)
    assert.equal(guardCalls, 0)
  } finally {
    await app.close()
  }
})

test('parse: tanpa user -> 401 sebelum guard, OCR, dan QR disentuh', async () => {
  let touched = 0
  const app = await buildApp({
    user: null,
    guard: { checkActionRateLimit: async () => void touched++ },
    posterOcr: async () => (touched++, OK_OCR()),
    qrDecoder: async () => (touched++, NO_QR()),
  })
  try {
    const res = await app.inject({ method: 'POST', url: '/api/jobs/off-portal/parse', payload: { imageBase64: TINY_PNG_BASE64 } })
    assert.equal(res.statusCode, 401)
    assert.equal(touched, 0)
  } finally {
    await app.close()
  }
})

test('parse: dekoder QR melempar galat -> tetap 200 (QR dianggap kosong), bukan 500', async () => {
  const app = await buildApp({
    guard: { checkActionRateLimit: async () => {} },
    posterOcr: OK_OCR,
    qrDecoder: async () => {
      throw new Error('RangeError: array buatan')
    },
  })
  try {
    const res = await app.inject({ method: 'POST', url: '/api/jobs/off-portal/parse', payload: { imageBase64: TINY_PNG_BASE64 } })
    assert.equal(res.statusCode, 200, res.body)
    assert.equal(res.json().qr.method, 'none')
    assert.ok(res.json().jobs.length >= 1)
  } finally {
    await app.close()
  }
})

test('AiGuardService asli: RPC menolak -> checkActionRateLimit melempar AiAccessError 429 untuk action off_portal_ocr', async () => {
  const seen: any[] = []
  const client = {
    from() {
      throw new Error('tidak boleh dipakai bila RPC menjawab')
    },
    async rpc(fn: string, args: Record<string, unknown>) {
      seen.push([fn, args])
      return { data: { allowed: false, retry_after_sec: 12 }, error: null }
    },
  }
  const guard = new AiGuardService(client as any)
  await assert.rejects(
    () => guard.checkActionRateLimit('user-9', OFF_PORTAL_IMAGE_ACTION, '/api/jobs/off-portal/parse', OFF_PORTAL_IMAGE_LIMITS, 'Terlalu banyak unggahan poster'),
    (e: any) => e instanceof AiAccessError && e.statusCode === 429 && e.extra.retryAfterSec === 12,
  )
  assert.equal(seen[0][1].p_action, OFF_PORTAL_IMAGE_ACTION)
  assert.equal(seen[0][1].p_per_minute, 3)
  assert.equal(seen[0][1].p_per_hour, 20)
})

// ---------------------------------------------------------------------------
// /off-portal/save
// ---------------------------------------------------------------------------

function missingColumnsDb(counters: { inserts: number }) {
  return {
    from(table: string) {
      assert.equal(table, 'jobs')
      return {
        select() {
          const q: any = {
            eq: () => q,
            limit: () => Promise.resolve({ data: null, error: { code: '42703', message: 'column jobs.created_by does not exist' } }),
          }
          return q
        },
        insert() {
          counters.inserts++
          return { select: () => Promise.resolve({ data: null, error: { code: 'PGRST204', message: "Could not find the 'visibility' column of 'jobs'" } }) }
        },
      }
    },
  }
}

const SAVE_ITEM = { title: 'Data Analyst', company: 'PT Maju', location: 'Jakarta', description: 'Kirim CV ke hr@maju.id', sourceType: 'off_portal_caption', applyEmail: 'hr@maju.id' }

test('POST /off-portal/save: kolom migrasi belum ada (produksi sekarang) -> 200 migrationRequired, nol insert, bukan 500', async () => {
  const counters = { inserts: 0 }
  const app = await buildApp({ db: missingColumnsDb(counters) })
  try {
    const res = await app.inject({ method: 'POST', url: '/api/jobs/off-portal/save', payload: { jobs: [SAVE_ITEM] } })
    assert.equal(res.statusCode, 200, res.body)
    const body = res.json()
    assert.equal(body.saved, false)
    assert.equal(body.migrationRequired, true)
    assert.equal(body.code, 'private_jobs_migration_required')
    assert.match(body.message, /DRAFT_2026-11-26_private_offportal_jobs\.sql/)
    assert.equal(counters.inserts, 0)
  } finally {
    await app.close()
  }
})

test('POST /off-portal/save: tanpa user 401; daftar kosong 400; galat DB tak terduga -> 500 generik tanpa bocoran', async () => {
  const noUser = await buildApp({ user: null, db: missingColumnsDb({ inserts: 0 }) })
  try {
    const res = await noUser.inject({ method: 'POST', url: '/api/jobs/off-portal/save', payload: { jobs: [SAVE_ITEM] } })
    assert.equal(res.statusCode, 401)
  } finally {
    await noUser.close()
  }

  const app = await buildApp({ db: missingColumnsDb({ inserts: 0 }) })
  try {
    const empty = await app.inject({ method: 'POST', url: '/api/jobs/off-portal/save', payload: { jobs: [] } })
    assert.equal(empty.statusCode, 400)
    assert.equal(empty.json().code, 'invalid_items')
  } finally {
    await app.close()
  }

  const broken = await buildApp({
    db: {
      from() {
        return {
          select() {
            const q: any = { eq: () => q, limit: () => Promise.resolve({ data: null, error: { code: '57P01', message: 'terminating connection: password=hunter2' } }) }
            return q
          },
        }
      },
    },
  })
  try {
    const res = await broken.inject({ method: 'POST', url: '/api/jobs/off-portal/save', payload: { jobs: [SAVE_ITEM] } })
    assert.equal(res.statusCode, 500)
    assert.equal(res.json().code, 'off_portal_save_failed')
    assert.doesNotMatch(res.body, /hunter2/)
  } finally {
    await broken.close()
  }
})

test('save: batas lowongan privat per pengguna -> 409 private_jobs_limit_reached, tanpa insert', async () => {
  let inserts = 0
  const db = {
    from() {
      return {
        select(_cols: string, o?: { head?: boolean }) {
          const q: any = {
            eq: () => q,
            limit: () => Promise.resolve({ data: [], error: null }),
            then: (resolve: any) => resolve(o?.head ? { count: MAX_PRIVATE_OFF_PORTAL_JOBS_PER_USER, error: null } : { data: [], error: null }),
          }
          return q
        },
        insert() {
          inserts++
          return { select: () => Promise.resolve({ data: [], error: null }) }
        },
      }
    },
  }
  const direct = await savePrivateOffPortalJobs(db as any, 'user-1', [SAVE_ITEM])
  assert.equal(direct.saved, false)
  assert.equal(direct.code, 'private_jobs_limit_reached')
  assert.equal(inserts, 0)

  const app = await buildApp({ db })
  try {
    const res = await app.inject({ method: 'POST', url: '/api/jobs/off-portal/save', payload: { jobs: [SAVE_ITEM] } })
    assert.equal(res.statusCode, 409)
    assert.equal(res.json().code, 'private_jobs_limit_reached')
  } finally {
    await app.close()
  }
})

test('save: dua simpan bersamaan (23505 dari indeks unik) memakai baris yang sudah ada, bukan 500', async () => {
  const existing = { id: 'priv-1', created_by: 'user-1', visibility: 'private', title: 'Data Analyst' }
  let lookups = 0
  const db = {
    from() {
      return {
        select(_cols: string, o?: { head?: boolean }) {
          const q: any = {
            eq: () => q,
            limit: () => {
              lookups++
              // 1: cek skema, 2: cek duplikat (belum ada), 3: cek ulang sesudah 23505 (sudah ada)
              return Promise.resolve({ data: lookups >= 3 ? [existing] : [], error: null })
            },
            then: (resolve: any) => resolve(o?.head ? { count: 0, error: null } : { data: [], error: null }),
          }
          return q
        },
        insert: () => ({ select: () => Promise.resolve({ data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint "idx_jobs_private_fingerprint_unique"' } }) }),
      }
    },
  }
  const res = await savePrivateOffPortalJobs(db as any, 'user-1', [SAVE_ITEM])
  assert.equal(res.saved, true)
  assert.equal(res.insertedCount, 0)
  assert.equal(res.duplicateCount, 1)
  assert.equal(res.jobs[0].id, 'priv-1')
})

// ---------------------------------------------------------------------------
// qr-decoder: gambar buatan dan batas dimensi
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(buf: Buffer): number {
  let crc = 0xffffffff
  for (let i = 0; i < buf.length; i++) crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

/** PNG RGB 8-bit papan catur dengan kotak `cell` piksel (pola buatan yang dulu membuat pemindai macet berdetik-detik). */
function checkerPng(size: number, cell: number): Buffer {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  const stride = size * 3 + 1
  const raw = Buffer.alloc(size * stride)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const v = (Math.floor(x / cell) + Math.floor(y / cell)) % 2 === 0 ? 0 : 255
      const o = y * stride + 1 + x * 3
      raw[o] = raw[o + 1] = raw[o + 2] = v
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

test('qr-decoder: PNG papan catur 2048x2048 selesai dalam anggaran waktu (dulu ~19 detik memblokir event loop)', async () => {
  const png = checkerPng(2048, 4)
  assert.ok(png.length < 200 * 1024, 'PNG buatan kecil, jauh di bawah batas 5 MB')
  const rgba = decodePngRgba(png)
  assert.ok(rgba)
  const started = Date.now()
  const texts = decodeQrStringsFromRgba(rgba!)
  const elapsed = Date.now() - started
  assert.deepEqual(texts, [])
  // Anggaran 1 detik + sisa pembulatan satu baris; margin lebar agar tidak rapuh di mesin lambat.
  assert.ok(elapsed < QR_SCAN_BUDGET_MS + 4000, `pemindaian memakan ${elapsed} ms`)
  const res = await decodeQrUrlsFromImage(png, 'image/png')
  assert.deepEqual(res.urls, [])
})

function jpegWithSof(width: number, height: number): Buffer {
  const sof = Buffer.alloc(19)
  sof[0] = 0xff
  sof[1] = 0xc0
  sof.writeUInt16BE(17, 2)
  sof[4] = 8
  sof.writeUInt16BE(height, 5)
  sof.writeUInt16BE(width, 7)
  sof[9] = 3
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00])
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, Buffer.alloc(8)])
}

function webpHeader(kind: 'VP8X' | 'VP8L' | 'VP8 ', width: number, height: number): Buffer {
  const b = Buffer.alloc(40)
  b.write('RIFF', 0, 'ascii')
  b.writeUInt32LE(32, 4)
  b.write('WEBP', 8, 'ascii')
  b.write(kind, 12, 'ascii')
  if (kind === 'VP8X') {
    b.writeUIntLE(width - 1, 24, 3)
    b.writeUIntLE(height - 1, 27, 3)
  } else if (kind === 'VP8L') {
    b[20] = 0x2f
    b.writeUInt32LE(((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14), 21)
  } else {
    b[23] = 0x9d
    b[24] = 0x01
    b[25] = 0x2a
    b.writeUInt16LE(width, 26)
    b.writeUInt16LE(height, 28)
  }
  return b
}

test('qr-decoder: peekImageDimensions membaca header JPEG dan tiga jenis WebP; header rusak -> null', () => {
  assert.deepEqual(peekImageDimensions(jpegWithSof(3000, 4000), 'image/jpeg'), { width: 3000, height: 4000 })
  assert.deepEqual(peekImageDimensions(webpHeader('VP8X', 1200, 1600), 'image/webp'), { width: 1200, height: 1600 })
  assert.deepEqual(peekImageDimensions(webpHeader('VP8L', 1200, 1600), 'image/webp'), { width: 1200, height: 1600 })
  assert.deepEqual(peekImageDimensions(webpHeader('VP8 ', 1200, 1600), 'image/webp'), { width: 1200, height: 1600 })
  assert.equal(peekImageDimensions(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]), 'image/jpeg'), null)
  assert.equal(peekImageDimensions(Buffer.alloc(40), 'image/webp'), null)
})

test('qr-decoder: gambar JPEG/WebP raksasa atau tak terbaca tidak dibuka di Chromium', async () => {
  assert.equal(isBrowserDecodableSize(jpegWithSof(4032, 3024), 'image/jpeg'), true)
  assert.equal(isBrowserDecodableSize(jpegWithSof(60000, 60000), 'image/jpeg'), false)
  assert.equal(isBrowserDecodableSize(jpegWithSof(12000, 12000), 'image/jpeg'), false, '144 MP melebihi batas piksel')
  assert.equal(isBrowserDecodableSize(webpHeader('VP8X', 16000, 16000), 'image/webp'), false)
  assert.equal(isBrowserDecodableSize(Buffer.alloc(40), 'image/webp'), false)

  // Jalur penuh: tanpa batas dimensi ini Chromium akan dicoba; dengan batas, hasilnya kosong tanpa meluncurkan apa pun.
  const started = Date.now()
  const res = await decodeQrUrlsFromImage(jpegWithSof(60000, 60000), 'image/jpeg')
  assert.deepEqual(res.urls, [])
  assert.equal(res.method, 'none')
  assert.ok(Date.now() - started < 2000)
})
