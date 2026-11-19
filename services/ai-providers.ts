// Penyedia model AI tambahan untuk backend: Gemini dan Anthropic lewat endpoint kompatibel OpenAI.
// Salinan pola `resolveModel` di applify-smart-job-applications/supabase/functions/_shared/providers.ts
// (backend adalah paket terpisah dan tidak mengimpor kode frontend).
//
// Entri rantai: "gemini:<model>" atau "anthropic:<model>". Entri tanpa awalan (slug OpenRouter) tidak dipakai di
// sini karena rantai OpenRouter dan Groq sudah ada di ai-pipeline.service.ts. Entri yang kuncinya tidak terpasang
// dilewati, jadi rantai tetap jalan walau hanya sebagian kunci ada.

export type PremiumProvider = 'gemini' | 'anthropic'

export interface ResolvedPremiumModel {
  provider: PremiumProvider
  /** Entri asli di rantai, untuk log. */
  entry: string
  model: string
  url: string
  headers: Record<string, string>
}

const ENDPOINTS: Record<PremiumProvider, string> = {
  gemini: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
  anthropic: 'https://api.anthropic.com/v1/chat/completions',
}

/** Rantai bawaan bila FREE_MODELS / PRO_MODELS tidak diisi. Sama dengan Edge Function (v7). */
export const DEFAULT_FREE_MODELS = 'gemini:gemini-3.5-flash-lite,anthropic:claude-haiku-5-5'
export const DEFAULT_PRO_MODELS =
  'gemini:gemini-4-hydrogen,gemini:gemini-4-argon,anthropic:claude-sonnet-5-5,anthropic:claude-haiku-5-5'

/** Batas waktu satu panggilan (ms). Gemini 4 pernah menggantung 90 detik, jadi sengaja pendek. */
export const PREMIUM_CALL_TIMEOUT_MS = Number(process.env.AI_PREMIUM_TIMEOUT_MS || 25_000)

export interface PremiumKeys {
  gemini?: string
  anthropic?: string
}

export function parseModelList(raw: string | undefined, fallback: string): string[] {
  return (raw && raw.trim() ? raw : fallback).split(',').map((m) => m.trim()).filter(Boolean)
}

/** Satu entri menjadi tujuan panggilan, atau null bila bukan entri gemini:/anthropic: atau kuncinya tidak ada. */
export function resolvePremiumModel(entry: string, keys: PremiumKeys): ResolvedPremiumModel | null {
  const m = /^(gemini|anthropic):(.+)$/.exec(entry)
  if (!m) return null
  const provider = m[1] as PremiumProvider
  const key = keys[provider]
  if (!key) return null
  return {
    provider,
    entry,
    model: m[2],
    url: ENDPOINTS[provider],
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
  }
}

/** Rantai Gemini/Anthropic untuk satu paket, urutan dipertahankan. */
export function premiumChain(
  tier: 'free' | 'pro',
  keys: PremiumKeys = { gemini: process.env.GEMINI_API_KEY, anthropic: process.env.ANTHROPIC_API_KEY },
  env: Record<string, string | undefined> = process.env
): ResolvedPremiumModel[] {
  const list =
    tier === 'pro'
      ? parseModelList(env.PRO_MODELS, DEFAULT_PRO_MODELS)
      : parseModelList(env.FREE_MODELS, DEFAULT_FREE_MODELS)
  return list.map((e) => resolvePremiumModel(e, keys)).filter((r): r is ResolvedPremiumModel => r !== null)
}
