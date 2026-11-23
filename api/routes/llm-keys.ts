import { FastifyInstance, FastifyPluginOptions } from 'fastify'
import { getByokProvider } from '../../services/byok-providers.js'
import { byokEncryptionReady, decryptByokKey, encryptByokKey } from '../../services/byok-crypto.js'
import {
  BYOK_PROVIDERS,
  byokEnabled,
  checkKeyFormat,
  checkModel,
  createAttemptLimiter,
  isByokProvider,
  isVerifiedProvider,
  keyLast4,
  validateKeyWithProvider,
  type AttemptLimiter,
} from '../../services/byok-guard.js'

export const LLM_KEYS_TABLE = 'user_llm_keys'

/** A body is `{ apiKey (at most 300 characters), model (at most 100), consent }`, so 2 KB is plenty. */
export const LLM_KEY_BODY_LIMIT = 2048

/** The query builder surface this route uses (Supabase in production, FakeDb in tests). */
export interface LlmKeysDb {
  from(table: string): any
}

export interface LlmKeysRouteOptions extends FastifyPluginOptions {
  /** Tests pass a fake database. Without it the server's Supabase client is loaded on first use. */
  db?: LlmKeysDb
  /** Tests pass a fake. Production uses the global fetch. */
  fetchImpl?: typeof fetch
  /** Clock in milliseconds. Tests inject their own. */
  now?: () => number
  /** Attempt limiter for PUT and POST /test. Without it the route builds its own (10 per user per hour). */
  limiter?: AttemptLimiter
  /** Where BYOK_ENABLED is read from. Defaults to process.env. */
  env?: Record<string, string | undefined>
}

/**
 * Routes for a user's own LLM API key (BYOK). Prefix /api/llm-keys, inside the authenticated scope of api/index.ts.
 *
 *  - GET    /                 flag, providers and the user's keys (last four characters and status only)
 *  - PUT    /:provider        check the key with the provider, store it encrypted (invalid keys are never stored)
 *  - POST   /:provider/test   check the stored key again and record the result
 *  - DELETE /:provider        remove the key (works when the flag is off, so a user can always take a key back)
 *
 * The key is a credential. Rules kept here:
 *  - Every query filters by user_id. The service role bypasses RLS, so this filter is the isolation.
 *  - key_encrypted is selected only by POST /test (it has to decrypt the key) and is never returned. The other
 *    handlers do not select it.
 *  - Nothing logs the key, the body, the ciphertext, a database message or text from the provider. Fastify's request
 *    logger writes method, url, host and remote address only. The default error handler would log `err.message`,
 *    and a JSON syntax error quotes part of the body, so this plugin sets its own scoped error handler that logs
 *    status and Fastify error code only.
 *  - Errors are `{ code }`. The code names the problem; there is no free text.
 */
export async function llmKeysRoutes(app: FastifyInstance, opts: LlmKeysRouteOptions = {}) {
  const now = opts.now ?? Date.now
  const limiter = opts.limiter ?? createAttemptLimiter({ now })
  const env = opts.env ?? process.env

  app.setErrorHandler((err: any, request, reply) => {
    const status = typeof err?.statusCode === 'number' && err.statusCode >= 400 && err.statusCode < 500 ? err.statusCode : 500
    request.log.warn({ statusCode: status, errCode: err?.code }, 'llm-keys request rejected')
    return reply.status(status).send({ code: status >= 500 ? 'internal_error' : 'invalid_request' })
  })

  // Fastify refuses an empty body under `content-type: application/json` (POST /test and DELETE carry none, and
  // browsers' fetch wrappers often set the header anyway). Accept an empty body here; a broken body is refused with
  // a fixed 400 that does not quote it.
  app.removeContentTypeParser('application/json')
  app.addContentTypeParser('application/json', { parseAs: 'string', bodyLimit: LLM_KEY_BODY_LIMIT }, (_req, body, done) => {
    const text = typeof body === 'string' ? body : ''
    if (!text.trim()) return done(null, undefined)
    try {
      done(null, JSON.parse(text))
    } catch {
      const err: any = new Error('invalid json body')
      err.statusCode = 400
      err.code = 'FST_ERR_CTP_INVALID_JSON_BODY'
      done(err, undefined)
    }
  })

  const getDb = async (): Promise<LlmKeysDb> =>
    opts.db ?? ((await import('../index.js')).supabase as unknown as LlmKeysDb)

  const isoNow = () => new Date(now()).toISOString()

  const keyView = (row: {
    provider: string
    key_last4: string
    status: string
    last_validated_at: string | null
    model?: string | null
  }) => ({
    provider: row.provider,
    last4: row.key_last4,
    status: row.status,
    lastValidatedAt: row.last_validated_at ?? null,
    model: row.model ?? null,
  })

  /** A database error can quote row values, so only its code is logged. */
  const dbFailure = (request: any, reply: any, op: string, error: any) => {
    request.log.error({ op, dbCode: error?.code }, 'llm-keys database error')
    return reply.status(500).send({ code: 'internal_error' })
  }

  // ---- GET / -------------------------------------------------------------------------------------------------
  app.get('/', async (request, reply) => {
    const userId = (request as any).user?.id
    if (!userId) return reply.status(401).send({ code: 'unauthorized' })

    const db = await getDb()
    const { data, error } = await db
      .from(LLM_KEYS_TABLE)
      .select('provider, key_last4, status, last_validated_at, updated_at, model')
      .eq('user_id', userId)
      .order('provider', { ascending: true })
    if (error) return dbFailure(request, reply, 'list', error)

    const keys = (data ?? []).map((row: any) => ({
      provider: row.provider,
      last4: row.key_last4,
      status: row.status,
      lastValidatedAt: row.last_validated_at ?? null,
      updatedAt: row.updated_at ?? null,
      model: row.model ?? null,
    }))
    return reply.send({ enabled: byokEnabled(env), providers: [...BYOK_PROVIDERS], keys })
  })

  // ---- PUT /:provider ----------------------------------------------------------------------------------------
  app.put('/:provider', { bodyLimit: LLM_KEY_BODY_LIMIT }, async (request, reply) => {
    const userId = (request as any).user?.id
    if (!userId) return reply.status(401).send({ code: 'unauthorized' })
    if (!byokEnabled(env)) return reply.status(403).send({ code: 'byok_disabled' })

    const provider = (request.params as any)?.provider
    if (!isByokProvider(provider)) return reply.status(400).send({ code: 'unknown_provider' })
    // A placeholder in the registry has no checked address yet: the key is not looked at, let alone sent anywhere.
    if (!isVerifiedProvider(provider)) return reply.status(400).send({ code: 'provider_unverified' })

    const body = request.body && typeof request.body === 'object' ? (request.body as Record<string, unknown>) : {}
    // The CV and profile text go to the provider the user picked, possibly abroad: the user must say yes, explicitly.
    if (body.consent !== true) return reply.status(400).send({ code: 'consent_required' })
    const format = checkKeyFormat(provider, body.apiKey)
    // `=== false` (not `!format.ok`): the project builds with strict off, where `!ok` does not narrow the union.
    if (format.ok === false) return reply.status(400).send({ code: format.code })
    const apiKey = format.key

    const modelCheck = checkModel(body.model)
    if (modelCheck.ok === false) return reply.status(400).send({ code: modelCheck.code })
    const model = modelCheck.model
    if (!model && getByokProvider(provider).requiresModel) return reply.status(400).send({ code: 'model_required' })

    // Fail before the key leaves for the provider when it could not be stored anyway.
    if (!byokEncryptionReady()) {
      request.log.error('llm-keys: BYOK_ENCRYPTION_KEY missing or too short')
      return reply.status(500).send({ code: 'encryption_unavailable' })
    }

    const attempt = limiter.tryConsume(userId)
    if (attempt.ok === false) {
      return reply.header('Retry-After', String(attempt.retryAfterSec)).status(429).send({ code: 'too_many_attempts' })
    }

    const verdict = await validateKeyWithProvider(provider, apiKey, { fetchImpl: opts.fetchImpl })
    if (verdict === 'invalid') return reply.status(400).send({ code: 'key_invalid' })
    if (verdict === 'unavailable') return reply.status(503).send({ code: 'validation_unavailable' })

    let keyEncrypted: string
    try {
      keyEncrypted = encryptByokKey(apiKey, { userId, provider })
    } catch {
      request.log.error('llm-keys: encryption failed')
      return reply.status(500).send({ code: 'encryption_unavailable' })
    }

    const stamp = isoNow()
    const row = {
      key_encrypted: keyEncrypted,
      key_last4: keyLast4(apiKey),
      status: 'valid',
      last_error: null,
      last_validated_at: stamp,
      updated_at: stamp,
      model,
      data_consent_at: stamp,
    }

    const db = await getDb()
    // Upsert on (user_id, provider): update the row when there is one, otherwise insert it. A parallel request can
    // insert between the two steps; the unique constraint then answers 23505 and the update runs once more.
    const update = () =>
      db.from(LLM_KEYS_TABLE).update(row).eq('user_id', userId).eq('provider', provider).select('id')
    let res = await update()
    if (res.error) return dbFailure(request, reply, 'update', res.error)
    if (!res.data || res.data.length === 0) {
      const ins = await db.from(LLM_KEYS_TABLE).insert({ user_id: userId, provider, ...row })
      if (ins.error?.code === '23505') {
        res = await update()
        if (res.error) return dbFailure(request, reply, 'update', res.error)
      } else if (ins.error) {
        return dbFailure(request, reply, 'insert', ins.error)
      }
    }

    request.log.info({ provider }, 'llm key stored')
    return reply.send({ key: { provider, last4: row.key_last4, status: 'valid', lastValidatedAt: stamp, model } })
  })

  // ---- POST /:provider/test ----------------------------------------------------------------------------------
  app.post('/:provider/test', async (request, reply) => {
    const userId = (request as any).user?.id
    if (!userId) return reply.status(401).send({ code: 'unauthorized' })
    if (!byokEnabled(env)) return reply.status(403).send({ code: 'byok_disabled' })

    const provider = (request.params as any)?.provider
    if (!isByokProvider(provider)) return reply.status(404).send({ code: 'not_found' })

    const db = await getDb()
    // The one place that selects key_encrypted: the stored key has to be decrypted to be checked again.
    const found = await db
      .from(LLM_KEYS_TABLE)
      .select('key_encrypted, key_last4, status, last_validated_at, model')
      .eq('user_id', userId)
      .eq('provider', provider)
      .maybeSingle()
    if (found.error) return dbFailure(request, reply, 'find', found.error)
    if (!found.data) return reply.status(404).send({ code: 'not_found' })

    const attempt = limiter.tryConsume(userId)
    if (attempt.ok === false) {
      return reply.header('Retry-After', String(attempt.retryAfterSec)).status(429).send({ code: 'too_many_attempts' })
    }

    let apiKey: string
    try {
      apiKey = decryptByokKey(found.data.key_encrypted, { userId, provider })
    } catch {
      request.log.error({ provider }, 'llm-keys: stored key could not be decrypted')
      return reply.status(500).send({ code: 'encryption_unavailable' })
    }

    const result = await validateKeyWithProvider(provider, apiKey, { fetchImpl: opts.fetchImpl })
    if (result === 'unavailable') {
      return reply.send({ result, key: keyView({ provider, ...found.data }) })
    }

    const stamp = isoNow()
    const status = result === 'valid' ? 'valid' : 'invalid'
    const patch = {
      status,
      last_error: result === 'valid' ? null : 'key_invalid',
      last_validated_at: stamp,
      updated_at: stamp,
    }
    // key_encrypted filter: if the user replaced the key during the 8 s check, the old result must not land on the new row.
    const upd = await db
      .from(LLM_KEYS_TABLE)
      .update(patch)
      .eq('user_id', userId)
      .eq('provider', provider)
      .eq('key_encrypted', found.data.key_encrypted)
    if (upd.error) return dbFailure(request, reply, 'update', upd.error)

    request.log.info({ provider, result }, 'llm key tested')
    return reply.send({
      result,
      key: keyView({ provider, key_last4: found.data.key_last4, status, last_validated_at: stamp, model: found.data.model }),
    })
  })

  // ---- DELETE /:provider -------------------------------------------------------------------------------------
  app.delete('/:provider', async (request, reply) => {
    const userId = (request as any).user?.id
    if (!userId) return reply.status(401).send({ code: 'unauthorized' })

    const provider = (request.params as any)?.provider
    if (!isByokProvider(provider)) return reply.send({ deleted: false })

    const db = await getDb()
    const { data, error } = await db
      .from(LLM_KEYS_TABLE)
      .delete()
      .eq('user_id', userId)
      .eq('provider', provider)
      .select('id')
    if (error) return dbFailure(request, reply, 'delete', error)
    return reply.send({ deleted: Array.isArray(data) && data.length > 0 })
  })
}
