import { readFileSync } from 'node:fs'
import { makePdf } from './makePdf.ts'

/**
 * Pemuat fixture PDF LinkedIn SINTETIS (tests/fixtures/linkedin/*.txt). Tokoh dan perusahaannya fiktif.
 * Baris berawalan "# " adalah komentar; halaman dipisah baris `---PAGE---`.
 */
export function fixturePages(name = 'synthetic-profile-en.txt'): string[][] {
  const raw = readFileSync(new URL(`../fixtures/linkedin/${name}`, import.meta.url), 'utf8')
  const lines = raw.split('\n').filter((l) => !l.startsWith('# '))
  const pages: string[][] = [[]]
  for (const l of lines) {
    if (l.trim() === '---PAGE---') pages.push([])
    else if (l.trim() !== '') pages[pages.length - 1].push(l)
  }
  return pages
}

export const fixtureText = (name?: string): string => fixturePages(name).map((p) => p.join('\n')).join('\n')
export const fixturePdf = (name?: string): Buffer => makePdf(fixturePages(name))

/** Tanggal tetap supaya uji tidak bergantung pada hari ini. */
export const NOW = new Date('2026-11-20T10:00:00.000Z')
