import Fastify from 'fastify'
import { extensionRoutes } from '../api/routes/extension.js'
import type { ExtensionPlanner } from '../services/extension-planner.js'

/** Pembantu uji (bukan berkas `*.test.ts`, jadi tidak dijalankan sendiri): DB tiruan + aplikasi Fastify ekstensi. */

export const USER_ID = '11111111-2222-3333-4444-555555555555'
export const OTHER_USER_ID = '99999999-2222-3333-4444-555555555555'
export const ENV = { SESSION_ENCRYPTION_KEY: 'super_secret_session_key_minimum_32_characters_long' }
export const VALID_PNG_BASE64 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]).toString('base64')

/** Kolom nyata `public.jobs` (database/schema.sql). Pilihan kolom lain membuat tiruan melempar, seperti PostgREST. */
export const JOBS_COLUMNS = new Set([
  'id',
  'title',
  'company',
  'location',
  'description',
  'external_url',
  'platform_source',
  'type',
  'workplace_type',
  'status',
  'salary_min',
  'salary_max',
  'requirements',
  'responsibilities',
  'benefits',
  'created_at',
  'updated_at',
])

export interface FakeDbOptions {
  /** Tabel yang menolak semua operasi dengan galat ini (mis. tabel belum dimigrasi: 42P01). */
  failTables?: Record<string, { code: string; message: string }>
  /** Kunci unik tunggal per tabel; sisipan ganda mengembalikan galat 23505. */
  uniqueKeys?: Record<string, string>
  /** Pengguna Supabase Auth tiruan untuk `auth.admin.getUserById` (kunci: id pengguna). */
  authUsers?: Record<string, { email?: string; email_confirmed_at?: string | null }>
  /** Isi bucket storage tiruan: kunci `<bucket>/<path>`. Objek yang tidak ada mengembalikan galat 404 seperti Supabase Storage. */
  storageObjects?: Record<string, Buffer>
  /** Galat `download` untuk kunci `<bucket>/<path>` tertentu (mis. gangguan storage): teks galat tidak boleh sampai ke klien. */
  storageDownloadErrors?: Record<string, { message: string; statusCode?: string }>
}

export function makeExtensionTestDb(seed?: Partial<Record<string, any[]>>, options: FakeDbOptions = {}) {
  const tables: Record<string, any[]> = {
    approval_requests: [],
    jobs: [],
    profiles: [],
    user_automation_settings: [],
    user_skills: [],
    work_experiences: [],
    achievements: [],
    user_form_answers: [],
    application_logs: [],
    ai_applications: [],
    subscriptions: [],
    approval_submit_claims: [],
    automation_queue: [],
    ...seed,
  }
  const uniqueKeys = { approval_submit_claims: 'approval_request_id', ...options.uniqueKeys }
  const uploads: Array<{ bucket: string; path: string; contentType: string; size: number }> = []
  /** Kunci `<bucket>/<path>` setiap `download` yang dipanggil, supaya tes bisa memastikan path pengguna lain tidak pernah diunduh. */
  const downloads: string[] = []
  const calls: Array<{ table: string; op: string }> = []

  const colValue = (row: any, col: string): unknown => {
    if (col.includes('->>') || col.includes('->')) {
      const [base, key] = col.split(/->>?/)
      return row?.[base]?.[key]
    }
    return row?.[col]
  }

  const matchesContains = (obj: any, needle: Record<string, unknown>) => {
    if (!obj || typeof obj !== 'object') return false
    return Object.entries(needle).every(([k, v]) => obj[k] === v)
  }

  class QueryBuilder {
    private filters: Array<(row: any) => boolean> = []
    private limitN: number | null = null
    private orderCol: string | null = null
    private orderAsc = true
    private countHead = false
    private pendingInsert: any[] | null = null
    private pendingUpdate: Record<string, unknown> | null = null
    private pendingUpsert: { rows: any[]; conflict: string[] } | null = null
    private pendingDelete = false

    constructor(private readonly table: string) {}

    select(cols?: string, opts?: { count?: string; head?: boolean }) {
      if (opts?.head) this.countHead = true
      if (this.table === 'jobs' && cols && cols !== '*') {
        for (const raw of cols.split(',')) {
          const name = raw.trim().split(':').pop()!.trim()
          if (name && !JOBS_COLUMNS.has(name)) throw new Error(`column jobs.${name} does not exist`)
        }
      }
      return this
    }
    eq(col: string, val: unknown) {
      this.filters.push((r) => colValue(r, col) === val)
      return this
    }
    in(col: string, vals: unknown[]) {
      this.filters.push((r) => vals.includes(colValue(r, col)))
      return this
    }
    gt(col: string, val: string) {
      this.filters.push((r) => String(r?.[col] ?? '') > val)
      return this
    }
    gte(col: string, val: string) {
      this.filters.push((r) => String(r?.[col] ?? '') >= val)
      return this
    }
    is(col: string, val: null | boolean) {
      this.filters.push((r) => (val === null ? r?.[col] == null : r?.[col] === val))
      return this
    }
    contains(col: string, needle: Record<string, unknown>) {
      this.filters.push((r) => matchesContains(r?.[col], needle))
      return this
    }
    order(col: string, opts?: { ascending?: boolean }) {
      this.orderCol = col
      this.orderAsc = opts?.ascending !== false
      return this
    }
    limit(n: number) {
      this.limitN = n
      return this
    }
    insert(rows: any) {
      this.pendingInsert = Array.isArray(rows) ? rows : [rows]
      return this
    }
    upsert(rows: any, opts?: { onConflict?: string }) {
      this.pendingUpsert = { rows: Array.isArray(rows) ? rows : [rows], conflict: String(opts?.onConflict ?? 'id').split(',').map((c) => c.trim()) }
      return this
    }
    update(patch: Record<string, unknown>) {
      this.pendingUpdate = patch
      return this
    }
    delete() {
      this.pendingDelete = true
      return this
    }

    private run() {
      const failure = options.failTables?.[this.table]
      calls.push({
        table: this.table,
        op: this.pendingInsert ? 'insert' : this.pendingUpsert ? 'upsert' : this.pendingDelete ? 'delete' : this.pendingUpdate ? 'update' : 'select',
      })
      if (failure) return { data: null, error: { code: failure.code, message: failure.message }, count: null }
      const list = tables[this.table] ?? (tables[this.table] = [])
      if (this.pendingUpsert) {
        const { rows, conflict } = this.pendingUpsert
        for (const r of rows) {
          const existing = list.find((x) => conflict.every((c) => x[c] === r[c]))
          if (existing) Object.assign(existing, r)
          else list.push({ id: r.id ?? `row-${list.length + 1}`, created_at: r.created_at ?? new Date().toISOString(), ...r })
        }
        return { data: rows, error: null, count: null }
      }
      if (this.pendingInsert) {
        const key = (uniqueKeys as Record<string, string>)[this.table]
        for (const r of this.pendingInsert) {
          if (key && list.some((x) => x[key] === r[key])) {
            return { data: null, error: { code: '23505', message: `duplicate key value violates unique constraint "${this.table}_pkey"` }, count: null }
          }
        }
        for (const r of this.pendingInsert) {
          list.push({ id: r.id ?? `log-${list.length + 1}`, created_at: r.created_at ?? new Date().toISOString(), ...r })
        }
        return { data: this.pendingInsert, error: null, count: null }
      }
      let rows = list.filter((r) => this.filters.every((f) => f(r)))
      if (this.pendingDelete) {
        for (const r of rows) list.splice(list.indexOf(r), 1)
        return { data: rows, error: null, count: rows.length }
      }
      if (this.pendingUpdate) {
        for (const r of rows) Object.assign(r, this.pendingUpdate)
        return { data: rows, error: null, count: rows.length }
      }
      if (this.orderCol) {
        const c = this.orderCol
        rows = [...rows].sort((a, b) => (String(a?.[c] ?? '') < String(b?.[c] ?? '') ? (this.orderAsc ? -1 : 1) : this.orderAsc ? 1 : -1))
      }
      const total = rows.length
      if (this.limitN !== null) rows = rows.slice(0, this.limitN)
      if (this.countHead) return { data: null, error: null, count: total }
      return { data: rows, error: null, count: total }
    }

    async maybeSingle() {
      const res = this.run()
      return { data: Array.isArray(res.data) ? res.data[0] ?? null : null, error: res.error ?? null }
    }

    then<TResult1 = any, TResult2 = never>(
      onfulfilled?: ((value: any) => TResult1 | PromiseLike<TResult1>) | null,
      onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | null
    ) {
      return Promise.resolve(this.run()).then(onfulfilled, onrejected)
    }
  }

  return {
    tables,
    uploads,
    downloads,
    calls,
    db: {
      from: (table: string) => new QueryBuilder(table),
      auth: {
        admin: {
          async getUserById(id: string) {
            const u = options.authUsers?.[id]
            return { data: { user: u ? { id, ...u } : null }, error: null }
          },
        },
      },
      /** RPC tiruan: hanya `register_notification_otp_attempt`, dengan semantik atomik yang sama seperti fungsi SQL-nya. */
      async rpc(name: string, args: Record<string, any>) {
        if (name === 'register_notification_otp_attempt') {
          const row = (tables.notification_verification_codes ?? []).find(
            (r) => r.id === args.p_id && Number(r.attempts ?? 0) < Number(args.p_max) && !r.consumed_at
          )
          if (!row) return { data: null, error: null }
          row.attempts = Number(row.attempts ?? 0) + 1
          return { data: row.attempts, error: null }
        }
        return { data: null, error: { code: '42883', message: 'function does not exist' } }
      },
      storage: {
        from(bucket: string) {
          return {
            async upload(path: string, buf: Buffer, opts: { contentType: string }) {
              uploads.push({ bucket, path, contentType: opts.contentType, size: buf.length })
              return { error: null }
            },
            async download(path: string) {
              const key = `${bucket}/${path}`
              downloads.push(key)
              const forced = options.storageDownloadErrors?.[key]
              if (forced) return { data: null, error: forced }
              const obj = options.storageObjects?.[key]
              if (!obj) return { data: null, error: { message: 'Object not found', statusCode: '404' } }
              return { data: new Blob([obj]), error: null }
            },
            async createSignedUrl(path: string) {
              return { data: { signedUrl: `https://storage.test/${bucket}/${path}?token=t` }, error: null }
            },
          }
        },
      },
    } as any,
  }
}

export function buildApp(opts: { db: any; primaryUserId?: string | null; planner?: ExtensionPlanner; now?: () => number }) {
  const app = Fastify()
  app.register(extensionRoutes, {
    prefix: '/api/extension',
    db: opts.db,
    env: ENV,
    now: opts.now,
    planner: opts.planner,
    authenticatePrimary: async (req: any, reply: any) => {
      if (!opts.primaryUserId) return reply.status(401).send({ error: 'Unauthorized' })
      req.user = { id: opts.primaryUserId }
    },
  })
  return app
}

export async function issueToken(app: ReturnType<typeof buildApp>): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/extension/token' })
  return res.json().token
}
