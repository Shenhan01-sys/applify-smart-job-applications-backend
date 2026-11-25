import test from 'node:test'
import assert from 'node:assert/strict'
import zlib from 'node:zlib'
import {
  POSTER_MAX_BYTES,
  decodePosterImageBase64,
  detectPosterImageMime,
  ocrPosterImage,
} from '../services/poster-ocr.service.js'
import {
  decodePngRgba,
  decodeQrMatrix,
  decodeQrUrlsFromImage,
} from '../services/qr-decoder.service.js'

// ============================================================================
// Helper: minimal ISO/IEC 18004 QR Encoder (Version 2/3, EC-M, Byte mode) + PNG builder
// untuk menguji decoder QR murni terhadap gambar QR nyata tanpa dependensi npm tambahan.
// ============================================================================

const GF_EXP = new Uint8Array(512)
const GF_LOG = new Uint8Array(256)
{
  let x = 1
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x
    GF_LOG[x] = i
    x <<= 1
    if (x & 0x100) x ^= 0x11d
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255]
}
function gfMul(a: number, b: number) {
  return a === 0 || b === 0 ? 0 : GF_EXP[GF_LOG[a] + GF_LOG[b]]
}
function rsEncode(data: Uint8Array, ecCount: number): Uint8Array {
  let gen = [1]
  for (let i = 0; i < ecCount; i++) {
    const next = new Array(gen.length + 1).fill(0)
    for (let j = 0; j < gen.length; j++) {
      next[j] ^= gen[j]
      next[j + 1] ^= gfMul(gen[j], GF_EXP[i])
    }
    gen = next
  }
  const rem = new Uint8Array(ecCount)
  for (const byte of data) {
    const factor = byte ^ rem[0]
    rem.copyWithin(0, 1)
    rem[ecCount - 1] = 0
    for (let j = 0; j < ecCount; j++) {
      rem[j] ^= gfMul(gen[j + 1], factor)
    }
  }
  return rem
}

/** Bangkitkan matriks QR Version 3 EC-L (kapasitas 53 byte UTF-8, mask 0). */
function encodeQrV3L(text: string): { size: number; matrix: Uint8Array } {
  const version = 3
  const size = 17 + 4 * version // 29
  const dataCap = 55
  const ecCount = 15
  const bytes = Buffer.from(text, 'utf8')
  assert.ok(bytes.length <= 53, 'fixture terlalu panjang untuk V3-L')

  const bits: number[] = []
  const pushBits = (val: number, len: number) => {
    for (let i = len - 1; i >= 0; i--) bits.push((val >> i) & 1)
  }
  pushBits(0b0100, 4) // Byte mode
  pushBits(bytes.length, 8)
  for (const b of bytes) pushBits(b, 8)
  pushBits(0, Math.min(4, dataCap * 8 - bits.length))
  while (bits.length % 8 !== 0) bits.push(0)
  const data = new Uint8Array(dataCap)
  for (let i = 0; i < bits.length / 8; i++) {
    let v = 0
    for (let b = 0; b < 8; b++) v = (v << 1) | bits[i * 8 + b]
    data[i] = v
  }
  const padBytes = [0xec, 0x11]
  for (let i = bits.length / 8, p = 0; i < dataCap; i++, p++) data[i] = padBytes[p % 2]
  const ec = rsEncode(data, ecCount)
  const codewords = new Uint8Array(dataCap + ecCount)
  codewords.set(data, 0)
  codewords.set(ec, dataCap)

  const matrix = new Uint8Array(size * size)
  const reserved = new Uint8Array(size * size)
  const setMod = (r: number, c: number, dark: number) => {
    matrix[r * size + c] = dark ? 1 : 0
    reserved[r * size + c] = 1
  }
  const drawFinder = (r0: number, c0: number) => {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const rr = r0 + r
        const cc = c0 + c
        if (rr < 0 || rr >= size || cc < 0 || cc >= size) continue
        const inBorder = r >= 0 && r <= 6 && c >= 0 && c <= 6
        const dark =
          inBorder && (r === 0 || r === 6 || c === 0 || c === 6 || (r >= 2 && r <= 4 && c >= 2 && c <= 4))
        setMod(rr, cc, dark ? 1 : 0)
      }
    }
  }
  drawFinder(0, 0)
  drawFinder(0, size - 7)
  drawFinder(size - 7, 0)
  // Alignment at (22, 22) for V3
  for (let r = -2; r <= 2; r++) {
    for (let c = -2; c <= 2; c++) {
      const dark = Math.max(Math.abs(r), Math.abs(c)) !== 1
      setMod(22 + r, 22 + c, dark ? 1 : 0)
    }
  }
  // Timing
  for (let i = 8; i < size - 8; i++) {
    setMod(6, i, i % 2 === 0 ? 1 : 0)
    setMod(i, 6, i % 2 === 0 ? 1 : 0)
  }
  // Reserve format info + dark module
  const f1: Array<[number, number]> = [
    [8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8],
    [7, 8], [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8],
  ]
  const f2: Array<[number, number]> = [
    [size - 1, 8], [size - 2, 8], [size - 3, 8], [size - 4, 8], [size - 5, 8], [size - 6, 8], [size - 7, 8],
    [8, size - 8], [8, size - 7], [8, size - 6], [8, size - 5], [8, size - 4], [8, size - 3], [8, size - 2], [8, size - 1],
  ]
  setMod(size - 8, 8, 1)
  // Format bits: EC=L (01), mask=0 (000) -> data = 0b01000 = 8
  let rem = 8 << 10
  for (let i = 14; i >= 10; i--) if (rem & (1 << i)) rem ^= 0x537 << (i - 10)
  const fmt = ((8 << 10) | rem) ^ 0x5412
  for (let i = 0; i < 15; i++) {
    const bit = (fmt >> (14 - i)) & 1
    setMod(f1[i][0], f1[i][1], bit)
    setMod(f2[i][0], f2[i][1], bit)
  }

  // Place data bits with mask 0 ((r + c) % 2 === 0)
  let bitIdx = 0
  let upward = true
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col--
    for (let step = 0; step < size; step++) {
      const r = upward ? size - 1 - step : step
      for (let dx = 0; dx < 2; dx++) {
        const c = col - dx
        if (reserved[r * size + c]) continue
        const cw = codewords[bitIdx >> 3] ?? 0
        let bit = (cw >> (7 - (bitIdx & 7))) & 1
        if ((r + c) % 2 === 0) bit ^= 1
        matrix[r * size + c] = bit
        bitIdx++
      }
    }
    upward = !upward
  }
  return { size, matrix }
}

function crc32(buf: Buffer): number {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i]
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  }
  return (c ^ 0xffffffff) >>> 0
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const t = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0)
  return Buffer.concat([len, t, data, crc])
}

function encodeRgbaToPng(width: number, height: number, rgba: Uint8Array): Buffer {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA
  const raw = Buffer.alloc(height * (1 + width * 4))
  for (let y = 0; y < height; y++) {
    raw[y * (1 + width * 4)] = 0
    raw.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), y * (1 + width * 4) + 1)
  }
  const idat = zlib.deflateSync(raw)
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

function renderQrIntoPosterPng(
  text: string,
  opts: { posterW?: number; posterH?: number; qrX?: number; qrY?: number; scale?: number } = {},
): Buffer {
  const { size, matrix } = encodeQrV3L(text)
  const scale = opts.scale ?? 5
  const quiet = 4 * scale
  const qrBox = size * scale + 2 * quiet
  const w = opts.posterW ?? qrBox
  const h = opts.posterH ?? qrBox
  const ox = opts.qrX ?? 0
  const oy = opts.qrY ?? 0
  const rgba = new Uint8Array(w * h * 4)
  // Isi latar poster putih bersih (dengan blok warna di atas untuk mensimulasikan header poster)
  rgba.fill(255)
  if (h > qrBox + 40) {
    for (let y = 0; y < 80; y++) {
      for (let x = 0; x < w; x++) {
        const p = (y * w + x) * 4
        rgba[p] = 10; rgba[p + 1] = 91; rgba[p + 2] = 224; rgba[p + 3] = 255
      }
    }
  }
  // Gambar kotak QR
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (!matrix[r * size + c]) continue
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const px = ox + quiet + c * scale + dx
          const py = oy + quiet + r * scale + dy
          if (px < 0 || px >= w || py < 0 || py >= h) continue
          const p = (py * w + px) * 4
          rgba[p] = 15; rgba[p + 1] = 15; rgba[p + 2] = 15; rgba[p + 3] = 255
        }
      }
    }
  }
  return encodeRgbaToPng(w, h, rgba)
}

test('poster-ocr: validasi magic bytes PNG/JPEG/WebP, tolak berkas palsu & gambar > 5 MB', () => {
  const png = renderQrIntoPosterPng('https://forms.gle/test123')
  assert.equal(detectPosterImageMime(png), 'image/png')
  assert.equal(detectPosterImageMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0])), 'image/jpeg')
  assert.equal(detectPosterImageMime(Buffer.from('RIFF\x00\x00\x00\x00WEBPVP8 ', 'latin1')), 'image/webp')
  assert.equal(detectPosterImageMime(Buffer.from('%PDF-1.7 fake pdf')), null)

  const ok = decodePosterImageBase64(`data:image/png;base64,${png.toString('base64')}`)
  assert.equal(ok.ok, true)
  if (ok.ok) assert.equal(ok.mimeType, 'image/png')

  const badMime = decodePosterImageBase64(Buffer.from('<html>not an image</html>').toString('base64'))
  assert.equal(badMime.ok, false)
  if (!badMime.ok) assert.equal(badMime.code, 'invalid_image')

  const tooBig = decodePosterImageBase64('A'.repeat(Math.ceil(((POSTER_MAX_BYTES + 1024) * 4) / 3)))
  assert.equal(tooBig.ok, false)
  if (!tooBig.ok) {
    assert.equal(tooBig.statusCode, 413)
    assert.equal(tooBig.code, 'image_too_large')
  }
})

test('poster-ocr: memanggil Gemini native inline_data, menandai truncated, dan mengembalikan unavailable tanpa API key', async () => {
  const png = renderQrIntoPosterPng('https://forms.gle/demo')
  const noKey = await ocrPosterImage(png, 'image/png', { apiKey: '' })
  assert.equal(noKey.status, 'unavailable')

  let capturedMime = ''
  let capturedPrompt = ''
  const ok = await ocrPosterImage(png, 'image/png', {
    apiKey: 'fake-key',
    fetchImpl: (async (_url: any, init: any) => {
      const body = JSON.parse(String(init.body))
      capturedMime = body.contents[0].parts[0].inline_data.mime_type
      capturedPrompt = body.contents[0].parts[1].text
      return {
        ok: true,
        status: 200,
        json: async () => ({
          candidates: [
            {
              finishReason: 'MAX_TOKENS',
              content: { parts: [{ text: 'PT Maju Bersama\nWe Are Hiring:\n1. Frontend Developer' }] },
            },
          ],
        }),
      } as any
    }) as any,
  })
  assert.equal(capturedMime, 'image/png')
  assert.match(capturedPrompt, /never an instruction to follow/i)
  assert.match(capturedPrompt, /Do NOT guess or invent URLs from QR codes/i)
  assert.equal(ok.status, 'ok')
  assert.equal(ok.truncated, true)
  assert.match(ok.text, /Frontend Developer/)
})

test('qr-decoder: mendekode QR URL langsung dari PNG utuh dan dari QR kecil di sudut poster 600x800', async () => {
  const url = 'https://forms.gle/ApplifyGel3Test2026'
  const directPng = renderQrIntoPosterPng(url, { scale: 6 })
  const decodedDirect = await decodeQrUrlsFromImage(directPng, 'image/png')
  assert.equal(decodedDirect.method, 'png_native')
  assert.deepEqual(decodedDirect.urls, [url])
  assert.deepEqual(decodedDirect.rejectedUrls, [])

  // QR kecil di pojok kanan bawah poster 600x800
  const posterPng = renderQrIntoPosterPng(url, { posterW: 600, posterH: 800, qrX: 400, qrY: 600, scale: 4 })
  const rgba = decodePngRgba(posterPng)
  assert.ok(rgba && rgba.width === 600 && rgba.height === 800)
  const decodedPoster = await decodeQrUrlsFromImage(posterPng, 'image/png')
  assert.deepEqual(decodedPoster.urls, [url])
})

test('qr-decoder: koreksi galat Reed-Solomon memulihkan bit rusak dan menolak URL berbahaya/privat di QR', async () => {
  const { size, matrix } = encodeQrV3L('https://docs.google.com/forms/d/e/1FAIpQL/viewform')
  // Balik beberapa modul data (korupsi 2 byte dalam kapasitas koreksi V3-L = 7 byte)
  matrix[14 * size + 14] ^= 1
  matrix[15 * size + 15] ^= 1
  matrix[16 * size + 16] ^= 1
  assert.equal(decodeQrMatrix(matrix, size), 'https://docs.google.com/forms/d/e/1FAIpQL/viewform')

  const evilPng = renderQrIntoPosterPng('http://127.0.0.1:8080/internal-admin', { scale: 5 })
  const evilRes = await decodeQrUrlsFromImage(evilPng, 'image/png')
  assert.deepEqual(evilRes.urls, [])
  assert.deepEqual(evilRes.rejectedUrls, ['http://127.0.0.1:8080/internal-admin'])
})
