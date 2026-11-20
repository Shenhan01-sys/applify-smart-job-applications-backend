/**
 * Aturan cadangan untuk data pelamar yang kosong di Pengaturan Otomasi (`user_automation_settings`). Fungsi murni:
 * tanpa jaringan dan database. Dipakai jawaban formulir di layar persetujuan (approval-answers.service.ts,
 * form-autofill.service.ts) dan pembuat data kandidat worker (worker/src/lib/ai.ts), supaya keduanya sepakat.
 *
 * Berkas ini disalin byte demi byte ke worker/src/lib/applicantFallbacks.ts (paket terpisah); ubah keduanya sekaligus.
 * Tes di worker/tests/applicant-fallbacks.test.ts memeriksa kesamaannya.
 *
 * Dua aturan:
 *   1. Negara diturunkan dari teks lokasi Profil hanya bila bagian terakhir (setelah koma terakhir) adalah nama
 *      negara yang dikenal. Nama kota atau provinsi tidak pernah ditebak menjadi negara: "Yogyakarta" tidak
 *      menghasilkan apa-apa, "Sleman, Yogyakarta" juga tidak, "Yogyakarta, Indonesia" menghasilkan "Indonesia".
 *   2. "No" pada `require_visa` (huruf N besar, persis) adalah nilai bawaan kolom di database production, bukan
 *      pilihan pengguna. Pada 200 baris snapshot 3 Oktober 2026 (.backup/2026-10-03-db-reconcile) semuanya "No"
 *      padahal skrip seed tidak pernah mengisinya, dan database/schema.sql tidak memuat nilai bawaan itu (hanya
 *      live schema yang memuatnya). Halaman Pengaturan Agen menyimpan pilihan pengguna dengan huruf kecil
 *      ("no" atau "yes"), jadi "No" persis berarti belum pernah dipilih.
 */

/** Keyakinan jawaban yang datanya hanya nilai bawaan database: "sedang", jadi selalu ditandai untuk dicek. */
export const UNCONFIRMED_DEFAULT_CONFIDENCE = 0.6

/**
 * Nama negara kanonik (bahasa Inggris, sesuai daftar negara di formulir lowongan) beserta nama lain dalam bahasa
 * Indonesia dan singkatannya. Sengaja tanpa nama yang juga nama kota atau negara bagian ("Georgia", "Jordan").
 */
const COUNTRY_NAMES: Array<[string, ...string[]]> = [
  ['Indonesia', 'republik indonesia', 'republic of indonesia'],
  ['Malaysia'],
  ['Singapore', 'singapura'],
  ['Thailand'],
  ['Vietnam', 'viet nam'],
  ['Philippines', 'the philippines', 'filipina'],
  ['Brunei', 'brunei darussalam'],
  ['Cambodia', 'kamboja'],
  ['Laos'],
  ['Myanmar', 'burma'],
  ['Timor-Leste', 'timor leste', 'east timor', 'timor timur'],
  ['India'],
  ['Pakistan'],
  ['Bangladesh'],
  ['Sri Lanka'],
  ['Japan', 'jepang'],
  ['South Korea', 'korea selatan', 'republic of korea'],
  ['China', 'tiongkok', 'cina', "people's republic of china"],
  ['Hong Kong'],
  ['Taiwan'],
  ['Australia'],
  ['New Zealand', 'selandia baru'],
  ['United States', 'united states of america', 'usa', 'u.s.a.', 'us', 'u.s.', 'amerika serikat'],
  ['Canada', 'kanada'],
  ['Mexico', 'meksiko'],
  ['Brazil', 'brasil'],
  ['Argentina'],
  ['Chile'],
  ['Colombia', 'kolombia'],
  ['Peru'],
  ['United Kingdom', 'uk', 'u.k.', 'great britain', 'britania raya', 'inggris'],
  ['Ireland', 'irlandia'],
  ['France', 'prancis'],
  ['Germany', 'jerman', 'deutschland'],
  ['Netherlands', 'the netherlands', 'belanda'],
  ['Belgium', 'belgia'],
  ['Luxembourg', 'luksemburg'],
  ['Spain', 'spanyol'],
  ['Portugal'],
  ['Italy', 'italia'],
  ['Switzerland', 'swiss'],
  ['Austria'],
  ['Sweden', 'swedia'],
  ['Norway', 'norwegia'],
  ['Denmark'],
  ['Finland', 'finlandia'],
  ['Poland', 'polandia'],
  ['Czech Republic', 'czechia', 'republik ceko', 'ceko'],
  ['Hungary', 'hongaria'],
  ['Romania', 'rumania'],
  ['Greece', 'yunani'],
  ['Turkey', 'turkiye', 'turki'],
  ['Russia', 'rusia'],
  ['Ukraine', 'ukraina'],
  ['Israel'],
  ['United Arab Emirates', 'uae', 'u.a.e.', 'uni emirat arab'],
  ['Saudi Arabia', 'arab saudi'],
  ['Qatar'],
  ['Egypt', 'mesir'],
  ['South Africa', 'afrika selatan'],
  ['Nigeria'],
  ['Kenya'],
]

const normalizeName = (s: string): string =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()

const COUNTRY_BY_NAME: Map<string, string> = new Map()
for (const [canonical, ...aliases] of COUNTRY_NAMES) {
  for (const name of [canonical, ...aliases]) COUNTRY_BY_NAME.set(normalizeName(name), canonical)
}

const locationParts = (location: unknown): string[] =>
  typeof location === 'string'
    ? location
        .split(',')
        .map((p) => p.trim())
        .filter(Boolean)
    : []

/**
 * Negara dari teks lokasi bebas ("Yogyakarta, Indonesia" -> "Indonesia"), atau null bila bagian terakhirnya bukan
 * nama negara yang dikenal. Hasilnya selalu nama kanonik bahasa Inggris ("Amerika Serikat" -> "United States").
 */
export function countryFromLocation(location: unknown): string | null {
  const parts = locationParts(location)
  if (parts.length === 0) return null
  return COUNTRY_BY_NAME.get(normalizeName(parts[parts.length - 1])) ?? null
}

/**
 * Kota dari teks lokasi bebas: bagian sebelum koma pertama. Lokasi yang hanya berisi nama negara ("Indonesia")
 * tidak punya kota, jadi hasilnya null, bukan nama negara yang dipakai sebagai kota.
 */
export function cityFromLocation(location: unknown): string | null {
  const parts = locationParts(location)
  if (parts.length === 0) return null
  if (parts.length === 1 && COUNTRY_BY_NAME.has(normalizeName(parts[0]))) return null
  return parts[0]
}

/**
 * True bila `require_visa` berisi nilai bawaan database ("No" persis, huruf N besar), yaitu pengguna belum pernah
 * memilih. Pilihan pengguna di Pengaturan Agen tersimpan sebagai "no" atau "yes" (huruf kecil). Nilai kosong
 * bukan nilai bawaan ini: itu "belum diisi" dan ditangani pemanggil.
 */
export function isUnconfirmedVisaDefault(value: unknown): boolean {
  return typeof value === 'string' && value.trim() === 'No'
}
