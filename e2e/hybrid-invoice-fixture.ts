export function buildHybridInvoicePdf(xml: Buffer) {
  const objects = [
    { id: 1, body: Buffer.from('<< /Type /Filespec /F (factur-x.xml) /AFRelationship /Data /EF << /F 2 0 R >> >>') },
    { id: 2, body: Buffer.concat([Buffer.from(`<< /Type /EmbeddedFile /Subtype /application#2Fxml /Length ${xml.length} >>\nstream\n`), xml, Buffer.from('\nendstream')]) },
    { id: 3, body: Buffer.from('<< /Type /Catalog /AF [1 0 R] >>') },
  ]
  const parts: Buffer[] = [Buffer.from('%PDF-1.7\n')]
  const offsets = new Map<number, number>()
  let length = parts[0].length
  for (const object of objects) {
    offsets.set(object.id, length)
    const bytes = Buffer.concat([Buffer.from(`${object.id} 0 obj\n`), object.body, Buffer.from('\nendobj\n')])
    parts.push(bytes); length += bytes.length
  }
  const xrefOffset = length
  const entries = Array.from({ length: 4 }, (_, id) => id === 0 ? '0000000000 65535 f ' : `${String(offsets.get(id)).padStart(10, '0')} 00000 n `)
  parts.push(Buffer.from(`xref\n0 4\n${entries.join('\n')}\ntrailer\n<< /Size 4 /Root 3 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`))
  return Buffer.concat(parts)
}
