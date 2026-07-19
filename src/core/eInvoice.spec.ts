import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { zlibSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { EInvoiceValidationError, InvoiceCorrectionChain, extractUncompressedStructuredInvoiceFromPdf, generateUblInvoice, preserveOriginal, receiveStructuredInvoice, renderInvoiceHtml, validateInvoice, type StructuredInvoiceData } from './eInvoice'

const fixture = (name: string) => readFile(path.join(process.cwd(), 'src/core/data_fixtures/eInvoice', name))
const buildPdf = (objects: Array<{ id: number; body: Buffer }>, rootId = 3) => {
  const parts: Buffer[] = [Buffer.from('%PDF-1.7\n')]; const offsets = new Map<number, number>(); let length = parts[0].length
  for (const object of [...objects].sort((a, b) => a.id - b.id)) { offsets.set(object.id, length); const bytes = Buffer.concat([Buffer.from(`${object.id} 0 obj\n`), object.body, Buffer.from('\nendobj\n')]); parts.push(bytes); length += bytes.length }
  const xrefOffset = length; const maxId = Math.max(...objects.map(object => object.id)); const entries = Array.from({ length: maxId + 1 }, (_, id) => id === 0 ? '0000000000 65535 f ' : offsets.has(id) ? `${String(offsets.get(id)).padStart(10, '0')} 00000 n ` : '0000000000 00000 f ')
  parts.push(Buffer.from(`xref\n0 ${maxId + 1}\n${entries.join('\n')}\ntrailer\n<< /Size ${maxId + 1} /Root ${rootId} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`))
  return Buffer.concat(parts)
}
const buildXrefStreamPdf = (objects: Array<{ id: number; body: Buffer }>, rootId = 3, xrefOverride?: { data: Buffer; dictionary: string }) => {
  const parts: Buffer[] = [Buffer.from('%PDF-1.7\n')]; const offsets = new Map<number, number>(); let length = parts[0].length
  for (const object of [...objects].sort((a, b) => a.id - b.id)) { offsets.set(object.id, length); const bytes = Buffer.concat([Buffer.from(`${object.id} 0 obj\n`), object.body, Buffer.from('\nendobj\n')]); parts.push(bytes); length += bytes.length }
  const xrefId = Math.max(...objects.map(object => object.id)) + 1; const xrefOffset = length; offsets.set(xrefId, xrefOffset)
  const entries = Buffer.alloc((xrefId + 1) * 7)
  entries.writeUInt16BE(65_535, 5)
  for (let id = 1; id <= xrefId; id++) { const row = id * 7; entries[row] = 1; entries.writeUInt32BE(offsets.get(id) ?? 0, row + 1) }
  const xrefData = xrefOverride?.data ?? entries
  parts.push(Buffer.concat([Buffer.from(`${xrefId} 0 obj\n<< /Type /XRef /Size ${xrefId + 1} /Root ${rootId} 0 R /W [1 4 2] /Index [0 ${xrefId + 1}] /Length ${xrefData.length} ${xrefOverride?.dictionary ?? ''} >>\nstream\n`), xrefData, Buffer.from(`\nendstream\nendobj\nstartxref\n${xrefOffset}\n%%EOF\n`)]))
  return Buffer.concat(parts)
}
const previousXrefOffset = (pdf: Buffer) => { const match = /startxref\s+(\d+)\s+%%EOF\s*$/.exec(pdf.toString('latin1')); if (!match) throw new Error('Test PDF has no startxref.'); return Number(match[1]) }
const appendClassicPdfRevision = (pdf: Buffer, objects: Array<{ id: number; body: Buffer }>) => {
  const parts: Buffer[] = [pdf]; const offsets = new Map<number, number>(); let length = pdf.length
  for (const object of [...objects].sort((a, b) => a.id - b.id)) { offsets.set(object.id, length); const bytes = Buffer.concat([Buffer.from(`${object.id} 0 obj\n`), object.body, Buffer.from('\nendobj\n')]); parts.push(bytes); length += bytes.length }
  const xrefOffset = length
  parts.push(Buffer.from(`xref\n${[...objects].sort((a, b) => a.id - b.id).map(object => `${object.id} 1\n${String(offsets.get(object.id)).padStart(10, '0')} 00000 n `).join('\n')}\n`))
  parts.push(Buffer.from(`trailer\n<< /Size 20 /Prev ${previousXrefOffset(pdf)} >>\nstartxref\n${xrefOffset}\n%%EOF\n`))
  return Buffer.concat(parts)
}
const appendXrefStreamPdfRevision = (pdf: Buffer, objects: Array<{ id: number; body: Buffer }>, xrefId = 19) => {
  const parts: Buffer[] = [pdf]; const offsets = new Map<number, number>(); let length = pdf.length
  for (const object of [...objects].sort((a, b) => a.id - b.id)) { offsets.set(object.id, length); const bytes = Buffer.concat([Buffer.from(`${object.id} 0 obj\n`), object.body, Buffer.from('\nendobj\n')]); parts.push(bytes); length += bytes.length }
  const xrefOffset = length; offsets.set(xrefId, xrefOffset); const ids = [...offsets.keys()].sort((a, b) => a - b); const entries = Buffer.alloc(ids.length * 7)
  ids.forEach((id, index) => { entries[index * 7] = 1; entries.writeUInt32BE(offsets.get(id)!, index * 7 + 1) })
  const index = ids.map(id => `${id} 1`).join(' ')
  parts.push(Buffer.concat([Buffer.from(`${xrefId} 0 obj\n<< /Type /XRef /Size ${xrefId + 1} /W [1 4 2] /Index [${index}] /Length ${entries.length} /Prev ${previousXrefOffset(pdf)} >>\nstream\n`), entries, Buffer.from(`\nendstream\nendobj\nstartxref\n${xrefOffset}\n%%EOF\n`)]))
  return Buffer.concat(parts)
}
const buildObjectStreamPdf = (xml: Buffer) => {
  const fileSpec = Buffer.from('<< /Type /Filespec /F (factur-x.xml) /AFRelationship /Data /EF << /F 2 0 R >> >>'); const catalog = Buffer.from('<< /Type /Catalog /AF [1 0 R] >>')
  const objectHeader = Buffer.from(`1 0 3 ${fileSpec.length + 1} `); const objectStream = Buffer.concat([objectHeader, fileSpec, Buffer.from(' '), catalog])
  const objects = [{ id: 2, body: embeddedXmlBody(xml) }, { id: 4, body: Buffer.concat([Buffer.from(`<< /Type /ObjStm /N 2 /First ${objectHeader.length} /Length ${objectStream.length} >>\nstream\n`), objectStream, Buffer.from('\nendstream')]) }]
  const parts: Buffer[] = [Buffer.from('%PDF-1.7\n')]; const offsets = new Map<number, number>(); let length = parts[0].length
  for (const object of objects) { offsets.set(object.id, length); const bytes = Buffer.concat([Buffer.from(`${object.id} 0 obj\n`), object.body, Buffer.from('\nendobj\n')]); parts.push(bytes); length += bytes.length }
  const xrefOffset = length; const entries = Buffer.alloc(6 * 7); entries.writeUInt16BE(65_535, 5)
  const entry = (id: number, type: number, field2: number, field3 = 0) => { const row = id * 7; entries[row] = type; entries.writeUInt32BE(field2, row + 1); entries.writeUInt16BE(field3, row + 5) }
  entry(1, 2, 4); entry(2, 1, offsets.get(2)!); entry(3, 2, 4, 1); entry(4, 1, offsets.get(4)!); entry(5, 1, xrefOffset)
  parts.push(Buffer.concat([Buffer.from(`5 0 obj\n<< /Type /XRef /Size 6 /Root 3 0 R /W [1 4 2] /Length ${entries.length} >>\nstream\n`), entries, Buffer.from(`\nendstream\nendobj\nstartxref\n${xrefOffset}\n%%EOF\n`)]))
  return Buffer.concat(parts)
}
const embeddedXmlBody = (xml: Buffer, dictionary = `/Type /EmbeddedFile /Subtype /application#2Fxml /Length ${xml.length}`) => Buffer.concat([Buffer.from(`<< ${dictionary} >>\nstream\n`), xml, Buffer.from('\nendstream')])

describe('structured e-invoices', () => {
  it('preserves and hashes the exact UBL original while extracting reviewed values with provenance', async () => {
    const original = await fixture('valid-ubl.xml')
    const result = receiveStructuredInvoice(original)
    expect(Buffer.from(result.structuredOriginal.bytes)).toEqual(original)
    expect(result.structuredOriginal.sha256).toMatch(/^[a-f0-9]{64}$/)
    expect(result.data).toMatchObject({ syntax: 'UBL', invoiceNumber: 'RE-2026-0001', netAmountCents: 10_000, taxAmountCents: 1_900, grossAmountCents: 11_900 })
    expect(result.provenance.invoiceNumber).toBe('structured-original:invoiceNumber')
    const exposed = result.structuredOriginal.bytes; exposed[0] = 0
    expect(Buffer.from(result.structuredOriginal.bytes)).toEqual(original)
  })

  it('accepts CII and preserves both originals of a ZUGFeRD hybrid without replacing XML by rendering', async () => {
    const xml = await fixture('valid-cii.xml'); const pdf = buildPdf([{ id: 1, body: Buffer.from('<< /Type /Filespec /F (factur-x.xml) /AFRelationship /Data /EF << /F 2 0 R >> >>') }, { id: 2, body: embeddedXmlBody(xml) }, { id: 3, body: Buffer.from('<< /Type /Catalog /AF [1 0 R] >>') }])
    expect(receiveStructuredInvoice(xml).data.syntax).toBe('CII')
    const extracted = extractUncompressedStructuredInvoiceFromPdf(pdf); const hybrid = receiveStructuredInvoice(extracted.xmlBytes, extracted.extraction)
    expect(Buffer.from(extracted.xmlBytes)).toEqual(xml)
    expect(hybrid.data.syntax).toBe('ZUGFERD')
    expect(Buffer.from(hybrid.visualOriginal!.bytes)).toEqual(pdf)
    expect(hybrid.structuredOriginal.sha256).toBe(extracted.extraction.embeddedXmlSha256)
    const exposedPdf = extracted.extraction.pdfBytes; exposedPdf[0] = 0; expect(Buffer.from(extracted.extraction.pdfBytes)).toEqual(pdf)
    expect(() => receiveStructuredInvoice(xml, { pdfBytes: pdf, mediaType: 'application/pdf', embeddedXmlSha256: hybrid.structuredOriginal.sha256 } as never)).toThrow(/metadata does not match/)
    const decoy = buildPdf([{ id: 1, body: Buffer.from('<< /Type /Filespec /F (factur-x.xml) /AFRelationship /Data /EF << /F 2 0 R >> >>') }, { id: 2, body: embeddedXmlBody(xml) }, { id: 3, body: Buffer.from('<< /Type /Catalog /AF [1 0 R] >>') }, { id: 4, body: Buffer.from('<< /Length 56 >>\nstream\n5 0 obj << /Type /Catalog >> endobj trailer << /Root 5 0 R >>\nendstream') }])
    expect(Buffer.from(extractUncompressedStructuredInvoiceFromPdf(decoy).xmlBytes)).toEqual(xml)
  })

  it('rejects DTD/entity input before parsing and enforces mandatory UStG totals and fields', async () => {
    const invalid = await fixture('invalid-active.xml')
    expect(() => receiveStructuredInvoice(invalid)).toThrow(/forbidden/)
    const valid = receiveStructuredInvoice(await fixture('valid-ubl.xml')).data
    expect(validateInvoice({ ...valid, invoiceNumber: '', grossAmountCents: 1 })).toEqual(expect.arrayContaining(['Invoice number is mandatory.', 'Net, tax and gross totals do not reconcile.']))
    expect(validateInvoice({ ...valid, issueDate: '2026-02-30' })).toContain('Issue and supply dates must be real ISO dates.')
    expect(validateInvoice({ ...valid, lines: [{ ...valid.lines[0], taxRateBasisPoints: Number.NaN }] }).some(issue => issue.startsWith('At least one complete invoice line'))).toBe(true)
    expect(validateInvoice({ ...valid, buyer: { ...valid.buyer, name: '   ' } })).toContain('Complete buyer address is mandatory.')
    expect(validateInvoice({ ...valid, lines: [{ ...valid.lines[0], description: '  ' }] }).some(issue => issue.startsWith('At least one complete invoice line'))).toBe(true)
    expect(validateInvoice({ ...valid, kind: 'credit-note', correctedInvoiceNumber: '   ' })).toContain('Corrections must reference a nonblank original invoice number.')
    expect(validateInvoice({ ...valid, taxAmountCents: 0, grossAmountCents: valid.netAmountCents, lines: [{ ...valid.lines[0], taxRateBasisPoints: 0, taxCategoryCode: 'E', exemptionReason: '   ' }] })).toContain('VAT exemption reasons must be nonblank when provided.')
    const contradictoryPayable = (await fixture('valid-ubl.xml')).toString('utf8').replace('<cbc:PayableAmount currencyID="EUR">119.00</cbc:PayableAmount>', '<cbc:PayableAmount currencyID="EUR">118.99</cbc:PayableAmount>')
    expect(() => receiveStructuredInvoice(Buffer.from(contradictoryPayable))).toThrow(/Payable amount does not reconcile/)
    const ublWithoutPayable = (await fixture('valid-ubl.xml')).toString('utf8').replace('<cbc:PayableAmount currencyID="EUR">119.00</cbc:PayableAmount>', '')
    const ciiWithoutPayable = (await fixture('valid-cii.xml')).toString('utf8').replace('<ram:DuePayableAmount currencyID="EUR">119.00</ram:DuePayableAmount>', '')
    expect(() => receiveStructuredInvoice(Buffer.from(ublWithoutPayable))).toThrow(/explicit PayableAmount/)
    expect(() => receiveStructuredInvoice(Buffer.from(ciiWithoutPayable))).toThrow(/explicit DuePayableAmount/)
    const contradictoryTaxExclusive = (await fixture('valid-ubl.xml')).toString('utf8').replace('<cbc:TaxInclusiveAmount', '<cbc:TaxExclusiveAmount currencyID="EUR">99.99</cbc:TaxExclusiveAmount><cbc:TaxInclusiveAmount')
    expect(() => receiveStructuredInvoice(Buffer.from(contradictoryTaxExclusive))).toThrow(/TaxExclusiveAmount does not reconcile/)
    const ublWithoutSupplyDate = (await fixture('valid-ubl.xml')).toString('utf8').replace('<cac:Delivery><cbc:ActualDeliveryDate>2026-07-16</cbc:ActualDeliveryDate></cac:Delivery>', '')
    expect(() => receiveStructuredInvoice(Buffer.from(ublWithoutSupplyDate))).toThrow(/explicit supported supply date/)
    const ciiWithoutSupplyDate = (await fixture('valid-cii.xml')).toString('utf8').replace('<ram:ApplicableHeaderTradeDelivery><ram:ActualDeliverySupplyChainEvent><ram:OccurrenceDateTime><udt:DateTimeString>20260716</udt:DateTimeString></ram:OccurrenceDateTime></ram:ActualDeliverySupplyChainEvent></ram:ApplicableHeaderTradeDelivery>', '<ram:ApplicableHeaderTradeDelivery/>')
    expect(() => receiveStructuredInvoice(Buffer.from(ciiWithoutSupplyDate))).toThrow(/explicit supported supply date/)
    const ublWithoutUnit = (await fixture('valid-ubl.xml')).toString('utf8').replace(' unitCode="C62"', '')
    const ciiWithoutUnit = (await fixture('valid-cii.xml')).toString('utf8').replace(' unitCode="C62"', '')
    expect(() => receiveStructuredInvoice(Buffer.from(ublWithoutUnit))).toThrow(/complete invoice line/)
    expect(() => receiveStructuredInvoice(Buffer.from(ciiWithoutUnit))).toThrow(/complete invoice line/)
    const ublSource = (await fixture('valid-ubl.xml')).toString('utf8')
    expect(() => receiveStructuredInvoice(Buffer.from(ublSource.replace('<cbc:ID>RE-2026-0001</cbc:ID>', '<cbc:ID>RE<cac:Nested/>-2026-0001</cbc:ID>')))).toThrow(/Scalar invoice element ID must not contain nested elements/)
    expect(() => receiveStructuredInvoice(Buffer.from(ublSource.replace(' currencyID="EUR"', '')))).toThrow(/monetary amount must declare currencyID/)
    expect(validateInvoice({ ...valid, seller: { ...valid.seller, countryCode: 'ZZ' } })).toContain('Seller and buyer country codes must be canonical ISO 3166-1 alpha-2 codes.')
    expect(validateInvoice({ ...valid, seller: { ...valid.seller, vatId: 'FR12345678901' } })).toContain('Party VAT IDs must match the country-specific canonical syntax.')
    expect(() => receiveStructuredInvoice(Buffer.from(ublSource.replace('<cbc:CompanyID>DE123456789</cbc:CompanyID>', '<cbc:CompanyID>bogus</cbc:CompanyID>')))).toThrow(/country-specific canonical syntax/)
    const ublNonVatLine = ublSource.replace('<cac:ClassifiedTaxCategory><cbc:ID>S</cbc:ID><cbc:Percent>19</cbc:Percent><cac:TaxScheme><cbc:ID>VAT</cbc:ID>', '<cac:ClassifiedTaxCategory><cbc:ID>S</cbc:ID><cbc:Percent>19</cbc:Percent><cac:TaxScheme><cbc:ID>GST</cbc:ID>')
    const ublNonVatHeader = ublSource.replace('<cac:TaxCategory><cbc:ID>S</cbc:ID><cbc:Percent>19</cbc:Percent><cac:TaxScheme><cbc:ID>VAT</cbc:ID>', '<cac:TaxCategory><cbc:ID>S</cbc:ID><cbc:Percent>19</cbc:Percent><cac:TaxScheme><cbc:ID>GST</cbc:ID>')
    expect(() => receiveStructuredInvoice(Buffer.from(ublNonVatLine))).toThrow(/line tax category.*VAT tax scheme/)
    expect(() => receiveStructuredInvoice(Buffer.from(ublNonVatHeader))).toThrow(/header tax category.*VAT tax scheme/)
    const ciiSource = (await fixture('valid-cii.xml')).toString('utf8')
    const ciiNonVatLine = ciiSource.replace('<ram:ApplicableTradeTax><ram:TypeCode>VAT</ram:TypeCode>', '<ram:ApplicableTradeTax><ram:TypeCode>GST</ram:TypeCode>')
    const ciiNonVatHeader = ciiSource.replace('<ram:ApplicableHeaderTradeSettlement><ram:ApplicableTradeTax><ram:TypeCode>VAT</ram:TypeCode>', '<ram:ApplicableHeaderTradeSettlement><ram:ApplicableTradeTax><ram:TypeCode>GST</ram:TypeCode>')
    expect(() => receiveStructuredInvoice(Buffer.from(ciiNonVatLine))).toThrow(/line applicable tax.*VAT type code/)
    expect(() => receiveStructuredInvoice(Buffer.from(ciiNonVatHeader))).toThrow(/header applicable tax.*VAT type code/)
    const unsupportedUblType = (await fixture('valid-ubl.xml')).toString('utf8').replace('<cbc:ID>RE-2026-0001</cbc:ID>', '<cbc:ID>RE-2026-0001</cbc:ID><cbc:InvoiceTypeCode>999</cbc:InvoiceTypeCode>')
    const unsupportedCiiType = (await fixture('valid-cii.xml')).toString('utf8').replace('<ram:ID>CII-2026-1</ram:ID>', '<ram:ID>CII-2026-1</ram:ID><ram:TypeCode>999</ram:TypeCode>')
    expect(() => receiveStructuredInvoice(Buffer.from(unsupportedUblType))).toThrow(/Unsupported UBL invoice type code/)
    expect(() => receiveStructuredInvoice(Buffer.from(unsupportedCiiType))).toThrow(/Unsupported CII invoice type code/)
    const ublPrice = (await fixture('valid-ubl.xml')).toString('utf8').replace('</cac:Item></cac:InvoiceLine>', '</cac:Item><cac:Price><cbc:PriceAmount currencyID="EUR">100.00</cbc:PriceAmount><cbc:BaseQuantity>1</cbc:BaseQuantity></cac:Price></cac:InvoiceLine>')
    expect(receiveStructuredInvoice(Buffer.from(ublPrice)).data.lines[0].netAmountCents).toBe(10_000)
    expect(() => receiveStructuredInvoice(Buffer.from(ublPrice.replace('>100.00</cbc:PriceAmount>', '>999.00</cbc:PriceAmount>')))).toThrow(/declared line price does not reconcile/)
    const ciiPrice = (await fixture('valid-cii.xml')).toString('utf8').replace('</ram:SpecifiedTradeProduct><ram:SpecifiedLineTradeDelivery>', '</ram:SpecifiedTradeProduct><ram:SpecifiedLineTradeAgreement><ram:NetPriceProductTradePrice><ram:ChargeAmount>100.00</ram:ChargeAmount><ram:BasisQuantity>1</ram:BasisQuantity></ram:NetPriceProductTradePrice></ram:SpecifiedLineTradeAgreement><ram:SpecifiedLineTradeDelivery>')
    expect(receiveStructuredInvoice(Buffer.from(ciiPrice)).data.lines[0].netAmountCents).toBe(10_000)
    expect(() => receiveStructuredInvoice(Buffer.from(ciiPrice.replace('<ram:ChargeAmount>100.00</ram:ChargeAmount>', '<ram:ChargeAmount>999.00</ram:ChargeAmount>')))).toThrow(/declared line price does not reconcile/)
  })

  it('generates a complete, sequentially identified UBL invoice and round-trips its legal values', async () => {
    const input = receiveStructuredInvoice(await fixture('valid-ubl.xml')).data
    const generated = generateUblInvoice({ ...input, kind: 'invoice' })
    const roundTrip = receiveStructuredInvoice(generated)
    expect(roundTrip.data).toMatchObject({ invoiceNumber: input.invoiceNumber, issueDate: input.issueDate, supplyDate: input.supplyDate, netAmountCents: input.netAmountCents, taxAmountCents: input.taxAmountCents, grossAmountCents: input.grossAmountCents })
    expect(new TextDecoder().decode(generated)).toContain('<cbc:CustomizationID>urn:sanjo-solutions:accounting:ubl:1</cbc:CustomizationID>')
    expect(new TextDecoder().decode(generated)).not.toMatch(/peppol|en16931/i)
  })

  it('models UBL prepayments and signed payable rounding in the payable formula', async () => {
    const base = receiveStructuredInvoice(await fixture('valid-ubl.xml')).data
    const { syntax: _syntax, ...input } = { ...base, prepaidAmountCents: 2_000, payableRoundingAmountCents: -1, payableAmountCents: 9_899 }
    const bytes = generateUblInvoice(input); const xml = new TextDecoder().decode(bytes)
    expect(xml).toContain('<cbc:PrepaidAmount currencyID="EUR">20.00</cbc:PrepaidAmount>')
    expect(xml).toContain('<cbc:PayableRoundingAmount currencyID="EUR">-0.01</cbc:PayableRoundingAmount>')
    expect(receiveStructuredInvoice(bytes).data).toMatchObject({ grossAmountCents: 11_900, prepaidAmountCents: 2_000, payableRoundingAmountCents: -1, payableAmountCents: 9_899 })
    expect(validateInvoice({ ...base, prepaidAmountCents: 2_000, payableAmountCents: 9_901 })).toContain('Payable amount does not reconcile to gross, prepayments and rounding.')
  })

  it('supports exemption/reverse charge rules and escapes untrusted values in safe rendering/generation', async () => {
    const base = receiveStructuredInvoice(await fixture('valid-ubl.xml')).data
    const exempt: StructuredInvoiceData = { ...base, taxAmountCents: 0, grossAmountCents: 10_000, exemptionReason: 'UStG §4 <script>', lines: [{ ...base.lines[0], description: '<img src=x onerror=alert(1)>', taxRateBasisPoints: 0, taxCategoryCode: undefined }] }
    const { syntax: _syntax, ...toGenerate } = exempt
    const parsed = receiveStructuredInvoice(generateUblInvoice(toGenerate))
    const html = renderInvoiceHtml(parsed)
    expect(html).not.toContain('<script>')
    expect(html).not.toContain('<img ')
    expect(html).toContain('&lt;img')
  })

  it('keeps immutable cancellation, credit-note and correction links to an original', () => {
    const original = preserveOriginal(Buffer.from('invoice'), 'application/xml')
    const cancellation = preserveOriginal(Buffer.from('cancel'), 'application/xml')
    const chain = new InvoiceCorrectionChain().append({ id: 'RE-1', kind: 'invoice', sha256: original.sha256 }).append({ id: 'RE-1-S', kind: 'cancellation', sha256: cancellation.sha256, corrects: 'RE-1' })
    expect(chain.links).toHaveLength(2)
    expect(() => chain.append({ id: 'RE-2', kind: 'credit-note', sha256: '1'.repeat(64), corrects: 'missing' })).toThrow(/reference an existing/)
    expect(() => chain.append(chain.links[1])).toThrow(/immutable and unique/)
    expect(() => new InvoiceCorrectionChain([{ id: 'bad', kind: 'correction', sha256: '1'.repeat(64), corrects: 'missing' }])).toThrow(/start with an invoice/)
    expect(() => new InvoiceCorrectionChain([{ id: 'RE-1', kind: 'invoice', sha256: '1'.repeat(64) }, { id: 'RE-2', kind: 'correction', sha256: '2'.repeat(64), corrects: 'future' }])).toThrow(/earlier immutable/)
    expect(() => new InvoiceCorrectionChain([{ id: 'RE-1', kind: 'invoice', sha256: '1'.repeat(64), corrects: 'older' }])).toThrow(/no correction reference/)
    expect(() => chain.append({ id: 'RE-2', kind: 'invoice', sha256: '3'.repeat(64), corrects: 'RE-1' })).toThrow(/Only the root/)
    expect(() => new InvoiceCorrectionChain([{ id: ' ', kind: 'invoice', sha256: '1'.repeat(64) }])).toThrow(/nonblank identifiers/)
    expect(() => new InvoiceCorrectionChain([{ id: 'RE-1', kind: 'invoice', sha256: 'A'.repeat(64) }])).toThrow(/canonical lowercase SHA-256/)
    expect(() => chain.append({ id: 'RE-2', kind: 'correction', sha256: '4'.repeat(64), corrects: ' ' })).toThrow(/nonblank identifiers/)
  })

  it('round-trips multi-line corrections and their original-invoice reference', async () => {
    const base = receiveStructuredInvoice(await fixture('valid-ubl.xml')).data
    const correction = { ...base, kind: 'correction' as const, invoiceNumber: 'RE-2026-0002', correctedInvoiceNumber: base.invoiceNumber, lines: [{ ...base.lines[0], netAmountCents: 6_000 }, { ...base.lines[0], description: 'Additional service', netAmountCents: 4_000 }] }
    expect(() => generateUblInvoice({ ...correction, correctedInvoiceNumber: correction.invoiceNumber })).toThrow(/distinct original invoice number/)
    const { syntax: _syntax, ...toGenerate } = correction
    const roundTrip = receiveStructuredInvoice(generateUblInvoice(toGenerate))
    expect(roundTrip.data).toMatchObject({ kind: 'correction', correctedInvoiceNumber: 'RE-2026-0001', netAmountCents: 10_000 })
    expect(roundTrip.data.lines).toHaveLength(2)
  })

  it('uses namespace/path-aware extraction so extension elements cannot spoof invoice identity', async () => {
    const xml = (await fixture('valid-ubl.xml')).toString('utf8').replace('<cbc:ID>RE-2026-0001</cbc:ID>', '<cac:UBLExtensions><cac:ID>SPOOF</cac:ID></cac:UBLExtensions><cbc:ID>RE-2026-0001</cbc:ID>')
    expect(receiveStructuredInvoice(Buffer.from(xml)).data.invoiceNumber).toBe('RE-2026-0001')
    const wrongNamespace = xml.replace('xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"', 'xmlns:cac="https://attacker.invalid"')
    expect(() => receiveStructuredInvoice(Buffer.from(wrongNamespace))).toThrow(/Unsupported XML namespace/)
  })

  it('serializes payment data in schema order and never mistakes invoice ID for IBAN', async () => {
    const base = receiveStructuredInvoice(await fixture('valid-ubl.xml')).data
    const { syntax: _syntax, ...toGenerate } = { ...base, paymentIban: 'DE89370400440532013000', paymentTerms: 'Pay within 14 days' }
    const bytes = generateUblInvoice(toGenerate); const xml = new TextDecoder().decode(bytes)
    expect(xml.indexOf('<cac:AccountingCustomerParty>')).toBeLessThan(xml.indexOf('<cac:Delivery>'))
    expect(xml.indexOf('<cac:Delivery>')).toBeLessThan(xml.indexOf('<cac:PaymentMeans>'))
    expect(xml.indexOf('<cac:PaymentMeans>')).toBeLessThan(xml.indexOf('<cac:TaxTotal>'))
    expect(xml).toContain('<cac:PayeeFinancialAccount><cbc:ID>DE89370400440532013000</cbc:ID>')
    expect(xml).toContain('<cac:Price>')
    expect(receiveStructuredInvoice(bytes).data).toMatchObject({ paymentIban: 'DE89370400440532013000', paymentTerms: 'Pay within 14 days' })
    expect(base.paymentIban).toBeUndefined()
    expect(validateInvoice({ ...base, paymentIban: 'DE00370400440532013000' })).toContain('Payment IBAN is invalid.')
    expect(validateInvoice({ ...base, paymentIban: 'DE8937040044053201300' })).toContain('Payment IBAN is invalid.')
  })

  it('keeps attribute namespaces distinct and rejects skipped/trailing XML content', async () => {
    const original = (await fixture('valid-ubl.xml')).toString('utf8')
    const namespacedAttribute = original.replace('unitCode="C62"', 'xmlns:cbc2="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2" cbc2:unitCode="H87" unitCode="C62"')
    expect(receiveStructuredInvoice(Buffer.from(namespacedAttribute)).data.lines[0].unitCode).toBe('C62')
    expect(receiveStructuredInvoice(Buffer.from(original.replace('unitCode="C62"', 'note="A>B" unitCode="C62"'))).data.lines[0].unitCode).toBe('C62')
    expect(receiveStructuredInvoice(Buffer.from(original.replace('unitCode="C62"', 'xml:lang="de" unitCode="C62"'))).data.lines[0].unitCode).toBe('C62')
    expect(() => receiveStructuredInvoice(Buffer.from(original.replace('<Invoice ', '<Invoice xmlns:xml="https://attacker.invalid" ')))).toThrow(/reserved XML namespace binding/)
    expect(() => receiveStructuredInvoice(Buffer.from(original.replace('<Invoice ', '<Invoice xmlns:xmlns="http://www.w3.org/2000/xmlns/" ')))).toThrow(/reserved XML namespace binding/)
    expect(() => receiveStructuredInvoice(Buffer.from(original.replace('<Invoice ', '<Invoice xmlns:evil="http://www.w3.org/XML/1998/namespace" ')))).toThrow(/reserved XML namespace binding/)
    const excessiveAliases = Array.from({ length: 65 }, (_, index) => `xmlns:a${index}="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2"`).join(' ')
    expect(() => receiveStructuredInvoice(Buffer.from(original.replace('<Invoice ', `<Invoice ${excessiveAliases} `)))).toThrow(/namespace declaration limit/)
    expect(() => receiveStructuredInvoice(Buffer.from(`${original}attacker-trailer`))).toThrow(/outside the XML root|Trailing/)
    expect(() => receiveStructuredInvoice(Buffer.from(`${original.slice(0, -11)}<malformed`))).toThrow(/skipped XML|well-formed|Unterminated XML tag/)
    expect(() => receiveStructuredInvoice(Buffer.from(original.replace('unitCode="C62"', 'unitCode=C62')))).toThrow(/unquoted|start-tag/)
    expect(() => receiveStructuredInvoice(Buffer.from(original.replace('<Invoice ', '<Invoice\u00a0')))).toThrow(/qualified element name|start-tag/)
    expect(() => receiveStructuredInvoice(Buffer.from(`\u00a0${original}`))).toThrow(/outside the XML root/)
    expect(() => receiveStructuredInvoice(Buffer.from(original.replace('unitCode="C62"', 'unitCode="C62" unitCode="H87"')))).toThrow(/Duplicate XML attribute/)
    expect(() => receiveStructuredInvoice(Buffer.from(original.replace('unitCode="C62"', 'bad:name:extra="x" unitCode="C62"')))).toThrow(/Invalid XML attribute name/)
    expect(() => receiveStructuredInvoice(Buffer.from(original.replace('unitCode="C62"', 'unitCode="C<62"')))).toThrow(/raw value/)
    expect(() => receiveStructuredInvoice(Buffer.from(original.replace('xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2"', 'xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2" xmlns:cbc="urn:duplicate"')))).toThrow(/namespace declaration/)
    expect(() => receiveStructuredInvoice(Buffer.from(original.replace('<?xml version="1.0" encoding="UTF-8"?>', '<?xml version="1.0"?><?xml version="1.0"?>')))).toThrow(/Only one complete/)
    expect(() => receiveStructuredInvoice(Buffer.from(` \n${original}`))).toThrow(/complete leading XML declaration/)
    expect(() => receiveStructuredInvoice(Buffer.from(original.replace('<?xml version="1.0" encoding="UTF-8"?>', '<?xml bogus="true"?>')))).toThrow(/complete leading XML declaration/)
    expect(() => receiveStructuredInvoice(Buffer.from(original.replace('encoding="UTF-8"', 'encoding="UTF-16"')))).toThrow(/complete leading XML declaration/)
    expect(() => receiveStructuredInvoice(Buffer.from(original.replace('?>', '>')))).toThrow(/complete leading XML declaration/)
    expect(() => receiveStructuredInvoice(Buffer.from(original.replace('Beratung', 'Bad\u0001text')))).toThrow(/forbidden by XML 1.0/)
    expect(() => receiveStructuredInvoice(Buffer.from(original.replace('Beratung', 'Bad&#1;text')))).toThrow(/numeric XML entity|forbidden by XML 1.0/)
    expect(() => receiveStructuredInvoice(Buffer.from(original.replace('Beratung', 'Bad&#X41;text')))).toThrow(/unknown XML entity/)
    expect(() => receiveStructuredInvoice(Buffer.from(original.replace('Beratung', 'Bad]]>text')))).toThrow(/forbidden \]\]>/)
    const nodeFlood = original.replace('</Invoice>', `${'<cbc:Note/>'.repeat(50_001)}</Invoice>`)
    expect(() => receiveStructuredInvoice(Buffer.from(nodeFlood))).toThrow(/structural limits|token limit/)
    const aliasedClose = original.replace('xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2"', 'xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2" xmlns:cbc2="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2"').replace('</cbc:ID>', '</cbc2:ID>')
    expect(() => receiveStructuredInvoice(Buffer.from(aliasedClose))).toThrow(/closing qualified name/)
    expect(() => receiveStructuredInvoice(Buffer.from(original.replace('<cbc:ID>', '<cbc:Bad:ID>')))).toThrow(/qualified element name/)
  })

  it('emits and reconciles one VAT subtotal per category/rate', async () => {
    const base = receiveStructuredInvoice(await fixture('valid-ubl.xml')).data
    const mixed: StructuredInvoiceData = { ...base, lines: [{ ...base.lines[0], netAmountCents: 10_000, taxRateBasisPoints: 1900 }, { ...base.lines[0], description: 'Reduced item', netAmountCents: 5_000, taxRateBasisPoints: 700 }], netAmountCents: 15_000, taxAmountCents: 2_250, grossAmountCents: 17_250 }
    const { syntax: _syntax, ...toGenerate } = mixed
    const bytes = generateUblInvoice(toGenerate); const xml = new TextDecoder().decode(bytes)
    expect(xml.match(/<cac:TaxSubtotal>/g)).toHaveLength(2)
    expect(receiveStructuredInvoice(bytes).data.lines.map(line => line.taxRateBasisPoints)).toEqual([1900, 700])
    expect(() => receiveStructuredInvoice(Buffer.from(xml.replace('>22.50</cbc:TaxAmount>', '>22.51</cbc:TaxAmount>')))).toThrow(/VAT breakdowns do not reconcile/)
    expect(() => receiveStructuredInvoice(Buffer.from(xml.replace('<cbc:ID>S</cbc:ID><cbc:Percent>19</cbc:Percent>', '<cbc:ID>Z</cbc:ID><cbc:Percent>19</cbc:Percent>')))).toThrow(/line tax categories/)
  })

  it('rounds VAT at category/rate totals and keeps zero-rate categories separate', async () => {
    const base = receiveStructuredInvoice(await fixture('valid-ubl.xml')).data
    const reasonSplit: StructuredInvoiceData = { ...base, lines: [{ ...base.lines[0], netAmountCents: 3 }, { ...base.lines[0], description: 'Second tiny line', netAmountCents: 3, exemptionReason: 'not applicable' }], netAmountCents: 6, taxAmountCents: 2, grossAmountCents: 8 }
    expect(validateInvoice(reasonSplit)).toContain('Category S must not carry a VAT exemption reason.')
    const { syntax: _reasonSyntax, ...reasonInput } = reasonSplit; expect(() => generateUblInvoice(reasonInput)).toThrow(/must not carry a VAT exemption reason/)
    const grouped: StructuredInvoiceData = { ...base, lines: [{ ...base.lines[0], netAmountCents: 3, taxRateBasisPoints: 1900 }, { ...base.lines[0], description: 'Second tiny line', netAmountCents: 3, taxRateBasisPoints: 1900 }, { ...base.lines[0], description: 'Zero item', netAmountCents: 100, taxRateBasisPoints: 0, taxCategoryCode: 'Z' }], netAmountCents: 106, taxAmountCents: 1, grossAmountCents: 107 }
    expect(validateInvoice(grouped)).toEqual([])
    const { syntax: _syntax, ...toGenerate } = grouped; const xml = new TextDecoder().decode(generateUblInvoice(toGenerate))
    expect(xml.match(/<cac:TaxSubtotal>/g)).toHaveLength(2)
    expect(xml).toContain('<cbc:ID>Z</cbc:ID><cbc:Percent>0</cbc:Percent>')
    const separateCategories: StructuredInvoiceData = { ...base, lines: [{ ...base.lines[0], netAmountCents: 3, taxCategoryCode: 'L' }, { ...base.lines[0], description: 'Other category', netAmountCents: 3, taxCategoryCode: 'M' }], netAmountCents: 6, taxAmountCents: 2, grossAmountCents: 8 }
    expect(validateInvoice(separateCategories)).toEqual([])
    const { syntax: _syntax2, ...separateInput } = separateCategories; expect(new TextDecoder().decode(generateUblInvoice(separateInput)).match(/<cac:TaxSubtotal>/g)).toHaveLength(2)
  })

  it('reads the standard CII VAT registration instead of a generic party ID', async () => {
    const original = (await fixture('valid-cii.xml')).toString('utf8')
    expect(receiveStructuredInvoice(Buffer.from(original)).data.seller.vatId).toBe('DE123456789')
    const spoofed = original.replace('<ram:SpecifiedTaxRegistration><ram:ID schemeID="VA">DE123456789</ram:ID></ram:SpecifiedTaxRegistration>', '<ram:ID>DE999999999</ram:ID>')
    expect(() => receiveStructuredInvoice(Buffer.from(spoofed))).toThrow(/Seller tax number or VAT ID/)
    const withCurrency = original.replaceAll('currencyID="EUR"', 'currencyID="CHF"').replace('<ram:ApplicableHeaderTradeSettlement>', '<ram:ApplicableHeaderTradeSettlement><ram:InvoiceCurrencyCode>CHF</ram:InvoiceCurrencyCode>')
    expect(receiveStructuredInvoice(Buffer.from(withCurrency)).data.currency).toBe('CHF')
    const contradictoryCurrency = original.replace('<ram:ApplicableHeaderTradeSettlement>', '<ram:ApplicableHeaderTradeSettlement><ram:InvoiceCurrencyCode>EUR</ram:InvoiceCurrencyCode>').replace('<ram:GrandTotalAmount currencyID="EUR">', '<ram:GrandTotalAmount currencyID="USD">')
    expect(() => receiveStructuredInvoice(Buffer.from(contradictoryCurrency))).toThrow(/currencyID must match the invoice currency code/)
    const duplicateVat = original.replace('</ram:SellerTradeParty>', '<ram:SpecifiedTaxRegistration><ram:ID schemeID="VA">DE999999999</ram:ID></ram:SpecifiedTaxRegistration></ram:SellerTradeParty>')
    expect(() => receiveStructuredInvoice(Buffer.from(duplicateVat))).toThrow(/at most one unambiguous VAT/)
    const headerAllowance = original.replace('<ram:ApplicableHeaderTradeSettlement>', '<ram:ApplicableHeaderTradeSettlement><ram:SpecifiedTradeAllowanceCharge><ram:ChargeIndicator><udt:Indicator>false</udt:Indicator></ram:ChargeIndicator></ram:SpecifiedTradeAllowanceCharge>')
    expect(() => receiveStructuredInvoice(Buffer.from(headerAllowance))).toThrow(/CII document-level allowances or charges/)
  })

  it('rejects empty monetary values and bare or unknown XML entities', async () => {
    const original = (await fixture('valid-ubl.xml')).toString('utf8')
    expect(() => receiveStructuredInvoice(Buffer.from(original.replace('>119.00</cbc:TaxInclusiveAmount>', '></cbc:TaxInclusiveAmount>')))).toThrow(/finite cents|reconcile|disagree/)
    expect(() => receiveStructuredInvoice(Buffer.from(original.replace('<cbc:TaxInclusiveAmount currencyID="EUR">119.00</cbc:TaxInclusiveAmount>', '')))).toThrow(/explicit TaxInclusiveAmount/)
    const headerAllowance = original.replace('<cac:TaxTotal>', '<cac:AllowanceCharge><cbc:ChargeIndicator>false</cbc:ChargeIndicator></cac:AllowanceCharge><cac:TaxTotal>')
    expect(() => receiveStructuredInvoice(Buffer.from(headerAllowance))).toThrow(/UBL document-level allowances or charges/)
    expect(() => receiveStructuredInvoice(Buffer.from(original.replace('Beratung', 'R&amp;D &unknown;')))).toThrow(/unknown XML entity/)
    expect(() => receiveStructuredInvoice(Buffer.from(original.replace('Beratung', 'R&D')))).toThrow(/Bare or unknown XML entity/)
  })

  it('requires consistent currencies, zero-rate AE, and precise unit prices', async () => {
    const base = receiveStructuredInvoice(await fixture('valid-ubl.xml')).data
    const original = (await fixture('valid-ubl.xml')).toString('utf8')
    expect(() => receiveStructuredInvoice(Buffer.from(original.replace('currencyID="EUR">119.00</cbc:TaxInclusiveAmount>', 'currencyID="USD">119.00</cbc:TaxInclusiveAmount>')))).toThrow(/currencyID/)
    expect(validateInvoice({ ...base, reverseCharge: true, taxAmountCents: 0, grossAmountCents: 10_000 })).toContain('Reverse-charge invoice lines must use category AE with a zero rate.')
    const precise = { ...base, lines: [{ ...base.lines[0], quantity: 3, netAmountCents: 100, taxRateBasisPoints: 0, taxCategoryCode: 'Z' }], netAmountCents: 100, taxAmountCents: 0, grossAmountCents: 100 }
    const { syntax: _syntax, ...toGenerate } = precise; const xml = new TextDecoder().decode(generateUblInvoice(toGenerate))
    expect(xml).toContain('<cbc:PriceAmount currencyID="EUR">0.333333</cbc:PriceAmount>')
    expect(() => generateUblInvoice({ ...toGenerate, currency: 'EU<&' })).toThrow(/three-letter uppercase/)
    expect(() => generateUblInvoice({ ...toGenerate, currency: 'ABC' })).toThrow(/ISO 4217/)
    const zwg = generateUblInvoice({ ...toGenerate, currency: 'ZWG' }); expect(receiveStructuredInvoice(zwg).data.currency).toBe('ZWG')
    expect(() => generateUblInvoice({ ...toGenerate, currency: 'ZWL' })).toThrow(/ISO 4217/)
    expect(() => generateUblInvoice({ ...toGenerate, lines: [{ ...toGenerate.lines[0], taxCategoryCode: '<script>' }] })).toThrow(/supported tax category/)
    expect(() => generateUblInvoice({ ...toGenerate, kind: 'unknown' as never, correctedInvoiceNumber: 'RE-1' })).toThrow(/supported discriminant/)
    expect(() => generateUblInvoice({ ...toGenerate, lines: [{ ...toGenerate.lines[0], quantity: 1e-7 }] })).toThrow(/complete invoice line/)
    expect(() => generateUblInvoice({ ...toGenerate, lines: [{ ...toGenerate.lines[0], quantity: 1.1234567 }] })).toThrow(/complete invoice line/)
    const excessiveSourcePrecision = original.replace(/(<cbc:InvoicedQuantity[^>]*>)1(<\/cbc:InvoicedQuantity>)/, (_match, open: string, close: string) => `${open}1.0000000000000001${close}`)
    expect(() => receiveStructuredInvoice(Buffer.from(excessiveSourcePrecision))).toThrow(/at most six fractional digits/)
    const maximum = { ...toGenerate, lines: [{ ...toGenerate.lines[0], quantity: 1, netAmountCents: Number.MAX_SAFE_INTEGER }], netAmountCents: Number.MAX_SAFE_INTEGER, taxAmountCents: 0, grossAmountCents: Number.MAX_SAFE_INTEGER }
    expect(receiveStructuredInvoice(generateUblInvoice(maximum)).data.lines[0].netAmountCents).toBe(Number.MAX_SAFE_INTEGER)
    const maximumTinyQuantity = { ...maximum, lines: [{ ...maximum.lines[0], quantity: 0.000001 }] }
    const maximumTinyXml = new TextDecoder().decode(generateUblInvoice(maximumTinyQuantity))
    expect(maximumTinyXml).toContain('90071992547409910000')
    expect(receiveStructuredInvoice(Buffer.from(maximumTinyXml)).data.lines[0]).toMatchObject({ quantity: 0.000001, netAmountCents: Number.MAX_SAFE_INTEGER })
  })

  it('supports mixed taxable/exempt groups and repeatable classified tax registrations', async () => {
    const base = receiveStructuredInvoice(await fixture('valid-ubl.xml')).data
    const mixed: StructuredInvoiceData = { ...base, lines: [{ ...base.lines[0], taxCategoryCode: 'S' }, { ...base.lines[0], description: 'Exempt service', netAmountCents: 5_000, taxRateBasisPoints: 0, taxCategoryCode: 'E', exemptionReason: 'UStG §4' }], netAmountCents: 15_000, taxAmountCents: 1_900, grossAmountCents: 16_900 }
    const { syntax: _syntax, ...toGenerate } = mixed; const parsed = receiveStructuredInvoice(generateUblInvoice(toGenerate))
    expect(parsed.data.lines).toEqual(expect.arrayContaining([expect.objectContaining({ taxCategoryCode: 'S' }), expect.objectContaining({ taxCategoryCode: 'E', exemptionReason: 'UStG §4' })]))
    expect(parsed.data.exemptionReason).toBeUndefined()
    const outsideScope: StructuredInvoiceData = { ...base, lines: [{ ...base.lines[0], taxRateBasisPoints: 0, taxCategoryCode: 'O', exemptionReason: 'Outside the scope of VAT' }], taxAmountCents: 0, grossAmountCents: base.netAmountCents }
    const { syntax: _outsideSyntax, ...outsideInput } = outsideScope
    const outsideXml = new TextDecoder().decode(generateUblInvoice(outsideInput)); const outsideReason = '<cbc:TaxExemptionReason>Outside the scope of VAT</cbc:TaxExemptionReason>'; const lastOutsideReason = outsideXml.lastIndexOf(outsideReason); const ublHeaderOnlyOutsideReason = outsideXml.slice(0, lastOutsideReason) + outsideXml.slice(lastOutsideReason + outsideReason.length)
    expect(receiveStructuredInvoice(Buffer.from(ublHeaderOnlyOutsideReason)).data.lines[0]).toMatchObject({ taxCategoryCode: 'O', exemptionReason: 'Outside the scope of VAT' })
    for (const taxCategoryCode of ['G', 'K']) expect(validateInvoice({ ...outsideScope, lines: [{ ...outsideScope.lines[0], taxCategoryCode, exemptionReason: undefined }] })).toContain(`Category ${taxCategoryCode} requires a nonblank VAT exemption reason.`)
    const exportSupply: StructuredInvoiceData = { ...outsideScope, lines: [{ ...outsideScope.lines[0], taxCategoryCode: 'G', exemptionReason: 'Export supply' }] }
    const { syntax: _exportSyntax, ...exportInput } = exportSupply; const exportXml = new TextDecoder().decode(generateUblInvoice(exportInput)); const exportReason = '<cbc:TaxExemptionReason>Export supply</cbc:TaxExemptionReason>'; const lastExportReason = exportXml.lastIndexOf(exportReason)
    const ublHeaderOnlyExportReason = exportXml.slice(0, lastExportReason) + exportXml.slice(lastExportReason + exportReason.length)
    expect(receiveStructuredInvoice(Buffer.from(ublHeaderOnlyExportReason)).data.lines[0]).toMatchObject({ taxCategoryCode: 'G', exemptionReason: 'Export supply' })
    const ubl = (await fixture('valid-ubl.xml')).toString('utf8').replace('</cac:PartyTaxScheme>', '</cac:PartyTaxScheme><cac:PartyTaxScheme><cbc:CompanyID>12/345/67890</cbc:CompanyID><cac:TaxScheme><cbc:ID>FC</cbc:ID></cac:TaxScheme></cac:PartyTaxScheme>')
    expect(receiveStructuredInvoice(Buffer.from(ubl)).data.seller).toMatchObject({ vatId: 'DE123456789', taxId: '12/345/67890' })
    const duplicateVat = (await fixture('valid-ubl.xml')).toString('utf8').replace('</cac:PartyTaxScheme>', '</cac:PartyTaxScheme><cac:PartyTaxScheme><cbc:CompanyID>DE999999999</cbc:CompanyID><cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:PartyTaxScheme>')
    expect(() => receiveStructuredInvoice(Buffer.from(duplicateVat))).toThrow(/at most one unambiguous VAT/)
    const reasons: StructuredInvoiceData = { ...base, lines: [{ ...base.lines[0], netAmountCents: 5_000, taxRateBasisPoints: 0, taxCategoryCode: 'E', exemptionReason: 'Reason A' }, { ...base.lines[0], description: 'Other exemption', netAmountCents: 5_000, taxRateBasisPoints: 0, taxCategoryCode: 'E', exemptionReason: 'Reason B' }], netAmountCents: 10_000, taxAmountCents: 0, grossAmountCents: 10_000 }
    const { syntax: _syntax2, ...reasonInput } = reasons; expect(receiveStructuredInvoice(generateUblInvoice(reasonInput)).data.lines.map(line => line.exemptionReason)).toEqual(['Reason A', 'Reason B'])
    const reverseCharge: StructuredInvoiceData = { ...base, taxAmountCents: 0, grossAmountCents: 10_000, reverseCharge: true, lines: [{ ...base.lines[0], taxRateBasisPoints: 0, taxCategoryCode: 'AE', reverseCharge: true, exemptionReason: 'Reverse charge' }] }
    const { syntax: _syntax4, ...reverseInput } = reverseCharge; const reverseXml = new TextDecoder().decode(generateUblInvoice(reverseInput)); const reasonTag = '<cbc:TaxExemptionReason>Reverse charge</cbc:TaxExemptionReason>'; const lastReason = reverseXml.lastIndexOf(reasonTag)
    const headerOnlyReason = reverseXml.slice(0, lastReason) + reverseXml.slice(lastReason + reasonTag.length)
    expect(receiveStructuredInvoice(Buffer.from(headerOnlyReason)).data.lines[0]).toMatchObject({ taxCategoryCode: 'AE', reverseCharge: true, exemptionReason: 'Reverse charge' })
    expect(validateInvoice({ ...reverseCharge, lines: [{ ...reverseCharge.lines[0], exemptionReason: undefined }] })).toContain('Category AE requires zero rate, reverse-charge treatment and a nonblank reason.')
    const ciiBase = (await fixture('valid-cii.xml')).toString('utf8')
    const ciiReverseCharge = ciiBase.replaceAll('<ram:CategoryCode>S</ram:CategoryCode>', '<ram:CategoryCode>AE</ram:CategoryCode>').replaceAll('<ram:RateApplicablePercent>19</ram:RateApplicablePercent>', '<ram:RateApplicablePercent>0</ram:RateApplicablePercent>').replace('<ram:CalculatedAmount>19.00</ram:CalculatedAmount>', '<ram:CalculatedAmount>0.00</ram:CalculatedAmount>').replace('<ram:TaxTotalAmount>19.00</ram:TaxTotalAmount>', '<ram:TaxTotalAmount>0.00</ram:TaxTotalAmount>').replace('<ram:GrandTotalAmount currencyID="EUR">119.00</ram:GrandTotalAmount>', '<ram:GrandTotalAmount currencyID="EUR">100.00</ram:GrandTotalAmount>').replace('<ram:DuePayableAmount currencyID="EUR">119.00</ram:DuePayableAmount>', '<ram:DuePayableAmount currencyID="EUR">100.00</ram:DuePayableAmount>')
    expect(() => receiveStructuredInvoice(Buffer.from(ciiReverseCharge))).toThrow(/Category AE requires zero rate, reverse-charge treatment and a nonblank reason/)
    const ciiWithReason = ciiReverseCharge.replaceAll('<ram:CategoryCode>AE</ram:CategoryCode><ram:RateApplicablePercent>0</ram:RateApplicablePercent>', '<ram:CategoryCode>AE</ram:CategoryCode><ram:RateApplicablePercent>0</ram:RateApplicablePercent><ram:ExemptionReason>Reverse charge under Article 196</ram:ExemptionReason>')
    expect(receiveStructuredInvoice(Buffer.from(ciiWithReason)).data.lines[0]).toMatchObject({ taxCategoryCode: 'AE', reverseCharge: true, exemptionReason: 'Reverse charge under Article 196' })
    expect(() => receiveStructuredInvoice(Buffer.from(ciiWithReason.replace('<ram:ExemptionReason>Reverse charge under Article 196</ram:ExemptionReason>', '<ram:ExemptionReason>Contradictory line reason</ram:ExemptionReason>')))).toThrow(/line and header ExemptionReason values must match/)
    expect(() => receiveStructuredInvoice(Buffer.from(reverseXml.replace(reasonTag, '<cbc:TaxExemptionReason>Different header reason</cbc:TaxExemptionReason>')))).toThrow(/line and header TaxExemptionReason/)
    const ciiExport = ciiBase.replaceAll('<ram:CategoryCode>S</ram:CategoryCode>', '<ram:CategoryCode>G</ram:CategoryCode>').replaceAll('<ram:RateApplicablePercent>19</ram:RateApplicablePercent>', '<ram:RateApplicablePercent>0</ram:RateApplicablePercent>').replace('<ram:CalculatedAmount>19.00</ram:CalculatedAmount>', '<ram:CalculatedAmount>0.00</ram:CalculatedAmount>').replace('<ram:TaxTotalAmount>19.00</ram:TaxTotalAmount>', '<ram:TaxTotalAmount>0.00</ram:TaxTotalAmount>').replace('<ram:GrandTotalAmount currencyID="EUR">119.00</ram:GrandTotalAmount>', '<ram:GrandTotalAmount currencyID="EUR">100.00</ram:GrandTotalAmount>').replace('<ram:DuePayableAmount currencyID="EUR">119.00</ram:DuePayableAmount>', '<ram:DuePayableAmount currencyID="EUR">100.00</ram:DuePayableAmount>').replace('<ram:BasisAmount>100.00</ram:BasisAmount><ram:CategoryCode>G</ram:CategoryCode>', '<ram:BasisAmount>100.00</ram:BasisAmount><ram:CategoryCode>G</ram:CategoryCode><ram:ExemptionReason>Export supply</ram:ExemptionReason>')
    expect(receiveStructuredInvoice(Buffer.from(ciiExport)).data.lines[0]).toMatchObject({ taxCategoryCode: 'G', exemptionReason: 'Export supply' })
    const ciiOutside = ciiExport.replaceAll('<ram:CategoryCode>G</ram:CategoryCode>', '<ram:CategoryCode>O</ram:CategoryCode>').replace('Export supply', 'Outside the scope of VAT')
    expect(receiveStructuredInvoice(Buffer.from(ciiOutside)).data.lines[0]).toMatchObject({ taxCategoryCode: 'O', exemptionReason: 'Outside the scope of VAT' })
    const bothIds = { ...base, seller: { ...base.seller, taxId: '12/345/67890' } }; const { syntax: _syntax3, ...bothInput } = bothIds; const bothXml = new TextDecoder().decode(generateUblInvoice(bothInput)); expect(bothXml).toContain('<cbc:ID>VAT</cbc:ID>'); expect(bothXml).toContain('<cbc:ID>FC</cbc:ID>')
  })

  it('parses PDF associated-file dictionaries independent of key order and enforces stream limits', async () => {
    const xml = await fixture('valid-cii.xml'); const reordered = buildPdf([{ id: 1, body: Buffer.from('<< /Type /Filespec /EF << /F 2 0 R >> /AFRelationship /Alternative /UF (zugferd.xml) >>') }, { id: 2, body: embeddedXmlBody(xml, `/Length ${xml.length} /Subtype /application#2Fxml /Type /EmbeddedFile`) }, { id: 3, body: Buffer.from('<< /Type /Catalog /Names << /EmbeddedFiles 4 0 R >> >>') }, { id: 4, body: Buffer.from('<< /Names [(zugferd.xml) 1 0 R] >>') }])
    expect(Buffer.from(extractUncompressedStructuredInvoiceFromPdf(reordered).xmlBytes)).toEqual(xml)
    const textXml = buildPdf([{ id: 1, body: Buffer.from('<< /Type /Filespec /F (factur-x.xml) /AFRelationship /Data /EF << /F 2 0 R >> >>') }, { id: 2, body: embeddedXmlBody(xml, `/Type /EmbeddedFile /Subtype /text#2Fxml /Length ${xml.length}`) }, { id: 3, body: Buffer.from('<< /Type /Catalog /AF [1 0 R] >>') }])
    expect(Buffer.from(extractUncompressedStructuredInvoiceFromPdf(textXml).xmlBytes)).toEqual(xml)
    const xrefStream = buildXrefStreamPdf([{ id: 1, body: Buffer.from('<< /Type /Filespec /F (factur-x.xml) /AFRelationship /Data /EF << /F 2 0 R >> >>') }, { id: 2, body: embeddedXmlBody(xml) }, { id: 3, body: Buffer.from('<< /Type /Catalog /AF [1 0 R] >>') }])
    expect(Buffer.from(extractUncompressedStructuredInvoiceFromPdf(xrefStream).xmlBytes)).toEqual(xml)
    expect(Buffer.from(extractUncompressedStructuredInvoiceFromPdf(buildObjectStreamPdf(xml)).xmlBytes)).toEqual(xml)
    const revisedXml = Buffer.concat([xml, Buffer.from('\n')]); const revisedXmlBody = embeddedXmlBody(revisedXml)
    const classicIncrement = appendClassicPdfRevision(reordered, [{ id: 2, body: revisedXmlBody }])
    expect(Buffer.from(extractUncompressedStructuredInvoiceFromPdf(classicIncrement).xmlBytes)).toEqual(revisedXml)
    const streamAfterClassic = appendXrefStreamPdfRevision(reordered, [{ id: 2, body: revisedXmlBody }])
    expect(Buffer.from(extractUncompressedStructuredInvoiceFromPdf(streamAfterClassic).xmlBytes)).toEqual(revisedXml)
    const classicAfterStream = appendClassicPdfRevision(xrefStream, [{ id: 2, body: revisedXmlBody }])
    expect(Buffer.from(extractUncompressedStructuredInvoiceFromPdf(classicAfterStream).xmlBytes)).toEqual(revisedXml)
    const selfReferencingPrev = Buffer.from(classicIncrement.toString('latin1').replace(`/Prev ${previousXrefOffset(reordered)}`, `/Prev ${previousXrefOffset(classicIncrement)}`), 'latin1')
    expect(() => extractUncompressedStructuredInvoiceFromPdf(selfReferencingPrev)).toThrow(/Prev does not resolve to an older bounded/)
    const oversizedFlate = Buffer.from(zlibSync(new Uint8Array(20 * 1024 * 1024 + 1)))
    const boundedBomb = buildXrefStreamPdf([{ id: 1, body: Buffer.from('<< /Type /Filespec /F (factur-x.xml) /AFRelationship /Data /EF << /F 2 0 R >> >>') }, { id: 2, body: embeddedXmlBody(xml) }, { id: 3, body: Buffer.from('<< /Type /Catalog /AF [1 0 R] >>') }], 3, { data: oversizedFlate, dictionary: '/Filter /FlateDecode' })
    expect(() => extractUncompressedStructuredInvoiceFromPdf(boundedBomb)).toThrow(/Decoded PDF stream exceeds the 20 MiB limit/)
    const crOnly = Buffer.from(reordered.toString('latin1').replaceAll('\n', '\r'), 'latin1')
    expect(Buffer.from(extractUncompressedStructuredInvoiceFromPdf(crOnly).xmlBytes)).toEqual(Buffer.from(xml.toString('latin1').replaceAll('\n', '\r'), 'latin1'))
    const unicodeFilename = buildPdf([{ id: 1, body: Buffer.from('<< /Type /Filespec /UF <FEFF006600610063007400750072002D0078006D006C> /F (factur-x.xml) /AFRelationship /Alternative /EF << /F 2 0 R >> >>') }, { id: 2, body: embeddedXmlBody(xml) }, { id: 3, body: Buffer.from('<< /Type /Catalog /AF [1 0 R] >>') }])
    expect(Buffer.from(extractUncompressedStructuredInvoiceFromPdf(unicodeFilename).xmlBytes)).toEqual(xml)
    const unusableUnicodeFallback = buildPdf([{ id: 1, body: Buffer.from('<< /Type /Filespec /UF <FEFF006E006F0074002D0078006D006C> /F (factur-x.xml) /AFRelationship /Alternative /EF << /F 2 0 R >> >>') }, { id: 2, body: embeddedXmlBody(xml) }, { id: 3, body: Buffer.from('<< /Type /Catalog /AF [1 0 R] >>') }])
    expect(Buffer.from(extractUncompressedStructuredInvoiceFromPdf(unusableUnicodeFallback).xmlBytes)).toEqual(xml)
    const indirectLengthBody = Buffer.concat([Buffer.from('<< /Type /EmbeddedFile /Subtype /application#2Fxml /Length 5 0 R >>\nstream\n'), xml, Buffer.from('\nendstream')])
    const indirectLength = buildPdf([{ id: 1, body: Buffer.from('<< /Type /Filespec /F (indirect.xml) /AFRelationship /Data /EF << /F 2 0 R >> >>') }, { id: 2, body: indirectLengthBody }, { id: 3, body: Buffer.from('<< /Type /Catalog /AF [1 0 R] >>') }, { id: 5, body: Buffer.from(String(xml.length)) }])
    expect(Buffer.from(extractUncompressedStructuredInvoiceFromPdf(indirectLength).xmlBytes)).toEqual(xml)
    const nestedDecoy = buildPdf([{ id: 1, body: Buffer.from('<< /Type /Filespec /F (real.xml) /AFRelationship /Data /EF << /F 2 0 R >> >>') }, { id: 2, body: embeddedXmlBody(xml) }, { id: 3, body: Buffer.from('<< /Type /Catalog /Metadata << /AF [4 0 R] >> /AF [1 0 R] >>') }, { id: 4, body: Buffer.from('<< /Type /Filespec /F (decoy.xml) /AFRelationship /Data /EF << /F 2 0 R >> >>') }])
    expect(Buffer.from(extractUncompressedStructuredInvoiceFromPdf(nestedDecoy).xmlBytes)).toEqual(xml)
    const deeplyNested = `${'<< /Next '.repeat(40)}/Leaf /value${' >>'.repeat(40)}`
    const nestingBomb = buildPdf([{ id: 1, body: Buffer.from('<< /Type /Filespec /F (real.xml) /AFRelationship /Data /EF << /F 2 0 R >> >>') }, { id: 2, body: embeddedXmlBody(xml) }, { id: 3, body: Buffer.from(`<< /Type /Catalog /Bomb ${deeplyNested} /AF [1 0 R] >>`) }])
    expect(() => extractUncompressedStructuredInvoiceFromPdf(nestingBomb)).toThrow(/nesting limit/)
    const oversizedDictionary = buildPdf([{ id: 1, body: Buffer.from('<< /Type /Filespec /F (real.xml) /AFRelationship /Data /EF << /F 2 0 R >> >>') }, { id: 2, body: embeddedXmlBody(xml) }, { id: 3, body: Buffer.from(`<< /Type /Catalog /Pad (${''.padEnd(1024 * 1024, 'A')}) /AF [1 0 R] >>`) }])
    expect(() => extractUncompressedStructuredInvoiceFromPdf(oversizedDictionary)).toThrow(/dictionary exceeds the 1 MiB/)
    const duplicateRootKey = buildPdf([{ id: 1, body: Buffer.from('<< /Type /Filespec /F (x.xml) /AFRelationship /Data /EF << /F 2 0 R >> >>') }, { id: 2, body: embeddedXmlBody(xml) }, { id: 3, body: Buffer.from('<< /Type /Catalog /AF [1 0 R] /AF [1 0 R] >>') }])
    expect(() => extractUncompressedStructuredInvoiceFromPdf(duplicateRootKey)).toThrow(/Duplicate critical PDF dictionary key \/AF/)
    const duplicateTrailerKey = Buffer.from(reordered.toString('latin1').replace('/Root 3 0 R', '/Root 3 0 R /Root 3 0 R'), 'latin1')
    expect(() => extractUncompressedStructuredInvoiceFromPdf(duplicateTrailerKey)).toThrow(/Duplicate critical PDF dictionary key \/Root/)
    const ambiguousRoot = Buffer.from(reordered.toString('latin1').replace('/Root 3 0 R', '/Root [3 0 R 4 0 R]'), 'latin1')
    expect(() => extractUncompressedStructuredInvoiceFromPdf(ambiguousRoot)).toThrow(/authoritative catalog root/)
    const trailerWithFileId = Buffer.from(reordered.toString('latin1').replace('/Root 3 0 R', '/Root 3 0 R /ID [<0011aaff> <0011aaff>]'), 'latin1')
    expect(Buffer.from(extractUncompressedStructuredInvoiceFromPdf(trailerWithFileId).xmlBytes)).toEqual(xml)
    const indirectNames = buildPdf([{ id: 1, body: Buffer.from('<< /Type /Filespec /F (indirect-names.xml) /AFRelationship /Data /EF << /F 2 0 R >> >>') }, { id: 2, body: embeddedXmlBody(xml) }, { id: 3, body: Buffer.from('<< /Type /Catalog /Names 4 0 R >>') }, { id: 4, body: Buffer.from('<< /EmbeddedFiles 5 0 R >>') }, { id: 5, body: Buffer.from('<< /Names [(indirect-names.xml) 1 0 R] >>') }])
    expect(Buffer.from(extractUncompressedStructuredInvoiceFromPdf(indirectNames).xmlBytes)).toEqual(xml)
    const indirectAfArray = buildPdf([{ id: 1, body: Buffer.from('<< /Type /Filespec /F (indirect-af.xml) /AFRelationship /Data /EF << /F 2 0 R >> >>') }, { id: 2, body: embeddedXmlBody(xml) }, { id: 3, body: Buffer.from('<< /Type /Catalog /AF 4 0 R >>') }, { id: 4, body: Buffer.from('[1 0 R]') }])
    expect(Buffer.from(extractUncompressedStructuredInvoiceFromPdf(indirectAfArray).xmlBytes)).toEqual(xml)
    const oversizedStream = buildPdf([{ id: 1, body: Buffer.from('<< /Type /Filespec /F (x.xml) /AFRelationship /Data /EF << /F 2 0 R >> >>') }, { id: 2, body: embeddedXmlBody(Buffer.from('x'), '/Type /EmbeddedFile /Subtype /application#2Fxml /Length 10485761') }, { id: 3, body: Buffer.from('<< /Type /Catalog /AF [1 0 R] >>') }])
    expect(() => extractUncompressedStructuredInvoiceFromPdf(oversizedStream)).toThrow(/exceeds 10 MiB/)
    for (const forbidden of ['/Filter /FlateDecode', '/DecodeParms << /Predictor 12 >>']) {
      const filtered = buildPdf([{ id: 1, body: Buffer.from('<< /Type /Filespec /F (x.xml) /AFRelationship /Data /EF << /F 2 0 R >> >>') }, { id: 2, body: embeddedXmlBody(xml, `/Type /EmbeddedFile /Subtype /application#2Fxml /Length ${xml.length} ${forbidden}`) }, { id: 3, body: Buffer.from('<< /Type /Catalog /AF [1 0 R] >>') }])
      expect(() => extractUncompressedStructuredInvoiceFromPdf(filtered)).toThrow(/Filter or DecodeParms/)
    }
    const orphan = buildPdf([{ id: 1, body: Buffer.from('<< /Type /Filespec /F (orphan.xml) /AFRelationship /Data /EF << /F 2 0 R >> >>') }, { id: 2, body: embeddedXmlBody(xml) }, { id: 3, body: Buffer.from('<< /Type /Catalog >>') }])
    expect(() => extractUncompressedStructuredInvoiceFromPdf(orphan)).toThrow(/no XML associated-file/)
    const ambiguous = buildPdf([{ id: 1, body: Buffer.from('<< /Type /Filespec /F (one.xml) /AFRelationship /Data /EF << /F 2 0 R >> >>') }, { id: 2, body: embeddedXmlBody(xml) }, { id: 3, body: Buffer.from('<< /Type /Catalog /AF [1 0 R 4 0 R] >>') }, { id: 4, body: Buffer.from('<< /Type /Filespec /F (two.xml) /AFRelationship /Data /EF << /F 2 0 R >> >>') }])
    expect(() => extractUncompressedStructuredInvoiceFromPdf(ambiguous)).toThrow(/ambiguous XML/)
    const trailingPseudoObject = Buffer.concat([reordered, Buffer.from('2 0 obj << /Type /EmbeddedFile >> endobj')])
    expect(() => extractUncompressedStructuredInvoiceFromPdf(trailingPseudoObject)).toThrow(/%%EOF boundary/)
    const dictionaryTail = buildPdf([{ id: 1, body: Buffer.from('<< /Type /Filespec /F (x.xml) /AFRelationship /Data /EF << /F 2 0 R >> >>') }, { id: 2, body: embeddedXmlBody(xml) }, { id: 3, body: Buffer.from('<< /Type /Catalog /AF [1 0 R] >> true') }])
    expect(() => extractUncompressedStructuredInvoiceFromPdf(dictionaryTail)).toThrow(/invalid trailing content/)
  })

  it('parses CII correction references and fiscal registrations', async () => {
    const original = (await fixture('valid-cii.xml')).toString('utf8')
    const cii = original.replace('<ram:ApplicableHeaderTradeSettlement>', '<ram:ApplicableHeaderTradeSettlement><ram:InvoiceReferencedDocument><ram:IssuerAssignedID>CII-ORIGINAL</ram:IssuerAssignedID></ram:InvoiceReferencedDocument>').replace('</ram:SellerTradeParty>', '<ram:SpecifiedTaxRegistration><ram:ID schemeID="FC">12/345/67890</ram:ID></ram:SpecifiedTaxRegistration></ram:SellerTradeParty>')
    expect(receiveStructuredInvoice(Buffer.from(cii)).data).toMatchObject({ correctedInvoiceNumber: 'CII-ORIGINAL', seller: { vatId: 'DE123456789', taxId: '12/345/67890' } })
    const supportingReference = original.replace('<ram:ApplicableHeaderTradeAgreement>', '<ram:ApplicableHeaderTradeAgreement><ram:AdditionalReferencedDocument><ram:IssuerAssignedID>PURCHASE-ORDER-1</ram:IssuerAssignedID></ram:AdditionalReferencedDocument>')
    expect(receiveStructuredInvoice(Buffer.from(supportingReference)).data.correctedInvoiceNumber).toBeUndefined()
    const payable = original.replace('<ram:DuePayableAmount currencyID="EUR">119.00</ram:DuePayableAmount>', '<ram:TotalPrepaidAmount>20.00</ram:TotalPrepaidAmount><ram:RoundingAmount>-0.01</ram:RoundingAmount><ram:DuePayableAmount>98.99</ram:DuePayableAmount>')
    expect(receiveStructuredInvoice(Buffer.from(payable)).data).toMatchObject({ prepaidAmountCents: 2_000, payableRoundingAmountCents: -1, payableAmountCents: 9_899 })
    expect(() => receiveStructuredInvoice(Buffer.from(payable.replace('>98.99</ram:DuePayableAmount>', '>99.00</ram:DuePayableAmount>')))).toThrow(/Payable amount does not reconcile/)
    const contradictoryBasis = original.replace('<ram:GrandTotalAmount', '<ram:TaxBasisTotalAmount>999.00</ram:TaxBasisTotalAmount><ram:GrandTotalAmount')
    expect(() => receiveStructuredInvoice(Buffer.from(contradictoryBasis))).toThrow(/TaxBasisTotalAmount does not reconcile/)
  })

  it('rejects non-decimal, over-precision, and unsafe monetary originals', async () => {
    const original = (await fixture('valid-ubl.xml')).toString('utf8')
    for (const invalid of ['1e2', '0x64', '100.001', '900719925474099.99']) expect(() => receiveStructuredInvoice(Buffer.from(original.replace('>100.00</cbc:LineExtensionAmount>', `>${invalid}</cbc:LineExtensionAmount>`)))).toThrow()
    expect(() => receiveStructuredInvoice(Buffer.from(original.replace('<cbc:Percent>19</cbc:Percent>', '<cbc:Percent>19.001</cbc:Percent>')))).toThrow(/tax values|VAT subtotal arithmetic/)
  })
})
