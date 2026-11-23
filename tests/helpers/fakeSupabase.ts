import http from 'node:http'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import type { AddressInfo } from 'node:net'

/**
 * Supabase tiruan yang STRIK, untuk uji integrasi backend. Berjalan sebagai server HTTP lokal (127.0.0.1) yang
 * menirukan PostgREST (`/rest/v1`) dan GoTrue (`/auth/v1/user`), jadi klien supabase-js yang SUNGGUHAN dipakai server
 * backend yang sungguhan. Bedanya dengan FakeDb di tests/helpers/fakeDb.ts: skema dibaca dari berkas SQL
 * (database/schema.sql dan database/migrations/*.sql, tanpa DRAFT_*), lalu:
 *   - tabel yang tidak ada             -> 404 PGRST205
 *   - kolom tak dikenal di select/filter/isi -> 400 42703 / PGRST204 (seperti PostgREST)
 *   - uuid yang bukan uuid, boolean, angka, waktu yang salah -> 22P02
 *   - NOT NULL tanpa default, CHECK (kolom in (...)) -> 23502 / 23514
 *   - kunci utama dan UNIQUE yang dilanggar -> 23505
 *   - operator filter yang belum didukung -> 400 (gagal keras, bukan diam-diam)
 * Tidak ada jaringan keluar: server hanya mendengarkan 127.0.0.1. Rahasia tidak dibaca dari mana pun.
 */

const DATABASE_DIR = path.resolve(new URL('.', import.meta.url).pathname, '..', '..', '..', 'database')

type Kind = 'uuid' | 'text' | 'int' | 'numeric' | 'bool' | 'time' | 'json' | 'other'
interface Column {
  name: string
  kind: Kind
  isArray: boolean
  notNull: boolean
  hasDefault: boolean
  defaultValue: () => unknown
  enumValues: string[] | null
}
interface Table {
  name: string
  columns: Map<string, Column>
  /** Daftar kolom unik (kunci utama dan UNIQUE), tiap entri satu kombinasi. */
  uniques: string[][]
}

// ───────────────────────────────────────────────────────────────── parser skema SQL

function stripComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
}

/** Pisahkan pada koma tingkat teratas (di luar kurung dan tanda kutip). */
function splitTop(body: string): string[] {
  const parts: string[] = []
  let depth = 0
  let quote = false
  let cur = ''
  for (const ch of body) {
    if (ch === "'") quote = !quote
    if (!quote) {
      if (ch === '(') depth++
      else if (ch === ')') depth--
      else if (ch === ',' && depth === 0) {
        parts.push(cur.trim())
        cur = ''
        continue
      }
    }
    cur += ch
  }
  if (cur.trim()) parts.push(cur.trim())
  return parts
}

function kindOf(type: string): { kind: Kind; isArray: boolean } {
  const t = type.toLowerCase()
  const isArray = /\[\]$/.test(t)
  const base = t.replace(/\[\]$/, '')
  if (base === 'uuid') return { kind: 'uuid', isArray }
  if (/^(text|varchar|character|char|citext)/.test(base)) return { kind: 'text', isArray }
  if (/^(int|integer|bigint|smallint|serial|bigserial)/.test(base)) return { kind: 'int', isArray }
  if (/^(numeric|decimal|real|double|float)/.test(base)) return { kind: 'numeric', isArray }
  if (/^bool/.test(base)) return { kind: 'bool', isArray }
  if (/^(timestamp|timestamptz|date|time)/.test(base)) return { kind: 'time', isArray }
  if (/^jsonb?$/.test(base)) return { kind: 'json', isArray }
  return { kind: 'other', isArray }
}

function defaultFn(expr: string | null): () => unknown {
  if (!expr) return () => null
  const e = expr.trim().replace(/^\((.*)\)$/s, '$1').trim()
  if (/^gen_random_uuid\(\)/i.test(e) || /^uuid_generate_v4\(\)/i.test(e)) return () => crypto.randomUUID()
  if (/^now\(\)/i.test(e) || /^current_timestamp/i.test(e)) {
    const m = /interval\s+'(\d+)\s*(minutes?|hours?|days?)'/i.exec(e)
    const ms = m ? Number(m[1]) * (/^min/i.test(m[2]) ? 60_000 : /^hour/i.test(m[2]) ? 3_600_000 : 86_400_000) : 0
    return () => new Date(Date.now() + ms).toISOString()
  }
  if (/^'\{\}'::jsonb?$/i.test(e)) return () => ({})
  if (/^'\[\]'::jsonb?$/i.test(e)) return () => []
  if (/^true$/i.test(e)) return () => true
  if (/^false$/i.test(e)) return () => false
  if (/^-?\d+(\.\d+)?$/.test(e)) return () => Number(e)
  const s = /^'((?:[^']|'')*)'(::\w+(\[\])?)?$/.exec(e)
  if (s) return () => s[1].replace(/''/g, "'")
  return () => null
}

function parseColumn(def: string): Column | null {
  const m = /^"?([a-z_][a-z0-9_]*)"?\s+([a-z]+(?:\s*\([^)]*\))?(?:\s+with(?:out)?\s+time\s+zone)?(?:\[\])?)/i.exec(def)
  if (!m) return null
  const name = m[1].toLowerCase()
  const { kind, isArray } = kindOf(m[2].replace(/\s*\(.*\)/, ''))
  const rest = def.slice(m[0].length)
  const dm = /\bdefault\s+(.+?)(?=\s+(?:not\s+null|null|check|references|primary|unique|constraint)\b|$)/is.exec(rest)
  const pk = /\bprimary\s+key\b/i.test(rest)
  const em = /\bcheck\s*\(\s*"?\w+"?\s+in\s*\(([^)]*)\)\s*\)/i.exec(rest)
  const enumValues = em ? [...em[1].matchAll(/'((?:[^']|'')*)'/g)].map((x) => x[1]) : null
  return {
    name,
    kind,
    isArray,
    notNull: pk || /\bnot\s+null\b/i.test(rest),
    hasDefault: !!dm,
    defaultValue: defaultFn(dm?.[1] ?? null),
    enumValues,
  }
}

export function loadSchema(dir = DATABASE_DIR): Map<string, Table> {
  const files = [path.join(dir, 'schema.sql')]
  const migDir = path.join(dir, 'migrations')
  for (const f of readdirSync(migDir).sort()) if (f.endsWith('.sql') && !f.startsWith('DRAFT')) files.push(path.join(migDir, f))

  const tables = new Map<string, Table>()
  for (const file of files) {
    const sql = stripComments(readFileSync(file, 'utf8'))
    for (const m of sql.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?(?:public\.)?"?(\w+)"?\s*\(/gi)) {
      let i = m.index! + m[0].length
      let depth = 1
      const start = i
      while (i < sql.length && depth > 0) {
        if (sql[i] === '(') depth++
        else if (sql[i] === ')') depth--
        i++
      }
      const body = sql.slice(start, i - 1)
      const name = m[1].toLowerCase()
      if (tables.has(name)) continue // create table if not exists: yang pertama menang
      const table: Table = { name, columns: new Map(), uniques: [] }
      for (const part of splitTop(body)) {
        const tc = /^(?:constraint\s+\S+\s+)?(primary\s+key|unique)\s*\(([^)]*)\)/i.exec(part)
        if (tc) {
          table.uniques.push(tc[2].split(',').map((c) => c.trim().replace(/"/g, '').toLowerCase()))
          continue
        }
        if (/^(constraint|foreign\s+key|check|exclude|like)\b/i.test(part)) continue
        const col = parseColumn(part)
        if (!col) continue
        table.columns.set(col.name, col)
        if (/\bprimary\s+key\b/i.test(part) || /\bunique\b/i.test(part)) table.uniques.push([col.name])
      }
      tables.set(name, table)
    }
    for (const m of sql.matchAll(/alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?(?:public\.)?"?(\w+)"?\s+([^;]*);/gi)) {
      const table = tables.get(m[1].toLowerCase())
      if (!table) continue
      for (const action of splitTop(m[2])) {
        const add = /^add\s+column\s+(?:if\s+not\s+exists\s+)?(.*)$/is.exec(action)
        if (add) {
          const col = parseColumn(add[1])
          if (col && !table.columns.has(col.name)) table.columns.set(col.name, col)
          continue
        }
        const drop = /^drop\s+column\s+(?:if\s+exists\s+)?"?(\w+)"?/i.exec(action)
        if (drop) table.columns.delete(drop[1].toLowerCase())
      }
    }
    for (const m of sql.matchAll(/create\s+unique\s+index\s+(?:if\s+not\s+exists\s+)?\S+\s+on\s+(?:public\.)?"?(\w+)"?\s*\(([^)]*)\)\s*;/gi)) {
      tables.get(m[1].toLowerCase())?.uniques.push(m[2].split(',').map((c) => c.trim().replace(/"/g, '').toLowerCase()))
    }
  }
  return tables
}

// ───────────────────────────────────────────────────────────────── galat dan nilai

class PgError extends Error {
  constructor(public status: number, public code: string, message: string, public details: string | null = null) {
    super(message)
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function coerce(table: string, col: Column, value: unknown): unknown {
  if (value === null || value === undefined) return null
  if (col.isArray) {
    if (!Array.isArray(value)) throw new PgError(400, '22P02', `malformed array literal for ${table}.${col.name}`)
    return value
  }
  const bad = (type: string) => new PgError(400, '22P02', `invalid input syntax for type ${type}: "${String(value).slice(0, 60)}"`)
  switch (col.kind) {
    case 'uuid':
      if (typeof value !== 'string' || !UUID_RE.test(value)) throw bad('uuid')
      return value
    case 'int':
      if (typeof value === 'number' ? !Number.isInteger(value) : !/^-?\d+$/.test(String(value))) throw bad('integer')
      return Number(value)
    case 'numeric':
      if (typeof value !== 'number' && !/^-?\d+(\.\d+)?$/.test(String(value))) throw bad('numeric')
      return Number(value)
    case 'bool':
      if (typeof value === 'boolean') return value
      if (value === 'true' || value === 'false') return value === 'true'
      throw bad('boolean')
    case 'time':
      if (Number.isNaN(Date.parse(String(value)))) throw bad('timestamp with time zone')
      return value
    case 'text':
      if (typeof value === 'object') throw bad('text')
      return String(value)
    default:
      return value
  }
}

function jsonPath(row: any, segments: string[]): unknown {
  let cur = row
  for (const s of segments) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return null
    cur = cur[s]
  }
  return cur ?? null
}

function isSubset(sub: any, sup: any): boolean {
  if (sub === null || typeof sub !== 'object') return sub === sup
  if (sup === null || typeof sup !== 'object') return false
  if (Array.isArray(sub)) return Array.isArray(sup) && sub.every((x) => sup.some((y) => isSubset(x, y)))
  return Object.entries(sub).every(([k, v]) => isSubset(v, sup[k]))
}

// ───────────────────────────────────────────────────────────────── filter

type Row = Record<string, any>
interface Filter {
  test: (row: Row) => boolean
}

function parseList(v: string): string[] {
  const inner = v.replace(/^\(/, '').replace(/\)$/, '')
  const out: string[] = []
  const re = /"((?:[^"\\]|\\.)*)"|([^,]+)/g
  for (const m of inner.matchAll(re)) out.push(m[1] !== undefined ? m[1].replace(/\\(.)/g, '$1') : m[2].trim())
  return out
}

function like(pattern: string, value: string, ci: boolean): boolean {
  const re = new RegExp('^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/%/g, '.*') + '$', ci ? 'i' : '')
  return re.test(value)
}

function makeFilter(t: Table, lhs: string, rhs: string): Filter {
  // lhs: kolom, atau kolom->a->>b (jalur JSON)
  const m = /^"?(\w+)"?((?:->>?\w+)*)$/.exec(lhs)
  if (!m) throw new PgError(400, 'PGRST100', `unsupported filter target "${lhs}"`)
  const colName = m[1].toLowerCase()
  const col = t.columns.get(colName)
  if (!col) throw new PgError(400, '42703', `column ${t.name}.${colName} does not exist`)
  const segs = [...m[2].matchAll(/->>?(\w+)/g)].map((x) => x[1])
  const asText = m[2].includes('->>')
  const get = (row: Row): any => {
    if (segs.length === 0) return row[colName]
    const v = jsonPath(row[colName], segs)
    return asText && v !== null && typeof v === 'object' ? JSON.stringify(v) : asText && v !== null ? String(v) : v
  }

  let negate = false
  let rest = rhs
  if (rest.startsWith('not.')) {
    negate = true
    rest = rest.slice(4)
  }
  const dot = rest.indexOf('.')
  const op = dot < 0 ? rest : rest.slice(0, dot)
  const arg = dot < 0 ? '' : rest.slice(dot + 1)

  // Nilai pembanding diperiksa dengan tipe kolom (uuid salah -> 22P02), kecuali untuk jalur JSON.
  const typed = (v: string): unknown => (segs.length === 0 ? coerce(t.name, col, v) : v)
  const cmp = (a: any, b: any): number => (a < b ? -1 : a > b ? 1 : 0)
  const tsOrNum = (v: any) => (col.kind === 'time' && segs.length === 0 ? Date.parse(String(v)) : v)

  let test: (row: Row) => boolean
  switch (op) {
    case 'eq': {
      const want = typed(arg)
      test = (r) => get(r) === want || (segs.length > 0 && !asText && JSON.stringify(get(r)) === arg)
      break
    }
    case 'neq': {
      const want = typed(arg)
      test = (r) => get(r) !== want
      break
    }
    case 'gt': case 'gte': case 'lt': case 'lte': {
      const want = tsOrNum(typed(arg))
      test = (r) => {
        const v = get(r)
        if (v === null || v === undefined) return false
        const c = cmp(tsOrNum(v), want)
        return op === 'gt' ? c > 0 : op === 'gte' ? c >= 0 : op === 'lt' ? c < 0 : c <= 0
      }
      break
    }
    case 'in': {
      const wants = parseList(arg).map((v) => typed(v))
      test = (r) => wants.includes(get(r))
      break
    }
    case 'is': {
      if (arg === 'null') test = (r) => get(r) === null || get(r) === undefined
      else if (arg === 'true' || arg === 'false') test = (r) => get(r) === (arg === 'true')
      else throw new PgError(400, '22P02', `invalid is.${arg}`)
      break
    }
    case 'like': case 'ilike': {
      test = (r) => typeof get(r) === 'string' && like(arg, get(r), op === 'ilike')
      break
    }
    case 'cs': {
      let want: unknown
      try {
        want = col.kind === 'json' ? JSON.parse(arg) : parseList(arg)
      } catch {
        throw new PgError(400, '22P02', `invalid cs.${arg}`)
      }
      test = (r) => isSubset(want, get(r))
      break
    }
    default:
      throw new PgError(400, 'PGRST100', `fake-supabase: filter operator "${op}" is not supported by the test fake (add it in tests/helpers/fakeSupabase.ts)`)
  }
  return { test: negate ? (r) => !test(r) : test }
}

function parseOr(t: Table, expr: string): Filter {
  const inner = expr.replace(/^\(/, '').replace(/\)$/, '')
  const parts = splitTop(inner).map((p) => {
    const i = p.indexOf('.')
    return makeFilter(t, p.slice(0, i), p.slice(i + 1))
  })
  return { test: (r) => parts.some((f) => f.test(r)) }
}

// ───────────────────────────────────────────────────────────────── server

export interface FakeRequestLog {
  method: string
  table: string | null
  op: 'select' | 'insert' | 'update' | 'delete' | 'upsert' | 'auth' | 'other'
  status: number
}

export interface FakeSupabase {
  url: string
  /** Isi tabel; baris awal lewat seed() divalidasi seperti sisipan sungguhan. */
  rows(table: string): Row[]
  seed(table: string, rows: Row | Row[]): void
  /** Token bearer -> pengguna. Token tak dikenal ditolak 401 oleh /auth/v1/user. */
  addUser(token: string, user: { id: string; email: string }): void
  /** Fungsi RPC; tanpa pendaftaran, /rpc/<nama> dijawab 404 PGRST202. */
  rpc: Record<string, (args: any) => unknown>
  requests: FakeRequestLog[]
  /** Kosongkan data dan log (skema tetap). */
  reset(): void
  tableNames(): string[]
  close(): Promise<void>
}

export async function startFakeSupabase(): Promise<FakeSupabase> {
  const schema = loadSchema()
  const data = new Map<string, Row[]>()
  const users = new Map<string, { id: string; email: string }>()
  const requests: FakeRequestLog[] = []
  const rpc: Record<string, (args: any) => unknown> = {}
  const rowsOf = (name: string) => {
    let r = data.get(name)
    if (!r) data.set(name, (r = []))
    return r
  }

  const tableFor = (name: string): Table => {
    const t = schema.get(name.toLowerCase())
    if (!t) throw new PgError(404, 'PGRST205', `Could not find the table 'public.${name}' in the schema cache`)
    return t
  }

  function prepareRow(t: Table, input: Row, forInsert: boolean): Row {
    const out: Row = {}
    for (const key of Object.keys(input)) {
      const col = t.columns.get(key.toLowerCase())
      if (!col) throw new PgError(400, 'PGRST204', `Could not find the '${key}' column of '${t.name}' in the schema cache`)
      const v = coerce(t.name, col, input[key])
      if (v !== null && col.enumValues && !col.enumValues.includes(String(v))) {
        throw new PgError(400, '23514', `new row for relation "${t.name}" violates check constraint "${t.name}_${col.name}_check"`)
      }
      out[col.name] = v
    }
    if (forInsert) {
      for (const col of t.columns.values()) {
        if (col.name in out) continue
        out[col.name] = col.hasDefault ? col.defaultValue() : null
      }
    }
    for (const col of t.columns.values()) {
      if (col.notNull && (out[col.name] === null || out[col.name] === undefined) && (forInsert || col.name in out)) {
        throw new PgError(400, '23502', `null value in column "${col.name}" of relation "${t.name}" violates not-null constraint`)
      }
    }
    return out
  }

  function checkUnique(t: Table, rows: Row[], candidate: Row, ignore?: Row) {
    for (const cols of t.uniques) {
      if (cols.some((c) => candidate[c] === null || candidate[c] === undefined)) continue
      if (rows.some((r) => r !== ignore && cols.every((c) => r[c] === candidate[c]))) {
        throw new PgError(409, '23505', `duplicate key value violates unique constraint "${t.name}_${cols.join('_')}_key"`, `Key (${cols.join(', ')}) already exists.`)
      }
    }
  }

  function project(t: Table, rows: Row[], select: string | null): Row[] {
    if (select === null || select.trim() === '*' || select.trim() === '') return rows.map((r) => ({ ...r }))
    if (/[()]/.test(select)) throw new PgError(400, 'PGRST100', 'fake-supabase: embedded resources in select are not supported by the test fake')
    const names = select.split(',').map((s) => s.trim().replace(/"/g, ''))
    for (const n of names) {
      if (n !== '*' && !t.columns.has(n.toLowerCase())) throw new PgError(400, '42703', `column ${t.name}.${n} does not exist`)
    }
    return rows.map((r) => {
      const o: Row = {}
      for (const n of names) {
        if (n === '*') Object.assign(o, r)
        else o[n.toLowerCase()] = r[n.toLowerCase()]
      }
      return o
    })
  }

  function filtersOf(t: Table, params: URLSearchParams): Filter[] {
    const reserved = new Set(['select', 'order', 'limit', 'offset', 'on_conflict', 'columns'])
    const out: Filter[] = []
    for (const [k, v] of params) {
      if (reserved.has(k)) continue
      if (k === 'or') out.push(parseOr(t, v))
      else if (k === 'and') throw new PgError(400, 'PGRST100', 'fake-supabase: and= is not supported')
      else out.push(makeFilter(t, k, v))
    }
    return out
  }

  function applyOrder(t: Table, rows: Row[], order: string | null): Row[] {
    if (!order) return rows
    const keys = order.split(',').map((o) => {
      const [c, ...flags] = o.split('.')
      if (!t.columns.has(c.toLowerCase())) throw new PgError(400, '42703', `column ${t.name}.${c} does not exist`)
      return { c: c.toLowerCase(), desc: flags.includes('desc'), nullsFirst: flags.includes('nullsfirst') }
    })
    return [...rows].sort((a, b) => {
      for (const k of keys) {
        const av = a[k.c], bv = b[k.c]
        if (av === bv) continue
        if (av === null || av === undefined) return k.nullsFirst ? -1 : 1
        if (bv === null || bv === undefined) return k.nullsFirst ? 1 : -1
        const c = av < bv ? -1 : 1
        return k.desc ? -c : c
      }
      return 0
    })
  }

  async function readBody(req: http.IncomingMessage): Promise<any> {
    const chunks: Buffer[] = []
    for await (const c of req) chunks.push(c as Buffer)
    const text = Buffer.concat(chunks).toString('utf8')
    return text ? JSON.parse(text) : null
  }

  async function handleRest(req: http.IncomingMessage, res: http.ServerResponse, url: URL, log: FakeRequestLog) {
    const segs = url.pathname.replace(/^\/rest\/v1\//, '').split('/')
    if (segs[0] === 'rpc') {
      const fn = rpc[segs[1]]
      if (!fn) throw new PgError(404, 'PGRST202', `Could not find the function public.${segs[1]} in the schema cache`)
      const body = req.method === 'POST' ? await readBody(req) : Object.fromEntries(url.searchParams)
      return send(res, 200, fn(body))
    }
    const t = tableFor(segs[0])
    log.table = t.name
    const params = url.searchParams
    const prefer = String(req.headers.prefer ?? '')
    const wantRep = /return=representation/.test(prefer)
    const wantCount = /count=(exact|planned|estimated)/.test(prefer)
    const single = /vnd\.pgrst\.object/.test(String(req.headers.accept ?? ''))
    const rows = rowsOf(t.name)
    const select = params.get('select')

    const respondRows = (hit: Row[], okStatus: number, total?: number) => {
      const shaped = project(t, hit, select)
      const headers: Record<string, string> = {}
      if (wantCount || total !== undefined) headers['content-range'] = `${shaped.length ? `0-${shaped.length - 1}` : '*'}/${total ?? shaped.length}`
      if (single) {
        if (shaped.length !== 1) {
          throw new PgError(406, 'PGRST116', 'Cannot coerce the result to a single JSON object', `The result contains ${shaped.length} rows`)
        }
        return send(res, okStatus, shaped[0], headers)
      }
      return send(res, okStatus, shaped, headers)
    }

    if (req.method === 'GET' || req.method === 'HEAD') {
      log.op = 'select'
      const filters = filtersOf(t, params)
      let hit = rows.filter((r) => filters.every((f) => f.test(r)))
      hit = applyOrder(t, hit, params.get('order'))
      const total = hit.length
      const offset = Number(params.get('offset') ?? 0)
      const limit = params.get('limit') !== null ? Number(params.get('limit')) : undefined
      hit = hit.slice(offset, limit !== undefined ? offset + limit : undefined)
      if (req.method === 'HEAD') return send(res, 200, null, { 'content-range': `${hit.length ? `0-${hit.length - 1}` : '*'}/${total}` })
      return respondRows(hit, 200, wantCount ? total : undefined)
    }

    if (req.method === 'POST') {
      const body = await readBody(req)
      const list: Row[] = Array.isArray(body) ? body : [body]
      const upsert = /resolution=(merge|ignore)-duplicates/.test(prefer)
      log.op = upsert ? 'upsert' : 'insert'
      const made: Row[] = []
      const staged = [...rows]
      for (const input of list) {
        const row = prepareRow(t, input, true)
        const conflictCols = (params.get('on_conflict') ?? '').split(',').filter(Boolean).map((c) => c.toLowerCase())
        const key = conflictCols.length ? [conflictCols] : t.uniques.slice(0, 1)
        const existing = upsert ? staged.find((r) => key.some((cols) => cols.every((c) => r[c] === row[c]))) : undefined
        if (existing) {
          if (/ignore-duplicates/.test(prefer)) continue
          Object.assign(existing, prepareRow(t, input, false))
          made.push(existing)
          continue
        }
        checkUnique(t, staged, row)
        staged.push(row)
        made.push(row)
      }
      rows.splice(0, rows.length, ...staged)
      if (!wantRep) return send(res, 201, null)
      return respondRows(made, 201)
    }

    if (req.method === 'PATCH') {
      log.op = 'update'
      const body = await readBody(req)
      const patch = prepareRow(t, body ?? {}, false)
      const filters = filtersOf(t, params)
      const hit = rows.filter((r) => filters.every((f) => f.test(r)))
      if (single && hit.length !== 1) throw new PgError(406, 'PGRST116', 'Cannot coerce the result to a single JSON object', `The result contains ${hit.length} rows`)
      for (const r of hit) checkUnique(t, rows, { ...r, ...patch }, r)
      for (const r of hit) Object.assign(r, patch)
      if (!wantRep) return send(res, 204, null)
      return respondRows(hit, 200)
    }

    if (req.method === 'DELETE') {
      log.op = 'delete'
      const filters = filtersOf(t, params)
      const hit = rows.filter((r) => filters.every((f) => f.test(r)))
      data.set(t.name, rows.filter((r) => !hit.includes(r)))
      if (!wantRep) return send(res, 204, null)
      return respondRows(hit, 200)
    }
    throw new PgError(405, 'PGRST000', `method ${req.method} not supported`)
  }

  function send(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
    const payload = body === null || body === undefined ? '' : JSON.stringify(body)
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers })
    res.end(status === 204 ? undefined : payload)
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://fake.local')
    const log: FakeRequestLog = { method: req.method ?? 'GET', table: null, op: 'other', status: 0 }
    requests.push(log)
    const origEnd = res.end.bind(res)
    ;(res as any).end = (...a: any[]) => {
      log.status = res.statusCode
      return origEnd(...a)
    }
    try {
      if (url.pathname.startsWith('/auth/v1/')) {
        log.op = 'auth'
        const bearer = /^Bearer (.+)$/.exec(String(req.headers.authorization ?? ''))?.[1] ?? ''
        const byId = /^\/auth\/v1\/admin\/users\/([^/]+)$/.exec(url.pathname)?.[1]
        const user = byId ? [...users.values()].find((u) => u.id === byId) : url.pathname === '/auth/v1/user' ? users.get(bearer) : undefined
        if (!user) return send(res, byId ? 404 : 401, { code: byId ? 404 : 401, error_code: 'bad_jwt', msg: 'invalid JWT' })
        const full = { id: user.id, email: user.email, aud: 'authenticated', role: 'authenticated', app_metadata: {}, user_metadata: {}, created_at: '2026-01-01T00:00:00Z' }
        return send(res, 200, byId ? { user: full, ...full } : full)
      }
      if (url.pathname.startsWith('/rest/v1/')) return await handleRest(req, res, url, log)
      return send(res, 404, { message: `fake-supabase: ${url.pathname} is not emulated` })
    } catch (e: any) {
      if (e instanceof PgError) return send(res, e.status, { code: e.code, details: e.details, hint: null, message: e.message })
      return send(res, 500, { code: 'FAKE500', message: String(e?.message ?? e) })
    }
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  return {
    url,
    rows: (table) => {
      tableFor(table)
      return rowsOf(table.toLowerCase())
    },
    seed(table, input) {
      const t = tableFor(table)
      const rows = rowsOf(t.name)
      for (const r of Array.isArray(input) ? input : [input]) {
        const row = prepareRow(t, r, true)
        checkUnique(t, rows, row)
        rows.push(row)
      }
    },
    addUser: (token, user) => void users.set(token, user),
    rpc,
    requests,
    reset() {
      data.clear()
      requests.length = 0
    },
    tableNames: () => [...schema.keys()],
    close: async () => {
      server.closeAllConnections?.()
      await new Promise<void>((r) => server.close(() => r()))
    },
  }
}
