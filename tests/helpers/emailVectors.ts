/**
 * Test vectors for the recipient address of an email_apply job: addresses that must pass and attempts
 * (header injection, recipient lists, display names, unicode line breaks, over-long and non-string values)
 * that must be refused. This file is copied byte for byte to worker/tests/helpers/emailVectors.ts, so the
 * backend queue guard and the worker run exactly the same cases.
 */

// A 254-character address: 64-character local part, 189-character domain (63 + 63 + 57-character labels + "com").
export const ADDR_254 = `${'a'.repeat(64)}@${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(57)}.com`

export const ACCEPTED = [
  'hrd@contoh.test',
  'hr@x.test',
  'HRD@Contoh.Test',
  'first.last+jobs@sub.contoh.co.id',
  'a_b-c%d@mail-server.example.com',
  'hr@xn--bcher-kva.example',
  `${'a'.repeat(64)}@x.test`,
  ADDR_254,
]

export type Vector = [string, unknown]

// Unicode and control characters that end a header line or are treated as a line break by some parser.
export const BREAKS: Array<[string, string]> = [
  ['CR LF', '\r\n'], ['LF', '\n'], ['CR', '\r'], ['NEL U+0085', '\u0085'], ['LS U+2028', '\u2028'],
  ['PS U+2029', '\u2029'], ['VT', '\u000b'], ['FF', '\u000c'], ['FS U+001C', '\u001c'], ['RS U+001E', '\u001e'],
  ['NUL', '\u0000'], ['DEL', '\u007f'], ['tab', '\t'], ['zero-width space', '\u200b'], ['BOM', '\ufeff'],
]

export const BREAK_VECTORS: Vector[] = [
  ...BREAKS.flatMap(([n, c]): Vector[] => [
    [`${n} lalu Bcc`, `hr@x.test${c}Bcc: attacker@evil.test`],
    [`${n} di akhir`, `hr@x.test${c}`],
    [`${n} di awal`, `${c}hr@x.test`],
    [`${n} di local part`, `h${c}r@x.test`],
    [`${n} di domain`, `hr@x${c}.test`],
  ]),
  ['Bcc lewat CRLF ganda', 'hr@x.test\r\nBcc: a@evil.test\r\n\r\nisi palsu'],
  ['Bcc dengan huruf kecil', 'hr@x.test\r\nbcc: a@evil.test'],
  ['Subject disusupkan', 'hr@x.test\r\nSubject: palsu'],
  ['CRLF sebagai teks escape', 'hr@x.test\\r\\nBcc: a@evil.test'],
  ['CRLF dikodekan persen', 'hr@x.test%0d%0aBcc:a@evil.test'],
]

export const LIST_AND_SYNTAX_VECTORS: Vector[] = [
  ['daftar dengan koma', 'a@x.test,b@y.test'],
  ['daftar dengan koma dan spasi', 'a@x.test, b@y.test'],
  ['daftar dengan titik koma', 'a@x.test;b@y.test'],
  ['dua alamat dipisah spasi', 'a@x.test b@y.test'],
  ['koma di awal', ',hr@x.test'],
  ['nama tampilan dan kurung sudut', 'Recruiter <hr@x.test>'],
  ['nama tampilan berkutip', '"Recruiter" <hr@x.test>'],
  ['kurung sudut saja', '<hr@x.test>'],
  ['kurung sudut tidak seimbang kanan', 'hr@x.test>'],
  ['kurung sudut tidak seimbang kiri', '<hr@x.test'],
  ['komentar RFC', 'hr@x.test (HRD)'],
  ['local part berkutip', '"a b"@x.test'],
  ['local part berkutip berisi koma', '"a,b"@x.test'],
  ['domain literal IP', 'hr@[127.0.0.1]'],
  ['IP biasa', 'hr@1.2.3.4'],
  ['tanpa titik di domain', 'hr@localhost'],
  ['TLD satu huruf', 'hr@x.t'],
  ['dua tanda @', 'hr@x@y.test'],
  ['@@', 'hr@@x.test'],
  ['tanpa local part', '@x.test'],
  ['tanpa domain', 'hr@'],
  ['tanpa @', 'hr'],
  ['skema mailto', 'mailto:hr@x.test'],
  ['port', 'hr@x.test:25'],
  ['kutip penutup', 'hr@x.test"'],
  ['kutip tunggal di domain', "hr@x.test'"],
  ['titik di awal local part', '.hr@x.test'],
  ['titik di akhir local part', 'hr.@x.test'],
  ['titik ganda di local part', 'h..r@x.test'],
  ['titik ganda di domain', 'hr@x..test'],
  ['titik di akhir domain', 'hr@x.test.'],
  ['label diawali tanda hubung', 'hr@-x.test'],
  ['label diakhiri tanda hubung', 'hr@x-.test'],
  ['spasi di depan', ' hr@x.test'],
  ['spasi di belakang', 'hr@x.test '],
  ['kosong', ''],
  ['hanya spasi', '   '],
  ['@ lebar penuh U+FF20', 'hr\uff20x.test'],
  ['titik lebar penuh U+FF0E', 'hr@x\uff0etest'],
  ['huruf non-ASCII di local part', 'hré@x.test'],
  ['huruf non-ASCII di domain', 'hr@exämple.com'],
  ['domain IDN tanpa punycode', 'hr@例え.jp'],
]

export const LENGTH_VECTORS: Vector[] = [
  ['local part 65 karakter', `${'a'.repeat(65)}@x.test`],
  ['label domain 64 karakter', `hr@${'b'.repeat(64)}.test`],
  ['255 karakter (selain panjang, bentuknya sah)', `${ADDR_254}e`],
  ['258 karakter (selain panjang, bentuknya sah)', `${ADDR_254.slice(0, -4)}xxxx.com`],
  ['sangat panjang', `${'a'.repeat(300)}@x.test`],
  ['sangat panjang di domain', `hr@${'b.'.repeat(200)}test`],
]

export const TYPE_VECTORS: Vector[] = [
  ['bukan string: undefined', undefined],
  ['bukan string: null', null],
  ['bukan string: angka', 42],
  ['bukan string: boolean', true],
  ['bukan string: objek', { email: 'hr@x.test' }],
  ['bukan string: larik satu alamat', ['hr@x.test']],
  ['bukan string: larik dua alamat', ['a@x.test', 'b@y.test']],
]

export const REJECTED: Vector[] = [...BREAK_VECTORS, ...LIST_AND_SYNTAX_VECTORS, ...LENGTH_VECTORS, ...TYPE_VECTORS]
