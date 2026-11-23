/**
 * The one list of providers a user can bring a key for (BYOK). byok-guard.ts and api/routes/llm-keys.ts derive
 * everything from it: ids, labels, which hosts a key may be sent to, how the key is attached, and which key prefixes
 * belong to which provider. No other file may hardcode the provider list.
 *
 * The same registry exists on the other two sides (frontend `src/lib/llmKeys.ts`, edge function
 * `supabase/functions/_shared/byok-providers.ts`). The ids and the `verified` flags must match.
 *
 * Rules:
 *  - `baseUrl` and `validate.url` are fixed here, https only. A base URL is never user input: a key must not be
 *    sendable to a host the user (or an attacker holding the user's session) typed in.
 *  - `baseUrl` is the prefix the model call appends its path to: `/chat/completions` for format 'openai',
 *    `/v1/messages` for format 'anthropic'.
 *  - `verified: false` marks a placeholder. Its endpoints have not been checked against the provider's own
 *    documentation yet, so it has an empty baseUrl and PUT refuses it (400 provider_unverified): no key is ever sent
 *    to an address nobody has verified. Flip the flag only together with real, checked URLs.
 */

export type ByokFormat = 'openai' | 'anthropic'

/**
 * How the key is attached to the validation request:
 *  - 'bearer'         Authorization: Bearer <key>
 *  - 'x-api-key'      x-api-key: <key>
 *  - 'x-goog-api-key' x-goog-api-key: <key>   (Google answers an invalid key with 400, see classifyValidationStatus)
 */
export type ByokHeaderStyle = 'bearer' | 'x-api-key' | 'x-goog-api-key'

export interface ByokProviderEntry {
  id: string
  label: string
  /** Wire format of the model call. 'anthropic' also adds the `anthropic-version` header to the validation request. */
  format: ByokFormat
  baseUrl: string
  /** One cheap GET that answers 2xx for a working key and 401/403 for a refused one. */
  validate: { url: string; headerStyle: ByokHeaderStyle }
  /** A key that starts with this text belongs to this provider only (anything else is `wrong_provider`). */
  keyPrefix?: string
  /** True when the preset has no default model, so the user must name one (400 model_required otherwise). */
  requiresModel?: boolean
  verified: boolean
}

const REGISTRY = [
  {
    id: 'anthropic',
    label: 'Anthropic (Claude)',
    format: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    validate: { url: 'https://api.anthropic.com/v1/models?limit=1', headerStyle: 'x-api-key' },
    keyPrefix: 'sk-ant-',
    verified: true,
  },
  {
    id: 'openai',
    label: 'OpenAI',
    format: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    validate: { url: 'https://api.openai.com/v1/models', headerStyle: 'bearer' },
    // Applify has not tested any OpenAI model yet, so there is no default.
    requiresModel: true,
    verified: true,
  },
  {
    id: 'gemini',
    label: 'Google Gemini',
    format: 'openai',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    validate: { url: 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1', headerStyle: 'x-goog-api-key' },
    verified: true,
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    format: 'openai',
    baseUrl: 'https://openrouter.ai/api/v1',
    validate: { url: 'https://openrouter.ai/api/v1/key', headerStyle: 'bearer' },
    keyPrefix: 'sk-or-',
    verified: true,
  },
  // Third-party OpenAI-compatible providers (Hans, 23 Nov 2026). Endpoints checked against each provider's own
  // documentation on 2026-11-23 (sources in Applify-Obsidian/NextRoadMap/19). International endpoints only: keys of
  // the mainland-China platforms are separate accounts and are not offered here.
  {
    id: 'deepseek',
    label: 'DeepSeek',
    format: 'openai',
    baseUrl: 'https://api.deepseek.com',
    validate: { url: 'https://api.deepseek.com/models', headerStyle: 'bearer' },
    verified: true,
  },
  {
    id: 'moonshot',
    label: 'Moonshot AI (Kimi, platform internasional)',
    format: 'openai',
    baseUrl: 'https://api.moonshot.ai/v1',
    validate: { url: 'https://api.moonshot.ai/v1/models', headerStyle: 'bearer' },
    verified: true,
  },
  // No documented cheap key check (a GET that needs the key) as of 2026-11-23, so they stay off. Their models can
  // be reached through Numes, CrowLLM or OpenRouter meanwhile.
  { id: 'zhipu', label: 'Zhipu AI (GLM)', format: 'openai', baseUrl: '', validate: { url: '', headerStyle: 'bearer' }, verified: false },
  { id: 'qwen', label: 'Qwen (Alibaba Cloud)', format: 'openai', baseUrl: '', validate: { url: '', headerStyle: 'bearer' }, verified: false },
  {
    id: 'mimo',
    label: 'Xiaomi MiMo',
    format: 'openai',
    baseUrl: 'https://api.xiaomimimo.com/v1',
    validate: { url: 'https://api.xiaomimimo.com/v1/models', headerStyle: 'bearer' },
    verified: true,
  },
  {
    id: 'numes',
    label: 'Numes',
    format: 'openai',
    baseUrl: 'https://api.numes.ai/api/v1',
    // Numes documents GET /key as the key check.
    validate: { url: 'https://api.numes.ai/api/v1/key', headerStyle: 'bearer' },
    verified: true,
  },
  {
    id: 'crowllm',
    label: 'CrowLLM',
    format: 'openai',
    baseUrl: 'https://crowllm.com/v1',
    // Weak check: /v1/models also answers anonymously. A bogus key sent with it got 401 on 2026-11-23, but that
    // behaviour is not documented. The edge function still marks the key invalid on its first 401.
    validate: { url: 'https://crowllm.com/v1/models', headerStyle: 'bearer' },
    requiresModel: true,
    verified: true,
  },
] as const satisfies readonly ByokProviderEntry[]

export type ByokProvider = (typeof REGISTRY)[number]['id']

export const BYOK_PROVIDER_REGISTRY: readonly ByokProviderEntry[] = REGISTRY

/** Every provider id, verified or not, in registry order. */
export const BYOK_PROVIDER_IDS: readonly ByokProvider[] = REGISTRY.map((entry) => entry.id)

export function isByokProvider(value: unknown): value is ByokProvider {
  return typeof value === 'string' && (BYOK_PROVIDER_IDS as readonly string[]).includes(value)
}

export function getByokProvider(id: ByokProvider): ByokProviderEntry {
  return BYOK_PROVIDER_REGISTRY.find((entry) => entry.id === id)!
}

/** True when the provider's endpoints were checked: only then may a key be validated, stored or sent. */
export function isVerifiedProvider(id: ByokProvider): boolean {
  const entry = getByokProvider(id)
  return entry.verified === true && entry.baseUrl.startsWith('https://') && entry.validate.url.startsWith('https://')
}
