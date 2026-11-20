import type { SalaryPeriod } from '../mcp/shared/types.js'

/**
 * Parsing dan normalisasi gaji. Murni (tanpa I/O).
 *
 * Portal menulis gaji sebagai teks bebas ("Rp 9.000.000 – Rp 13.000.000 per month", "Rp 5jt - 7jt",
 * "$80,000 – $100,000 per year") atau angka terstruktur (Glints, Dealls). Modul ini mengubah keduanya menjadi
 * bentuk yang sama: { min, max, currency, period }. Teks yang tidak bisa dibaca dengan yakin menghasilkan null,
 * tidak ditebak. Kolom `jobs.salary_min/max` bertipe bilangan bulat, jadi `toDbSalary` membulatkan dan menjepit
 * nilai ke rentang int32.
 */

export type { SalaryPeriod }

export interface ParsedSalary {
  min: number
  max: number
  currency: string
  period: SalaryPeriod
}

const INT32_MAX = 2147483647

const PERIODS: SalaryPeriod[] = ['month', 'year', 'hour', 'day', 'week']

/** Kode mata uang yang dikenali dari simbol atau singkatan di teks. */
function detectCurrency(s: string): string | null {
  if (/(?:^|[^a-z])rp(?![a-z])|\bidr\b|rupiah/.test(s)) return 'IDR'
  if (/\busd\b|us\$/.test(s)) return 'USD'
  if (/\bsgd\b|(?:^|[^a-z])s\$/.test(s)) return 'SGD'
  if (/\baud\b|(?:^|[^a-z])a\$/.test(s)) return 'AUD'
  if (/\bmyr\b|(?:^|[^a-z])rm(?=\s*\d)/.test(s)) return 'MYR'
  if (s.includes('$')) return 'USD'
  if (/\beur\b|€/.test(s)) return 'EUR'
  if (/\bgbp\b|£/.test(s)) return 'GBP'
  return null
}

/** Periode gaji dari teks ("per month", "/ bulan", "monthly", "per jam" ...); null bila tidak disebut. */
function detectPeriod(s: string): SalaryPeriod | null {
  if (/per\s*(?:hour|jam)\b|\/\s*(?:hour|hr|jam)\b|\bhourly\b|\bper\s*jam\b/.test(s)) return 'hour'
  if (/per\s*(?:day|hari)\b|\/\s*(?:day|hari)\b|\bdaily\b|\bharian\b/.test(s)) return 'day'
  if (/per\s*(?:week|minggu)\b|\/\s*(?:week|wk|minggu)\b|\bweekly\b|\bmingguan\b/.test(s)) return 'week'
  if (/per\s*(?:year|annum|tahun)\b|\/\s*(?:year|yr|tahun|thn)\b|\byearly\b|\bannual(?:ly)?\b|\btahunan\b|\bp\.a\.?(?![a-z])/.test(s)) return 'year'
  if (/per\s*(?:month|bulan)\b|\/\s*(?:month|mo|bln|bulan)\b|\bmonthly\b|\bbulanan\b/.test(s)) return 'month'
  return null
}

/** Ubah token angka ("9.000.000", "6,5", "80,000", "25.50") menjadi bilangan. null bila tidak masuk akal. */
function parseNumberToken(tok: string): number | null {
  if (!/^\d+(?:[.,]\d+)*$/.test(tok)) return null
  // Kelompok ribuan: tiap kelompok setelah pemisah pertama tepat 3 digit ("9.000.000", "80,000").
  if (/^\d{1,3}(?:[.,]\d{3})+$/.test(tok)) return Number(tok.replace(/[.,]/g, ''))
  const last = Math.max(tok.lastIndexOf('.'), tok.lastIndexOf(','))
  if (last < 0) return Number(tok)
  // Selain itu pemisah terakhir adalah desimal ("6,5", "25.50", "1.234,5").
  const n = Number(`${tok.slice(0, last).replace(/[.,]/g, '')}.${tok.slice(last + 1)}`)
  return Number.isFinite(n) ? n : null
}

const MULTIPLIERS: Record<string, number> = {
  juta: 1e6, jt: 1e6, million: 1e6,
  ribu: 1e3, rb: 1e3, thousand: 1e3, k: 1e3,
}

interface Amount { value: number; multiplied: boolean }

/** Ambil angka gaji berurutan dari teks, lengkap dengan pengali (jt, juta, rb, k, million). */
function extractAmounts(s: string): Amount[] {
  const out: Amount[] = []
  // Angka yang diikuti huruf ("13th month") atau angka lain dibuang; pengali hanya dari daftar di atas.
  const re = /(\d+(?:[.,]\d+)*)\s*(?:(juta|jt|million|ribu|rb|thousand|k)(?![a-z]))?(?!\d|[.,]\d)(?!(?:st|nd|rd|th)\b)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(s)) !== null) {
    const base = parseNumberToken(m[1])
    if (base === null) continue
    const mult = m[2] ? MULTIPLIERS[m[2]] : 1
    out.push({ value: base * mult, multiplied: Boolean(m[2]) })
  }
  return out
}

const round2 = (n: number) => Math.round(n * 100) / 100

/**
 * Batas kewajaran per mata uang dan periode. Di luar batas, nilai dianggap salah baca (nomor telepon, tahun,
 * "13th month") dan seluruh gaji dibuang.
 */
function withinBounds(value: number, currency: string, period: SalaryPeriod): boolean {
  if (!Number.isFinite(value) || value <= 0) return false
  if (currency === 'IDR') {
    if (value < 1_000 || value > 5e9) return false
    if (period === 'month') return value >= 100_000 && value <= 1e9
    if (period === 'year') return value >= 1_000_000
    return true
  }
  if (value < 1 || value > 5e7) return false
  if (period === 'month') return value >= 100 && value <= 1e6
  return true
}

/** Periode bawaan bila teks tidak menyebutnya: rupiah per bulan; mata uang lain ditebak dari besarnya angka. */
function defaultPeriod(currency: string, max: number): SalaryPeriod {
  if (currency === 'IDR') return 'month'
  if (max >= 10_000) return 'year'
  if (max < 500) return 'hour'
  return 'month'
}

/**
 * Rapikan gaji terstruktur: tukar bila min > max, isi sisi yang kosong dengan sisi lainnya, tolak nilai yang tidak
 * wajar. Dipakai juga untuk data dari API (Glints, Dealls, JSON-LD) selain hasil parseSalaryLabel.
 */
export function sanitizeSalary(input: {
  min?: unknown
  max?: unknown
  currency?: unknown
  period?: unknown
}): ParsedSalary | null {
  const num = (v: unknown) => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN)
  let min = num(input.min)
  let max = num(input.max)
  // Nol atau negatif berarti "tidak diisi" pada API portal, bukan gaji nol.
  if (!(min > 0)) min = NaN
  if (!(max > 0)) max = NaN
  if (!Number.isFinite(min) && !Number.isFinite(max)) return null
  if (!Number.isFinite(min)) min = max
  if (!Number.isFinite(max)) max = min
  if (min > max) [min, max] = [max, min]
  min = round2(min)
  max = round2(max)
  const currency = typeof input.currency === 'string' && /^[A-Za-z]{3}$/.test(input.currency.trim())
    ? input.currency.trim().toUpperCase()
    : 'IDR'
  const period: SalaryPeriod = PERIODS.includes(input.period as SalaryPeriod)
    ? (input.period as SalaryPeriod)
    : defaultPeriod(currency, max)
  if (!withinBounds(min, currency, period) || !withinBounds(max, currency, period)) return null
  if (min > 0 && max / min > 50) return null
  return { min, max, currency, period }
}

/** Padankan mode gaji dari API ("MONTH", "monthly", "YEAR", "HOUR", "per day") ke SalaryPeriod. */
export function periodFromMode(mode: unknown): SalaryPeriod | null {
  const t = String(mode ?? '').toLowerCase()
  if (!t) return null
  if (/hour|jam/.test(t)) return 'hour'
  if (/day|hari|daily/.test(t)) return 'day'
  if (/week|minggu/.test(t)) return 'week'
  if (/year|annu|tahun/.test(t)) return 'year'
  if (/month|bulan/.test(t)) return 'month'
  return null
}

/**
 * Baca teks gaji bebas. Contoh yang dikenali:
 *  "Rp 9.000.000 – Rp 13.000.000 per month", "Rp 5.000.000 per month" (satu angka: min = max),
 *  "Rp 5jt - 7jt", "Rp 6,5 jt", "IDR 8.000.000 - 12.000.000 / monthly", "$80,000 – $100,000 per year".
 * Tanpa penanda mata uang (Rp, IDR, $, ...) teks ditolak, kecuali memakai pengali Indonesia (jt, juta, rb, ribu)
 * yang berarti rupiah. Kosong, tanpa angka, atau angka tidak wajar menghasilkan null.
 */
export function parseSalaryLabel(label: unknown): ParsedSalary | null {
  if (typeof label !== 'string') return null
  const s = label
    .replace(/[   ]/g, ' ')
    .replace(/[‒–—−]/g, '-')
    .toLowerCase()
    .trim()
  if (!s || s.length > 200) return null

  let amounts = extractAmounts(s)
  if (amounts.length === 0) return null
  if (amounts.length > 2) amounts = amounts.slice(0, 2)

  // "5 - 7 jt": pengali di angka kedua berlaku juga untuk angka pertama yang kecil.
  if (amounts.length === 2 && !amounts[0].multiplied && amounts[1].multiplied && amounts[0].value < 1000) {
    const factor = amounts[1].value >= 1e6 ? 1e6 : 1e3
    amounts[0] = { value: amounts[0].value * factor, multiplied: true }
  }

  let currency = detectCurrency(s)
  if (!currency) {
    if (!/\b(?:juta|jt|ribu|rb)\b|\d\s*(?:juta|jt|ribu|rb)(?![a-z])/.test(s)) return null
    currency = 'IDR'
  }

  const values = amounts.map((a) => a.value)
  const period = detectPeriod(s) ?? undefined
  return sanitizeSalary({ min: Math.min(...values), max: Math.max(...values), currency, period })
}

/** Bidang JobPosting dari gaji terstruktur; objek kosong bila gaji null (aman di-spread). */
export function salaryFields(sal: ParsedSalary | null | undefined): {
  salary_min?: number
  salary_max?: number
  salary_currency?: string
  salary_period?: SalaryPeriod
} {
  if (!sal) return {}
  return { salary_min: sal.min, salary_max: sal.max, salary_currency: sal.currency, salary_period: sal.period }
}

/** Gaji terstruktur dari bidang JobPosting (salary_min/max/currency/period), atau dari salary_range bila itu saja. */
export function salaryOfPosting(job: {
  salary_min?: number
  salary_max?: number
  salary_currency?: string
  salary_period?: string
  salary_range?: string
}): ParsedSalary | null {
  if (job.salary_min != null || job.salary_max != null) {
    const s = sanitizeSalary({ min: job.salary_min, max: job.salary_max, currency: job.salary_currency, period: job.salary_period })
    if (s) return s
  }
  return parseSalaryLabel(job.salary_range)
}

/** Nilai untuk kolom jobs.salary_*: bilangan bulat dijepit ke int32 (kolom lama bertipe integer). */
export function toDbSalary(sal: ParsedSalary): {
  salary_min: number
  salary_max: number
  salary_currency: string
  salary_period: SalaryPeriod
} {
  const clamp = (n: number) => Math.min(INT32_MAX, Math.max(0, Math.round(n)))
  return {
    salary_min: clamp(sal.min),
    salary_max: clamp(sal.max),
    salary_currency: sal.currency,
    salary_period: sal.period,
  }
}
