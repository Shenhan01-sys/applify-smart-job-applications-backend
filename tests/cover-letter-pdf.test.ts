import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  LINES_PER_PAGE,
  MAX_COVER_LETTER_CHARS,
  PDF_MARGIN,
  PDF_PAGE_WIDTH,
  buildCoverLetterPdf,
  escapePdfText,
  glyphWidth,
  layoutPages,
  textWidthPt,
  toWinAnsiLines,
} from "../services/cover-letter-pdf.js";

/**
 * Pembuat PDF surat lamaran (port dari worker/tests/cover-letter-pdf.test.ts, tanpa bagian berkas sementara).
 * Tidak ada jaringan. Bila pdftotext ada di mesin ini, hasilnya ikut dibaca ulang; bila tidak, tes itu dilewati.
 */

const text = (pdf: Buffer): string => pdf.toString("latin1");
const PARA =
  "Dengan hormat, saya tertarik pada posisi Backend Engineer di perusahaan Anda. Selama tiga tahun terakhir saya membangun layanan " +
  "yang melayani jutaan permintaan per hari, dan saya ingin membawa pengalaman itu ke tim Anda.";

// ───────────────────────────────────────────────────────────── struktur PDF

test("PDF: dimulai %PDF-1.4, diakhiri %%EOF, A4, Helvetica WinAnsi", () => {
  const s = text(buildCoverLetterPdf("Halo dunia"));
  assert.ok(s.startsWith("%PDF-1.4\n"));
  assert.ok(s.endsWith("%%EOF"));
  assert.match(s, /\/MediaBox \[0 0 595 842\]/);
  assert.match(s, /\/BaseFont \/Helvetica \/Encoding \/WinAnsiEncoding/);
  assert.match(s, /\/Type \/Font \/Subtype \/Type1/);
  assert.match(s, /BT\n\/F1 11 Tf\n15 TL\n72 759 Td\n\(Halo dunia\) Tj\nET/);
});

test("PDF: tabel xref akurat, tiap offset menunjuk ke 'N 0 obj', startxref menunjuk ke 'xref'", () => {
  const pdf = buildCoverLetterPdf(Array.from({ length: 30 }, () => PARA).join("\n\n"), { title: "Cover Letter - Budi" });
  const s = text(pdf);
  assert.equal(pdf.length, s.length, "satu karakter = satu byte");
  const startxref = Number(/startxref\n(\d+)\n%%EOF$/.exec(s)?.[1]);
  assert.equal(s.slice(startxref, startxref + 4), "xref");
  const head = /xref\n0 (\d+)\n/.exec(s.slice(startxref));
  const size = Number(head?.[1]);
  assert.ok(size > 4);
  const entries = s.slice(startxref + head![0].length, s.indexOf("trailer")).split("\n").filter(Boolean);
  assert.equal(entries.length, size);
  assert.equal(entries[0], "0000000000 65535 f ");
  assert.ok(entries.every((e) => e.length === 19), "tiap entri 20 byte dengan akhir baris");
  entries.slice(1).forEach((e, i) => {
    const off = Number(e.slice(0, 10));
    assert.match(e, /^\d{10} 00000 n $/);
    assert.ok(s.slice(off).startsWith(`${i + 1} 0 obj\n`), `objek ${i + 1} di offset ${off}`);
  });
  assert.match(s, new RegExp(`trailer\\n<< /Size ${size} /Root 1 0 R /Info \\d+ 0 R >>`));
  // /Length tiap aliran cocok dengan isinya
  for (const m of s.matchAll(/<< \/Length (\d+) >>\nstream\n([\s\S]*?)\nendstream/g)) assert.equal(Number(m[1]), m[2].length);
});

test("PDF: teks panjang jadi beberapa halaman, tiap halaman tidak lebih dari LINES_PER_PAGE baris", () => {
  const s = text(buildCoverLetterPdf(Array.from({ length: 30 }, () => PARA).join("\n\n")));
  const pages = [...s.matchAll(/\/Type \/Page /g)].length;
  assert.ok(pages > 1, `halaman: ${pages}`);
  assert.match(s, new RegExp(`/Count ${pages} >>`));
  assert.equal(LINES_PER_PAGE, 46);
  for (const m of s.matchAll(/stream\n([\s\S]*?)\nendstream/g)) {
    const lines = (m[1].match(/^T\*$/gm) ?? []).length + 1; // the first line has no T*
    assert.ok(lines <= LINES_PER_PAGE, `baris: ${lines}`);
  }
  assert.equal([...s.matchAll(/\/Type \/Page /g)].length, layoutPages(Array.from({ length: 30 }, () => PARA).join("\n\n")).length);
});

test("PDF: teks pendek satu halaman; teks kosong tetap PDF sah satu halaman", () => {
  assert.equal([...text(buildCoverLetterPdf(PARA)).matchAll(/\/Type \/Page /g)].length, 1);
  const empty = text(buildCoverLetterPdf(""));
  assert.equal([...empty.matchAll(/\/Type \/Page /g)].length, 1);
  assert.ok(empty.startsWith("%PDF-1.4") && empty.endsWith("%%EOF"));
  assert.ok(!empty.includes("/Info"), "tanpa judul tidak ada /Info");
});

test("PDF: judul masuk ke /Info, ter-escape, dipotong 120 karakter", () => {
  const s = text(buildCoverLetterPdf("x", { title: "Surat (Budi) \\ Uji" }));
  assert.match(s, /<< \/Title \(Surat \\\(Budi\\\) \\\\ Uji\) >>/);
  assert.match(text(buildCoverLetterPdf("x", { title: "t".repeat(300) })), new RegExp(`/Title \\(t{120}\\)`));
});

// ───────────────────────────────────────────────────────────── teks dan penyandian

test("kurung dan garis miring terbalik di-escape", () => {
  const s = text(buildCoverLetterPdf("Teks (dalam kurung) dan C:\\folder"));
  assert.ok(s.includes("(Teks \\(dalam kurung\\) dan C:\\\\folder) Tj"));
  assert.equal(escapePdfText("a(b)c\\d"), "a\\(b\\)c\\\\d");
});

test("teks Indonesia dengan tanda petik lengkung, tanda pisah, elipsis dan huruf Latin-1 tersandi tanpa error", () => {
  const input = "Saya “siap” bekerja – ‘cepat’ — dan rapi… • Café, ñandú, über, Zoë, 5 € (100%)";
  const pdf = buildCoverLetterPdf(input);
  const s = text(pdf);
  assert.ok(s.startsWith("%PDF-1.4"));
  // WinAnsi: “ 147, ” 148, ‘ 145, ’ 146, – 150, — 151, … 133, • 149, é 233, ñ 241, ü 252, ë 235, € 128
  for (const oct of ["\\223", "\\224", "\\221", "\\226", "\\227", "\\205", "\\225", "\\351", "\\361", "\\374", "\\353", "\\200"]) {
    assert.ok(s.includes(oct), `harus memuat ${oct}`);
  }
  // Isi aliran murni ASCII (byte tinggi ditulis sebagai escape oktal)
  for (const m of s.matchAll(/stream\n([\s\S]*?)\nendstream/g)) assert.ok(/^[\x20-\x7e\n]*$/.test(m[1]));
  assert.deepEqual(toWinAnsiLines(input).map((l) => [...l].map((c) => c.charCodeAt(0)).slice(5, 11)), [[147, 115, 105, 97, 112, 148]]);
});

test("karakter di luar WinAnsi jadi '?', satu per karakter (emoji satu '?')", () => {
  assert.deepEqual(toWinAnsiLines("日本 😀 ok"), ["?? ? ok"]);
  assert.deepEqual(toWinAnsiLines("a\u0301b"), ["\u00e1b"], "huruf + tanda gabung disatukan lebih dulu (NFC)");
});

test("karakter kontrol dibuang, tab jadi empat spasi, CRLF satu baris baru", () => {
  assert.deepEqual(toWinAnsiLines("a\u0000b\u0007c\u001fd\u007fe\u0085x"), ["abcde", "x"]);
  assert.deepEqual(toWinAnsiLines("a\tb"), ["a    b"]);
  assert.deepEqual(toWinAnsiLines("satu\r\ndua\rtiga\u2028empat"), ["satu", "dua", "tiga", "empat"]);
  assert.deepEqual(toWinAnsiLines("a\u00a0b\u200bc"), ["a bc"], "nbsp jadi spasi, lebar nol dibuang");
});

test("masukan dipotong di 20.000 karakter", () => {
  assert.equal(MAX_COVER_LETTER_CHARS, 20_000);
  assert.equal(toWinAnsiLines("a".repeat(30_000)).join("").length, 20_000);
  assert.equal(toWinAnsiLines("😀".repeat(25_000)).join("").length, 20_000);
  assert.doesNotThrow(() => buildCoverLetterPdf("kata ".repeat(10_000)));
});

test("lebar huruf: tabel AFM Helvetica", () => {
  assert.equal(glyphWidth(32), 278);
  assert.equal(glyphWidth("W".charCodeAt(0)), 944);
  assert.equal(glyphWidth("i".charCodeAt(0)), 222);
  assert.equal(glyphWidth(233), 556); // é
  assert.equal(glyphWidth(133), 1000); // …
  assert.equal(glyphWidth(151), 1000); // —
  assert.equal(glyphWidth(255), 500);
  assert.equal(glyphWidth(500), 556, "kode di luar tabel memakai lebar aman");
  assert.ok(Math.abs(textWidthPt("Hello") - 25.058) < 1e-9);
  // semua angka berlebar sama, dan 15 huruf besar M lebih lebar dari 15 huruf i
  assert.equal(new Set([..."0123456789"].map((c) => glyphWidth(c.charCodeAt(0)))).size, 1);
});

// ───────────────────────────────────────────────────────────── tata letak

test("pemotongan baris: tidak ada baris lebih lebar dari 451 pt, kata terlalu panjang dipecah", () => {
  const long = [PARA.repeat(6), "x".repeat(300), "W".repeat(120), "M i W ".repeat(80)].join("\n\n");
  const maxPt = PDF_PAGE_WIDTH - 2 * PDF_MARGIN;
  const pages = layoutPages(long);
  const lines = pages.flat();
  assert.ok(lines.length > 10);
  for (const l of lines) assert.ok(textWidthPt(l) <= maxPt + 1e-9, `baris ${textWidthPt(l)} pt: ${l.slice(0, 30)}`);
  assert.ok(lines.filter((l) => /^x+$/.test(l)).length >= 3, "kata 300 huruf dipecah");
  // Tidak ada kata yang hilang: semua huruf 'x' masih ada
  assert.equal(lines.join("").split("x").length - 1, 300);
});

test("baris kosong dipertahankan sebagai pemisah paragraf (paling banyak dua berturut-turut), tidak membuka halaman", () => {
  assert.deepEqual(layoutPages("A\n\nB"), [["A", "", "B"]]);
  assert.deepEqual(layoutPages("\n\n\nA\n\n\n\n\n\nB\n\n\n"), [["A", "", "", "B"]]);
  assert.deepEqual(layoutPages("  A  \n   \nB"), [["A", "", "B"]]);
  // satu halaman penuh lalu baris kosong: halaman berikutnya tidak diawali baris kosong
  const full = Array.from({ length: LINES_PER_PAGE }, (_, i) => `baris ${i}`).join("\n");
  const pages = layoutPages(`${full}\n\nlanjut`);
  assert.equal(pages.length, 2);
  assert.deepEqual(pages[1], ["lanjut"]);
});

// ───────────────────────────────────────────────────────────── dibaca ulang oleh alat lain

const hasPdftotext = spawnSync("pdftotext", ["-v"]).error === undefined;

test("pdftotext (bila ada) membaca ulang PDF-nya", { skip: !hasPdftotext && "pdftotext tidak terpasang" }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "applify-pdftest-"));
  try {
    const file = path.join(dir, "t.pdf");
    await writeFile(file, buildCoverLetterPdf(`Kepada Yth. Tim Rekrutmen\n\n${PARA}\n\nHormat saya, “Budi” (Uji)`, { title: "Cover Letter - Budi" }));
    const r = spawnSync("pdftotext", [file, "-"], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stderr, "", "tanpa peringatan sintaks");
    assert.match(r.stdout, /Kepada Yth\. Tim Rekrutmen/);
    assert.match(r.stdout, /Backend Engineer/);
    assert.match(r.stdout, /“Budi” \(Uji\)/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

