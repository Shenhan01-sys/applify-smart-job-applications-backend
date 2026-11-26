import zlib from 'node:zlib'
import { extractUrlsFromText, isPublicHttpUrl } from './apply-channel.js'
import { chromiumLaunchOptions } from '../mcp/shared/browser.js'
import type { PosterImageMime } from './poster-ocr.service.js'

/**
 * Decoder QR deterministik tanpa dependensi npm tambahan (26 November 2026).
 *
 * Arsitektur dua lapis:
 *   1. PNG: didekode langsung di Node.js memakai `node:zlib` (`decodePngRgba`) lalu dipindai oleh
 *      decoder QR murni ISO/IEC 18004 (Version 1–10, EC L/M/Q/H, koreksi galat Reed-Solomon GF(256),
 *      semua 8 pola mask, mode Byte/Alphanumeric/Numeric, dukungan pemindaian kuadran poster).
 *   2. JPEG / WebP: menggunakan kanvas Chromium (Playwright yang sudah terpasang di backend/Dockerfile,
 *      dibatasi 1 slot konkurensi & ditutup di finally) untuk membaca piksel RGBA lalu masuk ke decoder
 *      QR yang sama. Bila Chromium tidak tersedia, mengembalikan hasil kosong tanpa melempar galat.
 */

export const MAX_QR_IMAGE_DIMENSION = 4096
const MAX_INFLATED_BYTES = 64 * 1024 * 1024

export interface RgbaImage {
  width: number
  height: number
  data: Uint8Array
}

// ============================================================================
// 1. Pure-TS PNG RGBA Decoder (8-bit non-interlaced: Gray, RGB, Palette, GA, RGBA)
// ============================================================================

function paethPredictor(a: number, b: number, c: number): number {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  if (pa <= pb && pa <= pc) return a
  if (pb <= pc) return b
  return c
}

export function decodePngRgba(buf: Buffer): RgbaImage | null {
  if (buf.length < 33) return null
  if (
    buf[0] !== 0x89 ||
    buf[1] !== 0x50 ||
    buf[2] !== 0x4e ||
    buf[3] !== 0x47 ||
    buf[4] !== 0x0d ||
    buf[5] !== 0x0a ||
    buf[6] !== 0x1a ||
    buf[7] !== 0x0a
  ) {
    return null
  }

  let width = 0
  let height = 0
  let bitDepth = 0
  let colorType = -1
  let interlace = 0
  let palette: Buffer | null = null
  const idatChunks: Buffer[] = []

  let offset = 8
  while (offset + 12 <= buf.length) {
    const length = buf.readUInt32BE(offset)
    const type = buf.subarray(offset + 4, offset + 8).toString('ascii')
    const dataStart = offset + 8
    const dataEnd = dataStart + length
    if (dataEnd + 4 > buf.length) return null

    if (type === 'IHDR' && length >= 13) {
      width = buf.readUInt32BE(dataStart)
      height = buf.readUInt32BE(dataStart + 4)
      bitDepth = buf[dataStart + 8]
      colorType = buf[dataStart + 9]
      const compression = buf[dataStart + 10]
      const filter = buf[dataStart + 11]
      interlace = buf[dataStart + 12]
      if (
        width <= 0 ||
        height <= 0 ||
        width > MAX_QR_IMAGE_DIMENSION ||
        height > MAX_QR_IMAGE_DIMENSION ||
        compression !== 0 ||
        filter !== 0 ||
        interlace !== 0 ||
        bitDepth !== 8
      ) {
        return null
      }
    } else if (type === 'PLTE') {
      palette = buf.subarray(dataStart, dataEnd)
    } else if (type === 'IDAT') {
      idatChunks.push(buf.subarray(dataStart, dataEnd))
    } else if (type === 'IEND') {
      break
    }
    offset = dataEnd + 4
  }

  if (width === 0 || height === 0 || idatChunks.length === 0) return null

  const channels = colorType === 0 ? 1 : colorType === 2 ? 3 : colorType === 3 ? 1 : colorType === 4 ? 2 : colorType === 6 ? 4 : 0
  if (channels === 0) return null
  if (colorType === 3 && !palette) return null

  let inflated: Buffer
  try {
    inflated = zlib.inflateSync(Buffer.concat(idatChunks), { maxOutputLength: MAX_INFLATED_BYTES })
  } catch {
    return null
  }

  const stride = width * channels
  if (inflated.length < height * (stride + 1)) return null

  const recon = new Uint8Array(height * stride)
  const bpp = channels
  for (let y = 0; y < height; y++) {
    const filterType = inflated[y * (stride + 1)]
    const srcOff = y * (stride + 1) + 1
    const dstOff = y * stride
    for (let x = 0; x < stride; x++) {
      const raw = inflated[srcOff + x]
      const a = x >= bpp ? recon[dstOff + x - bpp] : 0
      const b = y > 0 ? recon[dstOff - stride + x] : 0
      const c = x >= bpp && y > 0 ? recon[dstOff - stride + x - bpp] : 0
      let val = raw
      if (filterType === 1) val = (raw + a) & 0xff
      else if (filterType === 2) val = (raw + b) & 0xff
      else if (filterType === 3) val = (raw + ((a + b) >> 1)) & 0xff
      else if (filterType === 4) val = (raw + paethPredictor(a, b, c)) & 0xff
      else if (filterType !== 0) return null
      recon[dstOff + x] = val
    }
  }

  const rgba = new Uint8Array(width * height * 4)
  for (let i = 0, p = 0; i < width * height; i++, p += 4) {
    if (colorType === 6) {
      rgba[p] = recon[p]
      rgba[p + 1] = recon[p + 1]
      rgba[p + 2] = recon[p + 2]
      rgba[p + 3] = recon[p + 3]
    } else if (colorType === 2) {
      const s = i * 3
      rgba[p] = recon[s]
      rgba[p + 1] = recon[s + 1]
      rgba[p + 2] = recon[s + 2]
      rgba[p + 3] = 255
    } else if (colorType === 0) {
      const g = recon[i]
      rgba[p] = g
      rgba[p + 1] = g
      rgba[p + 2] = g
      rgba[p + 3] = 255
    } else if (colorType === 4) {
      const g = recon[i * 2]
      rgba[p] = g
      rgba[p + 1] = g
      rgba[p + 2] = g
      rgba[p + 3] = recon[i * 2 + 1]
    } else if (colorType === 3 && palette) {
      const idx = recon[i] * 3
      rgba[p] = palette[idx] ?? 0
      rgba[p + 1] = palette[idx + 1] ?? 0
      rgba[p + 2] = palette[idx + 2] ?? 0
      rgba[p + 3] = 255
    }
  }

  return { width, height, data: rgba }
}

// ============================================================================
// 2. GF(256) Reed-Solomon Error Correction (primitive polynomial 0x11d)
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

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0
  return GF_EXP[GF_LOG[a] + GF_LOG[b]]
}

function gfInv(a: number): number {
  if (a === 0) return 0
  return GF_EXP[255 - GF_LOG[a]]
}

function rsCorrectBlock(codewords: Uint8Array, ecCount: number): Uint8Array | null {
  const n = codewords.length
  const dataLen = n - ecCount
  if (dataLen <= 0) return null

  const msg = new Uint8Array(codewords)
  const syndromes = new Uint8Array(ecCount)
  let hasError = false
  for (let i = 0; i < ecCount; i++) {
    let evalVal = 0
    for (let j = 0; j < n; j++) {
      evalVal = gfMul(evalVal, GF_EXP[i]) ^ msg[j]
    }
    syndromes[i] = evalVal
    if (evalVal !== 0) hasError = true
  }
  if (!hasError) return msg.subarray(0, dataLen)

  // Berlekamp-Massey algorithm
  let errLoc = [1]
  let oldLoc = [1]
  for (let i = 0; i < ecCount; i++) {
    let delta = syndromes[i]
    for (let j = 1; j < errLoc.length; j++) {
      delta ^= gfMul(errLoc[errLoc.length - 1 - j], syndromes[i - j])
    }
    oldLoc.push(0)
    if (delta !== 0) {
      if (oldLoc.length > errLoc.length) {
        const newLoc = oldLoc.map((c) => gfMul(c, delta))
        oldLoc = errLoc.map((c) => gfMul(c, gfInv(delta)))
        errLoc = newLoc
      }
      const scale = delta
      const diff = errLoc.length - oldLoc.length
      for (let j = 0; j < oldLoc.length; j++) {
        errLoc[j + diff] ^= gfMul(oldLoc[j], scale)
      }
    }
  }
  while (errLoc.length > 0 && errLoc[0] === 0) errLoc.shift()
  const errCount = errLoc.length - 1
  if (errCount <= 0 || errCount * 2 > ecCount) return null

  // Chien search: find error powers p in 0..n-1 where Lambda(alpha^-p) = 0
  const revLoc = [...errLoc].reverse() // revLoc[0] = 1 (constant term)
  const errPowers: number[] = []
  for (let power = 0; power < n; power++) {
    const xInv = GF_EXP[(255 - power) % 255]
    let acc = 0
    let xPow = 1
    for (let j = 0; j < revLoc.length; j++) {
      acc ^= gfMul(revLoc[j], xPow)
      xPow = gfMul(xPow, xInv)
    }
    if (acc === 0) errPowers.push(power)
  }
  if (errPowers.length !== errCount) return null

  // Forney algorithm: Omega(z) = S(z) * Lambda(z) mod z^ecCount; for b=0, e = X * Omega(X^-1) / Lambda'(X^-1)
  const omega = new Uint8Array(ecCount)
  for (let i = 0; i < ecCount; i++) {
    let sum = 0
    for (let j = 0; j < revLoc.length && j <= i; j++) {
      sum ^= gfMul(revLoc[j], syndromes[i - j])
    }
    omega[i] = sum
  }

  for (const power of errPowers) {
    const pos = n - 1 - power
    const xVal = GF_EXP[power % 255]
    const xInv = GF_EXP[(255 - power) % 255]
    // Evaluate Omega(xInv)
    let num = 0
    let xPow = 1
    for (let i = 0; i < ecCount; i++) {
      num ^= gfMul(omega[i], xPow)
      xPow = gfMul(xPow, xInv)
    }
    // Formal derivative Lambda'(xInv) in GF(2^8): odd terms revLoc[1] + revLoc[3]*xInv^2 + ...
    let den = 0
    let xOdd = 1
    const xInv2 = gfMul(xInv, xInv)
    for (let i = 1; i < revLoc.length; i += 2) {
      den ^= gfMul(revLoc[i], xOdd)
      xOdd = gfMul(xOdd, xInv2)
    }
    if (den === 0) return null
    const mag = gfMul(xVal, gfMul(num, gfInv(den)))
    msg[pos] ^= mag
  }

  // Re-verify syndromes = 0
  for (let i = 0; i < ecCount; i++) {
    let evalVal = 0
    for (let j = 0; j < n; j++) {
      evalVal = gfMul(evalVal, GF_EXP[i]) ^ msg[j]
    }
    if (evalVal !== 0) return null
  }
  return msg.subarray(0, dataLen)
}

// ============================================================================
// 3. QR Tables (Versions 1..10, EC levels: 0=M, 1=L, 2=H, 3=Q per format bits)
// ============================================================================

interface EcSpec {
  ecPerBlock: number
  blocks: Array<[count: number, dataCodewords: number]>
}

// Keyed by version (1..10), then format EC bits (1=L, 0=M, 3=Q, 2=H)
const QR_EC_TABLE: Record<number, Record<number, EcSpec>> = {
  1: {
    1: { ecPerBlock: 7, blocks: [[1, 19]] },
    0: { ecPerBlock: 10, blocks: [[1, 16]] },
    3: { ecPerBlock: 13, blocks: [[1, 13]] },
    2: { ecPerBlock: 17, blocks: [[1, 9]] },
  },
  2: {
    1: { ecPerBlock: 10, blocks: [[1, 34]] },
    0: { ecPerBlock: 16, blocks: [[1, 28]] },
    3: { ecPerBlock: 22, blocks: [[1, 22]] },
    2: { ecPerBlock: 28, blocks: [[1, 16]] },
  },
  3: {
    1: { ecPerBlock: 15, blocks: [[1, 55]] },
    0: { ecPerBlock: 26, blocks: [[1, 44]] },
    3: { ecPerBlock: 18, blocks: [[2, 17]] },
    2: { ecPerBlock: 22, blocks: [[2, 13]] },
  },
  4: {
    1: { ecPerBlock: 20, blocks: [[1, 80]] },
    0: { ecPerBlock: 18, blocks: [[2, 32]] },
    3: { ecPerBlock: 26, blocks: [[2, 24]] },
    2: { ecPerBlock: 16, blocks: [[4, 9]] },
  },
  5: {
    1: { ecPerBlock: 26, blocks: [[1, 108]] },
    0: { ecPerBlock: 24, blocks: [[2, 43]] },
    3: { ecPerBlock: 18, blocks: [[2, 15], [2, 16]] },
    2: { ecPerBlock: 22, blocks: [[2, 11], [2, 12]] },
  },
  6: {
    1: { ecPerBlock: 18, blocks: [[2, 68]] },
    0: { ecPerBlock: 16, blocks: [[4, 27]] },
    3: { ecPerBlock: 24, blocks: [[4, 19]] },
    2: { ecPerBlock: 28, blocks: [[4, 15]] },
  },
  7: {
    1: { ecPerBlock: 20, blocks: [[2, 78]] },
    0: { ecPerBlock: 18, blocks: [[4, 31]] },
    3: { ecPerBlock: 18, blocks: [[2, 14], [4, 15]] },
    2: { ecPerBlock: 26, blocks: [[4, 13], [1, 14]] },
  },
  8: {
    1: { ecPerBlock: 24, blocks: [[2, 97]] },
    0: { ecPerBlock: 22, blocks: [[2, 38], [2, 39]] },
    3: { ecPerBlock: 22, blocks: [[4, 18], [2, 19]] },
    2: { ecPerBlock: 26, blocks: [[4, 14], [2, 15]] },
  },
  9: {
    1: { ecPerBlock: 30, blocks: [[2, 116]] },
    0: { ecPerBlock: 22, blocks: [[3, 36], [2, 37]] },
    3: { ecPerBlock: 20, blocks: [[4, 16], [4, 17]] },
    2: { ecPerBlock: 24, blocks: [[4, 12], [4, 13]] },
  },
  10: {
    1: { ecPerBlock: 18, blocks: [[2, 68], [2, 69]] },
    0: { ecPerBlock: 26, blocks: [[4, 43], [1, 44]] },
    3: { ecPerBlock: 24, blocks: [[6, 19], [2, 20]] },
    2: { ecPerBlock: 28, blocks: [[6, 15], [2, 16]] },
  },
}

const ALIGNMENT_CENTERS: Record<number, number[]> = {
  1: [],
  2: [6, 18],
  3: [6, 22],
  4: [6, 26],
  5: [6, 30],
  6: [6, 34],
  7: [6, 22, 38],
  8: [6, 24, 42],
  9: [6, 26, 46],
  10: [6, 28, 50],
}

// 32 valid 15-bit format strings (already XORed with 0x5412), indexed by 5-bit data (ec<<3 | mask)
const FORMAT_MASK = 0x5412
const VALID_FORMAT_CODES: number[] = Array.from({ length: 32 }, (_, data) => {
  let rem = data << 10
  for (let i = 14; i >= 10; i--) {
    if (rem & (1 << i)) rem ^= 0x537 << (i - 10)
  }
  return ((data << 10) | rem) ^ FORMAT_MASK
})

function popcount15(n: number): number {
  let c = 0
  let v = n & 0x7fff
  while (v) {
    v &= v - 1
    c++
  }
  return c
}

function decodeFormatInfo(raw1: number, raw2: number): { ecBits: number; mask: number } | null {
  let bestDist = 4
  let bestIdx = -1
  for (let i = 0; i < 32; i++) {
    const code = VALID_FORMAT_CODES[i]
    const d1 = popcount15(raw1 ^ code)
    const d2 = popcount15(raw2 ^ code)
    const d = Math.min(d1, d2)
    if (d < bestDist) {
      bestDist = d
      bestIdx = i
    }
  }
  if (bestIdx < 0) return null
  return { ecBits: (bestIdx >> 3) & 3, mask: bestIdx & 7 }
}

function applyMaskBit(mask: number, r: number, c: number): boolean {
  switch (mask) {
    case 0: return (r + c) % 2 === 0
    case 1: return r % 2 === 0
    case 2: return c % 3 === 0
    case 3: return (r + c) % 3 === 0
    case 4: return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0
    case 5: return ((r * c) % 2) + ((r * c) % 3) === 0
    case 6: return (((r * c) % 2) + ((r * c) % 3)) % 2 === 0
    case 7: return (((r + c) % 2) + ((r * c) % 3)) % 2 === 0
    default: return false
  }
}

function buildFunctionMask(version: number, size: number): Uint8Array {
  const fn = new Uint8Array(size * size)
  const markRect = (r0: number, c0: number, h: number, w: number) => {
    for (let r = Math.max(0, r0); r < Math.min(size, r0 + h); r++) {
      for (let c = Math.max(0, c0); c < Math.min(size, c0 + w); c++) {
        fn[r * size + c] = 1
      }
    }
  }
  // Finders + separators + format info areas
  markRect(0, 0, 9, 9)
  markRect(0, size - 8, 9, 8)
  markRect(size - 8, 0, 8, 9)
  // Timing patterns
  for (let i = 0; i < size; i++) {
    fn[6 * size + i] = 1
    fn[i * size + 6] = 1
  }
  // Alignment patterns
  const centers = ALIGNMENT_CENTERS[version] ?? []
  for (const cr of centers) {
    for (const cc of centers) {
      if ((cr <= 8 && cc <= 8) || (cr <= 8 && cc >= size - 9) || (cr >= size - 9 && cc <= 8)) continue
      markRect(cr - 2, cc - 2, 5, 5)
    }
  }
  // Version info (version >= 7)
  if (version >= 7) {
    markRect(0, size - 11, 6, 3)
    markRect(size - 11, 0, 3, 6)
  }
  return fn
}

const ALPHANUMERIC_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:'

function decodeDataBitstream(bytes: Uint8Array, version: number): string | null {
  let bitPos = 0
  const totalBits = bytes.length * 8
  const readBits = (count: number): number | null => {
    if (bitPos + count > totalBits) return null
    let v = 0
    for (let i = 0; i < count; i++) {
      const byteIdx = bitPos >> 3
      const bitIdx = 7 - (bitPos & 7)
      v = (v << 1) | ((bytes[byteIdx] >> bitIdx) & 1)
      bitPos++
    }
    return v
  }

  const outBytes: number[] = []
  while (bitPos + 4 <= totalBits) {
    const mode = readBits(4)
    if (mode === null || mode === 0) break
    if (mode === 4) {
      // Byte mode
      const lenBits = version <= 9 ? 8 : 16
      const count = readBits(lenBits)
      if (count === null) return null
      for (let i = 0; i < count; i++) {
        const b = readBits(8)
        if (b === null) return null
        outBytes.push(b)
      }
    } else if (mode === 2) {
      // Alphanumeric mode
      const lenBits = version <= 9 ? 9 : 11
      const count = readBits(lenBits)
      if (count === null) return null
      let rem = count
      while (rem >= 2) {
        const pair = readBits(11)
        if (pair === null) return null
        const c1 = ALPHANUMERIC_CHARS[Math.floor(pair / 45)]
        const c2 = ALPHANUMERIC_CHARS[pair % 45]
        if (!c1 || !c2) return null
        outBytes.push(c1.charCodeAt(0), c2.charCodeAt(0))
        rem -= 2
      }
      if (rem === 1) {
        const single = readBits(6)
        if (single === null || !ALPHANUMERIC_CHARS[single]) return null
        outBytes.push(ALPHANUMERIC_CHARS[single].charCodeAt(0))
      }
    } else if (mode === 1) {
      // Numeric mode
      const lenBits = version <= 9 ? 10 : 12
      const count = readBits(lenBits)
      if (count === null) return null
      let rem = count
      while (rem >= 3) {
        const v = readBits(10)
        if (v === null || v >= 1000) return null
        for (const ch of String(v).padStart(3, '0')) outBytes.push(ch.charCodeAt(0))
        rem -= 3
      }
      if (rem === 2) {
        const v = readBits(7)
        if (v === null || v >= 100) return null
        for (const ch of String(v).padStart(2, '0')) outBytes.push(ch.charCodeAt(0))
      } else if (rem === 1) {
        const v = readBits(4)
        if (v === null || v >= 10) return null
        outBytes.push(String(v).charCodeAt(0))
      }
    } else if (mode === 7) {
      // ECI assignment: skip 1 byte assignment number (UTF-8 = 26)
      const eci = readBits(8)
      if (eci === null) return null
    } else {
      return null
    }
  }

  if (outBytes.length === 0) return null
  return Buffer.from(outBytes).toString('utf8').trim() || null
}

/** Dekode matriks modul biner `size x size` (1=gelap, 0=terang) yang sudah berorientasi normal. */
export function decodeQrMatrix(matrix: Uint8Array, size: number): string | null {
  const version = (size - 17) / 4
  if (!Number.isInteger(version) || version < 1 || version > 10) return null
  const ecTable = QR_EC_TABLE[version]
  if (!ecTable) return null

  const bitAt = (r: number, c: number) => matrix[r * size + c] & 1

  // Read copy 1 of format info (MSB first: bits 14..0)
  const f1Coords: Array<[number, number]> = [
    [8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8],
    [7, 8], [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8],
  ]
  const f2Coords: Array<[number, number]> = [
    [size - 1, 8], [size - 2, 8], [size - 3, 8], [size - 4, 8], [size - 5, 8], [size - 6, 8], [size - 7, 8],
    [8, size - 8], [8, size - 7], [8, size - 6], [8, size - 5], [8, size - 4], [8, size - 3], [8, size - 2], [8, size - 1],
  ]
  let raw1 = 0
  let raw2 = 0
  for (let i = 0; i < 15; i++) {
    raw1 = (raw1 << 1) | bitAt(f1Coords[i][0], f1Coords[i][1])
    raw2 = (raw2 << 1) | bitAt(f2Coords[i][0], f2Coords[i][1])
  }
  const fmt = decodeFormatInfo(raw1, raw2)
  if (!fmt) return null
  const spec = ecTable[fmt.ecBits]
  if (!spec) return null

  const fnMask = buildFunctionMask(version, size)
  const rawCodewords: number[] = []
  let currentByte = 0
  let bitsInByte = 0
  let upward = true

  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col-- // Skip vertical timing column
    for (let step = 0; step < size; step++) {
      const r = upward ? size - 1 - step : step
      for (let dx = 0; dx < 2; dx++) {
        const c = col - dx
        if (fnMask[r * size + c]) continue
        let bit = bitAt(r, c)
        if (applyMaskBit(fmt.mask, r, c)) bit ^= 1
        currentByte = (currentByte << 1) | bit
        bitsInByte++
        if (bitsInByte === 8) {
          rawCodewords.push(currentByte)
          currentByte = 0
          bitsInByte = 0
        }
      }
    }
    upward = !upward
  }

  // De-interleave blocks
  const blockSpecs: number[] = []
  for (const [count, dataLen] of spec.blocks) {
    for (let i = 0; i < count; i++) blockSpecs.push(dataLen)
  }
  const numBlocks = blockSpecs.length
  const totalData = blockSpecs.reduce((a, b) => a + b, 0)
  const totalExpected = totalData + numBlocks * spec.ecPerBlock
  if (rawCodewords.length < totalExpected) return null

  const blocks = blockSpecs.map((dLen) => new Uint8Array(dLen + spec.ecPerBlock))
  const maxDataLen = Math.max(...blockSpecs)
  let ptr = 0
  for (let col = 0; col < maxDataLen; col++) {
    for (let b = 0; b < numBlocks; b++) {
      if (col < blockSpecs[b]) blocks[b][col] = rawCodewords[ptr++]
    }
  }
  for (let col = 0; col < spec.ecPerBlock; col++) {
    for (let b = 0; b < numBlocks; b++) {
      blocks[b][blockSpecs[b] + col] = rawCodewords[ptr++]
    }
  }

  const correctedData = new Uint8Array(totalData)
  let outOff = 0
  for (let b = 0; b < numBlocks; b++) {
    const corrected = rsCorrectBlock(blocks[b], spec.ecPerBlock)
    if (!corrected) return null
    correctedData.set(corrected, outOff)
    outOff += corrected.length
  }

  return decodeDataBitstream(correctedData, version)
}

// ============================================================================
// 4. Finder Pattern Localization & Grid Sampling on Grayscale / RGBA Images
// ============================================================================

interface FinderCenter {
  x: number
  y: number
  moduleSize: number
  count: number
}

function matchesFinderRatio(counts: number[]): number {
  const total = counts[0] + counts[1] + counts[2] + counts[3] + counts[4]
  if (total < 7) return 0
  const unit = total / 7
  const maxVar = unit * 0.55
  if (
    Math.abs(counts[0] - unit) < maxVar &&
    Math.abs(counts[1] - unit) < maxVar &&
    Math.abs(counts[2] - 3 * unit) < 3 * maxVar &&
    Math.abs(counts[3] - unit) < maxVar &&
    Math.abs(counts[4] - unit) < maxVar
  ) {
    return unit
  }
  return 0
}

function verifyVerticalFinder(
  bin: Uint8Array,
  w: number,
  h: number,
  cx: number,
  cy: number,
  expectedUnit: number,
): { y: number; unit: number } | null {
  const ix = Math.round(cx)
  const iy = Math.round(cy)
  if (ix < 0 || ix >= w || iy < 0 || iy >= h || bin[iy * w + ix] !== 1) return null

  // Satu run di kolom ini tidak mungkin lebih panjang dari beberapa modul. Dibatasi supaya gambar buatan
  // (garis vertikal panjang) tidak membuat tiap kandidat menelusuri seluruh tinggi gambar.
  const maxRun = Math.ceil(expectedUnit * 5) + 2
  let y = iy
  let overflow = false
  const run = (step: 1 | -1, color: 0 | 1): number => {
    let n = 0
    while (y >= 0 && y < h && bin[y * w + ix] === color && n <= maxRun) {
      n++
      y += step
    }
    if (n > maxRun) overflow = true
    return n
  }

  const counts = [0, 0, 0, 0, 0]
  // Walk up from center black
  counts[2] += run(-1, 1)
  counts[1] += run(-1, 0)
  counts[0] += run(-1, 1)
  // Walk down from center black
  y = iy + 1
  counts[2] += run(1, 1)
  counts[3] += run(1, 0)
  counts[4] += run(1, 1)
  if (overflow) return null

  const unit = matchesFinderRatio(counts)
  if (unit <= 0) return null
  if (Math.abs(unit - expectedUnit) > Math.max(1.5, expectedUnit * 0.45)) return null
  const centerY = y - counts[4] - counts[3] - counts[2] / 2
  return { y: centerY, unit }
}

function binarizeRegion(rgba: Uint8Array, imgW: number, rx: number, ry: number, rw: number, rh: number): Uint8Array {
  const gray = new Uint8Array(rw * rh)
  let minL = 255
  let maxL = 0
  for (let y = 0; y < rh; y++) {
    for (let x = 0; x < rw; x++) {
      const p = ((ry + y) * imgW + (rx + x)) * 4
      const a = rgba[p + 3] / 255
      // Composite transparent pixels over white background
      const r = rgba[p] * a + 255 * (1 - a)
      const g = rgba[p + 1] * a + 255 * (1 - a)
      const b = rgba[p + 2] * a + 255 * (1 - a)
      const lum = Math.round(0.299 * r + 0.587 * g + 0.114 * b)
      gray[y * rw + x] = lum
      if (lum < minL) minL = lum
      if (lum > maxL) maxL = lum
    }
  }
  const thresh = Math.round((minL + maxL) / 2)
  const bin = new Uint8Array(rw * rh)
  for (let i = 0; i < gray.length; i++) {
    bin[i] = gray[i] < thresh ? 1 : 0
  }
  return bin
}

/** Batas kandidat pusat finder yang disimpan. Pola kotak-kotak buatan bisa menghasilkan ratusan ribu kecocokan. */
const MAX_FINDER_CANDIDATES = 64
/** Anggaran waktu pemindaian QR per gambar (ms). Poster asli selesai dalam puluhan milidetik. */
export const QR_SCAN_BUDGET_MS = 1000

/** Tambah kandidat; bila penuh, buang kandidat dengan hitungan terendah (finder asli terkumpul di banyak baris). */
function addFinderCandidate(centers: FinderCenter[], cand: FinderCenter): void {
  if (centers.length < MAX_FINDER_CANDIDATES) {
    centers.push(cand)
    return
  }
  let lowest = 0
  for (let i = 1; i < centers.length; i++) if (centers[i].count < centers[lowest].count) lowest = i
  if (centers[lowest].count <= cand.count) centers[lowest] = cand
}

function findFinderCenters(bin: Uint8Array, w: number, h: number, deadline: number): FinderCenter[] {
  const centers: FinderCenter[] = []
  const rowStep = h > 500 ? 2 : 1

  for (let y = 0; y < h; y += rowStep) {
    // Cadangan terakhir: gambar buatan tidak boleh menahan proses lebih lama dari anggaran waktu.
    if (Date.now() > deadline) break
    const counts = [0, 0, 0, 0, 0]
    let state = 0
    for (let x = 0; x < w; x++) {
      const dark = bin[y * w + x] === 1
      if (dark) {
        if (state % 2 === 1) state++
        counts[state]++
      } else {
        if (state % 2 === 0) {
          if (state === 4) {
            const unit = matchesFinderRatio(counts)
            if (unit > 0) {
              const cx = x - counts[4] - counts[3] - counts[2] / 2
              const v = verifyVerticalFinder(bin, w, h, cx, y, unit)
              if (v) {
                const mod = (unit + v.unit) / 2
                let merged = false
                for (const fc of centers) {
                  if (Math.hypot(fc.x - cx, fc.y - v.y) <= Math.max(8, mod * 3.5)) {
                    const n = fc.count + 1
                    fc.x = (fc.x * fc.count + cx) / n
                    fc.y = (fc.y * fc.count + v.y) / n
                    fc.moduleSize = (fc.moduleSize * fc.count + mod) / n
                    fc.count = n
                    merged = true
                    break
                  }
                }
                if (!merged) addFinderCandidate(centers, { x: cx, y: v.y, moduleSize: mod, count: 1 })
              }
            }
            counts[0] = counts[2]
            counts[1] = counts[3]
            counts[2] = counts[4]
            counts[3] = 1
            counts[4] = 0
            state = 3
          } else {
            state++
            counts[state]++
          }
        } else {
          counts[state]++
        }
      }
    }
    if (state === 4) {
      const unit = matchesFinderRatio(counts)
      if (unit > 0) {
        const cx = w - counts[4] - counts[3] - counts[2] / 2
        const v = verifyVerticalFinder(bin, w, h, cx, y, unit)
        if (v) {
          const mod = (unit + v.unit) / 2
          addFinderCandidate(centers, { x: cx, y: v.y, moduleSize: mod, count: 1 })
        }
      }
    }
  }

  return centers.sort((a, b) => b.count - a.count).slice(0, 12)
}

function tryDecodeFromThreeFinders(bin: Uint8Array, w: number, h: number, trio: [FinderCenter, FinderCenter, FinderCenter]): string | null {
  // Determine which point is TL (vertex opposite longest hypotenuse)
  const d01 = Math.hypot(trio[0].x - trio[1].x, trio[0].y - trio[1].y)
  const d12 = Math.hypot(trio[1].x - trio[2].x, trio[1].y - trio[2].y)
  const d02 = Math.hypot(trio[0].x - trio[2].x, trio[0].y - trio[2].y)

  let tl: FinderCenter
  let pA: FinderCenter
  let pB: FinderCenter
  if (d12 >= d01 && d12 >= d02) {
    tl = trio[0]; pA = trio[1]; pB = trio[2]
  } else if (d02 >= d01 && d02 >= d12) {
    tl = trio[1]; pA = trio[0]; pB = trio[2]
  } else {
    tl = trio[2]; pA = trio[0]; pB = trio[1]
  }

  // Cross product determines TR vs BL: in screen coords (x right, y down), (TR - TL) x (BL - TL) > 0
  const cross = (pA.x - tl.x) * (pB.y - tl.y) - (pA.y - tl.y) * (pB.x - tl.x)
  const tr = cross > 0 ? pA : pB
  const bl = cross > 0 ? pB : pA

  const legX = Math.hypot(tr.x - tl.x, tr.y - tl.y)
  const legY = Math.hypot(bl.x - tl.x, bl.y - tl.y)
  if (legX < 14 || legY < 14) return null
  const ratio = legX / legY
  if (ratio < 0.75 || ratio > 1.33) return null

  const avgMod = (tl.moduleSize + tr.moduleSize + bl.moduleSize) / 3
  const estDim = Math.round((legX + legY) / (2 * avgMod)) + 7
  const baseVersion = Math.max(1, Math.min(10, Math.round((estDim - 17) / 4)))

  // Try nearest version and +/- 1 in case of slight module-size rounding drift
  const versions = [baseVersion, baseVersion - 1, baseVersion + 1].filter((v, i, a) => v >= 1 && v <= 10 && a.indexOf(v) === i)

  for (const v of versions) {
    const size = 17 + 4 * v
    const span = size - 7
    const ux = (tr.x - tl.x) / span
    const uy = (tr.y - tl.y) / span
    const vx = (bl.x - tl.x) / span
    const vy = (bl.y - tl.y) / span

    const matrix = new Uint8Array(size * size)
    let outOfBounds = false
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        const sx = Math.round(tl.x + (c - 3) * ux + (r - 3) * vx)
        const sy = Math.round(tl.y + (c - 3) * uy + (r - 3) * vy)
        if (sx < 0 || sx >= w || sy < 0 || sy >= h) {
          outOfBounds = true
          break
        }
        matrix[r * size + c] = bin[sy * w + sx]
      }
      if (outOfBounds) break
    }
    if (outOfBounds) continue

    const decoded = decodeQrMatrix(matrix, size)
    if (decoded) return decoded
  }
  return null
}

/** Memindai seluruh gambar RGBA dan sub-wilayah (4 kuadran + tengah) untuk mendeteksi 0..N kode QR. */
export function decodeQrStringsFromRgba(image: RgbaImage): string[] {
  const { width, height, data } = image
  if (width < 21 || height < 21 || data.length < width * height * 4) return []

  const regions: Array<[number, number, number, number]> = [[0, 0, width, height]]
  if (width >= 200 && height >= 200) {
    const hw = Math.floor(width / 2)
    const hh = Math.floor(height / 2)
    // 4 kuadran dengan sedikit overlap agar QR di dekat garis tengah tetap utuh
    const ow = Math.min(hw, Math.floor(width * 0.6))
    const oh = Math.min(hh, Math.floor(height * 0.6))
    regions.push(
      [0, 0, ow, oh],
      [width - ow, 0, ow, oh],
      [0, height - oh, ow, oh],
      [width - ow, height - oh, ow, oh],
    )
  }

  const found = new Set<string>()
  const deadline = Date.now() + QR_SCAN_BUDGET_MS
  for (const [rx, ry, rw, rh] of regions) {
    if (Date.now() > deadline) break
    const bin = binarizeRegion(data, width, rx, ry, rw, rh)
    const centers = findFinderCenters(bin, rw, rh, deadline)
    if (centers.length < 3) continue
    for (let i = 0; i < centers.length && i < 8; i++) {
      for (let j = i + 1; j < centers.length && j < 8; j++) {
        for (let k = j + 1; k < centers.length && k < 8; k++) {
          const text = tryDecodeFromThreeFinders(bin, rw, rh, [centers[i], centers[j], centers[k]])
          if (text) found.add(text)
        }
      }
    }
    if (found.size > 0 && rx === 0 && ry === 0 && rw === width && rh === height) {
      // Sudah dapat hasil dari gambar utuh; lanjutkan kuadran hanya bila gambar besar berpotensi punya QR lain.
      if (width < 400 && height < 400) break
    }
  }
  return [...found]
}

// ============================================================================
// 5. Optional Chromium Canvas Fallback for JPEG / WebP (concurrency capped to 1)
// ============================================================================

let activeQrBrowser = 0
const qrBrowserQueue: Array<() => void> = []
/** Antrean tunggu Chromium dibatasi: permintaan ke-(N+1) langsung dilewati (hasil QR kosong) alih-alih menumpuk gambar 5 MB di memori. */
export const MAX_QR_BROWSER_WAITING = 2
/** Batas waktu total satu dekode lewat Chromium (peluncuran + render + pembacaan piksel). */
export const QR_BROWSER_TIMEOUT_MS = 20_000
/** Batas dimensi gambar JPEG/WebP yang boleh dibuka Chromium (hindari gambar raksasa yang memboroskan memori). */
export const MAX_QR_BROWSER_SIDE = 12_000
export const MAX_QR_BROWSER_PIXELS = 50_000_000

async function withQrBrowserSlot<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  if (activeQrBrowser >= 1) {
    if (qrBrowserQueue.length >= MAX_QR_BROWSER_WAITING) return fallback
    await new Promise<void>((resolve) => qrBrowserQueue.push(resolve))
  }
  activeQrBrowser++
  try {
    return await fn()
  } finally {
    activeQrBrowser--
    const next = qrBrowserQueue.shift()
    if (next) next()
  }
}

/**
 * Baca lebar x tinggi dari header JPEG atau WebP tanpa mendekode piksel. null bila header tidak bisa dibaca
 * (gambar seperti itu tidak dibuka di Chromium).
 */
export function peekImageDimensions(buf: Buffer, mimeType: PosterImageMime): { width: number; height: number } | null {
  try {
    if (mimeType === 'image/jpeg') {
      let off = 2
      while (off + 9 < buf.length) {
        if (buf[off] !== 0xff) {
          off++
          continue
        }
        const marker = buf[off + 1]
        if (marker === 0xff) {
          off++
          continue
        }
        if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
          off += 2
          continue
        }
        const len = buf.readUInt16BE(off + 2)
        const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
        if (isSof) return { height: buf.readUInt16BE(off + 5), width: buf.readUInt16BE(off + 7) }
        if (len < 2) return null
        off += 2 + len
      }
      return null
    }
    if (mimeType === 'image/webp') {
      const kind = buf.subarray(12, 16).toString('ascii')
      if (kind === 'VP8X' && buf.length >= 30) return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) }
      if (kind === 'VP8L' && buf.length >= 25 && buf[20] === 0x2f) {
        const bits = buf.readUInt32LE(21)
        return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >>> 14) & 0x3fff) }
      }
      if (kind === 'VP8 ' && buf.length >= 30 && buf[23] === 0x9d && buf[24] === 0x01 && buf[25] === 0x2a) {
        return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff }
      }
      return null
    }
  } catch {
    return null
  }
  return null
}

export function isBrowserDecodableSize(buf: Buffer, mimeType: PosterImageMime): boolean {
  const dim = peekImageDimensions(buf, mimeType)
  if (!dim || dim.width < 1 || dim.height < 1) return false
  return dim.width <= MAX_QR_BROWSER_SIDE && dim.height <= MAX_QR_BROWSER_SIDE && dim.width * dim.height <= MAX_QR_BROWSER_PIXELS
}

async function decodeNonPngViaChromium(buffer: Buffer, mimeType: PosterImageMime): Promise<string[]> {
  if (process.env.QR_BROWSER_DECODER === 'false') return []
  if (!isBrowserDecodableSize(buffer, mimeType)) return []
  return withQrBrowserSlot(async () => {
    let browser: any = null
    try {
      const { chromium } = await import('playwright')
      browser = await chromium.launch(chromiumLaunchOptions({ headless: true, timeout: QR_BROWSER_TIMEOUT_MS }))
      const context = await browser.newContext()
      const page = await context.newPage()
      const dataUrl = `data:${mimeType};base64,${buffer.toString('base64')}`
      const evaluation = page.evaluate(async (src: string) => {
        const img = new Image()
        img.src = src
        await new Promise<void>((resolve, reject) => {
          img.onload = () => resolve()
          img.onerror = () => reject(new Error('img load failed'))
        })
        const scale = Math.min(1, 1400 / Math.max(img.naturalWidth || 1, img.naturalHeight || 1))
        const w = Math.max(1, Math.round(img.naturalWidth * scale))
        const h = Math.max(1, Math.round(img.naturalHeight * scale))
        const canvas = document.createElement('canvas')
        canvas.width = w
        canvas.height = h
        const ctx = canvas.getContext('2d')
        if (!ctx) return { barcodeTexts: [] as string[], width: 0, height: 0, rgba: [] as number[] }
        ctx.drawImage(img, 0, 0, w, h)
        const barcodeTexts: string[] = []
        try {
          const Detector = (globalThis as any).BarcodeDetector
          if (Detector) {
            const det = new Detector({ formats: ['qr_code'] })
            const codes = await det.detect(canvas)
            for (const c of codes ?? []) {
              if (typeof c?.rawValue === 'string' && c.rawValue.trim()) barcodeTexts.push(c.rawValue.trim())
            }
          }
        } catch {}
        const imgData = ctx.getImageData(0, 0, w, h)
        return { barcodeTexts, width: w, height: h, rgba: Array.from(imgData.data) }
      }, dataUrl)
      let timer: NodeJS.Timeout | undefined
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('qr browser timeout')), QR_BROWSER_TIMEOUT_MS)
      })
      let extracted: Awaited<typeof evaluation>
      try {
        extracted = await Promise.race([evaluation, timeout])
      } finally {
        if (timer) clearTimeout(timer)
        // Bila batas waktu menang, browser ditutup di finally luar dan evaluasi yang tertinggal ditolak; jangan jadi unhandled.
        evaluation.catch(() => {})
      }

      const results = new Set<string>(extracted.barcodeTexts)
      if (extracted.width >= 21 && extracted.height >= 21 && extracted.rgba.length >= extracted.width * extracted.height * 4) {
        const fromPure = decodeQrStringsFromRgba({
          width: extracted.width,
          height: extracted.height,
          data: Uint8Array.from(extracted.rgba),
        })
        for (const s of fromPure) results.add(s)
      }
      return [...results]
    } catch {
      return []
    } finally {
      if (browser) {
        try {
          await browser.close()
        } catch {}
      }
    }
  }, [])
}

export interface QrDecodeResult {
  rawTexts: string[]
  urls: string[]
  rejectedUrls: string[]
  method: 'png_native' | 'chromium_canvas' | 'none'
}

export interface QrDecodeOptions {
  enableBrowserFallback?: boolean
  customNonPngDecoder?: (buffer: Buffer, mimeType: PosterImageMime) => Promise<string[]>
}

export function extractQrUrlsFromStrings(rawTexts: readonly string[]): { urls: string[]; rejectedUrls: string[] } {
  const urls: string[] = []
  const rejectedUrls: string[] = []
  const seen = new Set<string>()

  for (const raw of rawTexts) {
    const trimmed = raw.trim()
    if (!trimmed) continue
    const candidates = extractUrlsFromText(trimmed)
    // Tangani juga skema non-http (seperti javascript:) yang sengaja dimasukkan ke QR agar tercatat sebagai rejected.
    if (candidates.length === 0 && /^[a-z][a-z0-9+.-]*:/i.test(trimmed)) {
      if (!seen.has(trimmed)) {
        seen.add(trimmed)
        rejectedUrls.push(trimmed)
      }
      continue
    }
    for (const url of candidates) {
      if (seen.has(url)) continue
      seen.add(url)
      if (isPublicHttpUrl(url)) urls.push(url)
      else rejectedUrls.push(url)
    }
  }
  return { urls, rejectedUrls }
}

/**
 * Dekode seluruh kode QR di dalam gambar poster (PNG murni tanpa browser; JPEG/WebP lewat kanvas bila aktif).
 * Mengembalikan hanya URL http(s) publik yang lolos `isPublicHttpUrl`; URL internal/berbahaya masuk `rejectedUrls`.
 */
export async function decodeQrUrlsFromImage(
  buffer: Buffer,
  mimeType: PosterImageMime,
  opts: QrDecodeOptions = {},
): Promise<QrDecodeResult> {
  if (mimeType === 'image/png') {
    const rgba = decodePngRgba(buffer)
    if (!rgba) return { rawTexts: [], urls: [], rejectedUrls: [], method: 'none' }
    const rawTexts = decodeQrStringsFromRgba(rgba)
    const { urls, rejectedUrls } = extractQrUrlsFromStrings(rawTexts)
    return { rawTexts, urls, rejectedUrls, method: 'png_native' }
  }

  if (opts.customNonPngDecoder) {
    const rawTexts = await opts.customNonPngDecoder(buffer, mimeType)
    const { urls, rejectedUrls } = extractQrUrlsFromStrings(rawTexts)
    return { rawTexts, urls, rejectedUrls, method: 'chromium_canvas' }
  }

  if (opts.enableBrowserFallback === false) {
    return { rawTexts: [], urls: [], rejectedUrls: [], method: 'none' }
  }

  const rawTexts = await decodeNonPngViaChromium(buffer, mimeType)
  const { urls, rejectedUrls } = extractQrUrlsFromStrings(rawTexts)
  return { rawTexts, urls, rejectedUrls, method: rawTexts.length > 0 ? 'chromium_canvas' : 'none' }
}
