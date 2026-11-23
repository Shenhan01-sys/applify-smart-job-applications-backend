/**
 * Mencocokkan jawaban dengan daftar pilihan (select/radio) tanpa menebak. Dipakai FormAutofillService dan planner
 * ekstensi, supaya jawaban yang tidak punya pilihan padanan tidak pernah berubah menjadi pilihan lain.
 *
 * Aturan (berurutan):
 *   1. Pilihan yang sama persis sesudah dinormalkan (huruf kecil, spasi dirapikan, tanda baca akhir dibuang).
 *   2. Bila tidak ada, TEPAT SATU pilihan yang berawalan jawaban pada batas kata ("Yes" cocok dengan
 *      "Yes, I am authorized", tetapi "No" tidak cocok dengan "None" atau "Non-binary" karena huruf berikutnya
 *      bukan batas kata).
 *   3. Selain itu null: tidak ada kecocokan, atau ambigu (pilihan ganda yang sama, atau lebih dari satu pilihan
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

/** Pilihan yang cocok dengan `answer`, atau null (tidak ada, kosong, atau ambigu). `options` kosong tidak ditangani di sini. */
export function matchOptionStrict(answer: unknown, options: readonly unknown[]): string | null {
  const wanted = normalizeOptionText(answer)
  if (!wanted) return null
  const list = options.map((o) => String(o ?? '')).filter((o) => o.trim() !== '')

  const exact = list.filter((o) => normalizeOptionText(o) === wanted)
  if (exact.length === 1) return exact[0]
  if (exact.length > 1) return null // pilihan duplikat: ambigu

  const prefixed = list.filter((o) => {
    const norm = normalizeOptionText(o)
    return norm.startsWith(wanted) && (norm.length === wanted.length || isBoundaryChar(norm[wanted.length]))
  })
  return prefixed.length === 1 ? prefixed[0] : null
}
