import type { SanitizedExtControl } from './extension-planner.js'

/**
 * Rencana berkas untuk Ekstensi Browser Applify: kontrol `<input type=file>` mana yang menerima berkas apa.
 *
 * Aturan pencarian disalin dari `worker/src/lib/formFill.ts` (`findResumeRef`, `findCoverLetterRef`,
 * `findTranscriptRef`, `findPortfolioRef`): petunjuk dari atribut `name` dan `id` didahulukan, baru label.
 * Urutannya sama (CV, surat lamaran, transkrip, portofolio) dan satu kontrol tidak pernah dipakai untuk dua jenis berkas.
 * Beda dengan worker: kontrol di sini sudah pasti `file`, jadi kata "upload" pada label tidak lagi disyaratkan.
 */

export type ExtFileKind = 'resume' | 'cover_letter' | 'transcript' | 'portfolio'
export const EXT_FILE_KINDS: readonly ExtFileKind[] = ['resume', 'cover_letter', 'transcript', 'portfolio']

export interface ExtFileTarget {
  controlId: string
  kind: ExtFileKind
}

type FileControl = Pick<SanitizedExtControl, 'controlId' | 'kind' | 'label' | 'groupLabel' | 'name' | 'placeholder'> & { elementId?: string }

/** Huruf kecil, camelCase dan pemisah (`_ - . / [ ] :`) menjadi spasi supaya `\b` bekerja pada `cover_letter` dan `coverLetter`. */
function norm(raw: string): string {
  return String(raw ?? '')
    .replace(/([a-z\d])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .replace(/[_\-./[\]:]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

const RESUME_HINT = /\b(?:resume|cv)\b/
const RESUME_NAME = /\b(?:resume|cv|curriculum vitae)\b/

const COVER_HINT = /\bcover letter\b(?! (?:text|body|content))/
const COVER_NAME = /cover\s*letter|surat\s+lamaran|motivation(?:al)?\s+letter|letter\s+of\s+motivation/

const TRANSCRIPT_HINT = /\b(?:transcripts?|transkrip)\b(?! (?:url|link|site|website|text))/
const TRANSCRIPT_NAME = /transcript|transkrip|academic\s+records?|grade\s+reports?|\bnilai\b/

const PORTFOLIO_HINT = /\bporto?folio\b(?! (?:url|link|site|website|text))/
const PORTFOLIO_NAME = /porto?folio|work\s+samples?/

/** Kolom unggah gambar (foto, logo): tidak pernah menerima CV lewat jalur cadangan. */
const IMAGE_ONLY_NAME = /\b(?:photo|foto|picture|image|avatar|headshot|logo|selfie)\b/

interface Candidate {
  c: FileControl
  hint: string
  text: string
}

function pick(candidates: Candidate[], hintRe: RegExp, nameRe: RegExp): Candidate | null {
  return candidates.find((x) => hintRe.test(x.hint)) ?? candidates.find((x) => nameRe.test(x.text)) ?? null
}

/**
 * Kontrol berkas -> jenis berkas yang cocok. Kontrol tanpa kecocokan tidak dilaporkan, kecuali CV: bila tidak ada
 * kontrol yang menyebut CV, kontrol berkas pertama yang belum terpakai dan bukan kolom gambar dipakai untuk CV
 * (perilaku lama `fileControlId`). Urutan hasil: resume, cover_letter, transcript, portfolio.
 */
export function planFileTargets(controls: readonly FileControl[]): ExtFileTarget[] {
  let rest: Candidate[] = controls
    .filter((c) => c.kind === 'file')
    .map((c) => ({
      c,
      hint: norm(`${c.name ?? ''} ${c.elementId ?? ''}`),
      text: norm(`${c.label ?? ''} ${c.groupLabel ?? ''} ${c.placeholder ?? ''}`),
    }))

  const out: ExtFileTarget[] = []
  const take = (kind: ExtFileKind, found: Candidate | null): boolean => {
    if (!found) return false
    out.push({ controlId: found.c.controlId, kind })
    rest = rest.filter((x) => x !== found)
    return true
  }

  const resumeFound = take('resume', pick(rest, RESUME_HINT, RESUME_NAME))
  take('cover_letter', pick(rest, COVER_HINT, COVER_NAME))
  take('transcript', pick(rest, TRANSCRIPT_HINT, TRANSCRIPT_NAME))
  take('portfolio', pick(rest, PORTFOLIO_HINT, PORTFOLIO_NAME))

  if (!resumeFound) {
    const fallback = rest.find((x) => !IMAGE_ONLY_NAME.test(x.text) && !IMAGE_ONLY_NAME.test(x.hint)) ?? null
    if (fallback) {
      out.unshift({ controlId: fallback.c.controlId, kind: 'resume' })
    }
  }
  return out
}
