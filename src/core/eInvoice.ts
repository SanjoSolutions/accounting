import { createHash } from 'node:crypto'
import { unzlibSync } from 'fflate'

export type EInvoiceSyntax = 'UBL' | 'CII' | 'ZUGFERD'
export type InvoiceDocumentKind = 'invoice' | 'credit-note' | 'cancellation' | 'correction'

export interface BinaryOriginal {
  readonly bytes: Uint8Array
  readonly mediaType: string
  readonly sha256: string
}

export interface EInvoiceParty { name: string; street: string; city: string; postalCode: string; countryCode: string; taxId?: string; vatId?: string }
export interface EInvoiceLine { description: string; quantity: number; unitCode: string; netAmountCents: number; taxRateBasisPoints: number; taxCategoryCode?: string; exemptionReason?: string; reverseCharge?: boolean }
export interface StructuredInvoiceData {
  syntax: EInvoiceSyntax
  kind: InvoiceDocumentKind
  invoiceNumber: string
  issueDate: string
  supplyDate: string
  seller: EInvoiceParty
  buyer: EInvoiceParty
  lines: EInvoiceLine[]
  netAmountCents: number
  taxAmountCents: number
  grossAmountCents: number
  prepaidAmountCents?: number
  payableRoundingAmountCents?: number
  payableAmountCents?: number
  currency: string
  paymentTerms?: string
  paymentIban?: string
  exemptionReason?: string
  reverseCharge?: boolean
  correctedInvoiceNumber?: string
}

export interface ValidatedEInvoice {
  readonly structuredOriginal: BinaryOriginal
  readonly visualOriginal?: BinaryOriginal
  readonly data: Readonly<StructuredInvoiceData>
  readonly provenance: Readonly<Record<keyof StructuredInvoiceData, string>>
  readonly warnings: readonly string[]
}
const TRUSTED_PDF_EXTRACTION = Symbol('trusted-pdf-extraction')
const trustedPdfExtractions = new WeakSet<object>()
export interface TrustedPdfExtraction { readonly pdfBytes: Uint8Array; readonly mediaType: 'application/pdf'; readonly embeddedXmlSha256: string; readonly [TRUSTED_PDF_EXTRACTION]: true }
export function extractUncompressedStructuredInvoiceFromPdf(pdfBytes: Uint8Array): { xmlBytes: Uint8Array; extraction: TrustedPdfExtraction } {
  if (pdfBytes.byteLength > 100 * 1024 * 1024) throw new EInvoiceValidationError(['PDF exceeds the 100 MiB hybrid-invoice limit.'])
  const pdfCopy = Uint8Array.from(pdfBytes); const text = new TextDecoder('latin1').decode(pdfCopy)
  if (!text.startsWith('%PDF-')) throw new EInvoiceValidationError(['ZUGFeRD visual original must be a PDF.'])
  const parsed = parseClassicPdf(text, pdfCopy)
  const objects = [...parsed.objects.values()]
  const byKey = parsed.objects
  const rootValue = pdfValueForKey(tokenizePdfDictionary(parsed.trailer), 'Root')
  const rootKey = rootValue?.kind === 'ref' ? rootValue.value : undefined
  const rootCatalog = rootKey ? byKey.get(rootKey)?.dictionary : undefined
  if (!rootCatalog) throw new EInvoiceValidationError(['PDF trailer does not identify an authoritative catalog root.'])
  const reachable = new Set<string>(); const queued = new Set<string>(); const queue: string[] = []
  const enqueue = (key: string) => { if (reachable.has(key) || queued.has(key)) return; if (queued.size >= 100_000) throw new EInvoiceValidationError(['PDF indirect-reference traversal limit exceeded.']); queued.add(key); queue.push(key) }
  const rootTokens = tokenizePdfDictionary(rootCatalog)
  if (pdfNameForKey(rootTokens, 'Type') !== 'Catalog') throw new EInvoiceValidationError(['PDF trailer does not identify an authoritative catalog root.'])
  for (const ref of [...pdfRefsForKey(rootTokens, 'AF'), ...pdfRefsForKey(rootTokens, 'Names'), ...pdfRefsForKey(rootTokens, 'EmbeddedFiles'), ...[pdfNestedRef(rootTokens, 'Names', 'EmbeddedFiles')].filter((item): item is string => Boolean(item))]) enqueue(ref)
  for (let index = 0; index < queue.length; index++) { const key = queue[index]; reachable.add(key); const object = byKey.get(key); if (object?.dictionary) { const tokens = tokenizePdfDictionary(object.dictionary); for (const ref of [...pdfRefsForKey(tokens, 'Kids'), ...pdfRefsForKey(tokens, 'Names'), ...pdfRefsForKey(tokens, 'EmbeddedFiles')]) enqueue(ref) } else if (object?.rawValue?.trim().startsWith('[')) { for (const ref of pdfRefsForKey(tokenizePdfDictionary(`<< /Items ${object.rawValue} >>`), 'Items')) enqueue(ref) } }
  const fileSpecs = objects.filter(object => { if (!reachable.has(object.key) || !object.dictionary) return false; const tokens = tokenizePdfDictionary(object.dictionary); const unicodeName = pdfStringForKey(tokens, 'UF'); const fallbackName = pdfStringForKey(tokens, 'F'); const fileName = unicodeName && /\.xml$/i.test(unicodeName) ? unicodeName : fallbackName; return pdfNameForKey(tokens, 'Type') === 'Filespec' && Boolean(fileName && /\.xml$/i.test(fileName)) && ['Data', 'Alternative'].includes(pdfNameForKey(tokens, 'AFRelationship') ?? '') && Boolean(pdfNestedRef(tokens, 'EF', 'F')) })
  if (fileSpecs.length !== 1) throw new EInvoiceValidationError([fileSpecs.length ? 'PDF has ambiguous XML associated-file specifications.' : 'PDF has no XML associated-file specification.'])
  const fileReference = pdfNestedRef(tokenizePdfDictionary(fileSpecs[0].dictionary!), 'EF', 'F')
  if (!fileReference) throw new EInvoiceValidationError(['PDF has no XML associated-file specification.'])
  const embedded = byKey.get(fileReference)
  const embeddedTokens = embedded?.dictionary ? tokenizePdfDictionary(embedded.dictionary) : []
  if (!embedded?.dictionary || embedded.dictionaryEnd === undefined || pdfNameForKey(embeddedTokens, 'Type') !== 'EmbeddedFile' || !['application/xml', 'text/xml'].includes(pdfNameForKey(embeddedTokens, 'Subtype')?.toLowerCase() ?? '')) throw new EInvoiceValidationError(['Associated XML is not an uncompressed application/xml or text/xml embedded-file stream.'])
  const embeddedDictionary = parsePdfDictionaryTokens(embeddedTokens)
  if (embeddedDictionary.has('Filter') || embeddedDictionary.has('DecodeParms')) throw new EInvoiceValidationError(['Associated XML embedded-file streams must not declare Filter or DecodeParms.'])
  const lengthReference = pdfRefsForKey(embeddedTokens, 'Length')[0]
  const length = pdfNumberForKey(embeddedTokens, 'Length') ?? (lengthReference ? Number(byKey.get(lengthReference)?.rawValue) : Number.NaN); if (!Number.isSafeInteger(length) || length <= 0 || length > MAX_XML_SIZE) throw new EInvoiceValidationError(['Embedded XML stream length is invalid or exceeds 10 MiB.'])
  const streamMarker = /^\s*stream(?:\r\n|\r|\n)/.exec(text.slice(embedded.dictionaryEnd, embedded.end))
  if (!streamMarker) throw new EInvoiceValidationError(['Associated XML is not an uncompressed application/xml embedded-file stream.'])
  const start = embedded.dictionaryEnd + streamMarker[0].length; const xmlBytes = pdfCopy.slice(start, start + length)
  if (start + length > embedded.end || !/^(?:\r\n|\r|\n)endstream\s+endobj\s*$/.test(text.slice(start + length, embedded.end))) throw new EInvoiceValidationError(['Embedded XML stream length does not match the PDF object.'])
  const embeddedXmlSha256 = createHash('sha256').update(xmlBytes).digest('hex')
  const extraction = Object.freeze({ get pdfBytes() { return Uint8Array.from(pdfCopy) }, mediaType: 'application/pdf' as const, embeddedXmlSha256, [TRUSTED_PDF_EXTRACTION]: true as const })
  trustedPdfExtractions.add(extraction)
  return { xmlBytes, extraction }
}

export class EInvoiceValidationError extends Error {
  constructor(readonly issues: readonly string[]) { super(issues.join(' ')); this.name = 'EInvoiceValidationError' }
}

interface ParsedPdfObject { key: string; dictionary?: string; rawValue?: string; offset: number; dictionaryEnd?: number; end: number }
interface PdfToken { kind: 'name' | 'number' | 'word' | 'string' | 'array-open' | 'array-close' | 'dict-open' | 'dict-close'; value?: string }
type PdfValue = { kind: 'name' | 'string' | 'number' | 'word'; value: string } | { kind: 'ref'; value: string } | { kind: 'array'; value: PdfValue[] } | { kind: 'dict'; value: Map<string, PdfValue> }
const MAX_PDF_DICTIONARY_SIZE = 1024 * 1024
const MAX_PDF_DICTIONARY_TOKENS = 100_000
const MAX_DECODED_PDF_STREAM_SIZE = 20 * 1024 * 1024
function decodePdfTextBytes(bytes: readonly number[]): string {
  if (bytes.length >= 2 && (bytes[0] === 0xfe && bytes[1] === 0xff || bytes[0] === 0xff && bytes[1] === 0xfe)) {
    if (bytes.length % 2) throw new EInvoiceValidationError(['PDF Unicode text string has an invalid byte length.'])
    const littleEndian = bytes[0] === 0xff
    let result = ''
    for (let index = 2; index < bytes.length; index += 2) result += String.fromCharCode(littleEndian ? bytes[index] | bytes[index + 1] << 8 : bytes[index] << 8 | bytes[index + 1])
    return result
  }
  return bytes.map(byte => String.fromCharCode(byte)).join('')
}
function tokenizePdfDictionary(value: string): PdfToken[] {
  if (value.length > MAX_PDF_DICTIONARY_SIZE) throw new EInvoiceValidationError(['PDF dictionary exceeds the 1 MiB structural limit.'])
  const tokens: PdfToken[] = []
  const append = (item: PdfToken) => { if (tokens.length >= MAX_PDF_DICTIONARY_TOKENS) throw new EInvoiceValidationError(['PDF dictionary token limit exceeded.']); tokens.push(item) }
  for (let index = 0; index < value.length;) {
    const char = value[index]
    if (/\s/.test(char)) { index++; continue }
    if (char === '%') { while (index < value.length && !/[\r\n]/.test(value[index])) index++; continue }
    if (value.startsWith('<<', index) || value.startsWith('>>', index)) { append({ kind: value[index] === '<' ? 'dict-open' : 'dict-close' }); index += 2; continue }
    if (char === '<') { const end = value.indexOf('>', index + 1); if (end < 0 || end - index > 1024 * 1024) throw new EInvoiceValidationError(['Unterminated or oversized PDF hexadecimal string.']); let hex = value.slice(index + 1, end).replace(/\s/g, ''); if (!/^[0-9a-f]*$/i.test(hex)) throw new EInvoiceValidationError(['Invalid PDF hexadecimal string.']); if (hex.length % 2) hex += '0'; const bytes = Array.from({ length: hex.length / 2 }, (_, offset) => Number.parseInt(hex.slice(offset * 2, offset * 2 + 2), 16)); append({ kind: 'string', value: decodePdfTextBytes(bytes) }); index = end + 1; continue }
    if (char === '[' || char === ']') { append({ kind: char === '[' ? 'array-open' : 'array-close' }); index++; continue }
    if (char === '/') { let end = index + 1; while (end < value.length && !/[\s()[\]<>/%]/.test(value[end])) end++; const raw = value.slice(index + 1, end); append({ kind: 'name', value: raw.replace(/#([0-9a-f]{2})/gi, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16))) }); index = end; continue }
    if (char === '(') { let depth = 1; let escaped = false; let result = ''; index++; while (index < value.length && depth) { const current = value[index++]; if (escaped) { result += current; escaped = false } else if (current === '\\') escaped = true; else if (current === '(') { depth++; result += current } else if (current === ')') { depth--; if (depth) result += current } else result += current } if (depth) throw new EInvoiceValidationError(['Unterminated PDF literal string.']); append({ kind: 'string', value: result }); continue }
    let end = index; while (end < value.length && !/[\s()[\]<>/%]/.test(value[end])) end++; if (end === index) throw new EInvoiceValidationError(['Unsupported PDF dictionary token.']); const word = value.slice(index, end); append({ kind: /^\d+$/.test(word) ? 'number' : 'word', value: word }); index = end
  }
  return tokens
}
function parsePdfDictionaryTokens(tokens: readonly PdfToken[]): Map<string, PdfValue> {
  if (tokens[0]?.kind !== 'dict-open') return parsePdfDictionaryTokens([{ kind: 'dict-open' }, ...tokens, { kind: 'dict-close' }])
  let cursor = 0
  const parseValue = (depth: number): PdfValue => {
    if (depth > 32) throw new EInvoiceValidationError(['PDF dictionary nesting limit exceeded.'])
    const token = tokens[cursor]
    if (!token) throw new EInvoiceValidationError(['PDF dictionary value is missing.'])
    if (token.kind === 'dict-open') return { kind: 'dict', value: parseDictionary(depth + 1) }
    if (token.kind === 'array-open') { cursor++; const values: PdfValue[] = []; while (tokens[cursor]?.kind !== 'array-close') { if (!tokens[cursor]) throw new EInvoiceValidationError(['Unterminated PDF array.']); values.push(parseValue(depth + 1)) } cursor++; return { kind: 'array', value: values } }
    if (token.kind === 'number' && tokens[cursor + 1]?.kind === 'number' && tokens[cursor + 2]?.kind === 'word' && tokens[cursor + 2].value === 'R') { cursor += 3; return { kind: 'ref', value: `${token.value} ${Number(tokens[cursor - 2].value)}` } }
    if (['name', 'string', 'number', 'word'].includes(token.kind)) { cursor++; return { kind: token.kind as 'name' | 'string' | 'number' | 'word', value: token.value ?? '' } }
    throw new EInvoiceValidationError(['Unsupported PDF dictionary value.'])
  }
  const parseDictionary = (depth: number): Map<string, PdfValue> => {
    if (depth > 32) throw new EInvoiceValidationError(['PDF dictionary nesting limit exceeded.'])
    if (tokens[cursor]?.kind !== 'dict-open') throw new EInvoiceValidationError(['Expected a PDF dictionary.'])
    cursor++; const result = new Map<string, PdfValue>()
    while (tokens[cursor]?.kind !== 'dict-close') {
      const key = tokens[cursor]
      if (!key) throw new EInvoiceValidationError(['Unterminated PDF dictionary.'])
      if (key.kind !== 'name' || !key.value) throw new EInvoiceValidationError(['PDF dictionary keys must be names.'])
      if (result.has(key.value)) throw new EInvoiceValidationError([`Duplicate critical PDF dictionary key /${key.value}.`])
      cursor++; result.set(key.value, parseValue(depth))
    }
    cursor++; return result
  }
  const dictionary = parseDictionary(0)
  if (cursor !== tokens.length) throw new EInvoiceValidationError(['Unexpected tokens after PDF dictionary.'])
  return dictionary
}
function pdfValueForKey(tokens: readonly PdfToken[], key: string) { return parsePdfDictionaryTokens(tokens).get(key) }
function pdfNameForKey(tokens: readonly PdfToken[], key: string) { const value = pdfValueForKey(tokens, key); return value?.kind === 'name' ? value.value : undefined }
function pdfStringForKey(tokens: readonly PdfToken[], key: string) { const value = pdfValueForKey(tokens, key); return value?.kind === 'string' ? value.value : undefined }
function pdfNumberForKey(tokens: readonly PdfToken[], key: string) { const value = pdfValueForKey(tokens, key); return value?.kind === 'number' ? Number(value.value) : undefined }
function pdfRefsForKey(tokens: readonly PdfToken[], key: string) { const value = pdfValueForKey(tokens, key); if (value?.kind === 'ref') return [value.value]; if (value?.kind === 'array') return value.value.filter((item): item is Extract<PdfValue, { kind: 'ref' }> => item.kind === 'ref').map(item => item.value); return [] }
function pdfNestedRef(tokens: readonly PdfToken[], outerKey: string, innerKey: string) { const outer = pdfValueForKey(tokens, outerKey); const inner = outer?.kind === 'dict' ? outer.value.get(innerKey) : undefined; return inner?.kind === 'ref' ? inner.value : undefined }
type PdfXrefEntry = { kind: 'free' } | { kind: 'uncompressed'; key: string; offset: number } | { kind: 'compressed'; key: string; streamNumber: number; index: number }
interface PdfXrefSection { entries: Map<number, PdfXrefEntry>; trailer: string; end: number; rowCount: number }
const MAX_PDF_XREF_ENTRIES = 50_000
const MAX_PDF_XREF_REVISIONS = 128
function parseClassicPdf(text: string, bytes: Uint8Array): { objects: Map<string, ParsedPdfObject>; trailer: string } {
  const eof = /startxref\s*(?:\r\n|\r|\n)(\d+)\s*(?:\r\n|\r|\n)%%EOF\s*$/.exec(text)
  if (!eof) throw new EInvoiceValidationError(['PDF must end with one valid startxref and %%EOF boundary.'])
  const latestXrefOffset = Number(eof[1])
  if (!Number.isSafeInteger(latestXrefOffset) || latestXrefOffset <= 0 || latestXrefOffset >= eof.index) throw new EInvoiceValidationError(['PDF startxref does not resolve to a bounded cross-reference section.'])
  const active = new Map<number, PdfXrefEntry>(); const allObjectOffsets = new Set<number>(); const xrefOffsets = new Set<number>(); const visited = new Set<number>()
  let selectedTrailer: string | undefined; let latestTrailer = ''; let xrefOffset = latestXrefOffset; let upperBound = eof.index; let totalRows = 0
  for (let revision = 0; ; revision++) {
    if (revision >= MAX_PDF_XREF_REVISIONS || visited.has(xrefOffset)) throw new EInvoiceValidationError(['PDF cross-reference revision limit or cycle detected.'])
    if (!Number.isSafeInteger(xrefOffset) || xrefOffset <= 0 || xrefOffset >= upperBound) throw new EInvoiceValidationError(['PDF Prev does not resolve to an older bounded cross-reference section.'])
    visited.add(xrefOffset); xrefOffsets.add(xrefOffset)
    const section = text.startsWith('xref', xrefOffset) ? parseClassicXrefSection(text, xrefOffset) : parseXrefStreamSection(text, bytes, xrefOffset, upperBound)
    xrefOffsets.add(section.end)
    if (revision === 0 && text.slice(section.end, eof.index).trim()) throw new EInvoiceValidationError(['Unexpected content between PDF cross-reference section and startxref.'])
    if (revision === 0) latestTrailer = section.trailer
    const trailerTokens = tokenizePdfDictionary(section.trailer); const trailerDictionary = parsePdfDictionaryTokens(trailerTokens)
    if (!selectedTrailer && trailerDictionary.has('Root')) selectedTrailer = section.trailer
    totalRows += section.rowCount
    if (totalRows > MAX_PDF_XREF_ENTRIES) throw new EInvoiceValidationError(['PDF xref object limit exceeded.'])
    for (const [objectNumber, entry] of section.entries) {
      if (entry.kind === 'uncompressed') allObjectOffsets.add(entry.offset)
      if (!active.has(objectNumber)) active.set(objectNumber, entry)
    }
    const previous = pdfNumberForKey(trailerTokens, 'Prev')
    if (previous === undefined) break
    if (!Number.isSafeInteger(previous) || previous <= 0 || previous >= xrefOffset) throw new EInvoiceValidationError(['PDF Prev does not resolve to an older bounded cross-reference section.'])
    upperBound = xrefOffset; xrefOffset = previous
  }
  const entries = new Map<string, number>(); const compressed = new Map<string, { streamNumber: number; index: number }>()
  for (const entry of active.values()) if (entry.kind === 'uncompressed') entries.set(entry.key, entry.offset); else if (entry.kind === 'compressed') compressed.set(entry.key, { streamNumber: entry.streamNumber, index: entry.index })
  const objects = parseUncompressedPdfObjects(text, entries, latestXrefOffset, new Set([...allObjectOffsets, ...xrefOffsets]))
  restoreCompressedPdfObjects(text, bytes, objects, compressed)
  return { objects, trailer: selectedTrailer ?? latestTrailer }
}
function parseClassicXrefSection(text: string, xrefOffset: number): PdfXrefSection {
  const readLine = (position: number) => { const eol = /\r\n|\r|\n/.exec(text.slice(position)); if (!eol) throw new EInvoiceValidationError(['Truncated PDF xref table.']); const end = position + eol.index; return { line: text.slice(position, end), next: end + eol[0].length } }
  let cursor = xrefOffset; let line = readLine(cursor); if (line.line !== 'xref') throw new EInvoiceValidationError(['Invalid PDF xref table.']); cursor = line.next
  const entries = new Map<number, PdfXrefEntry>(); let rowCount = 0
  while (true) {
    line = readLine(cursor); cursor = line.next
    if (line.line === 'trailer') break
    const subsection = /^(\d+)\s+(\d+)$/.exec(line.line)
    if (!subsection) throw new EInvoiceValidationError(['Invalid PDF xref subsection.'])
    const first = Number(subsection[1]); const count = Number(subsection[2])
    if (!Number.isSafeInteger(first) || !Number.isSafeInteger(count) || count < 0 || rowCount + count > MAX_PDF_XREF_ENTRIES) throw new EInvoiceValidationError(['PDF xref object limit exceeded.'])
    for (let index = 0; index < count; index++) {
      const entry = readLine(cursor); cursor = entry.next
      const parsed = /^(\d{10})\s+(\d{5})\s+([nf])(?:\s.*)?$/.exec(entry.line)
      if (!parsed) throw new EInvoiceValidationError(['Invalid PDF xref entry.'])
      const objectNumber = first + index; const generation = Number(parsed[2]); const offset = Number(parsed[1])
      if (!Number.isSafeInteger(objectNumber) || entries.has(objectNumber)) throw new EInvoiceValidationError(['PDF xref contains duplicate object entries.'])
      if (parsed[3] === 'n') { if (!Number.isSafeInteger(offset) || offset <= 0 || offset >= xrefOffset) throw new EInvoiceValidationError(['PDF xref contains invalid active objects.']); entries.set(objectNumber, { kind: 'uncompressed', key: `${objectNumber} ${generation}`, offset }) }
      else entries.set(objectNumber, { kind: 'free' })
    }
    rowCount += count
  }
  while (/\s/.test(text[cursor] ?? '')) cursor++
  const trailer = parsePdfDictionary(text, cursor)
  return { entries, trailer: trailer.content, end: trailer.end, rowCount }
}
function parseUncompressedPdfObjects(text: string, entries: ReadonlyMap<string, number>, terminalOffset: number, structuralOffsets: ReadonlySet<number>): Map<string, ParsedPdfObject> {
  const ordered = [...entries].filter(([, offset]) => offset !== terminalOffset).sort((a, b) => a[1] - b[1])
  if (new Set(ordered.map(([, offset]) => offset)).size !== ordered.length) throw new EInvoiceValidationError(['PDF xref reuses an active object offset.'])
  const boundaries = [...new Set([...ordered.map(([, offset]) => offset), ...structuralOffsets, terminalOffset])].sort((a, b) => a - b)
  const boundaryIndexes = new Map(boundaries.map((offset, index) => [offset, index]))
  const objects = new Map<string, ParsedPdfObject>()
  for (let index = 0; index < ordered.length; index++) {
    const [key, offset] = ordered[index]; const boundaryIndex = boundaryIndexes.get(offset); const end = boundaryIndex === undefined ? terminalOffset : boundaries[boundaryIndex + 1] ?? terminalOffset
    if (!Number.isSafeInteger(offset) || offset <= 0 || offset >= terminalOffset || end <= offset) throw new EInvoiceValidationError([`PDF xref object ${key} has invalid boundaries.`])
    const segment = text.slice(offset, end); const header = /^(\d+)[ \t\r\n]+(\d+)[ \t\r\n]+obj\b/.exec(segment)
    if (!header || `${header[1]} ${Number(header[2])}` !== key || !/endobj[ \t\r\n]*$/.test(segment)) throw new EInvoiceValidationError([`PDF xref object ${key} has invalid boundaries.`])
    let bodyStart = offset + header[0].length; while (/[\0\t\n\f\r ]/.test(text[bodyStart] ?? '')) bodyStart++
    const objectBodyEnd = offset + segment.lastIndexOf('endobj')
    if (text.startsWith('<<', bodyStart)) {
      const dictionary = parsePdfDictionary(text, bodyStart); const tail = text.slice(dictionary.end, objectBodyEnd)
      if (tail.trim() && !/^[ \t\r\n]*stream(?:\r\n|\r|\n)[\s\S]*(?:\r\n|\r|\n)endstream[ \t\r\n]*$/.test(tail)) throw new EInvoiceValidationError([`PDF dictionary object ${key} has invalid trailing content.`])
      objects.set(key, { key, dictionary: dictionary.content, offset, dictionaryEnd: dictionary.end, end })
    } else {
      const rawValue = text.slice(bodyStart, objectBodyEnd).trim()
      if (!rawValue || /\b(?:obj|stream|endstream)\b/.test(rawValue)) throw new EInvoiceValidationError([`PDF indirect object ${key} has an unsupported non-dictionary value.`])
      objects.set(key, { key, rawValue, offset, end })
    }
  }
  return objects
}
function parseXrefStreamSection(text: string, bytes: Uint8Array, xrefOffset: number, upperBound: number): PdfXrefSection {
  const xref = readDirectPdfStream(text, bytes, xrefOffset, upperBound)
  const tokens = tokenizePdfDictionary(xref.dictionary)
  if (pdfNameForKey(tokens, 'Type') !== 'XRef') throw new EInvoiceValidationError(['PDF startxref does not identify a bounded cross-reference stream.'])
  const widths = pdfIntegerArrayForKey(tokens, 'W'); const size = pdfNumberForKey(tokens, 'Size'); const index = pdfIntegerArrayForKey(tokens, 'Index') ?? (Number.isSafeInteger(size) ? [0, size!] : undefined)
  if (!widths || widths.length !== 3 || widths.some(width => width < 0 || width > 8) || widths.reduce((sum, width) => sum + width, 0) <= 0 || !index || index.length % 2 || index.some(value => value < 0) || index.some((value, position) => position % 2 === 1 && value > 50_000)) throw new EInvoiceValidationError(['PDF cross-reference stream has invalid W, Size or Index metadata.'])
  const rowWidth = widths.reduce((sum, width) => sum + width, 0); const rowCount = index.filter((_value, position) => position % 2 === 1).reduce((sum, count) => sum + count, 0)
  const decoded = decodePdfStream(xref.data, tokens, rowWidth)
  if (decoded.length !== rowWidth * rowCount || rowCount > MAX_PDF_XREF_ENTRIES) throw new EInvoiceValidationError(['PDF cross-reference stream length or object limit is invalid.'])
  const entries = new Map<number, PdfXrefEntry>(); let cursor = 0
  for (let pair = 0; pair < index.length; pair += 2) for (let item = 0; item < index[pair + 1]; item++) {
    const objectNumber = index[pair] + item; const type = widths[0] === 0 ? 1 : readBigEndianInteger(decoded, cursor, widths[0]); cursor += widths[0]; const field2 = readBigEndianInteger(decoded, cursor, widths[1]); cursor += widths[1]; const field3 = readBigEndianInteger(decoded, cursor, widths[2]); cursor += widths[2]
    if (!Number.isSafeInteger(objectNumber) || entries.has(objectNumber)) throw new EInvoiceValidationError(['PDF cross-reference stream contains duplicate object entries.'])
    if (type === 1) { if (field2 <= 0 || field2 > xrefOffset) throw new EInvoiceValidationError(['PDF cross-reference stream contains invalid active objects.']); entries.set(objectNumber, { kind: 'uncompressed', key: `${objectNumber} ${field3}`, offset: field2 }) }
    else if (type === 2) { if (field2 <= 0 || field3 < 0) throw new EInvoiceValidationError(['PDF cross-reference stream contains invalid compressed objects.']); entries.set(objectNumber, { kind: 'compressed', key: `${objectNumber} 0`, streamNumber: field2, index: field3 }) }
    else if (type === 0) entries.set(objectNumber, { kind: 'free' })
    else throw new EInvoiceValidationError(['PDF cross-reference stream contains an unsupported entry type.'])
  }
  return { entries, trailer: xref.dictionary, end: xref.end, rowCount }
}
function readDirectPdfStream(text: string, bytes: Uint8Array, offset: number, end: number) {
  const segment = text.slice(offset, end); const header = /^(\d+)[ \t\r\n]+(\d+)[ \t\r\n]+obj\b/.exec(segment)
  if (!header) throw new EInvoiceValidationError(['PDF cross-reference stream object header is invalid.'])
  let dictionaryStart = offset + header[0].length; while (/[\0\t\n\f\r ]/.test(text[dictionaryStart] ?? '')) dictionaryStart++
  const dictionary = parsePdfDictionary(text, dictionaryStart); const tokens = tokenizePdfDictionary(dictionary.content); const length = pdfNumberForKey(tokens, 'Length'); const marker = /^[ \t\r\n]*stream(?:\r\n|\r|\n)/.exec(text.slice(dictionary.end, end))
  if (!Number.isSafeInteger(length) || length! <= 0 || length! > 20 * 1024 * 1024 || !marker) throw new EInvoiceValidationError(['PDF stream requires a bounded direct Length.'])
  const start = dictionary.end + marker[0].length; const after = start + length!; const ending = /^(?:\r\n|\r|\n)endstream[ \t\r\n]+endobj\b/.exec(text.slice(after, end))
  if (after > end || !ending) throw new EInvoiceValidationError(['PDF stream length does not match its object boundary.'])
  return { dictionary: dictionary.content, data: bytes.slice(start, after), end: after + ending[0].length }
}
function pdfIntegerArrayForKey(tokens: readonly PdfToken[], key: string): number[] | undefined { const value = pdfValueForKey(tokens, key); if (value?.kind !== 'array' || value.value.some(item => item.kind !== 'number')) return undefined; const numbers = value.value.map(item => Number((item as { kind: 'number'; value: string }).value)); return numbers.every(Number.isSafeInteger) ? numbers : undefined }
function decodePdfStream(data: Uint8Array, tokens: readonly PdfToken[], defaultColumns: number): Uint8Array {
  const filter = pdfValueForKey(tokens, 'Filter'); let decoded: Uint8Array
  if (!filter) decoded = data
  else if (filter.kind === 'name' && filter.value === 'FlateDecode') { try { decoded = unzlibSync(data, { out: new Uint8Array(MAX_DECODED_PDF_STREAM_SIZE + 1) }) } catch { throw new EInvoiceValidationError(['PDF Flate stream is invalid.']) } }
  else throw new EInvoiceValidationError(['PDF stream uses an unsupported filter.'])
  if (decoded.length > MAX_DECODED_PDF_STREAM_SIZE) throw new EInvoiceValidationError(['Decoded PDF stream exceeds the 20 MiB limit.'])
  const parms = pdfValueForKey(tokens, 'DecodeParms'); if (!parms) return decoded
  if (parms.kind !== 'dict') throw new EInvoiceValidationError(['PDF stream DecodeParms must be a dictionary.'])
  const number = (key: string, fallback: number) => { const value = parms.value.get(key); return value?.kind === 'number' ? Number(value.value) : fallback }
  const predictor = number('Predictor', 1); const columns = number('Columns', defaultColumns); const colors = number('Colors', 1); const bits = number('BitsPerComponent', 8)
  if (predictor === 1) return decoded
  if (predictor < 10 || predictor > 15 || !Number.isSafeInteger(columns) || columns <= 0 || colors !== 1 || bits !== 8) throw new EInvoiceValidationError(['PDF stream uses unsupported predictor parameters.'])
  const rowSize = columns; if (decoded.length % (rowSize + 1)) throw new EInvoiceValidationError(['PDF predictor row length is invalid.'])
  const output = new Uint8Array(decoded.length / (rowSize + 1) * rowSize); let inputOffset = 0; let outputOffset = 0
  while (inputOffset < decoded.length) { const algorithm = decoded[inputOffset++]; if (algorithm > 4) throw new EInvoiceValidationError(['PDF predictor algorithm is invalid.']); for (let column = 0; column < rowSize; column++) { const raw = decoded[inputOffset++]; const left = column ? output[outputOffset + column - 1] : 0; const up = outputOffset >= rowSize ? output[outputOffset - rowSize + column] : 0; const upLeft = column && outputOffset >= rowSize ? output[outputOffset - rowSize + column - 1] : 0; output[outputOffset + column] = algorithm === 0 ? raw : algorithm === 1 ? raw + left : algorithm === 2 ? raw + up : algorithm === 3 ? raw + Math.floor((left + up) / 2) : raw + paeth(left, up, upLeft) } outputOffset += rowSize }
  return output
}
function paeth(left: number, up: number, upLeft: number) { const estimate = left + up - upLeft; const leftDistance = Math.abs(estimate - left); const upDistance = Math.abs(estimate - up); const diagonalDistance = Math.abs(estimate - upLeft); return leftDistance <= upDistance && leftDistance <= diagonalDistance ? left : upDistance <= diagonalDistance ? up : upLeft }
function readBigEndianInteger(bytes: Uint8Array, offset: number, width: number) { let value = 0; for (let index = 0; index < width; index++) { value = value * 256 + bytes[offset + index]; if (!Number.isSafeInteger(value)) throw new EInvoiceValidationError(['PDF cross-reference integer exceeds the safe bound.']) } return value }
function restoreCompressedPdfObjects(text: string, bytes: Uint8Array, objects: Map<string, ParsedPdfObject>, compressed: ReadonlyMap<string, { streamNumber: number; index: number }>) {
  const streams = new Map<number, { numbers: number[]; offsets: number[]; content: string; outer: ParsedPdfObject }>()
  for (const descriptor of compressed.values()) if (!streams.has(descriptor.streamNumber)) {
    const outer = objects.get(`${descriptor.streamNumber} 0`); if (!outer?.dictionary || outer.dictionaryEnd === undefined) throw new EInvoiceValidationError(['PDF compressed object references a missing object stream.'])
    const tokens = tokenizePdfDictionary(outer.dictionary); if (pdfNameForKey(tokens, 'Type') !== 'ObjStm') throw new EInvoiceValidationError(['PDF compressed object container is not an object stream.'])
    const count = pdfNumberForKey(tokens, 'N'); const first = pdfNumberForKey(tokens, 'First'); if (!Number.isSafeInteger(count) || count! <= 0 || count! > 50_000 || !Number.isSafeInteger(first) || first! <= 0) throw new EInvoiceValidationError(['PDF object stream metadata is invalid.'])
    const direct = readDirectPdfStream(text, bytes, outer.offset, outer.end); const decoded = decodePdfStream(direct.data, tokens, 1); if (first! >= decoded.length) throw new EInvoiceValidationError(['PDF object stream First offset is invalid.'])
    const content = new TextDecoder('latin1').decode(decoded); const header = content.slice(0, first!).trim().split(/[ \t\r\n]+/).map(Number); if (header.length !== count! * 2 || header.some(value => !Number.isSafeInteger(value) || value < 0)) throw new EInvoiceValidationError(['PDF object stream header is invalid.'])
    streams.set(descriptor.streamNumber, { numbers: header.filter((_value, index) => index % 2 === 0), offsets: header.filter((_value, index) => index % 2 === 1), content: content.slice(first!), outer })
  }
  for (const [key, descriptor] of compressed) {
    const stream = streams.get(descriptor.streamNumber)!; if (descriptor.index >= stream.numbers.length || `${stream.numbers[descriptor.index]} 0` !== key) throw new EInvoiceValidationError(['PDF compressed-object index does not match its object stream.'])
    const start = stream.offsets[descriptor.index]; const end = stream.offsets[descriptor.index + 1] ?? stream.content.length; if (start < 0 || end <= start || end > stream.content.length) throw new EInvoiceValidationError(['PDF compressed-object boundary is invalid.'])
    const body = stream.content.slice(start, end).trim(); if (body.startsWith('<<')) { const dictionary = parsePdfDictionary(body, 0); if (body.slice(dictionary.end).trim()) throw new EInvoiceValidationError(['PDF compressed dictionary has invalid trailing content.']); objects.set(key, { key, dictionary: dictionary.content, offset: stream.outer.offset, end: stream.outer.end }) } else { if (!body || /\b(?:obj|stream|endstream)\b/.test(body)) throw new EInvoiceValidationError(['PDF compressed object value is invalid.']); objects.set(key, { key, rawValue: body, offset: stream.outer.offset, end: stream.outer.end }) }
  }
}
function parsePdfDictionary(text: string, start: number): { content: string; end: number } {
  if (!text.startsWith('<<', start)) throw new EInvoiceValidationError(['Expected a bounded PDF dictionary.'])
  let depth = 0; let stringDepth = 0; let escaped = false
  for (let index = start; index < text.length - 1; index++) {
    const char = text[index]
    if (stringDepth) { if (escaped) escaped = false; else if (char === '\\') escaped = true; else if (char === '(') stringDepth++; else if (char === ')') stringDepth--; continue }
    if (char === '(') { stringDepth = 1; continue }
    if (text.startsWith('<<', index)) { depth++; index++; continue }
    if (text.startsWith('>>', index)) { depth--; index++; if (depth === 0) return { content: text.slice(start + 2, index - 1), end: index + 1 }; if (depth < 0) break }
  }
  throw new EInvoiceValidationError(['Unterminated PDF dictionary.'])
}

const MAX_XML_SIZE = 10 * 1024 * 1024
const isoDate = /^\d{4}-\d{2}-\d{2}$/
const isoCurrencies = new Set('AED AFN ALL AMD ANG AOA ARS AUD AWG AZN BAM BBD BDT BGN BHD BIF BMD BND BOB BOV BRL BSD BTN BWP BYN BZD CAD CDF CHE CHF CHW CLF CLP CNY COP COU CRC CUP CVE CZK DJF DKK DOP DZD EGP ERN ETB EUR FJD FKP GBP GEL GHS GIP GMD GNF GTQ GYD HKD HNL HRK HTG HUF IDR ILS INR IQD IRR ISK JMD JOD JPY KES KGS KHR KMF KPW KRW KWD KYD KZT LAK LBP LKR LRD LSL LYD MAD MDL MGA MKD MMK MNT MOP MRU MUR MVR MWK MXN MXV MYR MZN NAD NGN NIO NOK NPR NZD OMR PAB PEN PGK PHP PKR PLN PYG QAR RON RSD RUB RWF SAR SBD SCR SDG SEK SGD SHP SLE SOS SRD SSP STN SVC SYP SZL THB TJS TMT TND TOP TRY TTD TWD TZS UAH UGX USD USN UYI UYU UYW UZS VED VES VND VUV WST XAF XAG XAU XBA XBB XBC XBD XCD XCG XDR XOF XPD XPF XPT XSU XTS XUA XXX YER ZAR ZMW ZWG'.split(' '))
const isoCountries = new Set('AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW'.split(' '))
const vatIdPatterns: Readonly<Record<string, RegExp>> = { AT: /^ATU\d{8}$/, BE: /^BE0?\d{9}$/, BG: /^BG\d{9,10}$/, CY: /^CY\d{8}[A-Z]$/, CZ: /^CZ\d{8,10}$/, DE: /^DE\d{9}$/, DK: /^DK\d{8}$/, EE: /^EE\d{9}$/, GR: /^EL\d{9}$/, ES: /^ES[A-Z0-9]\d{7}[A-Z0-9]$/, FI: /^FI\d{8}$/, FR: /^FR[A-Z0-9]{2}\d{9}$/, GB: /^(?:GB|XI)(?:\d{9}|\d{12}|GD\d{3}|HA\d{3})$/, HR: /^HR\d{11}$/, HU: /^HU\d{8}$/, IE: /^IE[A-Z0-9]{8,9}$/, IT: /^IT\d{11}$/, LT: /^LT(?:\d{9}|\d{12})$/, LU: /^LU\d{8}$/, LV: /^LV\d{11}$/, MT: /^MT\d{8}$/, NL: /^NL[A-Z0-9]{9}B\d{2}$/, PL: /^PL\d{10}$/, PT: /^PT\d{9}$/, RO: /^RO\d{2,10}$/, SE: /^SE\d{12}$/, SI: /^SI\d{8}$/, SK: /^SK\d{10}$/ }
const money = (value: string | undefined) => { const match = value?.trim().match(/^(-?)(\d+)(?:\.(\d{1,2}))?$/); if (!match) return Number.NaN; const cents = BigInt(match[2]) * BigInt(100) + BigInt((match[3] ?? '').padEnd(2, '0') || '0'); const signed = match[1] ? -cents : cents; const result = Number(signed); return Number.isSafeInteger(result) ? result : Number.NaN }
const num = (value: string | undefined) => { const normalized = value?.trim(); return normalized && /^-?\d+(?:\.\d+)?$/.test(normalized) && Number.isFinite(Number(normalized)) ? Number(normalized) : Number.NaN }
const basisPoints = (value: string | undefined) => { const match = value?.trim().match(/^(\d+)(?:\.(\d{1,2}))?$/); if (!match) return Number.NaN; const result = Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0')); return Number.isSafeInteger(result) ? result : Number.NaN }

export function preserveOriginal(bytes: Uint8Array, mediaType: string): BinaryOriginal {
  const copy = Uint8Array.from(bytes)
  const sha256 = createHash('sha256').update(copy).digest('hex')
  return Object.freeze({ get bytes() { return Uint8Array.from(copy) }, mediaType, sha256 })
}

/** Parses only text content and never resolves DTDs, entities, stylesheets or external resources. */
export function receiveStructuredInvoice(xmlBytes: Uint8Array, visual?: TrustedPdfExtraction): ValidatedEInvoice {
  if (xmlBytes.byteLength > MAX_XML_SIZE) throw new EInvoiceValidationError(['Structured invoice exceeds 10 MiB.'])
  const xml = new TextDecoder('utf-8', { fatal: true }).decode(xmlBytes)
  if (/<!DOCTYPE|<!ENTITY|<\?xml-stylesheet/i.test(xml)) throw new EInvoiceValidationError(['Active or external XML constructs are forbidden.'])
  const xmlSha256 = createHash('sha256').update(xmlBytes).digest('hex')
  if (visual && (!trustedPdfExtractions.has(visual) || visual.embeddedXmlSha256 !== xmlSha256)) throw new EInvoiceValidationError(['ZUGFeRD PDF extraction metadata does not match the exact trusted extraction instance.'])
  const root = parseSafeXml(xml)
  const syntax = detectRootSyntax(root, Boolean(visual))
  const data = syntax === 'UBL' ? parseUbl(root) : parseCii(root, syntax)
  const issues = validateInvoice(data)
  if (issues.length) throw new EInvoiceValidationError(issues)
  const provenance = Object.fromEntries(Object.keys(data).map(key => [key, `structured-original:${key}`])) as Record<keyof StructuredInvoiceData, string>
  return Object.freeze({
    structuredOriginal: preserveOriginal(xmlBytes, 'application/xml'),
    visualOriginal: visual ? preserveOriginal(visual.pdfBytes, visual.mediaType) : undefined,
    data: deepFreeze(data), provenance: Object.freeze(provenance), warnings: Object.freeze([]),
  })
}

export function validateInvoice(data: StructuredInvoiceData): string[] {
  const issues: string[] = []
  if (!['invoice', 'credit-note', 'correction', 'cancellation'].includes(data.kind)) issues.push('Invoice document kind must use a supported discriminant.')
  if (!data.invoiceNumber.trim()) issues.push('Invoice number is mandatory.')
  if (!isoCurrencies.has(data.currency)) issues.push('Invoice currency must be a supported three-letter uppercase ISO 4217 code.')
  if (!isRealDate(data.issueDate) || !isRealDate(data.supplyDate)) issues.push('Issue and supply dates must be real ISO dates.')
  if (![data.seller.name, data.seller.street, data.seller.city, data.seller.postalCode, data.seller.countryCode].every(value => value.trim())) issues.push('Complete seller address is mandatory.')
  if (![data.buyer.name, data.buyer.street, data.buyer.city, data.buyer.postalCode, data.buyer.countryCode].every(value => value.trim())) issues.push('Complete buyer address is mandatory.')
  if (!isoCountries.has(data.seller.countryCode) || !isoCountries.has(data.buyer.countryCode)) issues.push('Seller and buyer country codes must be canonical ISO 3166-1 alpha-2 codes.')
  if ([data.seller, data.buyer].some(party => party.vatId !== undefined && !isVatIdForCountry(party.vatId, party.countryCode))) issues.push('Party VAT IDs must match the country-specific canonical syntax.')
  if (![data.seller.taxId, data.seller.vatId].some(value => value?.trim())) issues.push('Seller tax number or VAT ID is mandatory.')
  const supportedCategories = new Set(['S', 'Z', 'E', 'AE', 'G', 'O', 'K', 'L', 'M', 'B'])
  if (!data.lines.length || data.lines.some(line => !line.description.trim() || !line.unitCode.trim() || !isValidQuantity(line.quantity) || !Number.isSafeInteger(line.netAmountCents) || line.netAmountCents < 0 || !Number.isInteger(line.taxRateBasisPoints) || line.taxRateBasisPoints < 0 || line.taxRateBasisPoints > 10_000 || (line.taxCategoryCode !== undefined && !supportedCategories.has(line.taxCategoryCode)))) issues.push('At least one complete invoice line with finite, bounded tax values and supported tax category is mandatory.')
  if (![data.netAmountCents, data.taxAmountCents, data.grossAmountCents].every(value => Number.isSafeInteger(value))) issues.push('Net, tax and gross amounts must be present finite safe-integer cents.')
  const grossCheck = data.netAmountCents + data.taxAmountCents
  if (!Number.isSafeInteger(grossCheck) || grossCheck !== data.grossAmountCents) issues.push('Net, tax and gross totals do not reconcile.')
  if (data.prepaidAmountCents !== undefined && (!Number.isSafeInteger(data.prepaidAmountCents) || data.prepaidAmountCents < 0)) issues.push('Prepaid amount must be nonnegative safe-integer cents.')
  if (data.payableRoundingAmountCents !== undefined && !Number.isSafeInteger(data.payableRoundingAmountCents)) issues.push('Payable rounding amount must be safe-integer cents.')
  if (data.payableAmountCents !== undefined && !Number.isSafeInteger(data.payableAmountCents)) issues.push('Payable amount must be safe-integer cents.')
  const expectedPayable = data.grossAmountCents - (data.prepaidAmountCents ?? 0) + (data.payableRoundingAmountCents ?? 0)
  if (!Number.isSafeInteger(expectedPayable) || (data.payableAmountCents ?? data.grossAmountCents) !== expectedPayable) issues.push('Payable amount does not reconcile to gross, prepayments and rounding.')
  const lineTotal = data.lines.reduce((sum, line) => sum + line.netAmountCents, 0)
  if (!Number.isSafeInteger(lineTotal) || lineTotal !== data.netAmountCents) issues.push('Line amounts do not reconcile to net total within safe integer cents.')
  const hasLegacyWholeInvoiceSpecialTax = Boolean(data.exemptionReason || data.reverseCharge)
  if (hasLegacyWholeInvoiceSpecialTax && data.lines.every(line => !line.exemptionReason && !line.reverseCharge) && data.taxAmountCents !== 0) issues.push('Exempt/reverse-charge invoices must not charge VAT.')
  if (data.reverseCharge && data.exemptionReason) issues.push('Reverse charge and tax exemption must not be asserted together.')
  if ((data.exemptionReason !== undefined && !data.exemptionReason.trim()) || data.lines.some(line => line.exemptionReason !== undefined && !line.exemptionReason.trim())) issues.push('VAT exemption reasons must be nonblank when provided.')
  if (data.reverseCharge && data.lines.some(line => !line.exemptionReason && !line.reverseCharge && line.taxRateBasisPoints !== 0)) issues.push('Reverse-charge invoice lines must use category AE with a zero rate.')
  if (data.exemptionReason && data.lines.some(line => !line.exemptionReason && !line.reverseCharge && line.taxRateBasisPoints !== 0)) issues.push('Tax-exempt invoice lines must use a zero rate.')
  for (const line of data.lines) { const category = effectiveTaxCategory(line, data); const reason = line.exemptionReason ?? data.exemptionReason; if (line.taxCategoryCode && line.taxCategoryCode !== category) issues.push(`Declared category ${line.taxCategoryCode} conflicts with the line's effective VAT treatment ${category}.`); if (reason?.trim() && !['E', 'AE', 'G', 'O', 'K'].includes(category)) issues.push(`Category ${category} must not carry a VAT exemption reason.`); if (category === 'E' && (line.taxRateBasisPoints !== 0 || !reason?.trim())) issues.push('Category E requires zero rate and a nonblank exemption reason.'); if (['G', 'K'].includes(category) && !reason?.trim()) issues.push(`Category ${category} requires a nonblank VAT exemption reason.`); if (category === 'AE' && (line.taxRateBasisPoints !== 0 || !(line.reverseCharge || data.reverseCharge) || !line.exemptionReason?.trim())) issues.push('Category AE requires zero rate, reverse-charge treatment and a nonblank reason.'); if (['Z', 'G', 'O', 'K'].includes(category) && line.taxRateBasisPoints !== 0) issues.push(`Category ${category} requires a zero rate.`); if (category === 'S' && line.taxRateBasisPoints === 0) issues.push('Category S requires a positive rate.'); if (!isRepresentableUnitPrice(line.netAmountCents, line.quantity)) issues.push('Line net amount cannot be represented consistently by quantity and unit price.') }
  const taxGroups = new Map<string, { category: string; rate: number; taxable: number }>()
  for (const line of data.lines) { const category = effectiveTaxCategory(line, data); const reason = taxReasonForCategory(category, line.exemptionReason ?? data.exemptionReason ?? (line.reverseCharge || data.reverseCharge ? 'Reverse charge' : '')); const key = `${category}:${line.taxRateBasisPoints}:${reason}`; const group = taxGroups.get(key) ?? { category, rate: line.taxRateBasisPoints, taxable: 0 }; group.taxable += line.netAmountCents; taxGroups.set(key, group) }
  const expectedTax = [...taxGroups.values()].reduce((sum, group) => sum + (['AE', 'E'].includes(group.category) ? 0 : roundProduct(group.taxable, group.rate, 10_000)), 0)
  if (!Number.isSafeInteger(expectedTax) || expectedTax !== data.taxAmountCents) issues.push('Charged VAT does not reconcile to invoice line rates within safe integer cents.')
  if (data.paymentIban && !isValidIban(data.paymentIban)) issues.push('Payment IBAN is invalid.')
  if (data.paymentTerms !== undefined && !data.paymentTerms.trim()) issues.push('Payment terms must not be empty.')
  if (data.kind !== 'invoice' && !data.correctedInvoiceNumber?.trim()) issues.push('Corrections must reference a nonblank original invoice number.')
  if (data.kind !== 'invoice' && data.correctedInvoiceNumber?.trim() === data.invoiceNumber.trim()) issues.push('Correction documents must reference a distinct original invoice number.')
  return issues
}

export function generateUblInvoice(data: Omit<StructuredInvoiceData, 'syntax'>): Uint8Array {
  const complete = { ...data, syntax: 'UBL' as const }
  const issues = validateInvoice(complete)
  if (issues.length) throw new EInvoiceValidationError(issues)
  const root = data.kind === 'credit-note' ? 'CreditNote' : 'Invoice'
  const quantityTag = root === 'CreditNote' ? 'CreditedQuantity' : 'InvoicedQuantity'
  const categoryFor = (line: EInvoiceLine) => effectiveTaxCategory(line, data)
  const lines = data.lines.map((line, index) => { const lineExemption = line.exemptionReason ?? data.exemptionReason ?? (line.reverseCharge || data.reverseCharge ? 'Reverse charge' : undefined); return `<cac:${root}Line><cbc:ID>${index + 1}</cbc:ID><cbc:${quantityTag} unitCode="${esc(line.unitCode)}">${formatQuantity(line.quantity)}</cbc:${quantityTag}><cbc:LineExtensionAmount currencyID="${esc(data.currency)}">${formatMoney(line.netAmountCents)}</cbc:LineExtensionAmount><cac:Item><cbc:Description>${esc(line.description)}</cbc:Description><cac:ClassifiedTaxCategory><cbc:ID>${esc(categoryFor(line))}</cbc:ID><cbc:Percent>${line.taxRateBasisPoints / 100}</cbc:Percent>${lineExemption ? `<cbc:TaxExemptionReason>${esc(lineExemption)}</cbc:TaxExemptionReason>` : ''}<cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:ClassifiedTaxCategory></cac:Item><cac:Price><cbc:PriceAmount currencyID="${esc(data.currency)}">${formatUnitPrice(line.netAmountCents, line.quantity)}</cbc:PriceAmount></cac:Price></cac:${root}Line>` }).join('')
  const reference = data.correctedInvoiceNumber ? `<cac:BillingReference><cac:InvoiceDocumentReference><cbc:ID>${esc(data.correctedInvoiceNumber)}</cbc:ID></cac:InvoiceDocumentReference></cac:BillingReference>` : ''
  const typeCode = data.kind === 'invoice' ? '380' : data.kind === 'credit-note' ? '381' : data.kind === 'correction' ? '384' : '457'
  const payment = data.paymentIban ? `<cac:PaymentMeans><cbc:PaymentMeansCode>58</cbc:PaymentMeansCode><cac:PayeeFinancialAccount><cbc:ID>${esc(data.paymentIban.replace(/\s/g, '').toUpperCase())}</cbc:ID></cac:PayeeFinancialAccount></cac:PaymentMeans>` : ''
  const terms = data.paymentTerms ? `<cac:PaymentTerms><cbc:Note>${esc(data.paymentTerms)}</cbc:Note></cac:PaymentTerms>` : ''
  const groups = new Map<string, { category: string; rate: number; taxable: number; exemption?: string }>()
  for (const line of data.lines) { const category = categoryFor(line); const exemption = taxReasonForCategory(category, line.exemptionReason ?? data.exemptionReason ?? (line.reverseCharge || data.reverseCharge ? 'Reverse charge' : undefined)); const key = `${category}:${line.taxRateBasisPoints}:${exemption ?? ''}`; const group = groups.get(key) ?? { category, rate: line.taxRateBasisPoints, taxable: 0, exemption: exemption || undefined }; group.taxable += line.netAmountCents; groups.set(key, group) }
  const taxSubtotals = [...groups.values()].map(group => { const tax = ['AE', 'E'].includes(group.category) ? 0 : roundProduct(group.taxable, group.rate, 10_000); if (!Number.isSafeInteger(tax)) throw new EInvoiceValidationError(['Generated VAT subtotal exceeds exact safe-integer arithmetic.']); const exemption = group.exemption ? `<cbc:TaxExemptionReason>${esc(group.exemption)}</cbc:TaxExemptionReason>` : ''; return `<cac:TaxSubtotal><cbc:TaxableAmount currencyID="${esc(data.currency)}">${formatMoney(group.taxable)}</cbc:TaxableAmount><cbc:TaxAmount currencyID="${esc(data.currency)}">${formatMoney(tax)}</cbc:TaxAmount><cac:TaxCategory><cbc:ID>${esc(group.category)}</cbc:ID><cbc:Percent>${group.rate / 100}</cbc:Percent>${exemption}<cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:TaxCategory></cac:TaxSubtotal>` }).join('')
  const prepaid = data.prepaidAmountCents === undefined ? '' : `<cbc:PrepaidAmount currencyID="${esc(data.currency)}">${formatMoney(data.prepaidAmountCents)}</cbc:PrepaidAmount>`
  const rounding = data.payableRoundingAmountCents === undefined ? '' : `<cbc:PayableRoundingAmount currencyID="${esc(data.currency)}">${formatMoney(data.payableRoundingAmountCents)}</cbc:PayableRoundingAmount>`
  const payable = data.payableAmountCents ?? data.grossAmountCents - (data.prepaidAmountCents ?? 0) + (data.payableRoundingAmountCents ?? 0)
  const xml = `<?xml version="1.0" encoding="UTF-8"?><${root} xmlns="urn:oasis:names:specification:ubl:schema:xsd:${root}-2" xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2"><cbc:CustomizationID>urn:sanjo-solutions:accounting:ubl:1</cbc:CustomizationID><cbc:ProfileID>urn:sanjo-solutions:accounting:billing:1</cbc:ProfileID><cbc:ID>${esc(data.invoiceNumber)}</cbc:ID><cbc:IssueDate>${data.issueDate}</cbc:IssueDate><cbc:${root}TypeCode>${typeCode}</cbc:${root}TypeCode>${data.reverseCharge ? '<cbc:Note>Reverse charge</cbc:Note>' : ''}<cbc:DocumentCurrencyCode>${esc(data.currency)}</cbc:DocumentCurrencyCode>${reference}${partyXml('AccountingSupplierParty', data.seller)}${partyXml('AccountingCustomerParty', data.buyer)}<cac:Delivery><cbc:ActualDeliveryDate>${data.supplyDate}</cbc:ActualDeliveryDate></cac:Delivery>${payment}${terms}<cac:TaxTotal><cbc:TaxAmount currencyID="${esc(data.currency)}">${formatMoney(data.taxAmountCents)}</cbc:TaxAmount>${taxSubtotals}</cac:TaxTotal><cac:LegalMonetaryTotal><cbc:LineExtensionAmount currencyID="${esc(data.currency)}">${formatMoney(data.netAmountCents)}</cbc:LineExtensionAmount><cbc:TaxExclusiveAmount currencyID="${esc(data.currency)}">${formatMoney(data.netAmountCents)}</cbc:TaxExclusiveAmount><cbc:TaxInclusiveAmount currencyID="${esc(data.currency)}">${formatMoney(data.grossAmountCents)}</cbc:TaxInclusiveAmount>${prepaid}${rounding}<cbc:PayableAmount currencyID="${esc(data.currency)}">${formatMoney(payable)}</cbc:PayableAmount></cac:LegalMonetaryTotal>${lines}</${root}>`
  return new TextEncoder().encode(xml)
}

export function renderInvoiceHtml(invoice: ValidatedEInvoice): string {
  const d = invoice.data
  return `<!doctype html><html><body><h1>${esc(d.kind)} ${esc(d.invoiceNumber)}</h1><p>${esc(d.issueDate)} · ${esc(d.seller.name)} → ${esc(d.buyer.name)}</p><table><tbody>${d.lines.map(line => `<tr><td>${esc(line.description)}</td><td>${line.quantity}</td><td>${formatMoney(line.netAmountCents)} ${esc(d.currency)}</td></tr>`).join('')}</tbody></table><strong>${formatMoney(d.grossAmountCents)} ${esc(d.currency)}</strong></body></html>`
}

export interface CorrectionLink { readonly id: string; readonly kind: InvoiceDocumentKind; readonly sha256: string; readonly corrects?: string }
function validateCorrectionLinkProvenance(link: CorrectionLink) {
  if (!link.id.trim() || !/^[a-f0-9]{64}$/.test(link.sha256) || link.corrects !== undefined && !link.corrects.trim() || !['invoice', 'credit-note', 'correction', 'cancellation'].includes(link.kind)) throw new EInvoiceValidationError(['Correction-chain links require nonblank identifiers, supported document kinds and canonical lowercase SHA-256 provenance.'])
}
export class InvoiceCorrectionChain {
  readonly links: readonly CorrectionLink[]
  constructor(links: readonly CorrectionLink[] = []) {
    const copy = links.map(link => Object.freeze({ ...link }))
    const ids = new Set<string>(); const hashes = new Set<string>()
    copy.forEach((link, index) => { validateCorrectionLinkProvenance(link); if (ids.has(link.id) || hashes.has(link.sha256)) throw new EInvoiceValidationError(['Correction documents must be immutable and unique.']); if (index === 0 && (link.kind !== 'invoice' || link.corrects)) throw new EInvoiceValidationError(['A correction chain must start with an invoice that has no correction reference.']); if (index > 0 && link.kind === 'invoice') throw new EInvoiceValidationError(['Only the root correction-chain document may be an invoice.']); if (index > 0 && (!link.corrects || !ids.has(link.corrects))) throw new EInvoiceValidationError(['Correction must reference an earlier immutable chain member.']); ids.add(link.id); hashes.add(link.sha256) })
    this.links = Object.freeze(copy); Object.freeze(this)
  }
  append(link: CorrectionLink): InvoiceCorrectionChain {
    validateCorrectionLinkProvenance(link)
    if (this.links.some(item => item.id === link.id || item.sha256 === link.sha256)) throw new EInvoiceValidationError(['Correction documents must be immutable and unique.'])
    if (this.links.length === 0 && (link.kind !== 'invoice' || link.corrects)) throw new EInvoiceValidationError(['A correction chain must start with an invoice that has no correction reference.'])
    if (this.links.length > 0 && link.kind === 'invoice') throw new EInvoiceValidationError(['Only the root correction-chain document may be an invoice.'])
    if (this.links.length > 0 && (!link.corrects || !this.links.some(item => item.id === link.corrects))) throw new EInvoiceValidationError(['Correction must reference an existing immutable chain member.'])
    return new InvoiceCorrectionChain([...this.links, Object.freeze({ ...link })])
  }
}

interface XmlNode { local: string; ns: string; attrs: Readonly<Record<string, string>>; text: string; children: XmlNode[] }
const UBL_INVOICE = 'urn:oasis:names:specification:ubl:schema:xsd:Invoice-2'
const UBL_CREDIT = 'urn:oasis:names:specification:ubl:schema:xsd:CreditNote-2'
const CAC = 'urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2'
const CBC = 'urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2'
const CII = 'urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100'
const RAM = 'urn:un:unece:uncefact:data:standard:ReusableAggregateBusinessInformationEntity:100'
const UDT = 'urn:un:unece:uncefact:data:standard:UnqualifiedDataType:100'
const XML_NAMESPACE = 'http://www.w3.org/XML/1998/namespace'
const XMLNS_NAMESPACE = 'http://www.w3.org/2000/xmlns/'

interface ScannedXmlToken { index: number; raw: string; tag?: string; text?: string }
function* scanXmlTokens(xml: string): Generator<ScannedXmlToken> {
  let cursor = 0; let emitted = 0
  const emit = (part: ScannedXmlToken) => { if (++emitted > 100_000) throw new EInvoiceValidationError(['XML token limit exceeded.']); return part }
  while (cursor < xml.length) {
    const open = xml.indexOf('<', cursor)
    if (open < 0) { yield emit({ index: cursor, raw: xml.slice(cursor), text: xml.slice(cursor) }); break }
    if (open > cursor) yield emit({ index: cursor, raw: xml.slice(cursor, open), text: xml.slice(cursor, open) })
    let quote = ''; let end = open + 1
    for (; end < xml.length; end++) { const char = xml[end]; if (quote) { if (char === quote) quote = '' } else if (char === '"' || char === "'") quote = char; else if (char === '>') break }
    if (end >= xml.length) throw new EInvoiceValidationError(['Unterminated XML tag.'])
    yield emit({ index: open, raw: xml.slice(open, end + 1), tag: xml.slice(open + 1, end) }); cursor = end + 1
  }
}

function parseSafeXml(xml: string): XmlNode {
  const allowed = new Set([UBL_INVOICE, UBL_CREDIT, CAC, CBC, CII, RAM, UDT, XML_NAMESPACE, 'urn:un:unece:uncefact:data:standard:QualifiedDataType:100'])
  const document: XmlNode = { local: '#document', ns: '', attrs: {}, text: '', children: [] }
  const stack: Array<{ node: XmlNode; namespaces: Record<string, string>; qName: string }> = [{ node: document, namespaces: { xml: XML_NAMESPACE }, qName: '#document' }]
  if (!isXml10Text(xml)) throw new EInvoiceValidationError(['XML contains characters forbidden by XML 1.0.'])
  if (/<!--|<!\[CDATA\[/i.test(xml)) throw new EInvoiceValidationError(['Comments and CDATA are not accepted in structured invoice input.'])
  const xmlParts = scanXmlTokens(xml)
  let nodes = 0
  let namespaceDeclarations = 0
  let declarationSeen = false
  let cursor = 0
  for (const token of xmlParts) {
    if (token.index !== cursor && !isXmlWhitespace(xml.slice(cursor, token.index))) throw new EInvoiceValidationError(['Malformed or skipped XML content.'])
    cursor = token.index + token.raw.length
    if (token.text !== undefined) { if (token.text.includes(']]>')) throw new EInvoiceValidationError(['The forbidden ]]> sequence is not allowed in XML character data.']); if (stack.length === 1) { if (!isXmlWhitespace(token.text)) throw new EInvoiceValidationError(['Non-whitespace content outside the XML root is forbidden.']) } else stack.at(-1)!.node.text += decodeXml(token.text); continue }
    const raw = trimXmlWhitespace(token.tag!)
    if (raw.startsWith('?')) {
      const validDeclaration = /^\?xml[ \t\r\n]+version=(?:"1\.0"|'1\.0')(?:[ \t\r\n]+encoding=(?:"UTF-8"|'UTF-8'|"utf-8"|'utf-8'))?(?:[ \t\r\n]+standalone=(?:"(?:yes|no)"|'(?:yes|no)'))?[ \t\r\n]*\?$/.test(raw)
      if (validDeclaration) {
        if (declarationSeen || token.index !== 0 || document.children.length || stack.length !== 1) throw new EInvoiceValidationError(['Only one complete leading XML declaration is allowed.'])
        declarationSeen = true; continue
      }
      if (/^\?xml(?:[ \t\r\n]|\?)/i.test(raw)) throw new EInvoiceValidationError(['Only one complete leading XML declaration is allowed.'])
      if (!/^\?[A-Za-z_][A-Za-z0-9_.-]*(?:[ \t\r\n][^<>]*)?\?$/.test(raw)) throw new EInvoiceValidationError(['Malformed XML processing instruction.'])
      continue
    }
    if (raw.startsWith('/')) {
      if (stack.length === 1) throw new EInvoiceValidationError(['Malformed XML closing tag.'])
      const closingName = trimXmlWhitespace(raw.slice(1))
      const current = stack.at(-1)!
      if (!isXmlQName(closingName) || closingName !== current.qName) throw new EInvoiceValidationError(['Mismatched or invalid XML closing qualified name.'])
      stack.pop(); continue
    }
    const selfClosing = raw.endsWith('/')
    const name = raw.match(/^([^ \t\r\n/>]+)/)?.[1]
    if (!name || !isXmlQName(name)) throw new EInvoiceValidationError(['Malformed XML qualified element name.'])
    const namespaces = { ...stack.at(-1)!.namespaces }
    const rawAttrs: Record<string, string> = {}
    const rawAttributeNames = new Set<string>()
    const tagTail = raw.slice(name.length, selfClosing ? -1 : undefined); const attributePattern = /[ \t\r\n]+([^ \t\r\n=/>]+)[ \t\r\n]*=[ \t\r\n]*(?:"([^"]*)"|'([^']*)')/gy; let attributeCursor = 0
    while (attributeCursor < tagTail.length) {
      attributePattern.lastIndex = attributeCursor; const match = attributePattern.exec(tagTail)
      if (!match) { if (!isXmlWhitespace(tagTail.slice(attributeCursor))) throw new EInvoiceValidationError(['Malformed, unquoted or skipped XML start-tag content.']); break }
      const key = match[1]; const value = decodeXml(match[2] ?? match[3] ?? '')
      if ((key !== 'xmlns' && !isXmlQName(key)) || (key.startsWith('xmlns:') && !/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(key.slice(6))) || (match[2] ?? match[3] ?? '').includes('<')) throw new EInvoiceValidationError([`Invalid XML attribute name or raw value for ${key}.`])
      if (rawAttributeNames.has(key)) throw new EInvoiceValidationError([`Duplicate XML attribute or namespace declaration ${key}.`])
      rawAttributeNames.add(key)
      if (key === 'xmlns') {
        if (++namespaceDeclarations > 64) throw new EInvoiceValidationError(['XML namespace declaration limit exceeded.'])
        if (value === XML_NAMESPACE || value === XMLNS_NAMESPACE) throw new EInvoiceValidationError(['The default namespace cannot use a reserved XML namespace URI.'])
        namespaces[''] = value
      }
      else if (key.startsWith('xmlns:')) {
        if (++namespaceDeclarations > 64) throw new EInvoiceValidationError(['XML namespace declaration limit exceeded.'])
        const declaredPrefix = key.slice(6)
        if (declaredPrefix === 'xmlns' || value === XMLNS_NAMESPACE || (declaredPrefix === 'xml' ? value !== XML_NAMESPACE : value === XML_NAMESPACE)) throw new EInvoiceValidationError([`Invalid reserved XML namespace binding for ${declaredPrefix}.`])
        namespaces[declaredPrefix] = value
      }
      else rawAttrs[key] = value
      attributeCursor = attributePattern.lastIndex
    }
    const [prefix = '', local = ''] = name.includes(':') ? name.split(':', 2) : ['', name]
    if (prefix === 'xmlns') throw new EInvoiceValidationError(['The xmlns prefix is reserved for namespace declarations.'])
    const ns = namespaces[prefix] ?? ''
    if (!allowed.has(ns)) throw new EInvoiceValidationError([`Unsupported XML namespace ${ns || '(empty)'}.`])
    const attrs: Record<string, string> = {}
    for (const [key, value] of Object.entries(rawAttrs)) {
      const [attributePrefix = '', attributeLocal = ''] = key.includes(':') ? key.split(':', 2) : ['', key]
      const attributeNs = attributePrefix ? namespaces[attributePrefix] : ''
      if (attributePrefix && !attributeNs) throw new EInvoiceValidationError([`Unknown XML attribute prefix ${attributePrefix}.`])
      const expanded = attributeNs ? `{${attributeNs}}${attributeLocal}` : attributeLocal
      if (attrs[expanded] !== undefined) throw new EInvoiceValidationError([`Duplicate XML attribute ${expanded}.`])
      attrs[expanded] = value
    }
    const node: XmlNode = { local, ns, attrs: Object.freeze(attrs), text: '', children: [] }
    stack.at(-1)!.node.children.push(node)
    if (++nodes > 50_000 || stack.length > 128) throw new EInvoiceValidationError(['XML structural limits exceeded.'])
    if (!selfClosing) stack.push({ node, namespaces, qName: name })
  }
  if (cursor !== xml.length && !isXmlWhitespace(xml.slice(cursor))) throw new EInvoiceValidationError(['Trailing or skipped XML content is forbidden.'])
  if (stack.length !== 1 || document.children.length !== 1) throw new EInvoiceValidationError(['XML must contain exactly one well-formed root element.'])
  return document.children[0]
}

function detectRootSyntax(root: XmlNode, hybrid: boolean): EInvoiceSyntax {
  if (root.ns === CII && root.local === 'CrossIndustryInvoice') return hybrid ? 'ZUGFERD' : 'CII'
  if ((root.ns === UBL_INVOICE && root.local === 'Invoice') || (root.ns === UBL_CREDIT && root.local === 'CreditNote')) return 'UBL'
  throw new EInvoiceValidationError(['Unsupported structured invoice syntax.'])
}

function parseUbl(root: XmlNode): StructuredInvoiceData {
  const kind = ublKind(root)
  if (children(root, CAC, 'AllowanceCharge').length) throw new EInvoiceValidationError(['Unsupported UBL document-level allowances or charges must not be silently ignored.'])
  const totals = nodeAt(root, [CAC, 'LegalMonetaryTotal'])
  const taxTotal = nodeAt(root, [CAC, 'TaxTotal'])
  const supplier = nodeAt(root, [CAC, 'AccountingSupplierParty'])
  const customer = nodeAt(root, [CAC, 'AccountingCustomerParty'])
  const lineName = root.local === 'CreditNote' ? 'CreditNoteLine' : 'InvoiceLine'
  const lines: EInvoiceLine[] = children(root, CAC, lineName).map(line => {
    const item = nodeAt(line, [CAC, 'Item'])
    const category = nodeAt(item, [CAC, 'ClassifiedTaxCategory'])
    if (textOf(nodeAt(category, [CAC, 'TaxScheme'], [CBC, 'ID'])) !== 'VAT') throw new EInvoiceValidationError(['Every UBL line tax category must explicitly use the VAT tax scheme.'])
    const quantity = child(line, CBC, root.local === 'CreditNote' ? 'CreditedQuantity' : 'InvoicedQuantity')
    const parsedQuantity = parseQuantityText(quantity?.text ?? ''); const netAmountCents = money(textOf(child(line, CBC, 'LineExtensionAmount'))); const price = nodeAt(line, [CAC, 'Price']); if (children(line, CAC, 'AllowanceCharge').length) throw new EInvoiceValidationError(['Unsupported UBL line allowances or charges must not be silently ignored.']); assertDeclaredLinePrice(textOf(child(price, CBC, 'PriceAmount')), textOf(child(price, CBC, 'BaseQuantity')), parsedQuantity, netAmountCents, 'UBL')
    return { description: textOf(child(item, CBC, 'Description') ?? child(item, CBC, 'Name')), quantity: parsedQuantity, unitCode: quantity?.attrs.unitCode ?? '', netAmountCents, taxRateBasisPoints: basisPoints(textOf(child(category, CBC, 'Percent'))), taxCategoryCode: textOf(child(category, CBC, 'ID')) || undefined, exemptionReason: textOf(child(category, CBC, 'TaxExemptionReason')) || undefined, reverseCharge: textOf(child(category, CBC, 'ID')) === 'AE' }
  })
  const payment = child(root, CAC, 'PaymentMeans')
  const subtotals = children(taxTotal, CAC, 'TaxSubtotal')
  if (!subtotals.length) throw new EInvoiceValidationError(['UBL header tax must include an explicit VAT subtotal and tax scheme.'])
  const subtotalTax = safeMoneySum(subtotals.map(subtotal => money(textOf(child(subtotal, CBC, 'TaxAmount')))))
  const headerTax = money(textOf(child(taxTotal, CBC, 'TaxAmount')))
  if (subtotals.length && subtotalTax !== headerTax) throw new EInvoiceValidationError(['UBL VAT breakdowns do not reconcile to total tax.'])
  const categories = subtotals.map(subtotal => nodeAt(subtotal, [CAC, 'TaxCategory'])).filter((item): item is XmlNode => Boolean(item))
  if (categories.length !== subtotals.length || categories.some(category => textOf(nodeAt(category, [CAC, 'TaxScheme'], [CBC, 'ID'])) !== 'VAT')) throw new EInvoiceValidationError(['Every UBL header tax category must explicitly use the VAT tax scheme.'])
  const categoryCodes = categories.map(category => textOf(child(category, CBC, 'ID')))
  for (const line of lines) {
    const matchingCategories = categories.filter(item => textOf(child(item, CBC, 'ID')) === line.taxCategoryCode && basisPoints(textOf(child(item, CBC, 'Percent'))) === line.taxRateBasisPoints)
    const category = line.exemptionReason ? matchingCategories.find(item => textOf(child(item, CBC, 'TaxExemptionReason')) === line.exemptionReason) ?? matchingCategories[0] : matchingCategories.length === 1 ? matchingCategories[0] : undefined
    const headerReason = textOf(child(category, CBC, 'TaxExemptionReason')) || undefined
    if (['E', 'AE', 'G', 'K', 'O'].includes(line.taxCategoryCode ?? '')) {
      if (line.exemptionReason && headerReason && line.exemptionReason !== headerReason) throw new EInvoiceValidationError(['UBL line and header TaxExemptionReason values do not match.'])
      line.exemptionReason ??= headerReason
    }
    if (line.taxCategoryCode === 'AE') line.reverseCharge = true
  }
  if (subtotals.length) {
    const headerGroups = new Map<string, number>()
    for (const subtotal of subtotals) { const category = nodeAt(subtotal, [CAC, 'TaxCategory']); const code = textOf(child(category, CBC, 'ID')); const rate = basisPoints(textOf(child(category, CBC, 'Percent'))); const reason = textOf(child(category, CBC, 'TaxExemptionReason')); const taxable = money(textOf(child(subtotal, CBC, 'TaxableAmount'))); const tax = money(textOf(child(subtotal, CBC, 'TaxAmount'))); const key = `${code}:${rate}:${reason}`; if (headerGroups.has(key)) throw new EInvoiceValidationError(['Duplicate UBL VAT subtotal category/rate/reason.']); const expected = ['AE', 'E'].includes(code) ? 0 : roundProduct(taxable, rate, 10_000); if (!Number.isSafeInteger(expected) || tax !== expected) throw new EInvoiceValidationError(['UBL VAT subtotal arithmetic is invalid.']); headerGroups.set(key, taxable) }
    const lineGroups = new Map<string, number>(); for (const line of lines) { const key = `${line.taxCategoryCode ?? ''}:${line.taxRateBasisPoints}:${line.exemptionReason ?? ''}`; lineGroups.set(key, (lineGroups.get(key) ?? 0) + line.netAmountCents) }
    if (headerGroups.size !== lineGroups.size || [...lineGroups].some(([key, taxable]) => headerGroups.get(key) !== taxable)) throw new EInvoiceValidationError(['UBL line tax categories/rates do not reconcile to header VAT breakdowns.'])
  }
  const issueDate = textOf(child(root, CBC, 'IssueDate'))
  const supplyDate = textOf(nodeAt(child(root, CAC, 'Delivery'), [CBC, 'ActualDeliveryDate']))
  if (!supplyDate) throw new EInvoiceValidationError(['UBL requires an explicit supported supply date.'])
  const billingReference = child(root, CAC, 'BillingReference')
  const documentCurrency = textOf(child(root, CBC, 'DocumentCurrencyCode'))
  const taxInclusive = child(totals, CBC, 'TaxInclusiveAmount')
  if (!taxInclusive) throw new EInvoiceValidationError(['UBL requires an explicit TaxInclusiveAmount gross total.'])
  const taxExclusive = child(totals, CBC, 'TaxExclusiveAmount')
  const payable = child(totals, CBC, 'PayableAmount')
  const prepaid = child(totals, CBC, 'PrepaidAmount')
  const rounding = child(totals, CBC, 'PayableRoundingAmount')
  const lineExtensionAmount = money(textOf(child(totals, CBC, 'LineExtensionAmount')))
  if (!payable) throw new EInvoiceValidationError(['UBL requires an explicit PayableAmount.'])
  if (taxExclusive && money(taxExclusive.text) !== lineExtensionAmount) throw new EInvoiceValidationError(['UBL TaxExclusiveAmount does not reconcile to line-extension total without modeled allowances or charges.'])
  assertCurrencyIds(root, documentCurrency)
  return {
    syntax: 'UBL', kind, invoiceNumber: textOf(child(root, CBC, 'ID')), issueDate,
    supplyDate,
    seller: parseUblParty(supplier), buyer: parseUblParty(customer), lines,
    netAmountCents: lineExtensionAmount, taxAmountCents: headerTax, grossAmountCents: money(textOf(taxInclusive)),
    prepaidAmountCents: prepaid ? money(prepaid.text) : undefined,
    payableRoundingAmountCents: rounding ? money(rounding.text) : undefined,
    payableAmountCents: prepaid !== undefined || rounding !== undefined || money(payable.text) !== money(taxInclusive?.text) ? money(payable.text) : undefined,
    currency: documentCurrency,
    paymentTerms: textOf(nodeAt(child(root, CAC, 'PaymentTerms'), [CBC, 'Note'])) || undefined,
    paymentIban: textOf(nodeAt(payment, [CAC, 'PayeeFinancialAccount'], [CBC, 'ID'])) || undefined,
    exemptionReason: categoryCodes.length > 0 && categoryCodes.every(code => code === 'E') ? categories.map(category => textOf(child(category, CBC, 'TaxExemptionReason'))).find(Boolean) : undefined,
    reverseCharge: categoryCodes.length > 0 && categoryCodes.every(code => code === 'AE'),
    correctedInvoiceNumber: textOf(nodeAt(billingReference, [CAC, 'InvoiceDocumentReference'], [CBC, 'ID'])) || undefined,
  }
}

function parseCii(root: XmlNode, syntax: 'CII' | 'ZUGFERD'): StructuredInvoiceData {
  const document = nodeAt(root, [CII, 'ExchangedDocument'])
  const transaction = nodeAt(root, [CII, 'SupplyChainTradeTransaction'])
  const agreement = nodeAt(transaction, [RAM, 'ApplicableHeaderTradeAgreement'])
  const delivery = nodeAt(transaction, [RAM, 'ApplicableHeaderTradeDelivery'])
  const settlement = nodeAt(transaction, [RAM, 'ApplicableHeaderTradeSettlement'])
  if (children(settlement, RAM, 'SpecifiedTradeAllowanceCharge').length) throw new EInvoiceValidationError(['Unsupported CII document-level allowances or charges must not be silently ignored.'])
  const totals = nodeAt(settlement, [RAM, 'SpecifiedTradeSettlementHeaderMonetarySummation'])
  const issueDate = normalizeCiiDate(textOf(nodeAt(document, [RAM, 'IssueDateTime'], [UDT, 'DateTimeString'])))
  const supplyDate = normalizeCiiDate(textOf(nodeAt(delivery, [RAM, 'ActualDeliverySupplyChainEvent'], [RAM, 'OccurrenceDateTime'], [UDT, 'DateTimeString'])))
  if (!supplyDate) throw new EInvoiceValidationError(['CII requires an explicit supported supply date.'])
  const typeCode = textOf(child(document, RAM, 'TypeCode'))
  if (typeCode && !['380', '381', '384', '457'].includes(typeCode)) throw new EInvoiceValidationError([`Unsupported CII invoice type code ${typeCode}.`])
  const kind: InvoiceDocumentKind = typeCode === '381' ? 'credit-note' : typeCode === '384' ? 'correction' : typeCode === '457' ? 'cancellation' : 'invoice'
  const lines: EInvoiceLine[] = children(transaction, RAM, 'IncludedSupplyChainTradeLineItem').map(line => {
    const quantity = nodeAt(line, [RAM, 'SpecifiedLineTradeDelivery'], [RAM, 'BilledQuantity'])
    const lineSettlement = nodeAt(line, [RAM, 'SpecifiedLineTradeSettlement']); const lineTax = child(lineSettlement, RAM, 'ApplicableTradeTax'); const parsedQuantity = parseQuantityText(quantity?.text ?? ''); const netAmountCents = money(textOf(nodeAt(lineSettlement, [RAM, 'SpecifiedTradeSettlementLineMonetarySummation'], [RAM, 'LineTotalAmount']))); const price = nodeAt(line, [RAM, 'SpecifiedLineTradeAgreement'], [RAM, 'NetPriceProductTradePrice']); if (children(lineSettlement, RAM, 'SpecifiedTradeAllowanceCharge').length) throw new EInvoiceValidationError(['Unsupported CII line allowances or charges must not be silently ignored.']); assertDeclaredLinePrice(textOf(child(price, RAM, 'ChargeAmount')), textOf(child(price, RAM, 'BasisQuantity')), parsedQuantity, netAmountCents, 'CII')
    if (textOf(child(lineTax, RAM, 'TypeCode')) !== 'VAT') throw new EInvoiceValidationError(['Every CII line applicable tax must explicitly use VAT type code.'])
    return { description: textOf(nodeAt(line, [RAM, 'SpecifiedTradeProduct'], [RAM, 'Name'])), quantity: parsedQuantity, unitCode: quantity?.attrs.unitCode ?? '', netAmountCents, taxRateBasisPoints: basisPoints(textOf(child(lineTax, RAM, 'RateApplicablePercent'))), taxCategoryCode: textOf(child(lineTax, RAM, 'CategoryCode')) || undefined, exemptionReason: textOf(child(lineTax, RAM, 'ExemptionReason')) || undefined }
  })
  const tradeTaxes = children(settlement, RAM, 'ApplicableTradeTax')
  if (!tradeTaxes.length || tradeTaxes.some(tax => textOf(child(tax, RAM, 'TypeCode')) !== 'VAT')) throw new EInvoiceValidationError(['Every CII header applicable tax must explicitly use VAT type code.'])
  const calculatedTax = safeMoneySum(tradeTaxes.map(tax => money(textOf(child(tax, RAM, 'CalculatedAmount')))))
  const headerTax = money(textOf(child(totals, RAM, 'TaxTotalAmount')))
  if (tradeTaxes.length && calculatedTax !== headerTax) throw new EInvoiceValidationError(['CII VAT breakdowns do not reconcile to total tax.'])
  const categoryCodes = tradeTaxes.map(tax => textOf(child(tax, RAM, 'CategoryCode')))
  for (const line of lines) { const tax = tradeTaxes.find(item => textOf(child(item, RAM, 'CategoryCode')) === line.taxCategoryCode && basisPoints(textOf(child(item, RAM, 'RateApplicablePercent'))) === line.taxRateBasisPoints); if (['E', 'AE', 'G', 'K', 'O'].includes(line.taxCategoryCode ?? '')) { const headerReason = textOf(child(tax, RAM, 'ExemptionReason')) || undefined; if (line.exemptionReason?.trim() && headerReason?.trim() && line.exemptionReason.trim() !== headerReason.trim()) throw new EInvoiceValidationError(['CII line and header ExemptionReason values must match.']); line.exemptionReason = line.exemptionReason?.trim() || headerReason?.trim() || undefined } if (line.taxCategoryCode === 'AE') line.reverseCharge = true }
  if (tradeTaxes.length) {
    const headerGroups = new Map<string, number>()
    for (const tax of tradeTaxes) { const code = textOf(child(tax, RAM, 'CategoryCode')); const rate = basisPoints(textOf(child(tax, RAM, 'RateApplicablePercent'))); const basis = money(textOf(child(tax, RAM, 'BasisAmount'))); const calculated = money(textOf(child(tax, RAM, 'CalculatedAmount'))); const key = `${code}:${rate}`; if (headerGroups.has(key)) throw new EInvoiceValidationError(['Duplicate CII VAT breakdown category/rate.']); const expected = ['AE', 'E'].includes(code) ? 0 : roundProduct(basis, rate, 10_000); if (!Number.isSafeInteger(expected) || calculated !== expected) throw new EInvoiceValidationError(['CII VAT breakdown arithmetic is invalid.']); headerGroups.set(key, basis) }
    const lineGroups = new Map<string, number>(); for (const line of lines) { const key = `${line.taxCategoryCode ?? ''}:${line.taxRateBasisPoints}`; lineGroups.set(key, (lineGroups.get(key) ?? 0) + line.netAmountCents) }
    if (headerGroups.size !== lineGroups.size || [...lineGroups].some(([key, basis]) => headerGroups.get(key) !== basis)) throw new EInvoiceValidationError(['CII line tax categories/rates do not reconcile to header VAT breakdowns.'])
  }
  const payment = child(settlement, RAM, 'SpecifiedTradeSettlementPaymentMeans')
  const invoiceCurrency = textOf(child(settlement, RAM, 'InvoiceCurrencyCode')) || child(totals, RAM, 'GrandTotalAmount')?.attrs.currencyID || ''
  const grandTotal = child(totals, RAM, 'GrandTotalAmount')
  const lineTotal = child(totals, RAM, 'LineTotalAmount')
  const taxBasisTotal = child(totals, RAM, 'TaxBasisTotalAmount')
  const prepaid = child(totals, RAM, 'TotalPrepaidAmount')
  const rounding = child(totals, RAM, 'RoundingAmount')
  const payable = child(totals, RAM, 'DuePayableAmount')
  if (!payable) throw new EInvoiceValidationError(['CII requires an explicit DuePayableAmount.'])
  if (lineTotal && taxBasisTotal && money(lineTotal.text) !== money(taxBasisTotal.text)) throw new EInvoiceValidationError(['CII TaxBasisTotalAmount does not reconcile to line total without modeled allowances or charges.'])
  assertCurrencyIds(root, invoiceCurrency)
  return {
    syntax, kind, invoiceNumber: textOf(child(document, RAM, 'ID')), issueDate,
    supplyDate,
    seller: parseCiiParty(child(agreement, RAM, 'SellerTradeParty')), buyer: parseCiiParty(child(agreement, RAM, 'BuyerTradeParty')), lines,
    netAmountCents: money(textOf(lineTotal ?? taxBasisTotal)), taxAmountCents: headerTax, grossAmountCents: money(textOf(grandTotal)),
    prepaidAmountCents: prepaid ? money(prepaid.text) : undefined,
    payableRoundingAmountCents: rounding ? money(rounding.text) : undefined,
    payableAmountCents: prepaid !== undefined || rounding !== undefined || money(payable.text) !== money(grandTotal?.text) ? money(payable.text) : undefined,
    currency: invoiceCurrency, paymentTerms: textOf(nodeAt(settlement, [RAM, 'SpecifiedTradePaymentTerms'], [RAM, 'Description'])) || undefined,
    paymentIban: textOf(nodeAt(payment, [RAM, 'PayeePartyCreditorFinancialAccount'], [RAM, 'IBANID'])) || undefined,
    exemptionReason: categoryCodes.length > 0 && categoryCodes.every(code => code === 'E') ? tradeTaxes.map(tax => textOf(child(tax, RAM, 'ExemptionReason'))).find(Boolean) : undefined, reverseCharge: categoryCodes.length > 0 && categoryCodes.every(code => code === 'AE'),
    correctedInvoiceNumber: textOf(nodeAt(settlement, [RAM, 'InvoiceReferencedDocument'], [RAM, 'IssuerAssignedID'])) || undefined,
  }
}

function parseUblParty(container?: XmlNode): EInvoiceParty {
  const party = child(container, CAC, 'Party'); const address = child(party, CAC, 'PostalAddress'); const taxes = children(party, CAC, 'PartyTaxScheme')
  const vats = taxes.filter(tax => textOf(nodeAt(tax, [CAC, 'TaxScheme'], [CBC, 'ID'])).toUpperCase() === 'VAT'); const fiscals = taxes.filter(tax => ['FC', 'TAX'].includes(textOf(nodeAt(tax, [CAC, 'TaxScheme'], [CBC, 'ID'])).toUpperCase())); if (vats.length > 1 || fiscals.length > 1) throw new EInvoiceValidationError(['Invoice parties require at most one unambiguous VAT and fiscal registration.']); const vat = vats[0]; const fiscal = fiscals[0]
  return { name: textOf(nodeAt(party, [CAC, 'PartyLegalEntity'], [CBC, 'RegistrationName'])) || textOf(nodeAt(party, [CAC, 'PartyName'], [CBC, 'Name'])), street: textOf(child(address, CBC, 'StreetName')), city: textOf(child(address, CBC, 'CityName')), postalCode: textOf(child(address, CBC, 'PostalZone')), countryCode: textOf(nodeAt(address, [CAC, 'Country'], [CBC, 'IdentificationCode'])), vatId: textOf(child(vat, CBC, 'CompanyID')) || undefined, taxId: textOf(child(fiscal, CBC, 'CompanyID')) || undefined }
}
function parseCiiParty(party?: XmlNode): EInvoiceParty { const address = child(party, RAM, 'PostalTradeAddress'); const registrations = children(party, RAM, 'SpecifiedTaxRegistration').map(item => child(item, RAM, 'ID')); const vats = registrations.filter(id => id?.attrs.schemeID === 'VA'); const fiscals = registrations.filter(id => ['FC', 'TX'].includes(id?.attrs.schemeID ?? '')); if (vats.length > 1 || fiscals.length > 1) throw new EInvoiceValidationError(['Invoice parties require at most one unambiguous VAT and fiscal registration.']); const vatId = textOf(vats[0]); const taxId = textOf(fiscals[0]); return { name: textOf(child(party, RAM, 'Name')), street: textOf(child(address, RAM, 'LineOne')), city: textOf(child(address, RAM, 'CityName')), postalCode: textOf(child(address, RAM, 'PostcodeCode')), countryCode: textOf(child(address, RAM, 'CountryID')), vatId: vatId || undefined, taxId: taxId || undefined } }
function ublKind(root: XmlNode): InvoiceDocumentKind { const code = textOf(child(root, CBC, root.local === 'CreditNote' ? 'CreditNoteTypeCode' : 'InvoiceTypeCode')); if (root.local === 'CreditNote') { if (code && code !== '381') throw new EInvoiceValidationError([`Unsupported UBL credit-note type code ${code}.`]); return 'credit-note' } if (code && !['380', '384', '457'].includes(code)) throw new EInvoiceValidationError([`Unsupported UBL invoice type code ${code}.`]); return code === '384' ? 'correction' : code === '457' ? 'cancellation' : 'invoice' }
function children(node: XmlNode | undefined, ns: string, local: string) { return node?.children.filter(item => item.ns === ns && item.local === local) ?? [] }
function child(node: XmlNode | undefined, ns: string, local: string) { const matches = children(node, ns, local); if (matches.length > 1) throw new EInvoiceValidationError([`Duplicate ${local} element.`]); return matches[0] }
function nodeAt(node: XmlNode | undefined, ...path: Array<[string, string]>): XmlNode | undefined { let current = node; for (const [ns, local] of path) current = child(current, ns, local); return current }
function textOf(node: XmlNode | undefined) { if (node?.children.length) throw new EInvoiceValidationError([`Scalar invoice element ${node.local} must not contain nested elements.`]); return node?.text.trim() ?? '' }
function descendants(node: XmlNode): XmlNode[] { return [node, ...node.children.flatMap(descendants)] }
function assertCurrencyIds(root: XmlNode, currency: string) { if (!/^[A-Z]{3}$/.test(currency)) throw new EInvoiceValidationError(['Invoice currency code is missing or invalid.']); const monetaryNames = new Set(['LineExtensionAmount', 'TaxAmount', 'TaxableAmount', 'PriceAmount', 'TaxExclusiveAmount', 'TaxInclusiveAmount', 'PayableAmount', 'PrepaidAmount', 'PayableRoundingAmount', 'LineTotalAmount', 'TaxTotalAmount', 'GrandTotalAmount', 'TaxBasisTotalAmount', 'TotalPrepaidAmount', 'RoundingAmount', 'DuePayableAmount', 'CalculatedAmount', 'BasisAmount', 'ChargeAmount']); const monetary = descendants(root).filter(node => monetaryNames.has(node.local)); if (root.ns === UBL_INVOICE || root.ns === UBL_CREDIT) { if (monetary.some(node => !node.attrs.currencyID)) throw new EInvoiceValidationError(['Every consumed UBL monetary amount must declare currencyID.']) } if (monetary.some(node => node.attrs.currencyID && node.attrs.currencyID !== currency)) throw new EInvoiceValidationError(['Every monetary currencyID must match the invoice currency code.']) }
function extract(xml: string, localName: string): string | undefined { const value = xml.match(new RegExp(`<(?:(?:\\w+):)?${localName}\\b[^>]*>([^<]*)<\\/(?:(?:\\w+):)?${localName}>`, 'i'))?.[1]?.trim(); return value === undefined ? undefined : decodeXml(value) }
function first(xml: string, names: string[]): string | undefined { for (const name of names) { const value = extract(xml, name); if (value) return value } }
function attribute(xml: string, localName: string, name: string): string | undefined { return xml.match(new RegExp(`<(?:(?:\\w+):)?${localName}\\b[^>]*\\b${name}=["']([^"']+)["']`, 'i'))?.[1] }
function section(xml: string, localName: string, occurrence: number): string { const matches = [...xml.matchAll(new RegExp(`<(?:(?:\\w+):)?${localName}\\b[^>]*>([\\s\\S]*?)<\\/(?:(?:\\w+):)?${localName}>`, 'gi'))]; return matches[occurrence]?.[1] ?? '' }
function sections(xml: string, localName: string): string[] { return [...xml.matchAll(new RegExp(`<(?:(?:\\w+):)?${localName}\\b[^>]*>([\\s\\S]*?)<\\/(?:(?:\\w+):)?${localName}>`, 'gi'))].map(match => match[1]) }
function parseParty(xml: string, syntax: EInvoiceSyntax, role: 'seller' | 'buyer'): EInvoiceParty {
  const scope = syntax === 'CII' || syntax === 'ZUGFERD' ? section(xml, role === 'seller' ? 'SellerTradeParty' : 'BuyerTradeParty', 0) : section(xml, role === 'seller' ? 'AccountingSupplierParty' : 'AccountingCustomerParty', 0)
  return { name: first(scope, ['RegistrationName', 'Name']) ?? '', street: first(scope, ['StreetName', 'LineOne']) ?? '', city: first(scope, ['CityName']) ?? '', postalCode: first(scope, ['PostalZone', 'PostcodeCode']) ?? '', countryCode: first(scope, ['IdentificationCode', 'CountryID']) ?? '', taxId: first(scope, ['CompanyID', 'ID']), vatId: first(scope, ['CompanyID', 'ID']) }
}
function inferKind(xml: string, _syntax: EInvoiceSyntax): InvoiceDocumentKind { if (/CreditNote/i.test(xml) || /(?:Invoice|CreditNote)?TypeCode[^>]*>381</i.test(xml)) return 'credit-note'; if (/cancellation|storno/i.test(xml) || /(?:Invoice|CreditNote)?TypeCode[^>]*>457</i.test(xml)) return 'cancellation'; if (/(?:Invoice|CreditNote)?TypeCode[^>]*>384</i.test(xml)) return 'correction'; return 'invoice' }
function normalizeCiiDate(value?: string) { return value && /^\d{8}$/.test(value) ? `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6)}` : value ?? '' }
function partyXml(role: string, party: EInvoiceParty) { const registrations = `${party.vatId ? `<cac:PartyTaxScheme><cbc:CompanyID>${esc(party.vatId)}</cbc:CompanyID><cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:PartyTaxScheme>` : ''}${party.taxId ? `<cac:PartyTaxScheme><cbc:CompanyID>${esc(party.taxId)}</cbc:CompanyID><cac:TaxScheme><cbc:ID>FC</cbc:ID></cac:TaxScheme></cac:PartyTaxScheme>` : ''}`; return `<cac:${role}><cac:Party><cac:PartyName><cbc:Name>${esc(party.name)}</cbc:Name></cac:PartyName><cac:PostalAddress><cbc:StreetName>${esc(party.street)}</cbc:StreetName><cbc:CityName>${esc(party.city)}</cbc:CityName><cbc:PostalZone>${esc(party.postalCode)}</cbc:PostalZone><cac:Country><cbc:IdentificationCode>${esc(party.countryCode)}</cbc:IdentificationCode></cac:Country></cac:PostalAddress>${registrations}<cac:PartyLegalEntity><cbc:RegistrationName>${esc(party.name)}</cbc:RegistrationName></cac:PartyLegalEntity></cac:Party></cac:${role}>` }
function esc(value: string) { if (!isXml10Text(value)) throw new EInvoiceValidationError(['Generated XML text contains characters forbidden by XML 1.0.']); return value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!) }
function decodeXml(value: string) { if (/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[\dA-Fa-f]+);)/.test(value)) throw new EInvoiceValidationError(['Bare or unknown XML entity is forbidden.']); const decoded = value.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[\dA-Fa-f]+);/g, (_, entity: string) => { const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }; if (named[entity]) return named[entity]; const code = entity[1] === 'x' ? Number.parseInt(entity.slice(2), 16) : Number.parseInt(entity.slice(1), 10); if (!Number.isInteger(code) || !isXml10CodePoint(code)) throw new EInvoiceValidationError(['Invalid numeric XML entity.']); return String.fromCodePoint(code) }); if (!isXml10Text(decoded)) throw new EInvoiceValidationError(['XML contains characters forbidden by XML 1.0.']); return decoded }
function formatMoney(cents: number) { const negative = cents < 0; const absolute = BigInt(negative ? -cents : cents); return `${negative ? '-' : ''}${absolute / BigInt(100)}.${String(absolute % BigInt(100)).padStart(2, '0')}` }
function isVatIdForCountry(value: string, countryCode: string) { return Boolean(vatIdPatterns[countryCode]?.test(value.replace(/[\s.-]/g, '').toUpperCase())) }
function effectiveTaxCategory(line: EInvoiceLine, data: Pick<StructuredInvoiceData, 'reverseCharge' | 'exemptionReason'>) { return line.reverseCharge || data.reverseCharge ? 'AE' : line.taxCategoryCode ?? (line.exemptionReason || data.exemptionReason ? 'E' : line.taxRateBasisPoints === 0 ? 'Z' : 'S') }
function taxReasonForCategory(category: string, reason: string | undefined) { return ['E', 'AE', 'G', 'O', 'K'].includes(category) ? reason ?? '' : '' }
function decimalParts(value: string) { const match = /^(?:0|[1-9]\d{0,19})(?:\.(\d{1,12}))?$/.exec(value); if (!match) return undefined; const decimals = match[1]?.length ?? 0; return { coefficient: BigInt(value.replace('.', '')), scale: BigInt(10) ** BigInt(decimals) } }
function assertDeclaredLinePrice(priceText: string, baseQuantityText: string, quantity: number, netAmountCents: number, syntax: 'UBL' | 'CII') { if (!priceText && !baseQuantityText) return; const canonicalBase = baseQuantityText || '1'; const price = decimalParts(priceText); const base = /^(?:0|[1-9]\d{0,9})(?:\.\d{1,6})?$/.test(canonicalBase) ? quantityParts(Number(canonicalBase)) : undefined; const billed = quantityParts(quantity); if (!price || !base || !billed || !Number.isSafeInteger(netAmountCents)) throw new EInvoiceValidationError([`${syntax} declared line price or base quantity is invalid.`]); const reconstructed = roundRatio(price.coefficient * billed.coefficient * base.scale * BigInt(100), price.scale * billed.scale * base.coefficient); if (reconstructed !== BigInt(netAmountCents)) throw new EInvoiceValidationError([`${syntax} declared line price does not reconcile to quantity and line total.`]) }
function quantityParts(quantity: number) { const text = String(quantity); const match = /^(?:0|[1-9]\d{0,9})(?:\.(\d{1,6}))?$/.exec(text); if (!match || !(quantity > 0) || quantity > 1_000_000_000) return undefined; const decimals = match[1]?.length ?? 0; return { text, coefficient: BigInt(text.replace('.', '')), scale: BigInt(10) ** BigInt(decimals) } }
function parseQuantityText(text: string) { if (!/^(?:0|[1-9]\d{0,9})(?:\.\d{1,6})?$/.test(text)) throw new EInvoiceValidationError(['Invoice quantity must use a bounded non-exponent decimal with at most six fractional digits.']); const value = Number(text); if (!isValidQuantity(value)) throw new EInvoiceValidationError(['Invoice quantity must be greater than zero and within the supported bound.']); return value }
function isValidQuantity(quantity: number) { return Number.isFinite(quantity) && quantityParts(quantity) !== undefined }
function formatQuantity(quantity: number) { const parts = quantityParts(quantity); if (!parts) throw new EInvoiceValidationError(['Invoice quantity must use a bounded non-exponent decimal with at most six fractional digits.']); return parts.text }
function formatDecimal(coefficient: bigint, precision: number) { const digits = coefficient.toString().padStart(precision + 1, '0'); const value = `${digits.slice(0, -precision)}.${digits.slice(-precision)}`.replace(/0+$/, '').replace(/\.$/, ''); return value || '0' }
function roundRatio(numerator: bigint, denominator: bigint) { return (numerator + denominator / BigInt(2)) / denominator }
function unitPrice(netAmountCents: number, quantity: number): string | undefined { const parts = quantityParts(quantity); if (!parts || !Number.isSafeInteger(netAmountCents) || netAmountCents < 0) return undefined; for (let precision = 6; precision <= 12; precision++) { const priceScale = BigInt(10) ** BigInt(precision); const coefficient = roundRatio(BigInt(netAmountCents) * parts.scale * priceScale, BigInt(100) * parts.coefficient); const reconstructed = roundRatio(coefficient * parts.coefficient * BigInt(100), priceScale * parts.scale); if (reconstructed === BigInt(netAmountCents)) return formatDecimal(coefficient, precision) } }
function isRepresentableUnitPrice(netAmountCents: number, quantity: number) { return unitPrice(netAmountCents, quantity) !== undefined }
function formatUnitPrice(netAmountCents: number, quantity: number) { const value = unitPrice(netAmountCents, quantity); if (value === undefined) throw new EInvoiceValidationError(['Line net amount cannot be represented consistently by quantity and unit price.']); return value }
function isRealDate(value: string) { if (!isoDate.test(value)) return false; const date = new Date(`${value}T00:00:00Z`); return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value }
function isValidIban(value: string) { const iban = value.replace(/\s/g, '').toUpperCase(); const lengths: Record<string, number> = { AL:28, AD:24, AT:20, AZ:28, BH:22, BE:16, BA:20, BR:29, BG:22, CR:22, HR:21, CY:28, CZ:24, DK:18, DO:28, EE:20, FO:18, FI:18, FR:27, GE:22, DE:22, GI:23, GR:27, GL:18, GT:28, HU:28, IS:26, IE:22, IL:23, IT:27, JO:30, KZ:20, XK:20, KW:30, LV:21, LB:28, LI:21, LT:20, LU:20, MK:19, MT:31, MR:27, MU:30, MC:27, MD:24, ME:22, NL:18, NO:15, PK:24, PS:29, PL:28, PT:25, QA:29, RO:24, LC:32, SM:27, ST:25, SA:24, RS:22, SC:31, SK:24, SI:19, ES:24, SE:24, CH:21, TL:23, TN:24, TR:26, UA:29, AE:23, GB:22, VA:22, VG:24 }; if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(iban) || lengths[iban.slice(0, 2)] !== iban.length) return false; const rearranged = iban.slice(4) + iban.slice(0, 4); let remainder = 0; for (const char of rearranged) { const digits = /[A-Z]/.test(char) ? String(char.charCodeAt(0) - 55) : char; for (const digit of digits) remainder = (remainder * 10 + Number(digit)) % 97 } return remainder === 1 }
function roundProduct(value: number, multiplier: number, denominator: number) { if (!Number.isSafeInteger(value) || !Number.isSafeInteger(multiplier) || !Number.isSafeInteger(denominator) || denominator <= 0) return Number.NaN; const result = (BigInt(value) * BigInt(multiplier) + BigInt(Math.floor(denominator / 2))) / BigInt(denominator); const number = Number(result); return Number.isSafeInteger(number) ? number : Number.NaN }
function safeMoneySum(values: readonly number[]) { if (values.some(value => !Number.isSafeInteger(value))) return Number.NaN; const result = values.reduce((sum, value) => sum + BigInt(value), BigInt(0)); const number = Number(result); return Number.isSafeInteger(number) ? number : Number.NaN }
function isXml10CodePoint(code: number) { return code === 0x9 || code === 0xa || code === 0xd || (code >= 0x20 && code <= 0xd7ff) || (code >= 0xe000 && code <= 0xfffd) || (code >= 0x10000 && code <= 0x10ffff) }
function isXml10Text(value: string) { for (const char of value) if (!isXml10CodePoint(char.codePointAt(0)!)) return false; return true }
function isXmlWhitespace(value: string) { return /^[ \t\r\n]*$/.test(value) }
function trimXmlWhitespace(value: string) { return value.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, '') }
function isXmlQName(value: string) { return /^(?:[A-Za-z_][A-Za-z0-9_.-]*:)?[A-Za-z_][A-Za-z0-9_.-]*$/.test(value) }
function deepFreeze<T>(value: T): Readonly<T> { if (value && typeof value === 'object') { Object.freeze(value); Object.values(value).forEach(deepFreeze) } return value }
