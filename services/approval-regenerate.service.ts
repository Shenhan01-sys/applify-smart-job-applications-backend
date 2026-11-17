/**
 * Tombol "Tulis ulang" di layar persetujuan: surat lamaran pada permintaan persetujuan yang masih pending
 * ditulis ulang lewat AIPipelineService (OpenRouter, Groq sebagai cadangan), lalu disimpan.
 * Tidak ada yang dikirim; pengguna tetap harus menyetujui versi yang tampil di layar.
 */

import { checkGrounding, sanitizeLetter, type OutputWarning } from './ai-output-guard.js'

export const DEFAULT_REGENERATE_INSTRUCTIONS = 'Make it more concise and highlight relevant experience'
const MAX_INSTRUCTIONS = 500

export class ApprovalNotFoundError extends Error {
  readonly statusCode = 404
}
export class ApprovalExpiredError extends Error {
  readonly statusCode = 410
}
export class EmptyDraftError extends Error {
  readonly statusCode = 502
}
export class AiFailedError extends Error {
  readonly statusCode = 502
}

export interface RegenerateDb {
  from(table: string): any
}

export interface RegenerateAI {
  regenerateCoverLetter(p: {
    original: string
    instructions: string
    jobTitle: string
    company: string
    jobDescription: string
    userId?: string
  }): Promise<string>
  lastModelUsed?: string | null
}

export function cleanInstructions(raw: unknown): string {
  const text = typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim() : ''
  return (text || DEFAULT_REGENERATE_INSTRUCTIONS).slice(0, MAX_INSTRUCTIONS)
}

/**
 * Clean the model's reply: code fences, <think> reasoning blocks, a "Here is the letter:" preamble and markdown
 * bold are removed; the body itself is kept as written. (The pipeline already vets replies; this also covers a
 * different AI implementation passed in.)
 */
export function cleanLetter(raw: string): string {
  return sanitizeLetter(raw).text
}

export async function regenerateApprovalCoverLetter(
  db: RegenerateDb,
  ai: RegenerateAI,
  args: { userId: string; approvalId: string; instructions?: unknown; now?: Date }
): Promise<{ coverLetter: string; model: string | null; warnings: OutputWarning[] }> {
  const now = args.now ?? new Date()
  const { data: row, error } = await db
    .from('approval_requests')
    .select('*')
    .eq('id', args.approvalId)
    .eq('user_id', args.userId)
    .eq('status', 'pending')
    .maybeSingle()
  if (error || !row) throw new ApprovalNotFoundError('Approval request not found')
  if (new Date(row.expires_at).getTime() <= now.getTime()) throw new ApprovalExpiredError('Approval request has expired')

  let jobDescription = ''
  if (row.job_id) {
    const { data: job } = await db.from('jobs').select('description').eq('id', row.job_id).maybeSingle()
    jobDescription = String(job?.description ?? '')
  }

  let drafted: string
  try {
    drafted = await ai.regenerateCoverLetter({
      original: String(row.cover_letter ?? ''),
      instructions: cleanInstructions(args.instructions),
      jobTitle: row.job_title,
      company: row.company,
      jobDescription,
      userId: args.userId,
    })
  } catch (e: any) {
    throw new AiFailedError(`AI tidak bisa menulis ulang saat ini: ${String(e?.message ?? e).slice(0, 200)}`)
  }
  const coverLetter = cleanLetter(drafted ?? '')
  if (!coverLetter) throw new EmptyDraftError('AI returned an empty cover letter')

  // Guarded on 'pending': a request approved or rejected meanwhile is not touched.
  const { error: upErr } = await db
    .from('approval_requests')
    .update({ cover_letter: coverLetter })
    .eq('id', args.approvalId)
    .eq('user_id', args.userId)
    .eq('status', 'pending')
  if (upErr) throw new Error(`could not save regenerated cover letter: ${upErr.message}`)

  // The rewrite may not add facts. Numbers and percentages that the original letter did not contain are returned
  // as warnings for the approval screen (the user decides; nothing is silently trusted).
  const warnings = checkGrounding(coverLetter, { text: String(row.cover_letter ?? '') }, { sections: false })
  return { coverLetter, model: ai.lastModelUsed ?? null, warnings }
}
