// Muat .env SEBELUM modul lain di-import: modul ESM dievaluasi lebih dulu daripada badan file ini,
// sehingga pembacaan process.env di level modul (mis. kunci enkripsi sesi) harus sudah terisi.
import 'dotenv/config'
import Fastify from 'fastify'
import cors from '@fastify/cors'
import swagger from '@fastify/swagger'
import swaggerUi from '@fastify/swagger-ui'
import { createClient } from '@supabase/supabase-js'

import { automationRoutes } from './routes/automation.js'
import { platformRoutes } from './routes/platforms.js'
import { sessionRoutes } from './routes/sessions.js'
import { aiRoutes } from './routes/ai.js'
import { queueRoutes } from './routes/queue.js'
import { approvalRoutes } from './routes/approval.js'
import { rateLimitRoutes } from './routes/rate-limit.js'
import { linkedinSessionRoutes } from './routes/linkedin-session.js'
import { oauthRoutes } from './routes/oauth.js'
import { notificationRoutes } from './routes/notifications.js'
import { authMiddleware } from './middleware/auth.js'

const app = Fastify({
  logger: {
    transport: {
      target: 'pino-pretty',
      options: {
        colorize: true,
      },
    },
  },
})

// Supabase client
export const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

// Register plugins
const allowedOrigins = (process.env.FRONTEND_URL || 'http://localhost:3000')
  .split(',')
  .map(s => s.trim())

await app.register(cors, {
  origin: (origin, cb) => {
    if (!origin || allowedOrigins.includes(origin)) {
      cb(null, true)
    } else {
      cb(null, false)
    }
  },
  credentials: true,
})

await app.register(swagger, {
  openapi: {
    info: {
      title: 'Applify Automation API',
      description: 'API for Applify job automation platform',
      version: '1.0.0',
    },
    servers: [
      {
        url: 'http://localhost:4000',
      },
    ],
  },
})

await app.register(swaggerUi, {
  routePrefix: '/docs',
})

// Health check
app.get('/health', async () => {
  return { status: 'ok', timestamp: new Date().toISOString() }
})

// Register routes with auth middleware
await app.register(async (app) => {
  app.addHook('preHandler', authMiddleware)
  await app.register(automationRoutes, { prefix: '/api/automation' })
  await app.register(sessionRoutes, { prefix: '/api/sessions' })
  await app.register(aiRoutes, { prefix: '/api/ai' })
  await app.register(queueRoutes, { prefix: '/api/queue' })
  await app.register(approvalRoutes, { prefix: '/api/approvals' })
  await app.register(rateLimitRoutes, { prefix: '/api/rate-limits' })
  await app.register(linkedinSessionRoutes, { prefix: '/api/linkedin' })
  await app.register(notificationRoutes, { prefix: '/api/notifications' })
})

// Public routes
await app.register(platformRoutes, { prefix: '/api/platforms' })
// OAuth: google start + callback are browser redirects (public); status/disconnect verify
// the bearer token internally.
await app.register(oauthRoutes, { prefix: '/api/oauth' })

const start = async () => {
  try {
    const port = Number(process.env.PORT) || 4000
    await app.listen({ port, host: '0.0.0.0' })
    app.log.info(`Server running on http://localhost:${port}`)
    app.log.info(`API docs available at http://localhost:${port}/docs`)
  } catch (err) {
    app.log.error(err)
    process.exit(1)
  }
}

start()
