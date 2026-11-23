const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** True hanya untuk string berbentuk UUID (8-4-4-4-12 heksadesimal). Dipakai sebelum id masuk ke kueri Postgres. */
export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value)
}
