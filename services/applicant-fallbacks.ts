/**
 * Aturan cadangan untuk data pelamar yang kosong di Pengaturan Otomasi (`user_automation_settings`). Fungsi murni:
 * tanpa jaringan dan database. Dipakai jawaban formulir di layar persetujuan (approval-answers.service.ts,
 * form-autofill.service.ts) dan pembuat data kandidat worker (worker/src/lib/ai.ts), supaya keduanya sepakat.
 *
 * Berkas ini disalin byte demi byte ke worker/src/lib/applicantFallbacks.ts (paket terpisah); ubah keduanya sekaligus.
 * Tes di worker/tests/applicant-fallbacks.test.ts memeriksa kesamaannya.
 *
 * Dua aturan:
 *   1. Negara diturunkan dari teks lokasi Profil dengan dua cara. Pertama, bagian terakhir (setelah koma terakhir)
 *      adalah nama negara yang dikenal: "Yogyakarta, Indonesia" menghasilkan "Indonesia". Nama negara yang tertulis
 *      jelas selalu menang: "Jakarta, Singapore" menghasilkan "Singapore". Kedua, bila tidak ada satu bagian pun yang
 *      berupa nama negara, dan salah satu bagiannya provinsi atau kota Indonesia yang dikenal (daftar tetap
 *      INDONESIA_PLACES: 38 provinsi, ibu kota provinsi, dan beberapa kota besar), hasilnya "Indonesia":
 *      "Daerah Istimewa Yogyakarta" dan "Sleman, Yogyakarta" menghasilkan "Indonesia". Kota atau provinsi lain tetap
 *      tidak ditebak: "Atlanta, Georgia" menghasilkan null. Daftarnya sengaja tanpa nama yang juga dipakai negara
 *      lain.
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

/**
 * Provinsi dan kota di Indonesia yang cukup pasti menunjukkan negaranya. Isinya 38 provinsi (nama resmi, nama
 * Inggris, singkatan umum), ibu kota tiap provinsi, dan beberapa kota besar. Sengaja tanpa nama yang juga nama
 * tempat di negara lain, dan tanpa nama pulau atau wilayah luas ("Sumatera", "Kalimantan", "Timur").
 */
const INDONESIA_PLACES: string[] = [
  // Sumatera
  'Aceh', 'Nanggroe Aceh Darussalam', 'Daerah Istimewa Aceh', 'Banda Aceh',
  'Sumatera Utara', 'Sumatra Utara', 'North Sumatra', 'North Sumatera', 'Sumut', 'Medan',
  'Sumatera Barat', 'Sumatra Barat', 'West Sumatra', 'West Sumatera', 'Sumbar', 'Padang',
  'Riau', 'Pekanbaru',
  'Kepulauan Riau', 'Riau Islands', 'Kepri', 'Tanjung Pinang', 'Tanjungpinang', 'Batam',
  'Jambi',
  'Sumatera Selatan', 'Sumatra Selatan', 'South Sumatra', 'South Sumatera', 'Sumsel', 'Palembang',
  'Kepulauan Bangka Belitung', 'Bangka Belitung', 'Bangka Belitung Islands', 'Babel', 'Pangkal Pinang', 'Pangkalpinang',
  'Bengkulu',
  'Lampung', 'Bandar Lampung',
  // Jawa
  'DKI Jakarta', 'DKI', 'DKJ', 'Daerah Khusus Jakarta', 'Daerah Khusus Ibukota Jakarta', 'Daerah Khusus Ibu Kota Jakarta',
  'Special Capital Region of Jakarta', 'Jakarta Capital Region', 'Jakarta', 'Jakarta Raya', 'Jabodetabek',
  'Jakarta Pusat', 'Jakarta Selatan', 'Jakarta Barat', 'Jakarta Timur', 'Jakarta Utara',
  'Central Jakarta', 'South Jakarta', 'West Jakarta', 'East Jakarta', 'North Jakarta',
  'Jawa Barat', 'West Java', 'Jabar', 'Bandung', 'Bekasi', 'Depok', 'Bogor', 'Cirebon', 'Karawang',
  'Banten', 'Serang', 'Tangerang', 'Tangerang Selatan', 'South Tangerang',
  'Jawa Tengah', 'Central Java', 'Jateng', 'Semarang', 'Surakarta', 'Solo',
  'Daerah Istimewa Yogyakarta', 'DI Yogyakarta', 'DIY', 'Special Region of Yogyakarta', 'Yogyakarta Special Region',
  'Yogyakarta', 'Yogya', 'Jogja', 'Jogjakarta', 'Sleman', 'Bantul', 'Gunungkidul', 'Gunung Kidul', 'Kulon Progo',
  'Jawa Timur', 'East Java', 'Jatim', 'Surabaya', 'Malang',
  // Bali dan Nusa Tenggara
  'Bali', 'Denpasar',
  'Nusa Tenggara Barat', 'West Nusa Tenggara', 'NTB', 'Mataram',
  'Nusa Tenggara Timur', 'East Nusa Tenggara', 'NTT', 'Kupang',
  // Kalimantan
  'Kalimantan Barat', 'West Kalimantan', 'Kalbar', 'Pontianak',
  'Kalimantan Tengah', 'Central Kalimantan', 'Kalteng', 'Palangka Raya', 'Palangkaraya',
  'Kalimantan Selatan', 'South Kalimantan', 'Kalsel', 'Banjarmasin',
  'Kalimantan Timur', 'East Kalimantan', 'Kaltim', 'Samarinda', 'Balikpapan',
  'Kalimantan Utara', 'North Kalimantan', 'Kaltara', 'Tanjung Selor',
  // Sulawesi
  'Sulawesi Utara', 'North Sulawesi', 'Sulut', 'Manado',
  'Sulawesi Tengah', 'Central Sulawesi', 'Sulteng', 'Palu',
  'Sulawesi Selatan', 'South Sulawesi', 'Sulsel', 'Makassar',
  'Sulawesi Tenggara', 'Southeast Sulawesi', 'South East Sulawesi', 'Sultra', 'Kendari',
  'Gorontalo',
  'Sulawesi Barat', 'West Sulawesi', 'Sulbar', 'Mamuju',
  // Maluku dan Papua
  'Maluku', 'Moluccas', 'Ambon',
  'Maluku Utara', 'North Maluku', 'Malut', 'Sofifi', 'Ternate',
  'Papua', 'Jayapura',
  'Papua Barat', 'West Papua', 'Manokwari',
  'Papua Selatan', 'South Papua', 'Merauke',
  'Papua Tengah', 'Central Papua', 'Nabire',
  'Papua Pegunungan', 'Highland Papua', 'Mountain Papua', 'Wamena',
  'Papua Barat Daya', 'Southwest Papua', 'South West Papua', 'Sorong',
]

/** Seperti normalizeName, ditambah titik dibuang dan tanda hubung jadi spasi ("D.I. Yogyakarta" -> "di yogyakarta"). */
const normalizePlace = (s: string): string => normalizeName(s).replace(/\./g, '').replace(/-/g, ' ').replace(/\s+/g, ' ').trim()

const INDONESIA_PLACE_SET: Set<string> = new Set(INDONESIA_PLACES.map(normalizePlace))

/** Awalan dan akhiran yang sering menempel di nama tempat: "Kota Bandung", "Greater Jakarta Area", "Yogyakarta City". */
const PLACE_PREFIX = /^(?:kota|kabupaten|kab|provinsi|prov|greater|city of|province of)\s+/
const PLACE_SUFFIX = /\s+(?:metropolitan area|area|province|city|regency)$/

/** True bila satu bagian lokasi adalah provinsi atau kota Indonesia yang dikenal. */
const isIndonesiaPlace = (part: string): boolean => {
  const name = normalizePlace(part)
  if (INDONESIA_PLACE_SET.has(name)) return true
  const bare = name.replace(PLACE_PREFIX, '').replace(PLACE_SUFFIX, '').trim()
  return bare !== name && INDONESIA_PLACE_SET.has(bare)
}

const locationParts = (location: unknown): string[] =>
  typeof location === 'string'
    ? location
        .split(',')
        .map((p) => p.trim())
        .filter(Boolean)
    : []

/**
 * Negara dari teks lokasi bebas, atau null bila tidak ada petunjuk yang pasti. Hasilnya selalu nama kanonik
 * bahasa Inggris ("Amerika Serikat" -> "United States"). Urutannya:
 *   1. Bagian terakhir adalah nama negara ("Yogyakarta, Indonesia" -> "Indonesia"): itu hasilnya, apa pun
 *      bagian lainnya.
 *   2. Ada nama negara di bagian lain ("Indonesia, Remote"): null, karena maksudnya tidak jelas.
 *   3. Tanpa nama negara, salah satu bagian provinsi atau kota Indonesia yang dikenal ("Daerah Istimewa
 *      Yogyakarta", "Sleman, Yogyakarta") -> "Indonesia".
 */
export function countryFromLocation(location: unknown): string | null {
  const parts = locationParts(location)
  if (parts.length === 0) return null
  const explicit = COUNTRY_BY_NAME.get(normalizeName(parts[parts.length - 1]))
  if (explicit) return explicit
  if (parts.some((p) => COUNTRY_BY_NAME.has(normalizeName(p)))) return null
  return parts.some(isIndonesiaPlace) ? 'Indonesia' : null
}

/**
 * Kota dari teks lokasi bebas: bagian sebelum koma pertama. Lokasi yang hanya berisi nama negara ("Indonesia")
 * tidak punya kota, jadi hasilnya null, bukan nama negara yang dipakai sebagai kota. Lokasi satu bagian yang
 * berupa provinsi ("Daerah Istimewa Yogyakarta") tetap dipakai apa adanya: itu yang diketik pengguna, dan jawaban
 * dari Profil memang ditandai "sedang" supaya dicek.
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
