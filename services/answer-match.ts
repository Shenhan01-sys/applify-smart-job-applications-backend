/**
 * Pencocokan jawaban tersimpan (`user_form_answers`) yang fleksibel namun aman untuk perencana ekstensi:
 *   1. Cocok persis lewat `questionKey(label)`.
 *   2. Cocok kanonis (normalisasi pengisi kalimat & sinonim ID-EN seperti umur/usia/age, tempat lahir/birth place).
 *   3. Cocok tumpang-tindih kata inti (>= 0.72 overlap, min 2 token) dengan penjaga agar makna berlawanan
 *      (mis. start vs end, current vs expected, high school vs university) tidak pernah tertukar.
 */

export interface SavedAnswerEntry {
  key: string
  label: string
  answer: string
}

const STOPWORDS = new Set([
  'what', 'is', 'are', 'your', 'the', 'a', 'an', 'in', 'of', 'for', 'to', 'do', 'you', 'have', 'please',
  'enter', 'select', 'provide', 'tell', 'us', 'currently', 'current', 'present', 'now', 'about',
  'apa', 'apakah', 'berapa', 'siapa', 'dimana', 'di', 'mana', 'yang', 'anda', 'kamu', 'mu', 'nya',
  'silakan', 'isi', 'pilih', 'masukkan', 'tuliskan', 'sebutkan', 'saat', 'ini', 'sekarang', 'terkait',
])

const SYNONYM_BUCKETS: Array<[RegExp, string]> = [
  [/\b(?:umur(?:mu|nya)?|usia(?:mu|nya)?|age)\b/i, 'concept_age'],
  [/\b(?:tempat lahir|kota lahir|birth\s*place|place of birth|city of birth)\b/i, 'concept_birth_place'],
  [/\b(?:tanggal lahir|tgl lahir|birth\s*date|date of birth|dob)\b/i, 'concept_birth_date'],
  [/\b(?:tahun lulus|graduation year|year of (?:high school )?graduation|high school graduation year)\b/i, 'concept_grad_year'],
  [/\b(?:nama sma|nama sekolah menengah|high school name|senior high school)\b/i, 'concept_high_school'],
  [/\b(?:lama pengalaman|tahun pengalaman|years? of(?: relevant| work)? experience|total(?: work)? experience)\b/i, 'concept_exp_years'],
  [/\b(?:ekspektasi gaji|gaji yang diharapkan|expected (?:monthly )?salary|desired salary)\b/i, 'concept_expected_salary'],
  [/\b(?:gaji saat ini|gaji terakhir|current (?:monthly )?salary|last salary received)\b/i, 'concept_current_salary'],
  [/\b(?:portofolio|portfolio)(?: link| url)?\b/i, 'concept_portfolio'],
  [/\b(?:kewarganegaraan|nationality|citizenship)\b/i, 'concept_nationality'],
  [/\b(?:negara paspor|passport country)\b/i, 'concept_passport_country'],
  [/\b(?:in which country do you(?: currently)? (?:work|live|reside)|country you currently (?:work|live|reside) in|country of residence|negara domisili)\b/i, 'concept_residence_country'],
  [/\b(?:discipline|major(?: of study)?|field of study|jurusan|program studi)\b/i, 'concept_major'],
  [/\b(?:which gender|gender identity|jenis kelamin)\b/i, 'concept_gender'],
  [/^(?:(?:name of |your |last )?(?:university|universitas|college|kampus|institut|institution|almamater)(?: name)?|school(?: name)?|nama sekolah|nama universitas)$/i, 'concept_university'],
  [/\b(?:over the age of 18|18 years old|usia 18|berusia 18)\b/i, 'concept_over_18'],
  [/\b(?:bersedia relokasi|willing to relocate|relocation)\b/i, 'concept_relocate'],
  [/\b(?:kapan bisa bergabung|how soon are you able to join|earliest start date|ketersediaan mulai)\b/i, 'concept_join_when'],
]

const CONFLICT_GROUPS: ReadonlyArray<[RegExp, RegExp]> = [
  [/\b(?:start|mulai|awal|from|dari)\b/i, /\b(?:end|berakhir|akhir|selesai|until|to|sampai)\b/i],
  [/\b(?:current|saat ini|terakhir|last|previous)\b/i, /\b(?:expected|desired|diharapkan|ekspektasi)\b/i],
  [/\b(?:high school|sma|smk|sekolah menengah)\b/i, /\b(?:university|universitas|college|kampus|bachelor|s1|s2|master|(?<!high\s)school)\b/i],
  [/\b(?:first|depan)\b/i, /\b(?:last|belakang)\b/i],
]

const normalizeKey = (label: string): string =>
  String(label ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\((?:required|wajib|wajib diisi)\)/g, '')
    .replace(/\*/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .slice(0, 200)
    .trim()

function contentTokens(label: string): string[] {
  const key = normalizeKey(label)
  if (!key) return []
  return key.split(' ').filter((t) => t.length > 1 && !STOPWORDS.has(t))
}

function conceptTag(label: string): string | null {
  const k = normalizeKey(label)
  if (!k) return null
  for (const [re, tag] of SYNONYM_BUCKETS) {
    if (re.test(k)) return tag
  }
  return null
}

function hasDirectionConflict(a: string, b: string): boolean {
  for (const [left, right] of CONFLICT_GROUPS) {
    if ((left.test(a) && right.test(b)) || (right.test(a) && left.test(b))) return true
  }
  return false
}

/**
 * Cari jawaban tersimpan untuk label formulir tanpa harus sama persis huruf-demi-huruf.
 * Tetap aman: tidak pernah menukar pertanyaan berlawanan (mulai vs selesai, gaji saat ini vs ekspektasi, SMA vs kuliah).
 */
export function findFlexibleSavedAnswer(label: string, saved: readonly SavedAnswerEntry[]): SavedAnswerEntry | undefined {
  const exactKey = normalizeKey(label)
  if (!exactKey || saved.length === 0) return undefined
  const direct = saved.find((e) => normalizeKey(e.key) === exactKey)
  if (direct) return direct

  const targetTag = conceptTag(label)
  if (targetTag) {
    for (const entry of saved) {
      if (conceptTag(entry.label || entry.key) === targetTag && !hasDirectionConflict(label, entry.label || entry.key)) {
        return entry
      }
    }
  }

  const targetTokens = contentTokens(label)
  if (targetTokens.length < 2) return undefined
  const targetSet = new Set(targetTokens)

  let best: SavedAnswerEntry | undefined
  let bestScore = 0
  for (const entry of saved) {
    const srcText = entry.label || entry.key
    if (hasDirectionConflict(label, srcText)) continue
    const candTokens = contentTokens(srcText)
    if (candTokens.length < 2) continue
    const candSet = new Set(candTokens)
    let hit = 0
    for (const t of targetSet) if (candSet.has(t)) hit++
    if (hit < 2) continue
    const union = new Set([...targetSet, ...candSet]).size
    const jaccard = hit / union
    const containment = hit / Math.min(targetSet.size, candSet.size)
    const score = Math.max(jaccard, containment * 0.9)
    if (score >= 0.72 && score > bestScore) {
      bestScore = score
      best = entry
    }
  }
  return best
}
