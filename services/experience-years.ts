/**
 * Total lama pengalaman kerja dari baris `work_experiences` (start_date, end_date, is_current).
 * Dipakai bila `profiles.experience_years` dan Pengaturan Otomasi tidak mengisi "tahun pengalaman", supaya
 * jawaban formulir tidak jatuh ke 0 padahal profil memuat riwayat kerja. Fungsi murni: tanpa jaringan dan database.
 *
 * Berkas ini disalin byte demi byte ke worker/src/lib/experienceYears.ts (paket terpisah); ubah keduanya sekaligus.
 * Tes di worker/tests/experience-years.test.ts memeriksa kesamaannya.
 *
 * Aturan:
 *   - Tanggal dibaca per bulan (`YYYY-MM-DD`, `YYYY-MM`, atau stempel ISO). Bulan mulai dan bulan selesai ikut
 *     dihitung, karena tanggal selesai tersimpan sebagai tanggal 1 bulan terakhir bekerja (impor LinkedIn).
 *   - Peran yang masih berjalan (`is_current` atau tanpa tanggal selesai) dihitung sampai bulan ini.
 *   - Periode yang tumpang tindih digabung: dua pekerjaan paralel tidak dihitung dua kali.
 *   - Baris dengan tanggal mulai tidak terbaca, di masa depan, atau selesai sebelum mulai dilewati dan dihitung.
 *   - Tahun dibulatkan ke bawah dari total bulan.
 */

export interface WorkPeriodRow {
  start_date?: unknown
  end_date?: unknown
  is_current?: unknown
}

export interface ExperienceYears {
  /** Total bulan bekerja setelah periode yang tumpang tindih digabung. */
  months: number
  /** Total bulan dibagi 12, dibulatkan ke bawah. */
  years: number
  /** Banyak baris yang dipakai. */
  used: number
  /** Banyak baris yang dilewati karena tanggalnya tidak sah. */
  skipped: number
}

const monthIndex = (v: unknown): number | null => {
  if (typeof v !== 'string') return null
  const m = /^(\d{4})-(\d{2})/.exec(v.trim())
  if (!m) return null
  const year = Number(m[1])
  const month = Number(m[2])
  if (year < 1950 || month < 1 || month > 12) return null
  return year * 12 + (month - 1)
}

/** null bila `rows` bukan daftar atau kosong (tidak ada riwayat kerja yang bisa dihitung). */
export function deriveExperienceYears(rows: unknown, now: Date = new Date()): ExperienceYears | null {
  if (!Array.isArray(rows) || rows.length === 0) return null
  const nowIdx = now.getUTCFullYear() * 12 + now.getUTCMonth()
  const spans: Array<[number, number]> = []
  let skipped = 0
  for (const r of rows) {
    const row = (r && typeof r === 'object' ? r : {}) as WorkPeriodRow
    const start = monthIndex(row.start_date)
    const open = row.is_current === true || row.end_date == null || row.end_date === ''
    const end = open ? nowIdx : monthIndex(row.end_date)
    if (start === null || end === null || start > nowIdx || end < start) {
      skipped++
      continue
    }
    spans.push([start, Math.min(end, nowIdx)])
  }
  spans.sort((a, b) => a[0] - b[0])
  let months = 0
  let cur: [number, number] | null = null
  for (const [s, e] of spans) {
    if (!cur) cur = [s, e]
    else if (s <= cur[1] + 1) cur[1] = Math.max(cur[1], e) // tumpang tindih atau bersambung langsung
    else {
      months += cur[1] - cur[0] + 1
      cur = [s, e]
    }
  }
  if (cur) months += cur[1] - cur[0] + 1
  return { months, years: Math.floor(months / 12), used: spans.length, skipped }
}
