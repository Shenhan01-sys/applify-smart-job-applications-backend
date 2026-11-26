import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import {
  DEFAULT_MONTHLY_QUOTA,
  FREE_MONTHLY_QUOTA,
  PRO_MONTHLY_QUOTA,
  monthlyQuotaForTier,
  parseQuotaStatus,
} from '../services/quota-status.ts'

/**
 * Keputusan Hans 26 November 2026: kuota draf AI bulanan Pro 100, Free tetap 10.
 * Batas yang berlaku ada di kolom subscriptions.monthly_quota (dibaca get_quota_status / consume_monthly_apply);
 * backend hanya membaca hasilnya lewat parseQuotaStatus, jadi kuota Pro 100 harus terbaca apa adanya.
 */

const ROOT = path.resolve(import.meta.dirname, '../..')

test('konstanta kuota bulanan: Free 10, Pro 100, selain Pro dianggap Free', () => {
  assert.equal(FREE_MONTHLY_QUOTA, 10)
  assert.equal(PRO_MONTHLY_QUOTA, 100)
  assert.equal(DEFAULT_MONTHLY_QUOTA, FREE_MONTHLY_QUOTA)
  assert.equal(monthlyQuotaForTier('pro'), 100)
  assert.equal(monthlyQuotaForTier(' Pro '), 100)
  assert.equal(monthlyQuotaForTier('free'), 10)
  assert.equal(monthlyQuotaForTier('kampus'), 10)
  assert.equal(monthlyQuotaForTier(undefined), 10)
  assert.equal(monthlyQuotaForTier(null), 10)
})

test('parseQuotaStatus membaca kuota Pro 100 dari hasil get_quota_status, bukan bawaan 10', () => {
  const pro = parseQuotaStatus({ allowed: true, used: 37, quota: 100, limit_qty: 100, remaining: 63, tier: 'pro', period: '2026-11' })
  assert.deepEqual(pro, { quota: 100, used: 37, remaining: 63, allowed: true })
  const proFull = parseQuotaStatus({ allowed: false, used: 100, quota: 100, limit_qty: 100, remaining: 0 })
  assert.equal(proFull.allowed, false)
  assert.equal(proFull.remaining, 0)
  // Baris Free tetap 10.
  assert.equal(parseQuotaStatus({ used: 3, limit_qty: 10, remaining: 7 }).quota, 10)
  // Tanpa baris (akun baru) = kuota Free.
  assert.deepEqual(parseQuotaStatus(null), { quota: 10, used: 0, remaining: 10, allowed: true })
})

test('salinan konstanta backend sama dengan Edge Function frontend', (t) => {
  const edge = path.join(ROOT, 'applify-smart-job-applications/supabase/functions/_shared/quota.ts')
  if (!existsSync(edge)) return t.skip('repo frontend tidak ada di samping backend')
  const src = readFileSync(edge, 'utf8')
  assert.match(src, /FREE_MONTHLY_QUOTA = 10/)
  assert.match(src, /PRO_MONTHLY_QUOTA = 100/)
})

test('draf SQL kuota Pro 100 memakai angka yang sama dan tidak merusak data', (t) => {
  const file = path.join(ROOT, 'database/migrations/DRAFT_2026-11-26_pro_monthly_quota_100.sql')
  if (!existsSync(file)) return t.skip('folder database/migrations tidak tersedia di samping backend')
  const sql = readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => !l.trim().startsWith('--'))
    .join('\n')
  assert.match(sql, new RegExp(`CASE WHEN v_is_pro THEN ${PRO_MONTHLY_QUOTA} ELSE ${FREE_MONTHLY_QUOTA} END`))
  assert.match(sql, new RegExp(`SET monthly_quota = ${PRO_MONTHLY_QUOTA}`))
  assert.match(sql, /BEFORE INSERT OR UPDATE OF ai_model_tier ON public\.subscriptions/)
  assert.doesNotMatch(sql, /DROP TABLE|DROP COLUMN|TRUNCATE|DELETE\s+FROM/i)
})
