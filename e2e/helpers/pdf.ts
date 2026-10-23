// A minimal PDF carrying a real text layer, so a scenario can exercise "born-digital
// PDF" ingest without checking a binary fixture into the repo.
export function textPdf(pages: string[][]): Buffer {
  const objects: string[] = []
  const add = (body: string) => objects.push(body)

  const catalog = add('')
  const pagesObj = add('')
  const font = add('/Type /Font /Subtype /Type1 /BaseFont /Helvetica')

  const kids: number[] = []
  for (const lines of pages) {
    let stream = 'BT /F1 12 Tf 72 720 Td 14 TL\n'
    for (const line of lines) {
      const escaped = line.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')
      stream += `(${escaped}) Tj T*\n`
    }
    stream += 'ET'
    const content = add(
      `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`)
    kids.push(add(
      `/Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 612 792] /Contents ${content} 0 R ` +
      `/Resources << /Font << /F1 ${font} 0 R >> >>`))
  }
  objects[catalog - 1] = `/Type /Catalog /Pages ${pagesObj} 0 R`
  objects[pagesObj - 1] =
    `/Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length}`

  let out = '%PDF-1.4\n'
  const offsets: number[] = []
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out, 'latin1'))
    out += `${i + 1} 0 obj\n${body.startsWith('<<') ? body : `<< ${body} >>`}\nendobj\n`
  })
  const xrefAt = Buffer.byteLength(out, 'latin1')
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const offset of offsets) out += `${String(offset).padStart(10, '0')} 00000 n \n`
  out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\n`
  out += `startxref\n${xrefAt}\n%%EOF\n`
  return Buffer.from(out, 'latin1')
}
