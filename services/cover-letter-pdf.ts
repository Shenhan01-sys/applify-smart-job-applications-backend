// Port of worker/src/lib/coverLetterPdf.ts (24 November 2026), copied as is so the two files can be compared with a plain diff.
// Keep them in step: a change to the layout in one place belongs in the other (tests/cover-letter-pdf.test.ts mirrors the worker's).
// Cover letter text -> PDF 1.4, without any dependency. Pure: no file, no network, no clock.
// A4, Helvetica 11 pt (standard Type1 font, WinAnsiEncoding, so nothing is embedded), 72 pt margins, word wrap by the
// real width of each glyph (standard Helvetica AFM widths), blank lines kept as paragraph breaks, new page when full.
// The text of a letter is personal data: nothing here logs it.

export interface CoverLetterPdfOptions {
  /** Document title (PDF Info /Title). Plain text, cut at 120 characters. */
  title?: string;
}

/** Longest input taken (in characters); the rest is dropped. A real cover letter is far shorter. */
export const MAX_COVER_LETTER_CHARS = 20_000;

export const PDF_PAGE_WIDTH = 595;
export const PDF_PAGE_HEIGHT = 842;
export const PDF_MARGIN = 72;
export const PDF_FONT_SIZE = 11;
export const PDF_LEADING = 15;

/** Baseline of the first line, and how many lines fit between the margins. */
const FIRST_BASELINE = PDF_PAGE_HEIGHT - PDF_MARGIN - PDF_FONT_SIZE;
export const LINES_PER_PAGE = Math.floor((FIRST_BASELINE - PDF_MARGIN) / PDF_LEADING) + 1;
/** Line width in AFM units (1/1000 of the font size): the 451 pt between the margins, at 11 pt. */
const MAX_LINE_UNITS = Math.floor(((PDF_PAGE_WIDTH - 2 * PDF_MARGIN) * 1000) / PDF_FONT_SIZE);
/** Longest run of blank lines kept between two paragraphs. */
const MAX_BLANK_RUN = 2;

/**
 * Helvetica glyph widths (Adobe AFM, 1/1000 em) for the WinAnsiEncoding codes 32..255, sixteen per row.
 * Codes WinAnsi leaves undefined (127, 129, 141, 143, 144, 157) use the bullet width, like a PDF viewer does.
 */
const HELVETICA_WIDTHS: readonly number[] = [
  /* 32 */ 278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
  /* 48 */ 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
  /* 64 */ 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
  /* 80 */ 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
  /* 96 */ 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
  /* 112 */ 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584, 350,
  /* 128 */ 556, 350, 222, 556, 333, 1000, 556, 556, 333, 1000, 667, 333, 1000, 350, 611, 350,
  /* 144 */ 350, 222, 222, 333, 333, 350, 556, 1000, 333, 1000, 500, 333, 944, 350, 500, 667,
  /* 160 */ 278, 333, 556, 556, 556, 556, 260, 556, 333, 737, 370, 556, 584, 333, 737, 333,
  /* 176 */ 400, 584, 333, 333, 333, 556, 537, 278, 333, 333, 365, 556, 834, 834, 834, 611,
  /* 192 */ 667, 667, 667, 667, 667, 667, 1000, 722, 667, 667, 667, 667, 278, 278, 278, 278,
  /* 208 */ 722, 722, 778, 778, 778, 778, 778, 584, 778, 722, 722, 722, 722, 667, 667, 611,
  /* 224 */ 556, 556, 556, 556, 556, 556, 889, 500, 556, 556, 556, 556, 278, 278, 278, 278,
  /* 240 */ 556, 556, 556, 556, 556, 556, 556, 584, 611, 556, 556, 556, 556, 500, 556, 500,
];

/** Width of one WinAnsi code in AFM units. */
export const glyphWidth = (code: number): number => (code >= 32 && code <= 255 ? HELVETICA_WIDTHS[code - 32] : 556);

/** Width of a string of WinAnsi characters, in AFM units. */
const unitsOf = (s: string): number => {
  let n = 0;
  for (let i = 0; i < s.length; i++) n += glyphWidth(s.charCodeAt(i));
  return n;
};

/** Text width in points at the document font size. */
export const textWidthPt = (s: string): number => (unitsOf(s) * PDF_FONT_SIZE) / 1000;

/** Unicode characters outside Latin-1 that WinAnsi (Windows-1252) has at codes 128..159. */
const WIN_ANSI_EXTRA = new Map<number, number>([
  [0x20ac, 128], [0x201a, 130], [0x0192, 131], [0x201e, 132], [0x2026, 133], [0x2020, 134], [0x2021, 135],
  [0x02c6, 136], [0x2030, 137], [0x0160, 138], [0x2039, 139], [0x0152, 140], [0x017d, 142], [0x2018, 145],
  [0x2019, 146], [0x201c, 147], [0x201d, 148], [0x2022, 149], [0x2013, 150], [0x2014, 151], [0x02dc, 152],
  [0x2122, 153], [0x0161, 154], [0x203a, 155], [0x0153, 156], [0x017e, 158], [0x0178, 159],
]);

/** Other Unicode characters that have a plain WinAnsi stand-in. */
const STAND_IN = new Map<number, string>([
  [0x2010, "-"], [0x2011, "-"], [0x2012, "-"], [0x2212, "-"], [0x2032, "'"], [0x2033, '"'],
  [0xfb00, "ff"], [0xfb01, "fi"], [0xfb02, "fl"], [0xfb03, "ffi"], [0xfb04, "ffl"],
]);

/** Characters that carry no width or no sense in a letter: dropped without a replacement. */
const isDropped = (cp: number): boolean =>
  cp < 0x20 || (cp >= 0x7f && cp <= 0x9f) || cp === 0xad || (cp >= 0x200b && cp <= 0x200f) || (cp >= 0x202a && cp <= 0x202e) ||
  cp === 0x2060 || cp === 0xfeff || (cp >= 0x0300 && cp <= 0x036f) || (cp >= 0xfe00 && cp <= 0xfe0f);

const isSpaceLike = (cp: number): boolean => cp === 0xa0 || (cp >= 0x2000 && cp <= 0x200a) || cp === 0x202f || cp === 0x205f || cp === 0x3000;
const isLineBreak = (cp: number): boolean => cp === 0x0a || cp === 0x0d || cp === 0x85 || cp === 0x2028 || cp === 0x2029;

/**
 * Text as lines of WinAnsi characters (one JS character = one WinAnsi code). Line breaks are kept, a tab becomes four
 * spaces, control characters are dropped, characters WinAnsi lacks become "?". Input is cut at MAX_COVER_LETTER_CHARS.
 */
export function toWinAnsiLines(input: unknown): string[] {
  const lines: string[] = [];
  let cur = "";
  let count = 0;
  const text = String(input ?? "").normalize("NFC");
  const chars = Array.from(text);
  for (let i = 0; i < chars.length && count < MAX_COVER_LETTER_CHARS; i++, count++) {
    const cp = chars[i].codePointAt(0) as number;
    if (isLineBreak(cp)) {
      if (cp === 0x0d && chars[i + 1] === "\n") i++; // CRLF is one break
      lines.push(cur);
      cur = "";
    } else if (cp === 0x09) {
      cur += "    ";
    } else if (isSpaceLike(cp)) {
      cur += " ";
    } else if (isDropped(cp)) {
      // nothing
    } else if (cp >= 0x20 && cp <= 0x7e) {
      cur += String.fromCharCode(cp);
    } else if (cp >= 0xa1 && cp <= 0xff) {
      cur += String.fromCharCode(cp);
    } else if (WIN_ANSI_EXTRA.has(cp)) {
      cur += String.fromCharCode(WIN_ANSI_EXTRA.get(cp) as number);
    } else if (STAND_IN.has(cp)) {
      cur += STAND_IN.get(cp);
    } else {
      cur += "?";
    }
  }
  lines.push(cur);
  return lines;
}

/** One PDF literal string body: backslash and parentheses escaped, every byte above 126 as an octal escape (pure ASCII). */
export function escapePdfText(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x5c) out += "\\\\";
    else if (c === 0x28) out += "\\(";
    else if (c === 0x29) out += "\\)";
    else if (c < 0x20 || c > 0x7e) out += "\\" + (c & 0xff).toString(8).padStart(3, "0");
    else out += s[i];
  }
  return out;
}

/** Cut a word that is wider than a whole line into pieces that each fit. */
function breakWord(word: string): string[] {
  const pieces: string[] = [];
  let cur = "";
  let units = 0;
  for (const ch of word) {
    const w = glyphWidth(ch.charCodeAt(0));
    if (cur && units + w > MAX_LINE_UNITS) {
      pieces.push(cur);
      cur = "";
      units = 0;
    }
    cur += ch;
    units += w;
  }
  if (cur) pieces.push(cur);
  return pieces;
}

/** Wrap one paragraph line to the text width. A blank line stays one blank line. */
export function wrapLine(line: string): string[] {
  const words = line.split(" ").filter(Boolean);
  if (words.length === 0) return [""];
  const spaceUnits = glyphWidth(32);
  const out: string[] = [];
  let cur = "";
  let curUnits = 0;
  for (const word of words) {
    const wordUnits = unitsOf(word);
    if (wordUnits > MAX_LINE_UNITS) {
      if (cur) out.push(cur);
      const pieces = breakWord(word);
      for (let k = 0; k < pieces.length - 1; k++) out.push(pieces[k]);
      cur = pieces[pieces.length - 1];
      curUnits = unitsOf(cur);
    } else if (!cur) {
      cur = word;
      curUnits = wordUnits;
    } else if (curUnits + spaceUnits + wordUnits <= MAX_LINE_UNITS) {
      cur += " " + word;
      curUnits += spaceUnits + wordUnits;
    } else {
      out.push(cur);
      cur = word;
      curUnits = wordUnits;
    }
  }
  if (cur) out.push(cur);
  return out;
}

/** Text -> wrapped lines split over pages. No blank line starts a page, and no page is empty (except for empty text). */
export function layoutPages(text: unknown): string[][] {
  const wrapped: string[] = [];
  let blankRun = 0;
  for (const raw of toWinAnsiLines(text)) {
    for (const line of wrapLine(raw.trim())) {
      if (line === "") {
        if (wrapped.length === 0 || ++blankRun > MAX_BLANK_RUN) continue;
      } else {
        blankRun = 0;
      }
      wrapped.push(line);
    }
  }
  while (wrapped.length > 0 && wrapped[wrapped.length - 1] === "") wrapped.pop();

  const pages: string[][] = [];
  let page: string[] = [];
  for (const line of wrapped) {
    if (page.length === 0 && line === "") continue;
    page.push(line);
    if (page.length === LINES_PER_PAGE) {
      pages.push(page);
      page = [];
    }
  }
  if (page.length > 0 || pages.length === 0) pages.push(page);
  return pages;
}

/** Content stream of one page: every line is shown, then the cursor moves one leading down. */
function pageStream(lines: string[]): string {
  const parts = ["BT", `/F1 ${PDF_FONT_SIZE} Tf`, `${PDF_LEADING} TL`, `${PDF_MARGIN} ${FIRST_BASELINE} Td`];
  lines.forEach((line, i) => {
    if (i > 0) parts.push("T*");
    if (line !== "") parts.push(`(${escapePdfText(line)}) Tj`);
  });
  parts.push("ET");
  return parts.join("\n");
}

/** Plain one-line text for the Info dictionary. */
function cleanTitle(title: unknown): string {
  return toWinAnsiLines(title).join(" ").replace(/\s+/g, " ").trim().slice(0, 120);
}

/**
 * The letter as a PDF 1.4 document. Object layout: 1 Catalog, 2 Pages, 3 Font, then a Page and its content stream per
 * page, and the Info dictionary last when a title is given. Every byte is ASCII except the binary comment of the header
 * line, so string offsets are byte offsets and the xref table is exact.
 */
export function buildCoverLetterPdf(text: string, opts: CoverLetterPdfOptions = {}): Buffer {
  const pages = layoutPages(text);
  const title = cleanTitle(opts.title);

  const bodies: string[] = [];
  const pageObj = (i: number) => 4 + 2 * i;
  bodies.push("<< /Type /Catalog /Pages 2 0 R >>");
  bodies.push(`<< /Type /Pages /Kids [${pages.map((_, i) => `${pageObj(i)} 0 R`).join(" ")}] /Count ${pages.length} >>`);
  bodies.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
  pages.forEach((lines, i) => {
    bodies.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PDF_PAGE_WIDTH} ${PDF_PAGE_HEIGHT}] ` +
        `/Resources << /Font << /F1 3 0 R >> >> /Contents ${pageObj(i) + 1} 0 R >>`
    );
    const stream = pageStream(lines);
    bodies.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  });
  const infoRef = title ? bodies.length + 1 : 0;
  if (title) bodies.push(`<< /Title (${escapePdfText(title)}) >>`);

  let out = "%PDF-1.4\n%âãÏÓ\n";
  const offsets: number[] = [];
  bodies.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefAt = out.length;
  out += `xref\n0 ${bodies.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${bodies.length + 1} /Root 1 0 R${infoRef ? ` /Info ${infoRef} 0 R` : ""} >>\nstartxref\n${xrefAt}\n%%EOF`;
  return Buffer.from(out, "latin1");
}
