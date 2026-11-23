/**
 * Tiny in-memory stand-in for the Supabase query builder, for unit tests only.
 * Supports the calls the worker and backend make: select/insert/update/delete, eq/neq/gt/gte/lt/lte/in/is/
 * contains filters, order/limit, single/maybeSingle, and head+count selects. No network is ever used.
 */
type Row = Record<string, any>;
type Result = { data: any; error: { message: string; code?: string } | null; count?: number | null };

function isSubset(sub: any, sup: any): boolean {
  if (sub === null || typeof sub !== "object") return sub === sup;
  if (sup === null || typeof sup !== "object") return false;
  return Object.entries(sub).every(([k, v]) => isSubset(v, sup[k]));
}

/** Column value; `payload->>key` reads one jsonb key as text, like PostgREST. */
function colValue(r: Row, col: string): any {
  const i = col.indexOf("->>");
  if (i < 0) return r[col];
  const v = r[col.slice(0, i)]?.[col.slice(i + 3)];
  return v == null ? v : String(v);
}

/** SQL LIKE with % wildcards, case-insensitive (enough for ilike/or filters in tests). */
function likeMatch(value: any, pattern: string): boolean {
  if (value == null) return false;
  const re = pattern.split("%").map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*");
  return new RegExp(`^${re}$`, "i").test(String(value));
}

export class FakeDb {
  tables: Record<string, Row[]>;
  /** Every write, in order: { table, op, payload } — for assertions. */
  writes: Array<{ table: string; op: "insert" | "update" | "delete"; payload?: any }> = [];
  private errors = new Map<string, { message: string; code?: string }>();
  private seq = 0;

  constructor(seed: Record<string, Row[]> = {}) {
    this.tables = {};
    for (const [t, rows] of Object.entries(seed)) this.tables[t] = rows.map((r) => ({ ...r }));
  }

  /** Make every `table.op` call fail with this message (op: select|insert|update|delete). */
  failOn(table: string, op: "select" | "insert" | "update" | "delete", message = "boom", code?: string) {
    this.errors.set(`${table}.${op}`, { message, code });
  }

  rows(table: string): Row[] {
    return (this.tables[table] ??= []);
  }

  nextId(): string {
    return `id-${++this.seq}`;
  }

  errorFor(table: string, op: string) {
    return this.errors.get(`${table}.${op}`) ?? null;
  }

  from(table: string) {
    return new Query(this, table);
  }
}

class Query implements PromiseLike<Result> {
  private op: "select" | "insert" | "update" | "delete" = "select";
  private payload: any = null;
  private filters: Array<(r: Row) => boolean> = [];
  private orderBy: { col: string; asc: boolean } | null = null;
  private max: number | null = null;
  private returning = false;
  private head = false;
  private wantCount = false;
  private mode: "many" | "single" | "maybeSingle" = "many";

  constructor(private db: FakeDb, private table: string) {}

  select(_cols?: string, opts?: { count?: string; head?: boolean }) {
    if (this.op === "select") {
      this.head = Boolean(opts?.head);
      this.wantCount = Boolean(opts?.count);
    } else {
      this.returning = true;
    }
    return this;
  }
  insert(payload: Row | Row[]) { this.op = "insert"; this.payload = payload; return this; }
  update(payload: Row) { this.op = "update"; this.payload = payload; return this; }
  delete() { this.op = "delete"; return this; }

  eq(col: string, val: any) { this.filters.push((r) => colValue(r, col) === val); return this; }
  neq(col: string, val: any) { this.filters.push((r) => r[col] !== val); return this; }
  gt(col: string, val: any) { this.filters.push((r) => r[col] != null && r[col] > val); return this; }
  gte(col: string, val: any) { this.filters.push((r) => r[col] != null && r[col] >= val); return this; }
  lt(col: string, val: any) { this.filters.push((r) => r[col] != null && r[col] < val); return this; }
  lte(col: string, val: any) { this.filters.push((r) => r[col] != null && r[col] <= val); return this; }
  in(col: string, vals: any[]) { this.filters.push((r) => vals.includes(colValue(r, col))); return this; }
  is(col: string, val: any) { this.filters.push((r) => (val === null ? r[col] == null : r[col] === val)); return this; }
  contains(col: string, obj: any) { this.filters.push((r) => isSubset(obj, r[col])); return this; }
  ilike(col: string, pattern: string) { this.filters.push((r) => likeMatch(r[col], pattern)); return this; }
  like(col: string, pattern: string) { this.filters.push((r) => likeMatch(r[col], pattern)); return this; }
  /** PostgREST `or`: "col.eq.v,col.is.null,col.ilike.%x%" — a row passes when any condition holds. */
  or(expr: string) {
    const conds = expr.split(",").map((c) => c.trim()).filter(Boolean).map((c) => {
      const [col, op, ...rest] = c.split(".");
      const val = rest.join(".");
      return (r: Row) => {
        if (op === "is") return val === "null" ? r[col] == null : String(r[col]) === val;
        if (op === "eq") return r[col] != null && String(r[col]) === val;
        if (op === "ilike" || op === "like") return likeMatch(r[col], val);
        return false;
      };
    });
    this.filters.push((r) => conds.some((f) => f(r)));
    return this;
  }
  order(col: string, opts?: { ascending?: boolean }) { this.orderBy = { col, asc: opts?.ascending !== false }; return this; }
  limit(n: number) { this.max = n; return this; }
  single() { this.mode = "single"; return this; }
  maybeSingle() { this.mode = "maybeSingle"; return this; }

  private run(): Result {
    const err = this.db.errorFor(this.table, this.op);
    if (err) return { data: null, error: { message: err.message, ...(err.code ? { code: err.code } : {}) } };
    const all = this.db.rows(this.table);

    if (this.op === "insert") {
      const list = Array.isArray(this.payload) ? this.payload : [this.payload];
      const made = list.map((r: Row) => ({ id: this.db.nextId(), created_at: new Date().toISOString(), ...r }));
      all.push(...made);
      this.db.writes.push({ table: this.table, op: "insert", payload: this.payload });
      return this.returning ? this.shape(made) : { data: null, error: null };
    }

    const hit = all.filter((r) => this.filters.every((f) => f(r)));

    if (this.op === "update") {
      for (const r of hit) Object.assign(r, this.payload);
      this.db.writes.push({ table: this.table, op: "update", payload: this.payload });
      return this.returning ? this.shape(hit) : { data: null, error: null };
    }
    if (this.op === "delete") {
      this.db.tables[this.table] = all.filter((r) => !hit.includes(r));
      this.db.writes.push({ table: this.table, op: "delete" });
      return this.returning ? this.shape(hit) : { data: null, error: null };
    }

    let out = [...hit];
    if (this.orderBy) {
      const { col, asc } = this.orderBy;
      out.sort((a, b) => (a[col] < b[col] ? -1 : a[col] > b[col] ? 1 : 0) * (asc ? 1 : -1));
    }
    if (this.max != null) out = out.slice(0, this.max);
    if (this.head) return { data: null, error: null, count: hit.length };
    const res = this.shape(out);
    return this.wantCount ? { ...res, count: hit.length } : res;
  }

  private shape(rows: Row[]): Result {
    if (this.mode === "many") return { data: rows.map((r) => ({ ...r })), error: null };
    if (rows.length > 1 && this.mode === "single") return { data: null, error: { message: "multiple rows", code: "PGRST116" } };
    if (rows.length === 0) {
      return this.mode === "single"
        ? { data: null, error: { message: "no rows", code: "PGRST116" } }
        : { data: null, error: null };
    }
    return { data: { ...rows[0] }, error: null };
  }

  then<T1 = Result, T2 = never>(
    onfulfilled?: ((value: Result) => T1 | PromiseLike<T1>) | null,
    onrejected?: ((reason: any) => T2 | PromiseLike<T2>) | null
  ): PromiseLike<T1 | T2> {
    return Promise.resolve(this.run()).then(onfulfilled, onrejected);
  }
}
