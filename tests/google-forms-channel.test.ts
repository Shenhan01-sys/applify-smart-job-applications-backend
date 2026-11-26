import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  approvalDispatchTarget,
  classifyJobChannel,
  isGoogleFormUrl,
  routesToExtension,
} from '../services/apply-channel.js'
import { grantExtensionConsent } from '../services/extension-consent.js'

describe('Google Forms channel routing & extension fallback (Gelombang 4 Prioritas A)', () => {
  it('mengenali docs.google.com/forms, /u/0/forms, dan forms.gle serta merutekan ke worker dengan fallback ekstensi', () => {
    assert.equal(isGoogleFormUrl('https://docs.google.com/forms/d/e/1FAIpQLSeDemo/viewform'), true)
    assert.equal(isGoogleFormUrl('https://docs.google.com/u/0/forms/d/e/1FAIpQLSeDemo/viewform'), true)
    assert.equal(isGoogleFormUrl('https://forms.gle/demoForm123'), true)
    assert.equal(isGoogleFormUrl('https://docs.google.com/spreadsheets/d/123'), false)

    const c = classifyJobChannel({
      platform_source: 'off_portal_poster',
      external_url: 'https://docs.google.com/forms/d/e/1FAIpQLSeDemo/viewform',
    })
    assert.equal(c.platform, 'google_forms')
    assert.equal(c.autoWorkerSupported, true)
    assert.equal(c.extensionSupported, true)
    assert.equal(c.manualOnly, false)
    assert.equal(routesToExtension(c), false, 'Google Forms tidak langsung ke ekstensi saat Setujui')
    assert.equal(approvalDispatchTarget(c), 'worker', 'Saat Setujui, Google Forms dikirim ke worker terlebih dahulu')
  })

  it('POST /extension-consent menerima fallback Google Forms setelah worker berhenti dan memindah kanal ke extension_apply', async () => {
    const channelUpdates: string[] = []
    let queuedCount = 0

    const fakeDb: any = {
      from(table: string) {
        if (table === 'approval_requests') {
          return {
            select() { return this },
            update(patch: any) {
              if (patch.apply_channel) channelUpdates.push(patch.apply_channel)
              return { eq() { return this }, select: async () => ({ data: [{ id: 'apr-gf-1' }], error: null }) }
            },
            eq() { return this },
            maybeSingle: async () => ({
              data: {
                id: 'apr-gf-1',
                user_id: 'u1',
                job_id: 'job-gf-1',
                status: 'approved',
                apply_channel: 'worker',
                expires_at: new Date(Date.now() + 3600_000).toISOString(),
              },
              error: null,
            }),
          }
        }
        if (table === 'jobs') {
          return {
            select() { return this },
            eq() { return this },
            maybeSingle: async () => ({
              data: {
                id: 'job-gf-1',
                platform_source: 'off_portal_poster',
                title: 'Frontend Engineer',
                company: 'PT Nusantara',
                external_url: 'https://docs.google.com/forms/d/e/1FAIpQLSeDemo/viewform',
                description: 'Isi Google Form berikut.',
              },
              error: null,
            }),
          }
        }
        if (table === 'application_logs' || table === 'automation_queue') {
          return {
            select() { return this },
            eq() { return this },
            in() { return this },
            contains() { return this },
            limit: async () => ({ data: [], error: null }),
          }
        }
        return { select() { return this }, eq() { return this }, maybeSingle: async () => ({ data: null, error: null }) }
      },
    }

    const fakeQueue = {
      async addApprovedExtensionApplyJob() {
        queuedCount++
        return { id: 'q-ext-gf-1' }
      },
    }

    const res = await grantExtensionConsent(fakeDb, fakeQueue, 'u1', 'apr-gf-1')
    assert.equal(res.status, 200)
    assert.equal(res.body.queued, true)
    assert.equal(res.body.queue_job_id, 'q-ext-gf-1')
    assert.equal(queuedCount, 1)
    assert.deepEqual(channelUpdates, ['extension'])
  })
})
