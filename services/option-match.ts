/**
 * Mencocokkan jawaban dengan daftar pilihan (select/radio) tanpa menebak. Dipakai FormAutofillService dan planner
 * ekstensi, supaya jawaban yang tidak punya pilihan padanan tidak pernah berubah menjadi pilihan lain.
 *
 * Aturan (berurutan):
 *   1. Pilihan yang sama persis sesudah dinormalkan (huruf kecil, spasi dirapikan, tanda baca akhir dibuang).
 *   2. Bila tidak ada, TEPAT SATU pilihan yang berawalan jawaban pada batas kata ("Yes" cocok dengan
 *      "Yes, I am authorized", tetapi "No" tidak cocok dengan "None" atau "Non-binary" karena huruf berikutnya
 *      bukan batas kata).
 *   3. Bila belum cocok, padanan Indonesia-Inggris yang pasti (Ya/Yes, Tidak/No, Pria/Male, nama bulan, dst.) dicoba
 *      dengan aturan 1 dan 2. Diterima hanya bila semua padanan menunjuk TEPAT SATU pilihan (uji JobStreet dan Dealls
 *      25 November 2026: jawaban profil berbahasa Indonesia, pilihan situs berbahasa Inggris, atau sebaliknya).
 *   4. Selain itu null: tidak ada kecocokan, atau ambigu (pilihan ganda yang sama, atau lebih dari satu pilihan
 *      berawalan jawaban). Pemanggil mengosongkan jawabannya dengan keyakinan 0 supaya pengguna ditanya.
 *
 * Tidak ada cadangan "pilihan pertama", tidak ada pencocokan "mengandung", dan tidak ada arah terbalik (jawaban yang
 * lebih panjang dari pilihan).
 */

export function normalizeOptionText(raw: unknown): string {
  return String(raw ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.!:;,\s]+$/, '')
}

const isBoundaryChar = (ch: string): boolean => !/[\p{L}\p{N}]/u.test(ch)

/**
 * Kelompok padanan yang maknanya sama persis. Hanya kata tunggal atau frasa baku; tidak ada sinonim longgar.
 * Bulan memakai nama lengkap dan singkatan tiga huruf.
 */
const ALIAS_GROUPS: readonly (readonly string[])[] = [
  ['ya', 'yes', 'y'],
  ['tidak', 'no', 'tdk', 'n'],
  ['laki-laki', 'laki laki', 'pria', 'male', 'man'],
  ['perempuan', 'wanita', 'female', 'woman'],
  ['lainnya', 'lain-lain', 'other', 'others'],
  ['belum', 'not yet'],
  ['sudah', 'already'],
  ['bersedia', 'willing'],
  ['tidak bersedia', 'not willing', 'unwilling'],
  ['sekarang', 'saat ini', 'present', 'current'],
  ['segera', 'langsung', 'immediate', 'immediately'],
  ['s1', 'sarjana', 'bachelor', 'undergraduate', 'strata 1'],
  ['s2', 'magister', 'master', 'postgraduate', 'strata 2'],
  ['d3', 'diploma', 'diploma 3', 'associate'],
  ['sma', 'smk', 'sma/smk', 'high school', 'senior high school'],
  ['full-time', 'full time', 'fulltime', 'penuh waktu'],
  ['part-time', 'part time', 'parttime', 'paruh waktu'],
  ['magang', 'internship', 'intern'],
  ['kontrak', 'contract'],
  ['remote', 'jarak jauh', 'wfh', 'work from home'],
  ['hybrid', 'hibrida'],
  ['onsite', 'on-site', 'on site', 'wfo', 'di kantor'],
  ['januari', 'january', 'jan'],
  ['februari', 'february', 'feb'],
  ['maret', 'march', 'mar'],
  ['april', 'apr'],
  ['mei', 'may'],
  ['juni', 'june', 'jun'],
  ['juli', 'july', 'jul'],
  ['agustus', 'august', 'agu', 'agt', 'aug'],
  ['september', 'sep', 'sept'],
  ['oktober', 'october', 'okt', 'oct'],
  ['november', 'nov'],
  ['desember', 'december', 'des', 'dec'],
]

const ALIASES = new Map<string, readonly string[]>()
for (const group of ALIAS_GROUPS) for (const word of group) ALIASES.set(word, group)

/** Padanan jawaban (tanpa jawaban itu sendiri), atau daftar kosong. */
export function optionAliases(answer: unknown): string[] {
  const wanted = normalizeOptionText(answer)
  return (ALIASES.get(wanted) ?? []).filter((w) => w !== wanted)
}

/** Aturan 1 dan 2 untuk satu jawaban yang sudah dinormalkan: pilihan tunggal, 'ambiguous', atau null. */
function matchOne(wanted: string, list: string[]): string | 'ambiguous' | null {
  const exact = list.filter((o) => normalizeOptionText(o) === wanted)
  if (exact.length === 1) return exact[0]
  if (exact.length > 1) return 'ambiguous' // pilihan duplikat
  const prefixed = list.filter((o) => {
    const norm = normalizeOptionText(o)
    return norm.startsWith(wanted) && (norm.length === wanted.length || isBoundaryChar(norm[wanted.length]))
  })
  if (prefixed.length === 1) return prefixed[0]
  return prefixed.length > 1 ? 'ambiguous' : null
}

/** Pilihan yang cocok dengan `answer`, atau null (tidak ada, kosong, atau ambigu). `options` kosong tidak ditangani di sini. */
export function matchOptionStrict(answer: unknown, options: readonly unknown[]): string | null {
  const wanted = normalizeOptionText(answer)
  if (!wanted) return null
  const list = options.map((o) => String(o ?? '')).filter((o) => o.trim() !== '')

  const direct = matchOne(wanted, list)
  if (direct === 'ambiguous') return null
  if (direct) return direct

  // Padanan ID-EN: setiap padanan dicoba; semua yang cocok harus menunjuk pilihan yang sama.
  const hits = new Set<string>()
  for (const alias of optionAliases(wanted)) {
    const hit = matchOne(alias, list)
    if (hit === 'ambiguous') return null
    if (hit) hits.add(hit)
  }
  return hits.size === 1 ? [...hits][0] : null
}
