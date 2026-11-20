import { stripCodeFence, stripReasoning, type AcceptOutcome } from './ai-output-guard.js'

/**
 * Penjaga keluaran model yang harus berupa SATU objek JSON (mis. impor profil dari PDF LinkedIn). Sengaja di
 * berkas terpisah: ai-output-guard.ts punya salinan identik di Edge Function (supabase/functions/_shared) dan
 * tes menjaga keduanya tetap sama, jadi berkas itu tidak diubah untuk keperluan backend saja.
 *
 * Blok penalaran dan pagar kode dibuang, lalu objek dipotong dari `{` pertama sampai `}` terakhir dan harus
 * lolos JSON.parse. `text` hasilnya JSON polos. Yang gagal ditolak, sehingga rantai model lanjut ke model berikutnya.
 */
export function acceptJsonObject(raw: string): AcceptOutcome {
  const r = stripReasoning(raw)
  if (!r.text) return { ok: false, reasons: ['empty'] }
  const fenced = stripCodeFence(r.text)
  const start = fenced.indexOf('{')
  const end = fenced.lastIndexOf('}')
  if (start < 0 || end <= start) return { ok: false, reasons: ['json_unparseable'] }
  const slice = fenced.slice(start, end + 1)
  try {
    const parsed = JSON.parse(slice)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false, reasons: ['json_not_object'] }
  } catch {
    return { ok: false, reasons: ['json_unparseable'] }
  }
  const repaired = [
    ...(r.removed ? ['reasoning_removed'] : []),
    ...(fenced !== r.text ? ['code_fence_removed'] : []),
    ...(slice !== fenced ? ['json_extracted'] : []),
  ]
  return { ok: true, text: slice, warnings: [], repaired }
}
