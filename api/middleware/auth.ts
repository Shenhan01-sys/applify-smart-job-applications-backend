import { FastifyRequest, FastifyReply, HookHandlerDoneFunction } from 'fastify'
import { createClient } from '@supabase/supabase-js'

const supabaseUrl = process.env.SUPABASE_URL!
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

export async function authMiddleware(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const authHeader = request.headers.authorization

  if (!authHeader?.startsWith('Bearer ')) {
    return reply.status(401).send({ error: 'Missing or invalid authorization header' })
  }

  const token = authHeader.substring(7)

  try {
    const supabase = createClient(supabaseUrl, supabaseKey)
    const { data: { user }, error } = await supabase.auth.getUser(token)

    if (error || !user) {
      return reply.status(401).send({ error: 'Invalid token' })
    }

    // Attach user to request
    ;(request as any).user = user
  } catch (err) {
    return reply.status(401).send({ error: 'Authentication failed' })
  }
}
