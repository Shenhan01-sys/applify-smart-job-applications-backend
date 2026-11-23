import { cleanLine, isSecretLabel, questionKey } from './extension-planner.js'
import { ExtensionRunnerError, isUuid, verifyExtensionApproval } from './extension-runner.js'
import type { GuardDb } from './queue-guard.js'

/**
 * Jawaban dari panel ekstensi (`POST /api/extension/answers`) -> bank jawaban `user_form_answers`.
 *
 * Baris yang sama persis dengan yang ditulis halaman Persetujuan (frontend `saveAnswers`): satu baris per pertanyaan,
 * kunci unik `(user_id, question_key)`, `question_key = questionKey(label)`. Fungsi `questionKey` adalah yang dipakai
 * perencana (harus sama persis dengan worker dan frontend); kunci kiriman klien tidak dipercaya, kunci selalu dihitung
 * ulang dari label. Jawaban untuk pertanyaan rahasia (kata sandi, PIN, OTP, kartu) ditolak: bank jawaban tidak boleh
 * menyimpannya.
 */

export const EXT_MAX_ANSWERS = 30
export const EXT_MAX_ANSWER_CHARS = 2000
/** Batas kolom `question_label` (database/migrations/2026-11-23_user_form_answers.sql). */
const MAX_LABEL_CHARS = 400
const ANSWERS_TABLE = 'user_form_answers'

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Teks jawaban: karakter kontrol dibuang (baris baru dan tab tetap), spasi tepi dipangkas. */
const cleanAnswer = (raw: string): string => raw.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim()

export interface ExtensionAnswerRow {
  user_id: string
  question_key: string
  question_label: string
  answer: string
  updated_at: string
}

/** Validasi seluruh kiriman lebih dulu: tidak ada yang ditulis bila salah satu jawaban tidak sah. */
export function parseExtensionAnswers(raw: unknown, userId: string, now: Date): ExtensionAnswerRow[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new ExtensionRunnerError(400, 'invalid_answers', 'answers harus berupa daftar jawaban yang tidak kosong')
  }
  if (raw.length > EXT_MAX_ANSWERS) {
    throw new ExtensionRunnerError(400, 'too_many_answers', `Paling banyak ${EXT_MAX_ANSWERS} jawaban per permintaan`)
  }
  const byKey = new Map<string, ExtensionAnswerRow>()
  for (const item of raw) {
    if (!isRecord(item)) throw new ExtensionRunnerError(400, 'invalid_answers', 'Setiap jawaban harus berupa objek {key, label, value}')
    if (typeof item.value !== 'string') throw new ExtensionRunnerError(400, 'invalid_answers', 'value jawaban harus berupa teks')
    const answer = cleanAnswer(item.value)
    if (answer.length > EXT_MAX_ANSWER_CHARS) {
      throw new ExtensionRunnerError(400, 'answer_too_long', `Setiap jawaban paling panjang ${EXT_MAX_ANSWER_CHARS} karakter`)
    }
    const label = cleanLine(item.label, MAX_LABEL_CHARS)
    const key = questionKey(label)
    if (!label || !key || key === '__proto__') {
      throw new ExtensionRunnerError(400, 'invalid_answers', 'Setiap jawaban harus punya label pertanyaan')
    }
    if (isSecretLabel(label)) {
      throw new ExtensionRunnerError(400, 'secret_question', 'Jawaban untuk kolom rahasia (kata sandi, PIN, OTP, kartu) tidak disimpan. Isi sendiri di halaman.')
    }
    // Jawaban kosong berarti belum dijawab: dilewati, bukan galat (panel boleh mengirim seluruh daftar).
    if (!answer) continue
    byKey.set(key, { user_id: userId, question_key: key, question_label: label, answer, updated_at: now.toISOString() })
  }
  return [...byKey.values()]
}

export async function saveExtensionAnswers(
  db: GuardDb,
  userId: string,
  input: { approvalId: unknown; answers: unknown },
  now: Date = new Date()
): Promise<{ saved: number }> {
  if (!isUuid(input.approvalId)) {
    throw new ExtensionRunnerError(400, 'invalid_id', 'approvalId tidak valid')
  }
  const rows = parseExtensionAnswers(input.answers, userId, now)

  const check = await verifyExtensionApproval(db, { userId, approvalId: input.approvalId, now })
  if ('code' in check) throw new ExtensionRunnerError(check.statusCode, check.code, check.error)

  if (rows.length === 0) return { saved: 0 }

  let error: { code?: string } | null = null
  try {
    const res = await db.from(ANSWERS_TABLE).upsert(rows, { onConflict: 'user_id,question_key' })
    error = res?.error ?? null
  } catch {
    error = { code: 'exception' }
  }
  if (error) {
    if (error.code === '42P01' || error.code === 'PGRST205') {
      throw new ExtensionRunnerError(503, 'answers_unavailable', 'Fitur jawaban tersimpan belum aktif di database.')
    }
    throw new ExtensionRunnerError(500, 'answers_save_failed', 'Jawaban belum bisa disimpan. Coba lagi.')
  }
  return { saved: rows.length }
}
