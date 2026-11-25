import test from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import { LinkedInMCPClient } from '../mcp/linkedin/index.js'
import { GlintsMCPClient, MAX_GLINTS_BROWSER_CONCURRENCY } from '../mcp/glints/index.js'
import { MAX_KAPSO_WEBHOOK_BYTES, whatsappWebhookRoutes } from '../api/routes/notifications.js'

test('BS-P2-06: LinkedInMCPClient menutup page, context, dan browser pada setiap searchJobs (termasuk saat error)', async () => {
  let launches = 0
  let pageCloses = 0
  let contextCloses = 0
  let browserCloses = 0

  const client = new LinkedInMCPClient({
    launch: async () => {
      launches++
      return {
        newContext: async () => ({
          newPage: async () => ({
            goto: async () => {
              throw new Error('login wall redirect')
            },
            close: async () => {
              pageCloses++
            },
          }),
          close: async () => {
            contextCloses++
          },
        }),
        close: async () => {
          browserCloses++
        },
      }
    },
  })

  const res = await client.searchJobs({ keywords: 'frontend', location: 'Jakarta' })
  assert.equal(res.success, false)
  assert.equal(launches, 1)
  assert.equal(pageCloses, 1)
  assert.equal(contextCloses, 1)
  assert.equal(browserCloses, 1)
})

test('P1-02: GlintsMCPClient membatasi konkurensi browser fallback agar tidak melonjak bersamaan', async () => {
  let inFlight = 0
  let peak = 0

  const client = new GlintsMCPClient({
    browserRunner: async () => {
      inFlight++
      peak = Math.max(peak, inFlight)
      await new Promise((r) => setTimeout(r, 25))
      inFlight--
      return { data: { searchJobsV3: { jobsInPage: [], hasMore: false } } }
    },
  })
  // Paksa jalur fetch gagal agar masuk fallback browser.
  ;(client as any).fetch = async () => {
    throw new Error('WAF 403')
  }

  const results = await Promise.all([
    client.searchJobs({ keywords: 'node' }),
    client.searchJobs({ keywords: 'react' }),
    client.searchJobs({ keywords: 'go' }),
  ])

  assert.equal(results.every((r) => r.success), true)
  assert.equal(peak, MAX_GLINTS_BROWSER_CONCURRENCY)
})

test('BS-P2-07: webhook Kapso menolak payload melebihi MAX_KAPSO_WEBHOOK_BYTES dengan 413', async () => {
  const app = Fastify()
  await app.register(whatsappWebhookRoutes, {
    env: { KAPSO_WEBHOOK_SECRET: 'rahasia-webhook-123456' },
  })
  await app.ready()
  try {
    const oversized = JSON.stringify({ pad: 'a'.repeat(MAX_KAPSO_WEBHOOK_BYTES + 4096) })
    const res = await app.inject({
      method: 'POST',
      url: '/whatsapp/webhook',
      headers: { 'content-type': 'application/json' },
      payload: oversized,
    })
    assert.equal(res.statusCode, 413)
  } finally {
    await app.close()
  }
})
