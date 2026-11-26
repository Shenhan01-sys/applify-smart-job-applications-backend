// Penyedia model AI tambahan untuk backend: Numes, Gemini, dan Anthropic lewat endpoint kompatibel OpenAI.
// Salinan pola `resolveModel` di applify-smart-job-applications/supabase/functions/_shared/providers.ts
// (backend adalah paket terpisah dan tidak mengimpor kode frontend).
//
// Entri rantai: "numes:<author/slug>", "gemini:<model>", atau "anthropic:<model>". Entri tanpa awalan (slug
// OpenRouter) tidak dipakai di sini karena rantai OpenRouter dan Groq sudah ada di ai-pipeline.service.ts. Entri
// yang kuncinya tidak terpasang dilewati, jadi rantai tetap jalan walau hanya sebagian kunci ada.
//
// Urutan panggilan di ai-pipeline.service.ts: Numes dan Gemini (`first`), lalu rantai OpenRouter, lalu Groq, dan
// Anthropic paling akhir (`last`). Anthropic selalu di belakang apa pun isi FREE_MODELS / PRO_MODELS: pemilik ingin
// menghemat kredit Anthropic, jadi Claude hanya dipakai bila semua penyedia lain gagal (keputusan 24 Nov 2026).

import { DEFAULT_NUMES_CALL_TIMEOUT_MS, NUMES_CHAT_URL, numesPoolFor, parseNumesKeys, type NumesKeyPool } from './numes-keys.js'

export type PremiumProvider = 'numes' | 'gemini' | 'anthropic'

export interface ResolvedPremiumModel {
  provider: PremiumProvider
  /** Entri asli di rantai, untuk log. */
  entry: string
  model: string
  url: string
  /** Untuk Numes tanpa Authorization: kuncinya dipasang per percobaan oleh kolam kunci. */
  headers: Record<string, string>
  /** Hanya Numes: kolam kunci platform (NUMES_API_KEY, _2, _3). */
  pool?: NumesKeyPool
}

const ENDPOINTS: Record<PremiumProvider, string> = {
  numes: NUMES_CHAT_URL,
  gemini: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
  anthropic: 'https://api.anthropic.com/v1/chat/completions',
}

// Model Numes bawaan. Dokumen Numes (numes.ai/docs/models, dibaca 24 Nov 2026) tidak mendaftar id model selain contoh,
// karena katalognya dinamis (GET /api/v1/models dengan kunci, atau numes.ai/models). Dua id di bawah dipilih Hans
// 23 Nov 2026 untuk preset Numes (Applify-Obsidian/NextRoadMap/19) dan sama dengan Edge Function. Akhiran `:free`
// berarti hanya endpoint berharga nol: tidak pernah ditagih, dan tidak pernah jatuh ke endpoint berbayar. Id tanpa
// `:free` butuh saldo (402 insufficient_credits bila kosong). Paket Pro memakai dua id yang sama karena tidak ada id
// yang lebih kuat yang bisa diverifikasi dari dokumen; setelah mengecek katalog dan saldo, taruh id berbayar di
// PRO_MODELS (misalnya `numes:author/model`).
const NUMES_MODELS = 'numes:z-ai/glm-5.3-flash:free,numes:deepseek/deepseek-v4.1-flash:free'

/**
 * Rantai bawaan bila FREE_MODELS / PRO_MODELS tidak diisi. Numes dulu, lalu Gemini, lalu Anthropic. Rantai OpenRouter
 * dan Groq (OPENROUTER_FALLBACK_MODELS, GROQ_FALLBACK_MODELS) dijalankan di antara Gemini dan Anthropic.
 * Sama dengan Edge Function dan worker.
 */
export const DEFAULT_FREE_MODELS = `${NUMES_MODELS},gemini:gemini-3.5-flash-lite,anthropic:claude-haiku-5-5`
export const DEFAULT_PRO_MODELS = `${NUMES_MODELS},gemini:gemini-4-hydrogen,gemini:gemini-4-argon,anthropic:claude-sonnet-5-5,anthropic:claude-haiku-5-5`

/** Batas waktu satu panggilan (ms). Gemini 4 pernah menggantung 90 detik, jadi sengaja pendek. */
export const positiveEnvMs = (raw: string | undefined, fallback: number): number => {
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : fallback
}
export const PREMIUM_CALL_TIMEOUT_MS = positiveEnvMs(process.env.AI_PREMIUM_TIMEOUT_MS, 25_000)

/**
 * Batas waktu satu percobaan Numes (ms), terpisah dari PREMIUM_CALL_TIMEOUT_MS: model gratis Numes yang lambat tidak
 * ditunggu lebih lama dari ini (bawaan 12 detik, env NUMES_TIMEOUT_MS). Seluruh entri Numes dalam satu permintaan juga
 * berbagi NumesBudget (paling banyak 40% sisa waktu atau 15 detik) supaya Gemini tetap kebagian waktu.
 */
export const NUMES_CALL_TIMEOUT_MS = positiveEnvMs(process.env.NUMES_TIMEOUT_MS, DEFAULT_NUMES_CALL_TIMEOUT_MS)

export interface PremiumKeys {
  gemini?: string
  anthropic?: string
  /** Kunci platform Numes (satu sampai tiga). */
  numes?: readonly string[]
}

export function parseModelList(raw: string | undefined, fallback: string): string[] {
  return (raw && raw.trim() ? raw : fallback).split(',').map((m) => m.trim()).filter(Boolean)
}

/** Satu entri menjadi tujuan panggilan, atau null bila bukan entri numes:/gemini:/anthropic: atau kuncinya tidak ada. */
export function resolvePremiumModel(entry: string, keys: PremiumKeys): ResolvedPremiumModel | null {
  const m = /^(numes|gemini|anthropic):(.+)$/.exec(entry)
  if (!m) return null
  const provider = m[1] as PremiumProvider
  if (provider === 'numes') {
    if (!keys.numes || keys.numes.length === 0) return null
    return {
      provider,
      entry,
      model: m[2],
      url: ENDPOINTS.numes,
      headers: { 'Content-Type': 'application/json' },
      pool: numesPoolFor(keys.numes),
    }
  }
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

export function premiumKeysFromEnv(env: Record<string, string | undefined> = process.env): PremiumKeys {
  return { gemini: env.GEMINI_API_KEY, anthropic: env.ANTHROPIC_API_KEY, numes: parseNumesKeys(env) }
}

/**
 * Rantai Numes/Gemini/Anthropic untuk satu paket, dipisah: `first` (Numes dan Gemini, urutan dipertahankan) jalan
 * sebelum rantai OpenRouter dan Groq, `last` (Anthropic) paling akhir.
 */
export function premiumChainParts(
  tier: 'free' | 'pro',
  keys: PremiumKeys = premiumKeysFromEnv(),
  env: Record<string, string | undefined> = process.env
): { first: ResolvedPremiumModel[]; last: ResolvedPremiumModel[] } {
  const list =
    tier === 'pro'
      ? parseModelList(env.PRO_MODELS, DEFAULT_PRO_MODELS)
      : parseModelList(env.FREE_MODELS, DEFAULT_FREE_MODELS)
  const resolved = list.map((e) => resolvePremiumModel(e, keys)).filter((r): r is ResolvedPremiumModel => r !== null)
  return { first: resolved.filter((r) => r.provider !== 'anthropic'), last: resolved.filter((r) => r.provider === 'anthropic') }
}

/** Seluruh rantai Numes/Gemini/Anthropic untuk satu paket: Anthropic selalu paling belakang. */
export function premiumChain(
  tier: 'free' | 'pro',
  keys: PremiumKeys = premiumKeysFromEnv(),
  env: Record<string, string | undefined> = process.env
): ResolvedPremiumModel[] {
  const { first, last } = premiumChainParts(tier, keys, env)
  return [...first, ...last]
}
