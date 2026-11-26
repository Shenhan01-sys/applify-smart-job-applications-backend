// Pelengkap klasifikator pertanyaan fakta pribadi (personal-fact-questions.ts, salinan dari frontend).
//
// Klasifikator frontend belum mengenali beberapa pertanyaan formulir ATS yang juga hanya bisa dijawab pengguna: usia
// minimal 18 tahun, pemakaian produk perusahaan, nomor identitas (NIK atau KTP), kesanggupan hadir di kantor, rujukan dari
// karyawan atau pimpinan, dan "currently employed by <perusahaan>". Berkas ini menambahkannya tanpa mengubah salinan
// frontend, dan memberi satu pintu masuk untuk backend dan worker: `classifyPersonalFact`.
//
// Berkas ini disalin byte demi byte ke worker/src/lib/personal-fact-extras.ts; ubah keduanya sekaligus. Tes worker
// (tests/personal-fact-questions.test.ts) memeriksa kesamaannya. Fungsi murni, satu-satunya impor adalah salinan frontend.

import { PERSONAL_FACT_REASON, personalFactCategory, type PersonalFactCategory } from './personal-fact-questions.js'

export type ExtraPersonalFactCategory =
  | 'age_requirement'
  | 'product_usage'
  | 'national_id'
  | 'office_attendance'
  | 'employee_referral'

export type NeedsUserCategory = PersonalFactCategory | ExtraPersonalFactCategory

/** Penjelasan ke pengguna untuk kelas tambahan, dengan nada yang sama dengan PERSONAL_FACT_REASON. */
export const EXTRA_PERSONAL_FACT_REASON: Record<ExtraPersonalFactCategory, string> = {
  age_requirement: 'Usiamu hanya kamu yang tahu.',
  product_usage: 'Pemakaian produk perusahaan ini hanya kamu yang tahu.',
  national_id: 'Nomor identitas hanya kamu yang boleh mengisi.',
  office_attendance: 'Kesanggupan hadir di kantor atau pindah lokasi hanya kamu yang bisa memastikan.',
  employee_referral: 'Rujukan dari karyawan atau pimpinan hanya kamu yang tahu.',
}

export interface PersonalFactVerdict {
  category: NeedsUserCategory
  reason: string
}

/** "Nama lengkap (sesuai KTP)" menanyakan nama, bukan nomornya: keterangan di belakang label dibuang sebelum diuji. */
const NAME_AS_ON_ID =
  /\s*[(\[]?\s*(?:sesuai|as per|as on|as in|according to|based on)\s+(?:ktp|ijazah|identitas|paspor|passport|akta|id|nik)\b[^)\]]*[)\]]?\s*$/i

// Angka usia harus berdiri sendiri: "at least 18 months" atau "over 21 projects" bukan pertanyaan usia.
const AGE_NUMBER = String.raw`(?:18|21|eighteen|twenty[- ]one)(?=\s*(?:\?|$|[,.;)]|years?\b|yrs?\b|y\.?o\b|of age|(?:or|and) (?:older|above|over)))`

const EXTRA_RULES: Array<[NeedsUserCategory, RegExp]> = [
  [
    'prior_employment',
    /\b(?:currently|previously|ever|formerly|presently)\b[^?]{0,40}\b(?:been\s+)?(?:employed|engaged|contracted|retained)\s+(?:by|at|with)\b|\bhave you (?:ever )?been (?:employed|an? (?:employee|intern|contractor|consultant))\b|\bare you (?:currently |presently )?(?:an? )?(?:current )?(?:employee|employed)\b|\bwork(?:s|ed|ing)?\s+(?:for|at)\s+(?:us|our company|this company|the company)\b/i,
  ],
  [
    'age_requirement',
    new RegExp(
      String.raw`\b${AGE_NUMBER}[^?]{0,25}\b(?:years?\s+(?:of age|old)|yrs?\s+old|or older|and (?:older|over))|\b(?:at least|over|above|older than|minimum age(?: of)?)\s+(?:the age of\s+)?${AGE_NUMBER}|\bage (?:of majority|requirement|limit)\b|\blegal age\b|\b(?:usia|umur|berusia)\b[^?]{0,40}\b(?:18|21|delapan belas)\b|\b(?:18|delapan belas)\s*tahun\b`,
      'i',
    ),
  ],
  [
    'national_id',
    /\bnik\b|\bktp\b|\bnpwp\b|nomor induk kependudukan|kartu tanda penduduk|\bnational (?:id|identity)\b|\b(?:id|identity) (?:card|number)\b|\bsocial security\b|\bssn\b|\btax (?:id|identification)\b|nomor identitas|no\.?\s*identitas/i,
  ],
  [
    'employee_referral',
    /\b(?:referr(?:ed|al)|recommended|endorsed|nominated)\b[^?]{0,60}\b(?:employee|leader|leadership|executive|manager|director|officer|board|colleague|staff|team member)\b|\b(?:employee|leader|leadership|executive|manager|director|officer|staff)\b[^?]{0,40}\b(?:referr(?:ed|al)|recommend\w*)\b|\bdo you know\b[^?]{0,40}\b(?:anyone|someone)\b[^?]{0,40}\b(?:works?|working|employed)\b|\b(?:friends?|family|acquaintances?)\b[^?]{0,40}\b(?:work(?:s|ing)?|employed)\b[^?]{0,20}\b(?:at|for|with)\b|direkomendasikan|rekomendasi\s+(?:karyawan|pimpinan|atasan)|\breferensi\s+(?:karyawan|pimpinan)/i,
  ],
  [
    'product_usage',
    /\b(?:do|did|have|are|were)\s+you\b(?![^?]*\b(?:experience|familiar\w*|skills?|proficien\w*|knowledge|languages?|frameworks?|tools?|technolog\w+|stack|librar\w+)\b)[^?]{0,40}\b(?:use[ds]?|using|been using|an? (?:existing |current )?(?:user|customer|subscriber|member))\b[^?]{0,50}\b(?:products?|services?|platform|apps?|application|exchange|wallet|website)\b|\b(?:existing|current)\s+(?:customer|user)\b|\b(?:pengguna|pelanggan|nasabah)\b[^?]{0,40}\b(?:produk|layanan|aplikasi|platform)\b|\bmenggunakan\b[^?]{0,40}\b(?:produk|layanan|aplikasi)\b[^?]{0,30}\b(?:kami|perusahaan)\b/i,
  ],
  [
    'office_attendance',
    /^(?![^?]*\bexperience\b).*?(?:\b(?:work|working|be|being|come|coming|commute|attend|report)\b[^?]{0,40}\b(?:(?:from )?(?:the |our |an )?office|on[- ]?site|in[- ]person|in[- ]office)\b|\b(?:on[- ]?site|in[- ]office|in[- ]person)\b[^?]{0,40}\b(?:required|requirement|expectation|days?|comfortable|willing|able|available)\b|\b(?:in|at|from)\s+(?:the|our)\s+office\b[^?]{0,40}\b(?:days?|times?|per|a week|weekly|required|willing|able)\b|\bhybrid\s+(?:work|working|schedule|arrangement|model|setup|environment|role|position)\b|\b(?:willing|able|open|prepared|comfortable)\b[^?]{0,30}\bhybrid\b|\brelocat\w+|\bwfo\b|\bwfh\b|\b(?:hadir|bekerja|masuk|datang)\b[^?]{0,40}\bkantor\b|\b(?:bersedia|sanggup|bisa|mau)\b[^?]{0,60}\b(?:kantor|onsite|on-site|hybrid|wfo|ditempatkan|penempatan)\b)/i,
  ],
  [
    'demographics',
    /\bhispanic\b|\bhandicap\w*|\blatin[oxae]s?\b|\btransgender\b|\blgbtq\w*|\bnon[- ]binary\b|\beeo\b|\bequal (?:employment|opportunity)\b|\bself[- ]identif\w+|\bprotected (?:class|group|veteran)\b|\bmilitary (?:service|status)\b|\barmed forces\b|\bdiversity (?:survey|question\w*|data)\b|\bgender identity\b|\bwarna kulit\b|\bsuku bangsa\b|\bidentitas gender\b/i,
  ],
]

const reasonOf = (category: NeedsUserCategory): string =>
  category in EXTRA_PERSONAL_FACT_REASON
    ? EXTRA_PERSONAL_FACT_REASON[category as ExtraPersonalFactCategory]
    : PERSONAL_FACT_REASON[category as PersonalFactCategory]

/**
 * Kelas dan alasan bila pertanyaan formulir hanya bisa dijawab pengguna sendiri, atau null bila AI boleh
 * menjawabnya dari profil. Aturan frontend dipakai lebih dulu (label dan pilihannya), lalu aturan tambahan
 * (label saja, karena pilihan jawaban sering berisi kata umum).
 */
export function classifyPersonalFact(label: unknown, options?: unknown): PersonalFactVerdict | null {
  const text = typeof label === 'string' ? label.replace(NAME_AS_ON_ID, '') : ''
  const base = personalFactCategory(text, options)
  if (base) return { category: base, reason: PERSONAL_FACT_REASON[base] }
  const haystack = text.replace(/\s+/g, ' ').trim()
  if (!haystack) return null
  for (const [category, re] of EXTRA_RULES) if (re.test(haystack)) return { category, reason: reasonOf(category) }
  return null
}
