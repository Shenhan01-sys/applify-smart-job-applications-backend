// Aturan bentuk surat lamaran untuk prompt model. Uji klik produksi 21 November 2026 (temuan 28): surat berupa satu
// paragraf tanpa jeda baris dan menulis "melamar posisi di FIN HOMEMART" tanpa menyebut nama posisi.
//
// Salinan yang identik ada di backend/services/letter-rules.ts (paket terpisah); tes di backend membandingkan keduanya.
// TypeScript murni tanpa impor, supaya jalan di Deno dan di `node --test`.

/** Jumlah paragraf pendek paling sedikit dalam satu surat. */
export const LETTER_MIN_PARAGRAPHS = 3;

/** Satu baris, tanpa kutip ganda, dipotong: judul dan perusahaan berasal dari data lowongan, bukan instruksi. */
function oneLine(value: unknown, max = 120): string {
  const s = typeof value === "string" ? value : "";
  return s.replace(/["“”]/g, "'").replace(/\s+/g, " ").trim().slice(0, max);
}

/** Aturan bentuk surat, satu kalimat per butir, siap dipasang sebagai daftar di prompt. */
export function letterStructureRules(jobTitle: unknown, company: unknown): string[] {
  const title = oneLine(jobTitle) || "the position";
  const co = oneLine(company) || "the company";
  return [
    `Name the exact position "${title}" and the company "${co}" in the first paragraph (for example "melamar posisi ${title} di ${co}" in Indonesian). Never write only "a position" or "posisi" without its title.`,
    `Write at least ${LETTER_MIN_PARAGRAPHS} short paragraphs separated by one blank line: (1) the position, the company and why you apply, (2) relevant experience and skills taken from the candidate data, (3) a polite closing with a call to action. Never output the letter as one block of text.`,
  ];
}
