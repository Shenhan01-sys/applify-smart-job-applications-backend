/**
 * Email dan nomor telepon pengguna tidak dikirim ke model bahasa (audit privasi 25 November 2026).
 * Model menulis token {{email}} dan {{phone}} di baris kontak CV; nilai asli dipasang sesudah jawaban model
 * diterima, sebelum validasi. Teks CV yang dinilai ulang oleh model juga disamarkan lebih dulu.
 */
export const EMAIL_TOKEN = '{{email}}'
export const PHONE_TOKEN = '{{phone}}'

const EMAIL_TOKEN_RE = /\{\{\s*email\s*\}\}/gi
const PHONE_TOKEN_RE = /\{\{\s*(?:phone|telepon)\s*\}\}/gi
const EMAIL_RE = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g
// Hanya pola nomor telepon yang jelas (awalan +, 62, atau 08), supaya rentang tahun "2019 - 2023" tidak ikut tersamar.
// Pemisah hanya spasi atau tab, supaya penyamaran tidak menyeberang ke baris berikutnya.
const PHONE_RE = /(?:\+\d{1,3}[ \t.-]?\(?\d[\d \t().-]{6,16}\d|\b(?:62|0)8[\d \t.-]{7,14}\d)/g

/** Baris profil untuk prompt: token bila nilainya ada, "(not provided)" bila kosong. */
export function contactPromptValue(value: string | null | undefined, token: string): string {
  return value && String(value).trim() ? `${token} (the real value is filled in by the system; copy the token exactly)` : '(not provided)'
}

/** Memasang nilai asli ke token. Token tanpa nilai dibuang, beserta pemisah yang jadi menggantung. */
export function fillContactTokens(text: string, contact: { email?: string | null; phone?: string | null }): string {
  if (!text) return text
  const email = (contact.email ?? '').trim()
  const phone = (contact.phone ?? '').trim()
  const filled = text.replace(EMAIL_TOKEN_RE, email).replace(PHONE_TOKEN_RE, phone)
  if (filled === text) return text
  return filled
    .split('\n')
    .map((line) => line
      .replace(/(\s*[|•·,]\s*){2,}/g, ' | ')
      .replace(/^\s*[|•·,]\s*/, '')
      .replace(/\s*[|•·,]\s*$/, '')
      .replace(/\b(?:Email|E-mail|Phone|Telepon|HP)\s*:\s*(?=\||$)/gi, '')
      .replace(/(\s*\|\s*){2,}/g, ' | ')
      .replace(/^\s*\|\s*|\s*\|\s*$/g, '')
      .trimEnd())
    .join('\n')
}

/** Menyamarkan email dan nomor telepon di teks yang akan dikirim ke model. */
export function maskContact(text: string): string {
  if (!text) return text
  return text.replace(EMAIL_RE, '[email]').replace(PHONE_RE, '[telepon]')
}
