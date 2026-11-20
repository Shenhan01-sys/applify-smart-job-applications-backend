/**
 * Pembuat PDF teks minimal untuk uji. Satu halaman per elemen `pages`, satu baris teks per elemen halaman,
 * font Helvetica standar (tanpa penyematan font), pengodean WinAnsi sehingga "·" (0xB7) ikut terbaca.
 * Tidak memakai pustaka PDF mana pun, jadi uji ekstraksi tidak bergantung pada alat di luar paket.
 */
const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')

export function makePdf(pages: string[][]): Buffer {
  const objects: Buffer[] = []
  const add = (body: string | Buffer): number => {
    objects.push(Buffer.isBuffer(body) ? body : Buffer.from(body, 'latin1'))
    return objects.length // nomor objek berbasis 1
  }

  // Objek 1 = katalog, 2 = daftar halaman, 3 = font; halaman dan isi mulai dari 4.
  add('<< /Type /Catalog /Pages 2 0 R >>')
  add('') // diisi setelah semua halaman diketahui
  add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>')

  const pageIds: number[] = []
  for (const lines of pages) {
    const ops = ['BT', '/F1 11 Tf', '14 TL', '50 780 Td']
    for (const line of lines) ops.push(`(${esc(line)}) Tj`, 'T*')
    ops.push('ET')
    const stream = Buffer.from(ops.join('\n'), 'latin1')
    const contentId = add(Buffer.concat([Buffer.from(`<< /Length ${stream.length} >>\nstream\n`, 'latin1'), stream, Buffer.from('\nendstream', 'latin1')]))
    const pageId = add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentId} 0 R >>`)
    pageIds.push(pageId)
  }
  objects[1] = Buffer.from(`<< /Type /Pages /Kids [${pageIds.map((i) => `${i} 0 R`).join(' ')}] /Count ${pageIds.length} >>`, 'latin1')

  const chunks: Buffer[] = [Buffer.from('%PDF-1.4\n', 'latin1')]
  const offsets: number[] = []
  let pos = chunks[0].length
  objects.forEach((obj, i) => {
    offsets.push(pos)
    const part = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`, 'latin1'), obj, Buffer.from('\nendobj\n', 'latin1')])
    chunks.push(part)
    pos += part.length
  })
  const xref = [`xref\n0 ${objects.length + 1}\n`, '0000000000 65535 f \n', ...offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`)].join('')
  chunks.push(Buffer.from(`${xref}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${pos}\n%%EOF\n`, 'latin1'))
  return Buffer.concat(chunks)
}
