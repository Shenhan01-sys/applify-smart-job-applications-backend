import type { SanitizedExtControl } from './extension-planner.js'

/**
 * Penjaga jenis isian untuk rencana Ekstensi Browser Applify.
 *
 * Uji kirim nyata SmartRecruiters (27 November 2026): kolom wajib `Institution*` pada blok Education ke-4 terisi URL
 * LinkedIn. Dua aturan di sini menutup celahnya di semua jalur (jawaban tersimpan, pencocokan fakta, AI):
 *   1. Nilai yang berupa satu URL hanya boleh masuk kolom yang memang menanyakan URL, tautan, LinkedIn, GitHub,
 *      website, atau portofolio. Selain itu aksinya dibuang dan kolomnya menjadi pertanyaan "Perlu dicek".
 *   2. Kolom Institution, School, dan University hanya diisi dari tabel `education` (atau dibiarkan kosong).
 */

type GuardControl = Pick<SanitizedExtControl, 'kind' | 'label' | 'groupLabel' | 'name' | 'placeholder' | 'inputType'> & {
  elementId?: string
  inputMode?: string
}

const normalize = (text: string): string =>
  String(text ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[_\-./[\]:*]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

/** Situs yang dikenal sebagai alamat profil, boleh tanpa skema ("github.com/budi"). */
const KNOWN_PROFILE_HOSTS = 'linkedin|github|gitlab|bitbucket|behance|dribbble|twitter|facebook|instagram|medium|kaggle|stackoverflow'

/**
 * Apakah `value` seluruhnya satu URL (tanpa spasi): berskema http(s), berawalan `www.`, atau alamat profil tanpa skema.
 * Teks panjang yang hanya memuat tautan di dalam kalimat (surat lamaran, esai) bukan URL. Nama seperti "Node.js" juga bukan.
 */
export function isUrlValue(value: unknown): boolean {
  if (typeof value !== 'string') return false
  const text = value.trim()
  if (!text || /\s/.test(text)) return false
  if (/^https?:\/\/\S+$/i.test(text) || /^www\.\S+\.\S+$/i.test(text)) return true
  return new RegExp(`^(?:[a-z0-9-]+\\.)*(?:${KNOWN_PROFILE_HOSTS})\\.(?:com|net|io|co|org|me|dev)(?:\\/\\S*)?$`, 'i').test(text)
}

/**
 * Kata yang menandai kolom meminta URL. Sengaja sempit: kolom berlabel lain (Institution, Company, Description)
 * tidak pernah menerima URL walau judul grup atau atribut `name`-nya menyebut LinkedIn.
 */
const URLISH_RE =
  /\b(?:urls?|uri|links?|tautan|website|web ?sites?|web ?pages?|situs|laman|portfolio|portofolio|linkedin|github|gitlab|bitbucket|twitter|behance|dribbble|homepage|home page|blog|social|sosmed|personal site|online profiles?|web profiles?|profile urls?)\b/

/** Label polos yang artinya ditentukan judul grupnya ("Profile" di bawah grup "Links"). Label bermakna lain tidak ikut grup. */
const GENERIC_OWN_LABEL_RE = /^(?:profile|profil|account|akun|username|user name|handle|other|lainnya|custom|additional|extra|input|field|text)$/

const INSTITUTION_NOUN_RE =
  /\b(?:institutions?|institutes?|institusi|schools?|sekolah|sma|smk|universit(?:y|ies|as)|colleges?|kampus|perguruan tinggi|almamater|alma mater|academy|akademi|politeknik)\b/

/** Atribut lain dari pendidikan (lokasi, tahun, nilai, jurusan): label seperti ini bukan nama institusi. */
const EDUCATION_ATTRIBUTE_RE =
  /\b(?:locations?|lokasi|city|kota|country|negara|state|province|provinsi|year|years|tahun|date|tanggal|start|end|gpa|ipk|grade|nilai|degrees?|majors?|minor|field|jurusan|program|study|studi|level|type|jenis|status|graduat\w*|lulus|descriptions?|deskripsi|address|alamat|email|phone|telepon|contact|kontak|zip|postal|id|number|nomor|honou?rs|activities|thesis|skripsi|credits|sks|semester|duration|durasi|month|bulan|website|url|link)\b/

/** Pertanyaan ("Did you attend a university?") dijawab model atau pengguna, bukan nama institusi. */
const QUESTION_START_RE = /^(?:do|did|does|have|has|are|is|will|would|can|could|should|which|what|when|where|how|why|apakah|pernah|pernahkah|dimana|di mana|kapan|mengapa)\b/

/** Teks label kolom itu sendiri (bukan judul grup): label, lalu placeholder, lalu atribut name atau id. */
function ownText(c: GuardControl): string {
  return normalize(c.label || c.placeholder || c.name || c.elementId || '')
}

/**
 * Apakah kolom menanyakan URL: tipe input url, label (atau placeholder berawalan http) yang menyebut URL, tautan,
 * LinkedIn, GitHub, website, atau portofolio, atau atribut name/id yang menyebutnya. Label polos tanpa kata kunci
 * ("Profile", "Other") ikut judul grupnya. Kolom bernama institusi tidak pernah dianggap kolom URL oleh name, id, atau judul grupnya.
 */
export function isUrlishControl(c: GuardControl): boolean {
  if (String(c.inputType ?? '').toLowerCase() === 'url' || String(c.inputMode ?? '').toLowerCase() === 'url') return true
  const own = ownText(c)
  if (URLISH_RE.test(own)) return true
  if (/^(?:https?:\/\/|www\.)/i.test(String(c.placeholder ?? '').trim())) return true
  if (INSTITUTION_NOUN_RE.test(own)) return false
  if (URLISH_RE.test(normalize(`${c.name} ${c.elementId ?? ''}`))) return true
  return (!own || GENERIC_OWN_LABEL_RE.test(own)) && URLISH_RE.test(normalize(c.groupLabel))
}

/**
 * Kolom nama institusi pendidikan: Institution, School, University, College, "Name of school", "School name", "High school".
 * Bukan atribut lain (School location, Graduation year, Degree, Field of study) dan bukan pertanyaan ("Did you attend...?").
 * Hanya kolom teks atau pilihan.
 */
export function isInstitutionControl(c: GuardControl): boolean {
  if (c.kind !== 'text' && c.kind !== 'select') return false
  const raw = String(c.label || c.placeholder || c.name || c.elementId || '')
  if (raw.includes('?')) return false
  const own = normalize(raw)
  if (!own || QUESTION_START_RE.test(own)) return false
  return INSTITUTION_NOUN_RE.test(own) && !EDUCATION_ATTRIBUTE_RE.test(own)
}

/** Kolom nama institusi setingkat SMA ("High school", "SMA/SMK", "Secondary school"). */
export function isHighSchoolInstitutionControl(c: GuardControl): boolean {
  return isInstitutionControl(c) && /\b(?:high school|senior high|secondary school|sma|smk|sekolah menengah)\b/.test(ownText(c))
}

/** Aksi isian minimal yang diperiksa penjaga URL. */
interface GuardAction {
  controlId: string
  value: unknown
}

/**
 * Buang aksi teks yang bernilai satu URL padahal kolomnya tidak menanyakan URL. Mengembalikan aksi yang lolos dan id
 * kolom yang dibuang, supaya pemanggil menjadikannya pertanyaan "Perlu dicek". Aksi untuk id yang tidak dikenal dibiarkan.
 */
export function dropMisplacedUrlActions<A extends GuardAction>(
  actions: readonly A[],
  controls: readonly (GuardControl & { controlId: string })[]
): { actions: A[]; droppedControlIds: string[] } {
  const byId = new Map(controls.map((c) => [c.controlId, c]))
  const kept: A[] = []
  const droppedControlIds: string[] = []
  for (const action of actions) {
    const control = byId.get(action.controlId)
    if (control && isUrlValue(action.value) && !isUrlishControl(control)) {
      droppedControlIds.push(action.controlId)
      continue
    }
    kept.push(action)
  }
  return { actions: kept, droppedControlIds }
}
