import { createCanvas } from '@napi-rs/canvas'

/** Synthetic scan: actual raster pixels, without any PDF text layer. */
export function scannedSearchPdf() {
  const canvas = createCanvas(1400, 450)
  const context = canvas.getContext('2d')
  context.fillStyle = 'white'; context.fillRect(0, 0, 1400, 450)
  context.fillStyle = 'black'; context.font = '54px Arial'
  context.fillText('Bergwald Scanbeleg 47291', 80, 100)
  context.fillText('Office supplies October 2026', 80, 195)
  context.fillText('Total EUR 119.00', 80, 290)
  const jpeg = canvas.toBuffer('image/jpeg')
  const paint = Buffer.from('q 700 0 0 225 0 0 cm /Scan Do Q')
  return pdf([
    Buffer.from('<< /Type /Catalog /Pages 2 0 R >>'),
    Buffer.from('<< /Type /Pages /Kids [3 0 R] /Count 1 >>'),
    Buffer.from('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 700 225] /Resources << /XObject << /Scan 4 0 R >> >> /Contents 5 0 R >>'),
    Buffer.concat([Buffer.from(`<< /Type /XObject /Subtype /Image /Width 1400 /Height 450 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`), jpeg, Buffer.from('\nendstream')]),
    Buffer.concat([Buffer.from(`<< /Length ${paint.length} >>\nstream\n`), paint, Buffer.from('\nendstream')]),
  ])
}

export function mixedSearchPdf() {
  const text = Buffer.from('BT /F1 18 Tf 30 150 Td (Readable first page) Tj ET')
  return pdf([
    Buffer.from('<< /Type /Catalog /Pages 2 0 R >>'),
    Buffer.from('<< /Type /Pages /Kids [3 0 R 6 0 R] /Count 2 >>'),
    Buffer.from('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>'),
    Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'),
    Buffer.concat([Buffer.from(`<< /Length ${text.length} >>\nstream\n`), text, Buffer.from('\nendstream')]),
    Buffer.from('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 200] /Resources << >> >>'),
  ])
}

function pdf(objects: Buffer[]) {
  const parts: Buffer[] = [Buffer.from('%PDF-1.4\n')]
  const offsets = [0]
  for (const [index, content] of objects.entries()) {
    offsets.push(parts.reduce((size, part) => size + part.length, 0))
    parts.push(Buffer.from(`${index + 1} 0 obj\n`), content, Buffer.from('\nendobj\n'))
  }
  const start = parts.reduce((size, part) => size + part.length, 0)
  parts.push(Buffer.from(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`))
  return Buffer.concat(parts)
}
