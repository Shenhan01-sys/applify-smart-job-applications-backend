import { FastifyInstance, FastifyPluginOptions } from 'fastify'
import { supabase } from '../index.js'

export async function platformRoutes(
  app: FastifyInstance,
  _opts: FastifyPluginOptions
) {
  // List all platforms
  app.get('/', async (_request, reply) => {
    const { data, error } = await supabase
      .from('job_platforms')
      .select('*')
      .eq('is_active', true)
      .order('display_name')

    if (error) {
      return reply.status(500).send({ error: error.message })
    }

    return data
  })

  // Get platform by name
  app.get('/:name', async (request, reply) => {
    const { name } = request.params as { name: string }

    const { data, error } = await supabase
      .from('job_platforms')
      .select('*')
      .eq('name', name)
      .single()

    if (error) {
      return reply.status(404).send({ error: 'Platform not found' })
    }

    return data
  })
}
