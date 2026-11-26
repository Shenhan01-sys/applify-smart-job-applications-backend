import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import { approvalRoutes } from '../api/routes/approval.js'

function buildApp(db: any, userId = 'user-a') {
  const app = Fastify({ logger: false })
  app.addHook('preHandler', async (req) => {
    ;(req as any).user = { id: userId, email: `${userId}@example.id` }
  })
  return app.register(approvalRoutes, {
    prefix: '/api/approvals',
    db,
    guard: { checkActionRateLimit: async () => {} },
  }).then(() => app)
}

function makeDb(opts: {
  jobRow?: Record<string, any> | null
  missingColMode?: 'error' | 'throw' | null
}) {
  let insertedApproval = false
  return {
    get insertedApproval() {
      return insertedApproval
    },
    from(table: string) {
      if (table === 'jobs') {
        return {
          select(cols: string) {
            const asksVisibility = /visibility|created_by/.test(cols)
            if (asksVisibility && opts.missingColMode === 'throw') {
              throw new Error('column jobs.visibility does not exist')
            }
            return {
              eq() {
                return {
                  maybeSingle: async () => {
                    if (asksVisibility && opts.missingColMode === 'error') {
                      return { data: null, error: { code: '42703', message: 'column jobs.visibility does not exist' } }
                    }
                    return { data: opts.jobRow ?? null, error: null }
                  },
                }
              },
            }
          },
        }
      }
      if (table === 'profiles') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: { resume_url: null }, error: null }),
            }),
          }),
        }
      }
      if (table === 'approval_requests') {
        return {
          insert(row: any) {
            insertedApproval = true
            return {
              select: async () => ({ data: [{ id: 'apr-new-1', ...row }], error: null }),
            }
          },
        }
      }
      return {
        select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }),
      }
    },
  }
}

describe('Prioritas Tinggi Gelombang 5: POST /api/approvals kepemilikan lowongan privat', () => {
  const payload = {
    job_id: 'job-1',
    job_title: 'Frontend Engineer',
    company: 'PT Privat',
    platform: 'off_portal_poster',
    cover_letter: 'Surat lamaran lengkap untuk posisi ini.',
    answers: [{ question: 'Nama', answer: 'Budi', confidence: 1 }],
  }

  it('mengembalikan 404 saat pengguna lain mencoba membuat approval untuk lowongan privat', async () => {
    const db = makeDb({ jobRow: { id: 'job-1', visibility: 'private', created_by: 'user-owner' } })
    const app = await buildApp(db, 'user-other')
    const res = await app.inject({ method: 'POST', url: '/api/approvals', payload })
    assert.equal(res.statusCode, 404)
    assert.equal(db.insertedApproval, false)
    await app.close()
  })

  it('mengizinkan pemilik membuat approval untuk lowongan privat miliknya sendiri', async () => {
    const db = makeDb({ jobRow: { id: 'job-1', visibility: 'private', created_by: 'user-owner' } })
    const app = await buildApp(db, 'user-owner')
    const res = await app.inject({ method: 'POST', url: '/api/approvals', payload })
    assert.equal(res.statusCode, 200)
    assert.equal(db.insertedApproval, true)
    await app.close()
  })

  it('mengizinkan pembuatan approval untuk lowongan publik', async () => {
    const db = makeDb({ jobRow: { id: 'job-1', visibility: 'public', created_by: null } })
    const app = await buildApp(db, 'user-any')
    const res = await app.inject({ method: 'POST', url: '/api/approvals', payload })
    assert.equal(res.statusCode, 200)
    assert.equal(db.insertedApproval, true)
    await app.close()
  })

  it('tetap berjalan sebelum kolom visibility dan created_by ada di DB (galat objek maupun lemparan)', async () => {
    for (const mode of ['error', 'throw'] as const) {
      const db = makeDb({ jobRow: { id: 'job-1' }, missingColMode: mode })
      const app = await buildApp(db, 'user-any')
      const res = await app.inject({ method: 'POST', url: '/api/approvals', payload })
      assert.equal(res.statusCode, 200, `mode ${mode} harus tetap 200 pra-migrasi`)
      assert.equal(db.insertedApproval, true)
      await app.close()
    }
  })
})

describe('Lapisan kedua: POST /api/approvals/:id/approve menolak persetujuan untuk lowongan privat milik orang lain', () => {
  function approveDb(jobRow: Record<string, any>) {
    let approvalWrites = 0
    const approval = {
      id: '11111111-1111-4111-8111-111111111111',
      user_id: 'user-other',
      job_id: 'job-1',
      status: 'pending',
      expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    }
    return {
      get approvalWrites() {
        return approvalWrites
      },
      from(table: string) {
        if (table === 'approval_requests') {
          const chain: any = {
            select: () => chain,
            eq: () => chain,
            single: async () => ({ data: approval, error: null }),
            update: () => {
              approvalWrites++
              return chain
            },
          }
          return chain
        }
        if (table === 'jobs') {
          return {
            select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: jobRow, error: null }) }) }),
          }
        }
        return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) }
      },
    }
  }

  it('approval yang disisipkan langsung lewat RLS untuk lowongan privat orang lain: 404 dan baris tidak diubah', async () => {
    const db = approveDb({ id: 'job-1', visibility: 'private', created_by: 'user-owner' })
    const app = await buildApp(db, 'user-other')
    const res = await app.inject({ method: 'POST', url: '/api/approvals/11111111-1111-4111-8111-111111111111/approve', payload: {} })
    assert.equal(res.statusCode, 404)
    assert.match(res.body, /Job not found/)
    assert.equal(db.approvalWrites, 0)
    await app.close()
  })
})
