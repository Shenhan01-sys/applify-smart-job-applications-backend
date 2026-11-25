import test from 'node:test'
import assert from 'node:assert/strict'
import { C1_RANKING_WEIGHTS, rankJobC1 } from '../services/job-ranking.service.ts'
import { aggregateJobs } from '../services/job-aggregation.service.ts'
import { mcpRegistry } from '../services/mcp-registry.ts'
import { BaseMCPClient, type JobPosting, type MCPResponse } from '../mcp/shared/types.ts'

const NOW = Date.parse('2026-11-24T12:00:00Z')
const hoursAgo = (h: number) => new Date(NOW - h * 3600 * 1000).toISOString()
const daysAgo = (d: number) => new Date(NOW - d * 24 * 3600 * 1000).toISOString()

test('C1 ranking weights: bobot Catatan 29 menjumlah 1.0 secara konsisten', () => {
  const sum = C1_RANKING_WEIGHTS.fit + C1_RANKING_WEIGHTS.freshness + C1_RANKING_WEIGHTS.salary + C1_RANKING_WEIGHTS.workType
  assert.ok(Math.abs(sum - 1.0) < 1e-9)
})

test('C1 sinonim ID/EN: kueri "analis data" mengenali judul Inggris "Data Analyst" + sinonim "k8s" / "Kubernetes"', () => {
  const bilingualJob: JobPosting = {
    id: 'j-syn',
    title: 'Data Analyst',
    company: 'PT Data',
    location: 'Jakarta, Indonesia',
    description: 'Membangun dashboard dan klaster Kubernetes untuk analitik.',
    posted_at: hoursAgo(6),
    url: 'https://example.test/syn',
  }
  const unrelatedJob: JobPosting = {
    id: 'j-other',
    title: 'Graphic Designer',
    company: 'PT Kreatif',
    location: 'Jakarta, Indonesia',
    description: 'Desain banner promosi.',
    posted_at: hoursAgo(6),
    url: 'https://example.test/other',
  }

  const rSyn = rankJobC1(bilingualJob, { keywords: 'analis data', skills: ['k8s'], location: 'Jakarta', nowMs: NOW })
  const rOther = rankJobC1(unrelatedJob, { keywords: 'analis data', skills: ['k8s'], location: 'Jakarta', nowMs: NOW })

  assert.ok(rSyn.score > rOther.score + 30)
  assert.ok(rSyn.matchedSynonyms.length >= 1)
  assert.ok(rSyn.matchedSkills.includes('k8s'))
  assert.ok(rSyn.reasons.some((s) => /sinonim/i.test(s)))
})

test('C1 saturasi BM25: pengulangan kata di deskripsi tidak mengalahkan kecocokan judul yang asli', () => {
  const titleMatch: JobPosting = {
    id: 'real',
    title: 'Backend Engineer',
    company: 'PT Nyata',
    location: 'Jakarta, Indonesia',
    description: 'Membangun layanan API dengan Node.js dan PostgreSQL.',
    posted_at: daysAgo(1),
    url: 'https://example.test/real',
  }
  const keywordSpam: JobPosting = {
    id: 'spam',
    title: 'Administrative Assistant',
    company: 'PT Spam',
    location: 'Jakarta, Indonesia',
    description: Array(20).fill('backend engineer api').join(' '),
    posted_at: daysAgo(1),
    url: 'https://example.test/spam',
  }

  const realRes = rankJobC1(titleMatch, { keywords: 'backend engineer', skills: ['PostgreSQL'], location: 'Jakarta', nowMs: NOW })
  const spamRes = rankJobC1(keywordSpam, { keywords: 'backend engineer', skills: ['PostgreSQL'], location: 'Jakarta', nowMs: NOW })

  assert.ok(realRes.score > spamRes.score, `real (${realRes.score}) harus menang melawan keyword stuffing (${spamRes.score})`)
  assert.ok(realRes.breakdown.fit !== null && spamRes.breakdown.fit !== null)
  assert.ok(realRes.breakdown.fit > spamRes.breakdown.fit)
})

test('C1 freshness, penalti seniority mismatch, dan faktor lokasi di daftar lowongan sintetis', () => {
  const ctx = {
    keywords: 'software engineer',
    skills: ['TypeScript', 'React'],
    location: 'Jakarta',
    experienceLevels: ['junior'],
    desiredSalary: 10_000_000,
    workTypes: ['remote'],
    nowMs: NOW,
  }

  const idealFresh: JobPosting = {
    id: 'ideal',
    title: 'Junior Software Engineer',
    company: 'PT Cocok',
    location: 'Jakarta, Indonesia',
    work_type: 'remote',
    description: 'TypeScript & React app',
    salary_min: 9_000_000,
    salary_max: 12_000_000,
    posted_at: hoursAgo(4),
    url: 'https://example.test/1',
  }
  const staleNoSalary: JobPosting = {
    id: 'stale',
    title: 'Junior Software Engineer',
    company: 'PT Lama',
    location: 'Jakarta, Indonesia',
    work_type: 'on-site',
    description: 'TypeScript & React app',
    posted_at: daysAgo(45),
    url: 'https://example.test/2',
  }
  const seniorMismatch: JobPosting = {
    id: 'senior',
    title: 'Lead Software Engineer',
    company: 'PT Lead',
    location: 'Jakarta, Indonesia',
    work_type: 'remote',
    description: 'TypeScript & React',
    salary_min: 20_000_000,
    salary_max: 30_000_000,
    posted_at: hoursAgo(4),
    url: 'https://example.test/3',
  }
  const wrongCityOnsite: JobPosting = {
    id: 'wrong-loc',
    title: 'Junior Software Engineer',
    company: 'PT Luar',
    location: 'Surabaya, Indonesia',
    work_type: 'on-site',
    description: 'TypeScript & React',
    posted_at: hoursAgo(4),
    url: 'https://example.test/4',
  }

  const rIdeal = rankJobC1(idealFresh, ctx)
  const rStale = rankJobC1(staleNoSalary, ctx)
  const rSenior = rankJobC1(seniorMismatch, ctx)
  const rLoc = rankJobC1(wrongCityOnsite, ctx)

  assert.ok(rIdeal.score >= 85 && rIdeal.score <= 100)
  assert.ok(rIdeal.score > rStale.score)
  assert.ok(rIdeal.score > rSenior.score)
  assert.ok(rIdeal.score > rLoc.score)
  assert.equal(rSenior.breakdown.seniorityPenalty, 25)
  assert.equal(rLoc.breakdown.locationFactor, 0.55)
  for (const r of [rIdeal, rStale, rSenior, rLoc]) {
    assert.ok(Number.isInteger(r.score) && r.score >= 0 && r.score <= 100)
    assert.ok(Array.isArray(r.reasons) && r.reasons.length >= 2)
  }
})

test('aggregateJobs mengurutkan hasil dengan skor hybrid C1 dan menyertakan score_reasons & scoreReasons', async () => {
  class SyntheticBoard extends BaseMCPClient {
    name = 'synth-c1'
    baseUrl = 'https://synth.c1.test'
    displayName = 'Synthetic C1'
    kind = 'board' as const
    async searchJobs(): Promise<MCPResponse> {
      return {
        success: true,
        data: {
          jobs: [
            {
              id: 'old-lead',
              title: 'Principal Backend Developer',
              company: 'PT Old',
              location: 'Surabaya, Indonesia',
              work_type: 'on-site',
              description: 'Backend APIs',
              posted_at: daysAgo(40),
              url: 'https://synth.c1.test/old-lead',
            },
            {
              id: 'fresh-junior',
              title: 'Junior Backend Developer',
              company: 'PT Fresh',
              location: 'Jakarta, Indonesia',
              work_type: 'remote',
              description: 'Node.js PostgreSQL APIs',
              salary_min: 8_000_000,
              salary_max: 11_000_000,
              posted_at: hoursAgo(5),
              url: 'https://synth.c1.test/fresh-junior',
            },
          ],
        },
      }
    }
    async getJobDetails(): Promise<MCPResponse> {
      return { success: false, error: 'n/a' }
    }
  }

  mcpRegistry.register('synth-c1', new SyntheticBoard())
  const agg = await aggregateJobs({
    keywords: 'backend developer',
    skills: ['Node.js', 'Postgres'],
    location: 'any',
    platforms: ['synth-c1'],
    experienceLevels: ['junior'],
    workTypes: ['remote'],
    nowMs: NOW,
  })

  assert.equal(agg.jobs.length, 2)
  assert.equal(agg.jobs[0].id, 'fresh-junior')
  assert.ok((agg.jobs[0].rank_score ?? 0) > (agg.jobs[1].rank_score ?? 0))
  assert.ok(Array.isArray(agg.jobs[0].score_reasons) && agg.jobs[0].score_reasons.length >= 3)
  assert.deepEqual(agg.jobs[0].scoreReasons, agg.jobs[0].score_reasons)
})

// ───────────────────────────────────────────── GAP-11: skor jujur saat data kosong

test('GAP-11: tanpa kata kunci dan tanpa skill, score dan breakdown.fit bernilai null, bukan 50', () => {
  const job: JobPosting = {
    id: 'no-input',
    title: 'Backend Engineer',
    company: 'Acme',
    location: 'Jakarta',
    description: 'Node.js dan PostgreSQL',
    posted_at: hoursAgo(3),
    url: 'https://example.test/no-input',
  }
  const r = rankJobC1(job, { keywords: '', skills: [], location: 'Jakarta', nowMs: NOW })
  assert.equal(r.score, null)
  assert.equal(r.breakdown.fit, null)
  assert.deepEqual(r.matchedKeywords, [])
  assert.deepEqual(r.matchedSkills, [])
  assert.ok(r.reasons.some((s) => /belum cukup/i.test(s)), JSON.stringify(r.reasons))
  assert.ok(!r.reasons.some((s) => /50%/.test(s)))
})

test('GAP-11: judul, deskripsi, requirements, dan skills kosong membuat score null walau kueri diisi', () => {
  const empty: JobPosting = {
    id: 'empty-text',
    company: 'Acme',
    location: 'Jakarta',
    posted_at: hoursAgo(3),
    url: 'https://example.test/empty-text',
  }
  const r = rankJobC1(empty, { keywords: 'backend engineer', skills: ['Node.js'], location: 'Jakarta', nowMs: NOW })
  assert.equal(r.score, null)
  assert.equal(r.breakdown.fit, null)
  assert.ok(r.reasons.some((s) => /belum cukup/i.test(s)))
})

test('GAP-11: gaji tidak tercantum membuat breakdown.salary null dan bobot didistribusikan ulang tanpa NaN', () => {
  const job: JobPosting = {
    id: 'no-salary',
    title: 'Backend Engineer',
    company: 'Acme',
    location: 'Jakarta',
    work_type: 'remote',
    description: 'Node.js dan PostgreSQL',
    posted_at: hoursAgo(3),
    url: 'https://example.test/no-salary',
  }
  const r = rankJobC1(job, { keywords: 'backend engineer', skills: ['Node.js'], location: 'Jakarta', nowMs: NOW })
  assert.equal(r.breakdown.salary, null)
  assert.equal(r.breakdown.weights, '0.78/0.17/0.00/0.06')
  assert.ok(r.breakdown.fit !== null && r.breakdown.fit > 0)
  assert.ok(typeof r.score === 'number' && Number.isFinite(r.score) && r.score > 0 && r.score <= 100)
  assert.ok(r.reasons.some((s) => /gaji belum tercantum/i.test(s)))

  const withSalary = rankJobC1({ ...job, salary_min: 10_000_000, salary_max: 15_000_000 }, { keywords: 'backend engineer', skills: ['Node.js'], location: 'Jakarta', nowMs: NOW })
  assert.equal(withSalary.breakdown.weights, '0.70/0.15/0.10/0.05')

  const noBasis = rankJobC1(job, { keywords: '', skills: [], location: 'Jakarta', nowMs: NOW })
  assert.equal(noBasis.breakdown.salary, null)
  assert.equal(noBasis.score, null)
})

test('GAP-11: agregasi mengurutkan lowongan berskor numerik di atas lowongan berskor null', async () => {
  class Gap11Board extends BaseMCPClient {
    name = 'gap11-null'
    baseUrl = 'https://gap11.test'
    displayName = 'Gap 11 Board'
    kind = 'board' as const
    async searchJobs(): Promise<MCPResponse> {
      return {
        success: true,
        data: {
          jobs: [
            {
              id: 'gap11-empty',
              company: 'Acme',
              location: 'Jakarta, Indonesia',
              posted_at: hoursAgo(1),
              url: 'https://gap11.test/empty',
            },
            {
              id: 'gap11-scored',
              title: 'Backend Engineer',
              company: 'Acme',
              location: 'Jakarta, Indonesia',
              description: 'Node.js dan PostgreSQL',
              posted_at: daysAgo(10),
              url: 'https://gap11.test/scored',
            },
          ],
        },
      }
    }
    async getJobDetails(): Promise<MCPResponse> {
      return { success: false, error: 'n/a' }
    }
  }
  mcpRegistry.register('gap11-null', new Gap11Board())
  const agg = await aggregateJobs({
    keywords: 'backend engineer',
    skills: ['Node.js'],
    location: 'any',
    platforms: ['gap11-null'],
    nowMs: NOW,
  })
  assert.equal(agg.jobs.length, 2)
  assert.equal(agg.jobs[0].id, 'gap11-scored')
  assert.ok(typeof agg.jobs[0].rank_score === 'number' && Number.isFinite(agg.jobs[0].rank_score))
  assert.equal(agg.jobs[1].rank_score, null)
})

// ───────────────────────────────────────────── 47.3 P1-04: tanggal terbit dan tipe kerja kosong tidak dikarang

const baseNoDates: JobPosting = {
  id: 'p104',
  title: 'Backend Engineer',
  company: 'Acme',
  location: 'Jakarta',
  description: 'Node.js dan PostgreSQL',
  url: 'https://example.test/p104',
}
const p104Ctx = { keywords: 'backend engineer', skills: ['Node.js'], location: 'Jakarta', nowMs: NOW }

test('P1-04: posted_at kosong atau tidak valid membuat breakdown.freshness null dan bobotnya didistribusikan ulang', () => {
  for (const posted_at of [undefined, '', 'bukan tanggal']) {
    const r = rankJobC1({ ...baseNoDates, posted_at }, p104Ctx)
    assert.equal(r.breakdown.freshness, null, String(posted_at))
    assert.equal(r.breakdown.workType, null)
    assert.equal(r.breakdown.salary, null)
    // Hanya fit yang punya data: bobot efektif 1.00 dan skor sama dengan fit (lokasi cocok, tanpa penalti).
    assert.equal(r.breakdown.weights, '1.00/0.00/0.00/0.00')
    assert.equal(r.score, r.breakdown.fit)
    assert.ok(r.reasons.some((s) => /tanggal terbit belum tercantum/i.test(s)))
  }
})

test('P1-04: work_type kosong membuat breakdown.workType null, baik dengan maupun tanpa preferensi tipe kerja', () => {
  const dated = { ...baseNoDates, posted_at: hoursAgo(3) }
  const noPref = rankJobC1(dated, p104Ctx)
  assert.equal(noPref.breakdown.workType, null)
  assert.equal(noPref.breakdown.weights, '0.82/0.18/0.00/0.00')

  const withPref = rankJobC1(dated, { ...p104Ctx, workTypes: ['remote'] })
  assert.equal(withPref.breakdown.workType, null)
  assert.equal(withPref.breakdown.weights, '0.82/0.18/0.00/0.00')
  assert.equal(withPref.score, noPref.score)
})

test('P1-04: work_type terisi tetap dinilai (cocok 100, tidak cocok 15, remote tanpa preferensi 85, on-site 55)', () => {
  const dated = { ...baseNoDates, posted_at: hoursAgo(3) }
  assert.equal(rankJobC1({ ...dated, work_type: 'remote' }, { ...p104Ctx, workTypes: ['remote'] }).breakdown.workType, 100)
  assert.equal(rankJobC1({ ...dated, work_type: 'on-site' }, { ...p104Ctx, workTypes: ['remote'] }).breakdown.workType, 15)
  assert.equal(rankJobC1({ ...dated, work_type: 'remote' }, p104Ctx).breakdown.workType, 85)
  assert.equal(rankJobC1({ ...dated, work_type: 'on-site' }, p104Ctx).breakdown.workType, 55)
})

test('P1-04: lowongan tanpa tanggal tidak lagi dihukum angka sintetis 30 dan tidak melampaui lowongan baru yang sama persis', () => {
  const undated = rankJobC1(baseNoDates, p104Ctx)
  const fresh = rankJobC1({ ...baseNoDates, posted_at: hoursAgo(3) }, p104Ctx)
  const stale = rankJobC1({ ...baseNoDates, posted_at: daysAgo(60) }, p104Ctx)
  assert.ok(typeof undated.score === 'number' && typeof fresh.score === 'number' && typeof stale.score === 'number')
  assert.ok(fresh.score >= undated.score, `${fresh.score} < ${undated.score}`)
  assert.ok(undated.score > stale.score, `${undated.score} <= ${stale.score}`)
})
