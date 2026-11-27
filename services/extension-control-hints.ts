import type { SanitizedExtControl } from './extension-planner.js'

/**
 * Petunjuk jenis kontrol yang tidak boleh menjadi pertanyaan pilihan di kartu Persetujuan:
 *
 *   - Pemilih kode negara telepon (label "IDN", "+62", "Kode negara"; pilihan memuat kode telepon). Selalu diisi
 *     Indonesia (+62) dan tidak pernah ditanyakan.
 *   - Kontrol unggah berkas yang tampil sebagai dropdown ("File PDF", "Unggah berkas"). Bukan pilihan: berkasnya
 *     dipasang dari profil atau diunggah pengguna sendiri, jadi dilaporkan sebagai pertanyaan jenis `file`.
 *
 * Logika yang sama ada di ekstensi (`extension/src/lib/controlHints.ts`), karena ekstensi juga menyusun pertanyaan
 * dari kolom yang tidak terisi. Ubah keduanya bersama.
 */

type HintControl = Pick<SanitizedExtControl, 'kind' | 'label' | 'groupLabel' | 'name' | 'placeholder' | 'options' | 'currentValue'> & {
  elementId?: string
}

const DIAL_OPTION_RE = /\+\s?\d{1,4}\b/
const COUNTRY_CODE_LABEL_RE =
  /\b(?:kode\s+(?:negara|telepon|telp|area|panggilan)|country\s+code|dial(?:ing)?\s+code|calling\s+code|phone\s+(?:code|prefix|country))\b/i
/** Label yang hanya berisi kode: "+62", "IDN", "INA". Dealls menampilkan kode negara terpilih sebagai label kolomnya. */
const BARE_INDONESIA_CODE_RE = /^\s*(?:\+\s?62|IDN|INA)\s*(?:\(\s*opsional\s*\))?\s*$/i
const BARE_ANY_CODE_RE = /^\s*(?:\+\s?\d{1,4}|[A-Za-z]{2,3})\s*$/
const INDONESIA_NAME_RE = /\bindonesia\b/i
/**
 * Nama negara diikuti kode telepon ("Afghanistan +93", "Åland Islands +358", "Indonesia (+62)"): tampilan pilihan terpilih
 * pemilih kode negara SmartRecruiters. Tanpa angka di nama dan paling panjang 40 huruf, supaya label biasa tidak ikut.
 */
const COUNTRY_WITH_DIAL_RE = /^[\p{L}\p{M}][\p{L}\p{M} .,'’()-]{1,39}?\s*\(?\+\s?\d{1,4}\)?$/u
const PLUS_62_RE = /\+\s?62(?!\d)/

/** Pemilih kode negara telepon: pilihannya (paling sedikit tiga) sebagian besar memuat kode telepon, atau labelnya menyebut kode negara. */
export function isCountryCodeSelect(c: HintControl): boolean {
  if (c.kind !== 'select') return false
  const options = Array.isArray(c.options) ? c.options : []
  const dialOptions = options.filter((o) => DIAL_OPTION_RE.test(o)).length
  if (options.length >= 3 && dialOptions / options.length >= 0.6) return true
  const own = [c.label, c.groupLabel, c.name, c.placeholder, c.elementId ?? ''].join(' ')
  if (COUNTRY_CODE_LABEL_RE.test(own)) return true
  const shown = [c.label, c.currentValue].map((v) => String(v ?? '').trim()).filter(Boolean)
  if (shown.some((v) => BARE_INDONESIA_CODE_RE.test(v) || COUNTRY_WITH_DIAL_RE.test(v))) return true
  // Label berupa kode negara lain ("SGP", "+65") hanya dihitung bila pilihannya memang daftar negara atau kode telepon.
  return (
    shown.some((v) => BARE_ANY_CODE_RE.test(v)) &&
    options.some((o) => DIAL_OPTION_RE.test(o) || INDONESIA_NAME_RE.test(o))
  )
}

/** Pilihan Indonesia (+62) dari daftar kode negara, atau null bila daftarnya kosong atau tidak memuat Indonesia. */
export function indonesiaDialOption(options: readonly string[]): string | null {
  const list = options.filter((o) => typeof o === 'string' && o.trim())
  const find = (re: RegExp) => list.find((o) => re.test(o)) ?? null
  return (
    list.find((o) => INDONESIA_NAME_RE.test(o) && PLUS_62_RE.test(o)) ??
    find(PLUS_62_RE) ??
    find(/\b(?:IDN|INA)\b/) ??
    find(INDONESIA_NAME_RE) ??
    null
  )
}

/** Nilai terpilih sekarang sudah Indonesia (+62): label kolom atau nilainya menyebutnya. */
export function showsIndonesiaCode(c: Pick<HintControl, 'label' | 'currentValue'>): boolean {
  return [c.label, c.currentValue].some((v) => {
    const text = String(v ?? '').trim()
    return BARE_INDONESIA_CODE_RE.test(text) || PLUS_62_RE.test(text) || INDONESIA_NAME_RE.test(text)
  })
}

const FILE_LABEL_RE = /\b(?:file|berkas|pdf|docx?|unggah|upload|lampiran|lampirkan|attach(?:ment)?)\b/i
const FILE_OPTION_RE = /\b(?:file|berkas|pdf|docx?|unggah|upload|lampiran|lampirkan|attach(?:ment)?|browse|choose|pilih)\b/i

/**
 * Kontrol pilihan yang sebenarnya unggah berkas: labelnya menyebut file/berkas/PDF/unggah, dan pilihannya kosong
 * atau seluruhnya juga kata unggah ("File PDF"). Dropdown yang pilihannya jawaban nyata (mis. "Dokumen identitas"
 * dengan KTP atau Paspor) bukan unggahan.
 */
export function isFileLikeSelect(c: HintControl): boolean {
  if (c.kind !== 'select') return false
  const own = [c.label, c.groupLabel, c.name, c.placeholder, c.elementId ?? ''].join(' ')
  const options = Array.isArray(c.options) ? c.options : []
  if (options.length === 0) return FILE_LABEL_RE.test(own)
  return options.every((o) => FILE_OPTION_RE.test(o)) && (FILE_LABEL_RE.test(own) || options.every((o) => FILE_LABEL_RE.test(o)))
}
