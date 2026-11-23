import { FastifyInstance, FastifyPluginOptions } from 'fastify'
import { submitSecurityCode, type SecurityCodeDb } from '../../services/security-code-guard.js'

export interface AgentCodeRouteOptions extends FastifyPluginOptions {
  /** Tests pass a fake database. Without it the server's Supabase client is loaded on first use. */
  db?: SecurityCodeDb
}

/** A body is a UUID plus a code of at most 12 characters (padded with spaces or dashes at worst). */
export const SECURITY_CODE_BODY_LIMIT = 1024

/**
 * POST /api/agent/security-code
 *
 * The user types the one-time code that a job form emailed to them. Same protection as /approvals/:id/rerun: the
 * auth preHandler of the /api scope, a user_id filter on every read, and the caps in security-code-guard.ts
 * (the agent must be waiting, three codes per job at most).
 *
 * The body holds a credential, so nothing here may log it:
 *  - Fastify's request logger writes method, url, host and remote address only, never headers or body.
 *  - The default error handler logs `err.message`, and a body that is not valid JSON produces a message that
 *    quotes part of the body. This plugin therefore sets its own error handler (scoped to this plugin only): it
 *    logs the status and Fastify error code, and answers with a fixed text.
 *  - The handler logs nothing from the body, and submitSecurityCode never puts the code into an error.
 */
export async function agentCodeRoutes(app: FastifyInstance, opts: AgentCodeRouteOptions) {
  app.setErrorHandler((err: any, request, reply) => {
    const status = typeof err?.statusCode === 'number' && err.statusCode >= 400 && err.statusCode < 500 ? err.statusCode : 500
    request.log.warn({ statusCode: status, errCode: err?.code }, 'security-code request rejected')
    return reply.status(status).send({ error: status >= 500 ? 'internal_error' : 'invalid_request' })
  })

  app.post('/security-code', { bodyLimit: SECURITY_CODE_BODY_LIMIT }, async (request, reply) => {
    const userId = (request as any).user?.id
    if (!userId) {
      return reply.status(401).send({ error: 'Unauthorized' })
    }

    const db = opts.db ?? ((await import('../index.js')).supabase as unknown as SecurityCodeDb)
    const result = await submitSecurityCode(db, userId, request.body)
    if (result.logNote) request.log.error(result.logNote)
    return reply.status(result.status).send(result.body)
  })
}
