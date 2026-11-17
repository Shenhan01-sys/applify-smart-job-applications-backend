import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { LINKEDIN_LAUNCH_ARGS, linkedinContextOptions } from '../mcp/linkedin/index.ts'
import { BROWSER_LIKE_USER_AGENT } from '../mcp/shared/types.ts'

// ---- LinkedIn client: no disguise -------------------------------------------------------------------

test('LinkedIn: tidak ada bendera penyembunyi otomasi dan UA tetap (tanpa rotasi acak)', () => {
  assert.deepEqual(LINKEDIN_LAUNCH_ARGS, ['--no-sandbox'])
  assert.ok(!LINKEDIN_LAUNCH_ARGS.some((a) => /AutomationControlled/i.test(a)))

  const seen = new Set<string>()
  for (let i = 0; i < 50; i++) seen.add(linkedinContextOptions().userAgent)
  assert.deepEqual([...seen], [BROWSER_LIKE_USER_AGENT])
  assert.equal(linkedinContextOptions('state.json').storageState, 'state.json')
  assert.equal('storageState' in linkedinContextOptions(), false)
})

test('LinkedIn: kode tidak lagi memuat getRandomUserAgent atau AutomationControlled (di luar komentar)', () => {
  const src = readFileSync(new URL('../mcp/linkedin/index.ts', import.meta.url), 'utf8')
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  assert.doesNotMatch(code, /getRandomUserAgent|AutomationControlled|Math\.random/)
})
