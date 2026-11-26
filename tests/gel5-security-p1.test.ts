import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import { planFileTargets } from '../services/extension-file-targets.js'
import { sanitizeExtensionControls } from '../services/extension-planner.js'
import { sessionRoutes } from '../api/routes/sessions.js'
import { approvalRoutes } from '../api/routes/approval.js'

describe('Gelombang 5 P1/P2 hardening (BS-U1-04, F-06, F-08, F-10)', () => {
  it('BS-U1-04: planFileTargets menolak label "nilai" ambigu tapi tetap mengenali daftar/transkrip nilai', () => {
    const fileCtl = (controlId: string, label: string) => ({
      controlId,
      kind: 'file' as const,
      label,
      name: controlId,
      required: false,
    })
    const ambig = planFileTargets(sanitizeExtensionControls([fileCtl('a', 'Resume CV'), fileCtl('b', 'Upload nilai gaji')]))
    assert.deepEqual(ambig, [{ controlId: 'a', kind: 'resume' }])

    const valid = planFileTargets(sanitizeExtensionControls([fileCtl('a', 'Resume CV'), fileCtl('b', 'Unggah daftar nilai')]))
    assert.deepEqual(valid, [
      { controlId: 'a', kind: 'resume' },
      { controlId: 'b', kind: 'transcript' },
    ])
  })

  it('F-06 & F-08: DELETE /api/sessions/:platform mengosongkan session_data dan menyembunyikan error internal DB', async () => {
    const updates: Array<Record<string, unknown>> = []
    const db = {
      from: () => ({
        update: (patch: Record<string, unknown>) => {
          updates.push(patch)
          return {
            eq: () => ({
              eq: async () => ({ error: null }),
            }),
          }
        },
        select: () => ({
          eq: async () => ({ data: null, error: { message: 'secret_internal_pg_error_xyz' } }),
        }),
      }),
    }
    const app = Fastify({ logger: false })
    app.addHook('preHandler', async (req) => {
      ;(req as any).user = { id: 'u1' }
    })
    await app.register(sessionRoutes, { db })

    const del = await app.inject({ method: 'DELETE', url: '/linkedin' })
    assert.equal(del.statusCode, 200)
    assert.equal(updates.length, 1)
    assert.equal(updates[0].is_active, false)
    assert.deepEqual(updates[0].session_data, {})

    const list = await app.inject({ method: 'GET', url: '/' })
    assert.equal(list.statusCode, 500)
    assert.equal(list.body.includes('secret_internal_pg_error_xyz'), false)
    await app.close()
  })

  it('F-10: POST /api/approvals/:id/reject memfilter status=pending & user_id dan membalas 409 jika sudah diproses', async () => {
    const approvalId = '00000000-0000-4000-8000-000000000001'
    const eqCalls: Array<[string, unknown]> = []
    const db = {
      from: (table: string) => {
        if (table === 'approval_requests') {
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  eq: () => ({
                    single: async () => ({
                      data: { id: approvalId, user_id: 'u1', status: 'pending', platform: 'greenhouse', job_id: 'j1', job_title: 'FE', company: 'Co' },
                      error: null,
                    }),
                  }),
                }),
              }),
            }),
            update: () => {
              const chain: any = {
                eq: (col: string, val: unknown) => {
                  eqCalls.push([col, val])
                  return chain
                },
                select: async () => ({ data: [], error: null }),
              }
              return chain
            },
          }
        }
        return { insert: async () => ({ error: null }) }
      },
    }
    const app = Fastify({ logger: false })
    app.addHook('preHandler', async (req) => {
      ;(req as any).user = { id: 'u1' }
    })
    await app.register(approvalRoutes, { db })

    const res = await app.inject({ method: 'POST', url: `/${approvalId}/reject`, payload: { reason: 'tidak cocok' } })
    assert.equal(res.statusCode, 409)
    assert.deepEqual(eqCalls, [
      ['id', approvalId],
      ['user_id', 'u1'],
      ['status', 'pending'],
    ])
    await app.close()
  })
})
