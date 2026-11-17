// Monthly AI-draft quota: how to read what the database functions get_quota_status / consume_monthly_apply
// return (database/rpc.sql is the source of truth for the columns).
//
// Salinan logika `parseQuotaStatus` di applify-smart-job-applications/supabase/functions/_shared/quota.ts,
// yang dipakai Edge Function generate-application. Backend adalah paket terpisah dan tidak mengimpor kode
// frontend, jadi file ini harus tetap sama dengan aslinya; tests/quota-status.test.ts memakai vektor uji yang
// sama dengan tests/quotaStatus.test.ts di frontend.
//
// Both functions are declared `returns table (...)`, so PostgREST sends an ARRAY with one row
// ({ allowed, used, limit_qty, remaining[, period] }), not an object. Reading `data.remaining` straight
// off the array gives undefined, which silently disables the quota check.

export const DEFAULT_MONTHLY_QUOTA = 10

export interface QuotaSummary {
  /** Allowed drafts per month (subscriptions.daily_apply_quota is the column the database functions use). */
  quota: number
  used: number
  remaining: number
  allowed: boolean
}

const count = (v: unknown): number | undefined => {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? Math.floor(n) : undefined
}

/** Normalise a get_quota_status / consume_monthly_apply result (array of rows, one row, or empty). */
export function parseQuotaStatus(raw: unknown): QuotaSummary {
  const row: any = Array.isArray(raw) ? raw[0] : raw
  if (!row || typeof row !== 'object') {
    return { quota: DEFAULT_MONTHLY_QUOTA, used: 0, remaining: DEFAULT_MONTHLY_QUOTA, allowed: true }
  }
  const quota = count(row.limit_qty) ?? count(row.limit) ?? DEFAULT_MONTHLY_QUOTA
  const used = count(row.used) ?? 0
  const remaining = count(row.remaining) ?? Math.max(0, quota - used)
  const allowed = typeof row.allowed === 'boolean' ? row.allowed : remaining > 0
  return { quota, used, remaining, allowed }
}
