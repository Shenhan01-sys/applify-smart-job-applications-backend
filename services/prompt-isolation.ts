/**
 * Isolasi teks tak tepercaya di prompt model (audit 48.3 BS-01).
 *
 * Deskripsi lowongan, pertanyaan formulir, CV unggahan, dan surat sebelumnya berasal dari pihak luar atau dari
 * klien. Prompt membungkusnya dengan tag data (`<job_description>` dan sejenisnya) dan memerintahkan model
 * memperlakukan isinya sebagai data. Pembungkus itu tidak berguna bila isi teks boleh memuat tag penutupnya:
 * penyerang menulis `</job_description>` lalu perintah baru, dan perintah itu tampak berada di luar pembungkus.
 *
 * `escapeUntrusted` mengganti `<` di depan nama tag pembungkus (pembuka, penutup, berspasi, berhuruf besar) dengan
 * `&lt;`. Penggantian tidak pernah menghasilkan karakter `<` baru, sehingga potongan seperti
 * `</job_</job_description>description>` tidak bisa tersusun kembali menjadi tag. Tag HTML lain tidak diubah.
 */

/** Semua tag pembungkus data tak tepercaya yang dipakai prompt backend. */
export const UNTRUSTED_WRAPPER_TAGS = [
  'job_description',
  'form_question',
  'candidate_cv',
  'original_letter',
  'rewrite_instructions',
  'job_posting',
  'page_context',
  'untrusted_form_controls',
] as const

const WRAPPER_TAG_START = new RegExp(`<(?=\\s*/?\\s*(?:${UNTRUSTED_WRAPPER_TAGS.join('|')})(?![\\w-]))`, 'gi')

/** Netralkan tag pembungkus di dalam `text`; nilai bukan teks menjadi string kosong. */
export function escapeUntrusted(text: unknown): string {
  if (typeof text !== 'string') return text == null ? '' : escapeUntrusted(String(text))
  return text.replace(WRAPPER_TAG_START, '&lt;')
}

/**
 * Untuk teks tak tepercaya yang terpaksa tampil di luar pembungkus (judul dan nama perusahaan di kalimat
 * instruksi): satu baris, tanda kutip ganda diganti, tag pembungkus dinetralkan, dipotong `max` karakter.
 */
export function inlineUntrusted(text: unknown, max = 120): string {
  return escapeUntrusted(text).replace(/["“”]/g, "'").replace(/\s+/g, ' ').trim().slice(0, max)
}
