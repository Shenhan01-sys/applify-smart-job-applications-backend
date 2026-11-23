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
import { notificationRoutes, whatsappWebhookRoutes } from './routes/notifications.js'
import { jobRoutes } from './routes/jobs.js'
import { profileImportRoutes } from './routes/profile-import.js'
import { agentCodeRoutes } from './routes/agent-code.js'
import { extensionRoutes } from './routes/extension.js'
import { authMiddleware } from './middleware/auth.js'
import { sessionKeyProblem } from '../services/session-crypto.js'
import { deployConfigWarnings, isOriginAllowed, parseAllowedOrigins } from '../services/deploy-config.js'
import { isExtensionOriginAllowed } from '../services/extension-token.js'

// Produksi (Railway, Docker): log JSON polos ke stdout supaya mudah dibaca penampung log.
// Lokal: pino-pretty berwarna.
const app = Fastify({
  logger:
    process.env.NODE_ENV === 'production'
      ? true
      : {
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
// FRONTEND_URL berisi satu atau beberapa origin dipisah koma (mis. URL Vercel dan localhost untuk uji).
const allowedOrigins = parseAllowedOrigins(process.env.FRONTEND_URL)

await app.register(cors, {
  origin: (origin, cb) => {
    cb(null, isOriginAllowed(origin, allowedOrigins) || isExtensionOriginAllowed(origin))
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
    // URL relatif: "Try it out" di /docs menembak host yang sama dengan halaman docs (lokal maupun Railway).
    servers: [
      {
        url: '/',
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
  await app.register(jobRoutes, { prefix: '/api/jobs' })
  await app.register(profileImportRoutes, { prefix: '/api/profile' })
  await app.register(agentCodeRoutes, { prefix: '/api/agent' })
})

// Public routes
await app.register(platformRoutes, { prefix: '/api/platforms' })
// OAuth: google start + callback are browser redirects (public); status/disconnect verify
// the bearer token internally.
await app.register(oauthRoutes, { prefix: '/api/oauth' })
// Extension: POST /token mewajibkan JWT Supabase utama; rute lain memakai token scoped `ext_tok_v1.*`.
await app.register(extensionRoutes, { prefix: '/api/extension' })
// Webhook publik Kapso WhatsApp (dilindungi signature HMAC `x-hub-signature-256`).
await app.register(whatsappWebhookRoutes, { prefix: '/api/notifications' })

const start = async () => {
  try {
    const port = Number(process.env.PORT) || 4000
    await app.listen({ port, host: '0.0.0.0' })
    app.log.info(`Server listening on 0.0.0.0:${port} (health: /health, docs: /docs)`)
    app.log.info(`CORS origins: ${allowedOrigins.join(', ')}`)
    for (const w of deployConfigWarnings()) app.log.warn(`[config] ${w}`)
    // Kunci enkripsi sesi platform: tanpa kunci yang sah (tidak ada kunci bawaan) rute sesi menjawab 503.
    // Server tetap berjalan supaya fitur lain tidak ikut mati; galatnya dicatat sekali di sini dan di tiap permintaan.
    const keyProblem = sessionKeyProblem()
    if (keyProblem) app.log.error(`[config] ${keyProblem}`)
  } catch (err) {
    app.log.error(err)
    process.exit(1)
  }
}

start()
