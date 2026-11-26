// SALINAN. Asal: applify-smart-job-applications/supabase/functions/_shared/personal-fact-questions.ts
// (repositori frontend, commit c59c1f6). Isi di bawah penanda disalin apa adanya, tanpa perubahan perilaku.
// Ubah di frontend dulu, lalu salin ulang ke dua tempat ini sekaligus:
//   backend/services/personal-fact-questions.ts
//   worker/src/lib/personal-fact-questions.ts
// Tes worker (tests/personal-fact-questions.test.ts) memeriksa kedua salinan sama persis. Tes backend memeriksa isi di
// bawah penanda sama dengan berkas frontend bila repositori frontend ada di samping backend.
// Pelengkap lokal yang tidak ada di frontend (usia, pemakaian produk, NIK atau KTP, hadir di kantor, rujukan karyawan):
// personal-fact-extras.ts.
// ---- salinan dimulai di bawah baris ini ----
// Pertanyaan formulir yang hanya bisa dijawab pengguna sendiri.
//
// Temuan E2E production 27 November 2026: AI menjawab pertanyaan formulir lowongan dengan fakta pribadi yang tidak ada
// di profil. Kewarganegaraan, izin kerja atau visa, kerabat pejabat, riwayat bekerja di perusahaan itu, dari mana
// lowongan ditemukan, dan kesanggupan mengikuti durasi magang adalah pernyataan tentang dunia nyata yang berakibat hukum
// atau penilaian. Jawaban karangan di sini lebih berbahaya daripada kolom kosong. Berkas ini mengenali pertanyaan
// seperti itu dari labelnya (Inggris dan Indonesia), supaya pembuat jawaban tidak memanggil model, menandai kartunya
// "Perlu dicek", dan menyerahkan jawabannya ke pengguna.
//
// Edge Function generate-application hanya menulis surat lamaran, jadi di repositori ini kelasnya dipakai prompt surat
// (EXPERIENCE_CLAIM_RULES melarang menyebut fakta ini). Pembuat jawaban formulir ada di backend
// (services/ai-pipeline.service.ts) dan worker, repositori terpisah: berkas ini disalin ke sana lalu dipakai sebelum
// memanggil model. Fungsi murni, tanpa impor, jalan di Deno, Node, dan peramban.

export type PersonalFactCategory =
  | 'citizenship'
  | 'work_authorization'
  | 'sponsorship'
  | 'government_relative'
  | 'prior_employment'
  | 'job_source'
  | 'internship_availability'
  | 'criminal_record'
  | 'demographics'

export const NEEDS_CHECK_LABEL = 'Perlu dicek'

/** Penjelasan ke pengguna, per kelas. */
export const PERSONAL_FACT_REASON: Record<PersonalFactCategory, string> = {
  citizenship: 'Kewarganegaraan hanya kamu yang tahu.',
  work_authorization: 'Izin kerja atau visa hanya kamu yang tahu.',
  sponsorship: 'Kebutuhan sponsor visa hanya kamu yang tahu.',
  government_relative: 'Hubungan dengan pejabat atau pegawai pemerintah hanya kamu yang tahu.',
  prior_employment: 'Riwayat bekerja di perusahaan ini hanya kamu yang tahu.',
  job_source: 'Dari mana kamu menemukan lowongan ini hanya kamu yang tahu.',
  internship_availability: 'Kesanggupan mengikuti durasi dan jadwal ini hanya kamu yang bisa memastikan.',
  criminal_record: 'Riwayat hukum hanya kamu yang tahu.',
  demographics: 'Data demografis bersifat pribadi dan boleh tidak dijawab.',
}

const RULES: Array<[PersonalFactCategory, RegExp]> = [
  ['sponsorship', /\b(?:require|need|needs)\b[^?]{0,40}\bsponsor\w*|\bsponsorship\b|\bsponsor(?:ing)?\s+(?:a\s+)?visa|sponsor visa|sponsorship visa|memerlukan sponsor|butuh sponsor/i],
  [
    'work_authorization',
    /\b(?:legally\s+)?(?:authori[sz]ed|eligible|permitted|allowed|right)\s+to\s+work|work\s+(?:authori[sz]ation|permit|eligibility)|\bvisa\b|\bright to work\b|izin\s+(?:kerja|bekerja)|surat izin kerja|\bkitas\b|\bkitap\b|\bimmigration\b|izin tinggal/i,
  ],
  [
    'citizenship',
    /\bcitizen(?:ship)?\b|\bnationality\b|\bnational of\b|warga\s*negara|kewarganegaraan|kebangsaan|\bpassport\b|\bpaspor\b/i,
  ],
  [
    'government_relative',
    /\b(?:relative|relatives|family member|family members|spouse|immediate family)\b[^?]{0,80}\b(?:government|public official|official|politician|civil servant|state[- ]owned|soe|military|police)|\b(?:government|public|political)\b[^?]{0,40}\b(?:official|employee|servant|officer)\b[^?]{0,60}\b(?:relative|related|family)|\bconflict of interest\b|\bpolitically exposed\b|kerabat|saudara[^?]{0,60}\b(?:pejabat|pegawai negeri|asn|pns|bumn|tni|polri|pemerintah)|keluarga[^?]{0,60}\b(?:pejabat|pegawai negeri|asn|pns|bumn|tni|polri|pemerintah)|hubungan keluarga/i,
  ],
  [
    'prior_employment',
    /\b(?:previously|ever|before|formerly)\b[^?]{0,40}\b(?:work(?:ed)?|employ(?:ed|ment)|intern(?:ed)?|appl(?:y|ied))\b[^?]{0,40}\b(?:for|at|with|here|company|us|this)\b|\bcurrent(?:ly)? (?:or former )?employee\b|\bformer employee\b|\bpast employee\b|\bhave you (?:ever )?(?:worked|applied)\b|pernah\s+(?:bekerja|magang|melamar|bekerja sama)|karyawan\s+(?:saat ini|sebelumnya|lama)|mantan karyawan/i,
  ],
  [
    'job_source',
    /\bhow did you (?:hear|find|learn|come across)\b|\bwhere did you (?:hear|find|see)\b|\bsource of (?:application|referral)\b|\bhow (?:you )?heard about\b|\breferr(?:ed|al)\b[^?]{0,30}\b(?:by|from|source)\b|\bhear(?:d)? about (?:this|us|the)\b|tahu\s+(?:lowongan|informasi|info)|mengetahui\s+(?:lowongan|informasi)|dari mana[^?]{0,40}(?:lowongan|informasi|info|mengetahui|tahu)|sumber\s+(?:informasi|lowongan)/i,
  ],
  [
    'internship_availability',
    /\b(?:available|availability|able|commit|committed|commitment|can you)\b[^?]{0,80}\b(?:internship|intern|weeks?|months?|duration|full[- ]time|start date|summer|semester|period)\b|\binternship\b[^?]{0,60}\b(?:duration|period|dates|schedule|weeks?|months?)\b|\bstart date\b|\bnotice period\b|\bearliest\b[^?]{0,20}\bstart\b|\bwilling to relocate\b|\bsanggup\b|\bbersedia\b[^?]{0,80}\b(?:magang|durasi|bulan|minggu|penuh waktu|full[- ]time|ditempatkan|relokasi|pindah)\b|\bdurasi magang\b|\bperiode magang\b|\btanggal mulai\b|\bmasa pemberitahuan\b/i,
  ],
  [
    'criminal_record',
    /\bcriminal\b|\bconvict(?:ed|ion)\b|\bfelony\b|\bbackground check\b|catatan kriminal|\bskck\b|pernah dihukum|terpidana/i,
  ],
  [
    'demographics',
    /\b(?:gender|sex|race|ethnicity|ethnic|veteran|disability|disabled|religion|sexual orientation|marital status|pronouns?)\b|jenis kelamin|\bsuku\b|\bagama\b|status pernikahan|status perkawinan|disabilitas|difabel/i,
  ],
]

/** Kelas fakta pribadi dari label pertanyaan (dan pilihannya), atau null bila AI boleh menjawabnya dari profil. */
export function personalFactCategory(label: unknown, options?: unknown): PersonalFactCategory | null {
  const parts = [typeof label === 'string' ? label : '']
  if (Array.isArray(options)) for (const o of options) if (typeof o === 'string') parts.push(o)
  const haystack = parts.join(' ').replace(/\s+/g, ' ').trim()
  if (!haystack) return null
  for (const [category, re] of RULES) if (re.test(haystack)) return category
  return null
}

export interface QuestionLike {
  label?: unknown
  options?: unknown
}

/**
 * Pertanyaan yang tidak boleh dijawab AI: dikembalikan dengan kelas dan alasannya, supaya kartu menandainya
 * "Perlu dicek". Pertanyaan lain tidak ikut.
 */
export function splitPersonalFactQuestions<T extends QuestionLike>(
  questions: readonly T[],
): { answerable: T[]; needsUser: Array<{ question: T; category: PersonalFactCategory; reason: string }> } {
  const answerable: T[] = []
  const needsUser: Array<{ question: T; category: PersonalFactCategory; reason: string }> = []
  for (const q of questions) {
    const category = personalFactCategory(q?.label, q?.options)
    if (category) needsUser.push({ question: q, category, reason: PERSONAL_FACT_REASON[category] })
    else answerable.push(q)
  }
  return { answerable, needsUser }
}
