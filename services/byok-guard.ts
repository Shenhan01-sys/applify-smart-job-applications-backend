/**
 * Rules for BYOK (a user's own LLM API key): which providers exist, what a key must look like, how a key is checked
 * with its provider, and how often a user may try. Pure functions plus one network call that is injectable, so the
 * tests never touch the network.
 *
 * The key is a credential. It travels only in a request header to the provider's own host, never in a URL, a log
 * line, an error message or a response. validateKeyWithProvider does not read the provider's answer body, so
 * provider error text cannot leak either.
 */

import {
  BYOK_PROVIDER_IDS,
  BYOK_PROVIDER_REGISTRY,
  getByokProvider,
  isByokProvider,
  isVerifiedProvider,
  type ByokProvider,
} from './byok-providers.js'

// The provider list lives in byok-providers.ts only. Re-exported here so callers have one import for the guard.
export { BYOK_PROVIDER_IDS as BYOK_PROVIDERS, isByokProvider, isVerifiedProvider }
export type { ByokProvider }

/** The feature is off unless BYOK_ENABLED is exactly the text "true". */
export function byokEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.BYOK_ENABLED === 'true'
}

// ---------------------------------------------------------------- key format

export const KEY_MIN_LENGTH = 20
export const KEY_MAX_LENGTH = 300

const KEY_CHARSET = /^[A-Za-z0-9_\-.]+$/

export type KeyFormatVerdict =
  | { ok: true; key: string }
  | { ok: false; code: 'key_format' | 'wrong_provider' }

/**
 * Trim, then accept 20 to 300 characters of letters, digits, `_`, `-` and `.`. A key that starts with a prefix the
 * registry assigns to one provider (`sk-ant-` Anthropic, `sk-or-` OpenRouter) and is given to another provider is
 * `wrong_provider` (a typical slip is pasting the key into the wrong card), not `key_format`. Providers without a
 * registered prefix need nothing more here; the provider itself has the last word (validateKeyWithProvider).
 */
export function checkKeyFormat(provider: ByokProvider, raw: unknown): KeyFormatVerdict {
  if (typeof raw !== 'string') return { ok: false, code: 'key_format' }
  const key = raw.trim()
  if (key.length < KEY_MIN_LENGTH || key.length > KEY_MAX_LENGTH || !KEY_CHARSET.test(key)) {
    return { ok: false, code: 'key_format' }
  }
  for (const entry of BYOK_PROVIDER_REGISTRY) {
    if (entry.keyPrefix && key.startsWith(entry.keyPrefix) && entry.id !== provider) return { ok: false, code: 'wrong_provider' }
  }
  return { ok: true, key }
}

/** The last four characters, the only part of a key that is ever shown again. */
export function keyLast4(key: string): string {
  return key.trim().slice(-4)
}

// ---------------------------------------------------------------- model name

export const MODEL_MAX_LENGTH = 100
const MODEL_CHARSET = /^[A-Za-z0-9._:/-]+$/

export type ModelVerdict = { ok: true; model: string | null } | { ok: false; code: 'model_format' }

/**
 * The optional model the user wants first (e.g. `gpt-4o`, `claude-sonnet-4-5`, `qwen/qwen3-32b:free`). Absent, null
 * or blank means "no choice" (null). Otherwise trim, then 1 to 100 characters of letters, digits and `. _ : / -`.
 * The text is later placed in a request body to the provider, so the charset is kept narrow on purpose.
 */
export function checkModel(raw: unknown): ModelVerdict {
  if (raw === undefined || raw === null) return { ok: true, model: null }
  if (typeof raw !== 'string') return { ok: false, code: 'model_format' }
  const model = raw.trim()
  if (model === '') return { ok: true, model: null }
  if (model.length > MODEL_MAX_LENGTH || !MODEL_CHARSET.test(model)) return { ok: false, code: 'model_format' }
  return { ok: true, model }
}

// ---------------------------------------------------------------- check with the provider

export type ValidationResult = 'valid' | 'invalid' | 'unavailable'

export const VALIDATION_TIMEOUT_MS = 8000

/** Request headers that carry the key (never the URL). Built from the registry entry of the provider. */
export function buildValidationHeaders(provider: ByokProvider, key: string): Record<string, string> {
  const entry = getByokProvider(provider)
  const headers: Record<string, string> =
    entry.validate.headerStyle === 'bearer'
      ? { Authorization: `Bearer ${key}` }
      : entry.validate.headerStyle === 'x-goog-api-key'
        ? { 'x-goog-api-key': key }
        : { 'x-api-key': key }
  if (entry.format === 'anthropic') headers['anthropic-version'] = '2023-06-01'
  return headers
}

/**
 * Status to result. Google answers an invalid key with 400 (API_KEY_INVALID), so for a provider that takes
 * `x-goog-api-key` 400 means invalid. For every other provider a 400 says nothing about the key.
 */
export function classifyValidationStatus(provider: ByokProvider, status: number): ValidationResult {
  if (status >= 200 && status < 300) return 'valid'
  if (status === 401 || status === 403) return 'invalid'
  if (status === 400 && getByokProvider(provider).validate.headerStyle === 'x-goog-api-key') return 'invalid'
  return 'unavailable'
}

export interface ValidateOptions {
  /** Tests pass a fake; production uses the global fetch. */
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

/**
 * Ask the provider whether the key works. 2xx is valid, 401/403 invalid (gemini: 400 too), anything else (other
 * 400, 429, 5xx, a redirect, a network error, a timeout) is unavailable: the key is neither accepted nor refused.
 * Redirects are not followed, so the key header can never be forwarded to another host.
 */
export async function validateKeyWithProvider(
  provider: ByokProvider,
  key: string,
  opts: ValidateOptions = {},
): Promise<ValidationResult> {
  // An unverified placeholder has no address to send the key to.
  if (!isByokProvider(provider) || !isVerifiedProvider(provider)) return 'unavailable'
  const doFetch = opts.fetchImpl ?? fetch
  try {
    const res = await doFetch(getByokProvider(provider).validate.url, {
      method: 'GET',
      headers: buildValidationHeaders(provider, key),
      redirect: 'manual',
      signal: AbortSignal.timeout(opts.timeoutMs ?? VALIDATION_TIMEOUT_MS),
    })
    // The body is never read. Drop it so the connection is released.
    try {
      await res.body?.cancel()
    } catch {
      /* ignore */
    }
    return classifyValidationStatus(provider, res.status)
  } catch {
    return 'unavailable'
  }
}

// ---------------------------------------------------------------- attempt limiter

/** PUT and POST /test each call the provider, so each costs one attempt. */
export const BYOK_ATTEMPTS_PER_WINDOW = 10
export const BYOK_ATTEMPT_WINDOW_MS = 60 * 60 * 1000

export type AttemptVerdict = { ok: true } | { ok: false; retryAfterSec: number }

export interface AttemptLimiter {
  /** Counts one attempt for the user when there is room. */
  tryConsume(userId: string): AttemptVerdict
}

export interface LimiterOptions {
  max?: number
  windowMs?: number
  /** Clock in milliseconds; tests inject their own. */
  now?: () => number
}

/**
 * Sliding window per user, kept in memory. Limits: it is per process (a restart or a second instance starts at
 * zero), which is acceptable for a guard against a loop or a typo storm, not against a determined attacker.
 */
export function createAttemptLimiter(opts: LimiterOptions = {}): AttemptLimiter {
  const max = opts.max ?? BYOK_ATTEMPTS_PER_WINDOW
  const windowMs = opts.windowMs ?? BYOK_ATTEMPT_WINDOW_MS
  const now = opts.now ?? Date.now
  const hits = new Map<string, number[]>()

  function sweep(cutoff: number) {
    for (const [user, times] of hits) {
      if (times[times.length - 1] <= cutoff) hits.delete(user)
    }
  }

  return {
    tryConsume(userId: string): AttemptVerdict {
      const t = now()
      const cutoff = t - windowMs
      const recent = (hits.get(userId) ?? []).filter((x) => x > cutoff)
      if (recent.length >= max) {
        hits.set(userId, recent)
        const retryAfterSec = Math.max(1, Math.ceil((recent[0] + windowMs - t) / 1000))
        return { ok: false, retryAfterSec }
      }
      recent.push(t)
      hits.set(userId, recent)
      if (hits.size > 10_000) sweep(cutoff)
      return { ok: true }
    },
  }
}
