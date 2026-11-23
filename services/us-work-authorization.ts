import { countryFromLocation } from './applicant-fallbacks.js'

/**
 * Aturan bersama untuk kolom `user_automation_settings.us_citizenship`, dipakai planner ekstensi
 * (extension-planner.ts) dan pengisi formulir lama (form-autofill.service.ts, lewat approval-answers.service.ts dan
 * POST /api/ai/fill-form), supaya keduanya sepakat.
 *
 * Kolom itu soal kewarganegaraan Amerika Serikat, teks bebas, tanpa daftar pilihan. Aturannya:
 *   1. Hanya dipakai untuk lowongan yang negaranya jelas Amerika Serikat (dari teks `jobs.location`). Negara lain,
 *      lokasi tanpa nama negara ("Remote", "Austin, TX"), atau lokasi kosong: tidak dijawab, pengguna ditanya.
 *   2. Nilai kolom dicocokkan persis (sesudah dinormalkan), bukan dengan pola kata. Pola `\bcitizen\b` cocok dengan
 *      "Non-citizen" dan "Not a citizen", lalu menjawab Yes.
 *   3. Kolom kosong atau nilai di luar daftar tidak pernah memicu jawaban "Yes" maupun jawaban cadangan seperti
 *      "Decline" atau opsi pertama.
 *
 * Berkas ini sengaja terpisah dari applicant-fallbacks.ts: berkas itu disalin byte demi byte ke paket worker.
 */

const YES_LIKE = new Set(['yes', 'ya', 'iya', 'true', 'y', 'setuju', 'i agree'])

export const isYesLike = (s: string): boolean => YES_LIKE.has(s.trim().toLowerCase().replace(/[.!\s]+$/, ''))

/**
 * Nilai persis (sesudah dinormalkan) yang berarti pengguna berhak bekerja di Amerika Serikat tanpa sponsor visa.
 * Sengaja daftar nilai persis, bukan pola kata.
 */
export const US_WORK_AUTHORIZED_VALUES: ReadonlySet<string> = new Set([
  'citizen',
  'us citizen',
  'united states citizen',
  'american citizen',
  'permanent resident',
  'us permanent resident',
  'lawful permanent resident',
  'green card',
  'green card holder',
  'us green card holder',
])

export const normalizeCitizenshipValue = (raw: unknown): string =>
  String(raw ?? '')
    .toLowerCase()
    .replace(/\./g, '')
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[!\s]+$/, '')

/** True hanya bila teks lokasi lowongan menyebut Amerika Serikat dengan jelas ("..., United States", "..., USA"). */
export function isUsJobLocation(jobLocation: unknown): boolean {
  return countryFromLocation(typeof jobLocation === 'string' ? jobLocation : '') === 'United States'
}

/**
 * Jawaban izin kerja ("Yes") yang boleh diturunkan dari `us_citizenship`; kosong bila lowongan bukan di Amerika
 * Serikat (atau tidak jelas) atau nilai kolom di luar daftar persis.
 */
export function workAuthorizationFromUsCitizenship(usCitizenship: unknown, jobLocation: unknown): string {
  if (!isUsJobLocation(jobLocation)) return ''
  const value = normalizeCitizenshipValue(usCitizenship)
  if (!value) return ''
  return US_WORK_AUTHORIZED_VALUES.has(value) || isYesLike(value) ? 'Yes' : ''
}

export interface CitizenshipFormAnswer {
  value: string
  /** 0 berarti "tidak ada jawaban yang aman": pengguna ditanya, sama seperti kota dan sponsor visa yang kosong. */
  confidence: number
}

const NO_ANSWER: CitizenshipFormAnswer = { value: '', confidence: 0 }
const MATCHED_CONFIDENCE = 0.9

/**
 * Jawaban untuk pertanyaan formulir "kewarganegaraan" atau "eligible to work".
 *   - Lowongan bukan di Amerika Serikat, atau tidak jelas: kosong.
 *   - Ada daftar pilihan: hanya pilihan yang persis sama dengan nilai pengguna, atau pilihan Yes bila nilai pengguna
 *     berarti berhak bekerja. Tanpa kecocokan: kosong (tidak ada pilihan pertama atau "Decline" yang diada-adakan).
 *   - Tanpa daftar pilihan: "Yes" untuk pertanyaan "eligible to work" bila berhak; untuk pertanyaan kewarganegaraan,
 *     nilai pengguna apa adanya, hanya bila nilainya termasuk daftar berhak bekerja.
 */
export function citizenshipFormAnswer(args: {
  usCitizenship: unknown
  jobLocation: unknown
  options?: string[]
  eligibleToWork?: boolean
}): CitizenshipFormAnswer {
  if (!isUsJobLocation(args.jobLocation)) return NO_ANSWER
  const raw = String(args.usCitizenship ?? '').trim()
  const norm = normalizeCitizenshipValue(raw)
  if (!norm) return NO_ANSWER

  const authorized = workAuthorizationFromUsCitizenship(raw, args.jobLocation) === 'Yes'
  const options = Array.isArray(args.options) ? args.options.map((o) => String(o)).filter((o) => o.trim() !== '') : []

  if (options.length > 0) {
    const exact = options.find((o) => normalizeCitizenshipValue(o) === norm)
    if (exact) return { value: exact, confidence: MATCHED_CONFIDENCE }
    if (authorized) {
      const yes = options.find((o) => isYesLike(o))
      if (yes) return { value: yes, confidence: MATCHED_CONFIDENCE }
    }
    return NO_ANSWER
  }

  if (args.eligibleToWork) return authorized ? { value: 'Yes', confidence: MATCHED_CONFIDENCE } : NO_ANSWER
  return US_WORK_AUTHORIZED_VALUES.has(norm) ? { value: raw, confidence: MATCHED_CONFIDENCE } : NO_ANSWER
}
