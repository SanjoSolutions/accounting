import 'server-only'

import { createHash, randomUUID } from 'node:crypto'
import { Document } from '@/core/Document'
import {
  EInvoiceValidationError,
  InvoiceCorrectionChain,
  extractUncompressedStructuredInvoiceFromPdf,
  generateUblInvoice,
  receiveStructuredInvoice,
  renderInvoiceHtml,
  type InvoiceDocumentKind,
  type StructuredInvoiceData,
  type ValidatedEInvoice,
} from '@/core/eInvoice'
import { prisma } from '@/server/persistence/client'
import { getDocumentStorage } from '@/server/storage'
import { importedInvoiceNumbersHash } from './operations'

const MAX_STRUCTURED_UPLOAD = 20 * 1024 * 1024
export class StructuredInvoiceConflictError extends Error {}

export type StructuredInvoiceInput = Omit<StructuredInvoiceData, 'syntax' | 'invoiceNumber'>
export function requireInvoiceIssuanceBody(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new EInvoiceValidationError(['Invoice issuance requires a JSON object.'])
  return value as Record<string, unknown>
}

function stableJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value).filter(key => (value as Record<string, unknown>)[key] !== undefined).sort().map(key => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`).join(',')}}`
  throw new EInvoiceValidationError(['Invoice issuance data contains an unsupported value.'])
}

function canonicalMediaType(value: string) {
  return value.split(';', 1)[0].trim().toLowerCase()
}

function sanitizeName(value: string, fallback: string) {
  const name = value.replace(/[\x00-\x1f\x7f\\/:*?"<>|]/g, '_').trim()
  return (name || fallback).slice(0, 200)
}

export function looksLikeHybridInvoice(content: Uint8Array, _fileName: string) {
  const text = new TextDecoder('latin1').decode(content)
  const recognizedInvoiceAttachment = /(?:factur-x|zugferd-invoice|xrechnung)[.]xml/i.test(text)
  return recognizedInvoiceAttachment && /\/AFRelationship\s*\/(?:Data|Alternative)/.test(text)
}

export function looksLikeStructuredInvoiceXml(content: Uint8Array) {
  const text = new TextDecoder('utf-8').decode(content)
  const root = /^\uFEFF?\s*(?:<\?xml\s[^?]*\?>\s*)?(?:(?:<!--[\s\S]*?-->|<\?(?!xml\b)[\s\S]*?\?>)\s*)*<([A-Za-z_][\w.-]*(?::[A-Za-z_][\w.-]*)?)(\s[^<>]*?)?\/?\s*>/i.exec(text)
  if (!root) return false
  const [prefix = '', localName] = root[1].includes(':') ? root[1].split(':', 2) : ['', root[1]]
  const namespaceName = prefix ? `xmlns:${prefix}` : 'xmlns'
  const namespace = new RegExp(`(?:^|\\s)${namespaceName.replace(':', '\\:')}\\s*=\\s*["']([^"']+)["']`).exec(root[2] ?? '')?.[1]
  if (localName === 'Invoice') return namespace === 'urn:oasis:names:specification:ubl:schema:xsd:Invoice-2'
  if (localName === 'CreditNote') return namespace === 'urn:oasis:names:specification:ubl:schema:xsd:CreditNote-2'
  return localName === 'CrossIndustryInvoice' && namespace === 'urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100'
}

export function parseStructuredUpload(content: Uint8Array, contentType: string, fileName: string): ValidatedEInvoice | null {
  const mediaType = canonicalMediaType(contentType)
  const xml = mediaType === 'application/xml' || mediaType === 'text/xml' || fileName.toLowerCase().endsWith('.xml')
  if (xml) {
    if (!looksLikeStructuredInvoiceXml(content)) return null
    if (!content.byteLength) throw new EInvoiceValidationError(['The structured invoice is empty.'])
    if (content.byteLength > MAX_STRUCTURED_UPLOAD) throw new EInvoiceValidationError(['The structured invoice exceeds 20 MiB.'])
    return receiveStructuredInvoice(content)
  }
  if (mediaType !== 'application/pdf' && !fileName.toLowerCase().endsWith('.pdf')) return null
  if (!looksLikeHybridInvoice(content, fileName)) return null
  if (!content.byteLength) throw new EInvoiceValidationError(['The structured invoice is empty.'])
  if (content.byteLength > MAX_STRUCTURED_UPLOAD) throw new EInvoiceValidationError(['The structured invoice exceeds 20 MiB.'])
  const { xmlBytes, extraction } = extractUncompressedStructuredInvoiceFromPdf(content)
  return receiveStructuredInvoice(xmlBytes, extraction)
}

export function invoiceIssuerKey(invoice: ValidatedEInvoice, direction: 'INCOMING' | 'OUTGOING', ownerId: string) {
  if (direction === 'OUTGOING') return createHash('sha256').update(`owner:${ownerId}`).digest('hex')
  const seller = invoice.data.seller
  const stableId = seller.vatId?.replace(/[\s.-]/g, '').toUpperCase() || seller.taxId?.replace(/\s/g, '').toUpperCase()
  const identity = stableId ? ['registered', stableId] : ['fallback', ...[seller.name, seller.street, seller.postalCode, seller.city, seller.countryCode].map(value => value.trim().replace(/\s+/g, ' ').toLocaleLowerCase('de-DE'))]
  return createHash('sha256').update(JSON.stringify(identity)).digest('hex')
}

export async function storeStructuredInvoice(ownerId: string, invoice: ValidatedEInvoice, fileName?: string, correctsId?: string, direction: 'INCOMING' | 'OUTGOING' = 'INCOMING', reservationId?: string, issuanceRequestId?: string) {
  if (!ownerId.trim()) throw new EInvoiceValidationError(['A tenant owner is required.'])
  const id = randomUUID()
  const documentId = randomUUID()
  const main = invoice.visualOriginal ?? invoice.structuredOriginal
  const extension = invoice.visualOriginal ? 'pdf' : 'xml'
  const storageKey = `documents/${encodeURIComponent(ownerId)}/${documentId}.${extension}`
  const safeFileName = sanitizeName(fileName ?? `${invoice.data.invoiceNumber}.${extension}`, `invoice.${extension}`)
  const storage = getDocumentStorage()
  const issuerKey = invoiceIssuerKey(invoice, direction, ownerId)
  if (issuanceRequestId) {
    const linked = await prisma.invoiceIssuanceRequest.updateMany({ where: { id: issuanceRequestId, ownerId, status: 'PROCESSING' }, data: { storageKey } })
    if (linked.count !== 1) throw new EInvoiceValidationError(['The invoice issuance request is missing before durable storage.'])
  }
  try {
    await storage.write(storageKey, Buffer.from(main.bytes), { contentType: main.mediaType, fileName: `${documentId}.${extension}` })
    const document = new Document(documentId, `/api/documents/${documentId}/file`, storageKey, safeFileName, main.mediaType, main.bytes.byteLength, ownerId)
    const record = await prisma.$transaction(async transaction => {
      let effectiveCorrectsId = correctsId
      if (!effectiveCorrectsId && invoice.data.kind !== 'invoice') {
        const target = await transaction.structuredInvoice.findFirst({ where: { ownerId, direction, issuerKey, invoiceNumber: invoice.data.correctedInvoiceNumber! } })
        effectiveCorrectsId = target?.id
      }
      if (invoice.data.kind !== 'invoice' && !effectiveCorrectsId) throw new EInvoiceValidationError(['A correction must link to an existing immutable invoice for this tenant.'])
      if (effectiveCorrectsId) {
        const target = await transaction.structuredInvoice.findFirst({ where: { id: effectiveCorrectsId, ownerId, direction } })
        if (!target) throw new EInvoiceValidationError(['The corrected invoice does not belong to this tenant.'])
      }
      await transaction.documentRecord.create({ data: { id: documentId, ownerId, payload: JSON.stringify(document) } })
      const created = await transaction.structuredInvoice.create({ data: {
        id, ownerId, documentId, syntax: invoice.data.syntax, kind: invoice.data.kind, direction, issuerKey,
        invoiceNumber: invoice.data.invoiceNumber, issueDate: new Date(`${invoice.data.issueDate}T00:00:00.000Z`),
        structuredHash: invoice.structuredOriginal.sha256, visualHash: invoice.visualOriginal?.sha256,
        originalMediaType: main.mediaType, structuredOriginal: Buffer.from(invoice.structuredOriginal.bytes),
        visualOriginal: invoice.visualOriginal ? Buffer.from(invoice.visualOriginal.bytes) : undefined, data: JSON.stringify(invoice.data),
        provenance: JSON.stringify(invoice.provenance), renderedHtml: renderInvoiceHtml(invoice), correctsId: effectiveCorrectsId,
      } })
      if (reservationId) {
        const issued = await transaction.invoiceNumberReservation.updateMany({ where: { id: reservationId, ownerId, invoiceNumber: invoice.data.invoiceNumber, status: 'RESERVED' }, data: { status: 'ISSUED', structuredInvoiceId: id } })
        if (issued.count !== 1) throw new EInvoiceValidationError(['The outgoing invoice number reservation is missing or no longer available.'])
      }
      if (issuanceRequestId) {
        const completed = await transaction.invoiceIssuanceRequest.updateMany({ where: { id: issuanceRequestId, ownerId, status: 'PROCESSING' }, data: { status: 'ISSUED', structuredInvoiceId: id, error: null } })
        if (completed.count !== 1) throw new EInvoiceValidationError(['The invoice issuance request is missing or no longer claimable.'])
      }
      return created
    })
    return publicStructuredInvoice(record)
  } catch (error) {
    await storage.delete(storageKey).catch(() => undefined)
    if (error && typeof error === 'object' && 'code' in error && error.code === 'P2002') throw new StructuredInvoiceConflictError('This structured invoice was already stored for the tenant and issuer.')
    throw error
  }
}

export async function configureInvoiceNumberSequence(ownerId: string, year: number, firstUnusedNumber: number, confirmedExistingSeries: boolean) {
  if (!Number.isInteger(year) || year < 2000 || year > 9999 || !Number.isInteger(firstUnusedNumber) || firstUnusedNumber < 1 || firstUnusedNumber > 999_999 || confirmedExistingSeries !== true) throw new EInvoiceValidationError(['Explicitly confirm the first unused number (1-999999) for a valid invoice year.'])
  return prisma.$transaction(async transaction => {
    const existing = await transaction.invoiceNumberSequence.findUnique({ where: { ownerId_year: { ownerId, year } } })
    if (existing) {
      if (existing.nextValue !== firstUnusedNumber) throw new EInvoiceValidationError(['The initialized invoice numbering series is immutable after setup.'])
      return existing
    }
    const [reservations, issued] = await Promise.all([
      transaction.invoiceNumberReservation.count({ where: { ownerId, year } }),
      transaction.structuredInvoice.count({ where: { ownerId, direction: 'OUTGOING', issueDate: { gte: new Date(`${year}-01-01T00:00:00.000Z`), lte: new Date(`${year}-12-31T23:59:59.999Z`) } } }),
    ])
    if (reservations || issued) throw new EInvoiceValidationError(['The invoice numbering series cannot be initialized after outgoing invoice activity exists for the year.'])
    return transaction.invoiceNumberSequence.create({ data: { ownerId, year, nextValue: firstUnusedNumber } })
  })
}
export function parseImportedInvoiceSequence(year: number, importedInvoiceNumbers: readonly string[], firstUnusedNumber: number) {
  if (!Number.isInteger(year) || year < 2000 || year > 9999 || !Array.isArray(importedInvoiceNumbers) || importedInvoiceNumbers.some(value => typeof value !== 'string')) throw new EInvoiceValidationError(['Imported invoice-number reconciliation requires a valid year and string invoice numbers.'])
  if (new Set(importedInvoiceNumbers).size !== importedInvoiceNumbers.length) throw new EInvoiceValidationError(['Imported invoice numbers must be unique.'])
  const pattern = new RegExp(`^${year}-(\\d{6})$`)
  const values = importedInvoiceNumbers.map(number => {
    const match = pattern.exec(number)
    if (!match) throw new EInvoiceValidationError([`Imported invoice number ${number} does not match the canonical ${year}-NNNNNN series.`])
    const value = Number(match[1])
    if (value < 1 || value > 999_999) throw new EInvoiceValidationError([`Imported invoice number ${number} must remain within the canonical 1-999999 range.`])
    return value
  })
  const highest = values.length ? Math.max(...values) : undefined
  if (!Number.isInteger(firstUnusedNumber) || firstUnusedNumber < 1 || firstUnusedNumber > 999_999 || highest !== undefined && firstUnusedNumber !== highest + 1) throw new EInvoiceValidationError(['The confirmed first unused number must immediately follow the highest imported invoice number and remain within 1-999999.'])
  return { highest, hash: importedInvoiceNumbersHash(importedInvoiceNumbers) }
}

export async function reconcileInvoiceNumberSequence(ownerId: string, actorId: string, year: number, firstUnusedNumber: number, importedInvoiceNumbers: readonly string[], confirmedExistingSeries: boolean) {
  if (confirmedExistingSeries !== true || !actorId.trim()) throw new EInvoiceValidationError(['An authenticated administrator must explicitly confirm the reconciled first unused invoice number.'])
  const imported = parseImportedInvoiceSequence(year, importedInvoiceNumbers, firstUnusedNumber)
  return prisma.$transaction(async transaction => {
    const localNumbers = await transaction.structuredInvoice.findMany({ where: { ownerId, direction: 'OUTGOING', issueDate: { gte: new Date(`${year}-01-01T00:00:00.000Z`), lte: new Date(`${year}-12-31T23:59:59.999Z`) } }, select: { invoiceNumber: true } })
    const localReservations = await transaction.invoiceNumberReservation.findMany({ where: { ownerId, year }, select: { sequenceValue: true } })
    const localValues = [...localNumbers.map(({ invoiceNumber }) => new RegExp(`^${year}-(\\d{6})$`).exec(invoiceNumber)).filter((match): match is RegExpExecArray => Boolean(match)).map(match => Number(match[1])), ...localReservations.map(({ sequenceValue }) => sequenceValue)]
    const localHighest = localValues.length ? Math.max(...localValues) : undefined
    if (localHighest !== undefined && firstUnusedNumber <= localHighest) throw new EInvoiceValidationError(['The confirmed first unused number conflicts with an issued, reserved or voided local invoice number.'])
    const onboarding = await transaction.invoiceNumberSequenceOnboarding.findUnique({ where: { ownerId_year: { ownerId, year } } })
    if (onboarding) throw new EInvoiceValidationError(['The invoice-number onboarding reconciliation evidence is immutable after setup.'])
    const existing = await transaction.invoiceNumberSequence.findUnique({ where: { ownerId_year: { ownerId, year } } })
    if (existing && firstUnusedNumber < existing.nextValue) throw new EInvoiceValidationError(['Invoice sequence reconciliation cannot move the next number backwards.'])
    const sequence = existing ? await transaction.invoiceNumberSequence.update({ where: { ownerId_year: { ownerId, year } }, data: { nextValue: firstUnusedNumber } }) : await transaction.invoiceNumberSequence.create({ data: { ownerId, year, nextValue: firstUnusedNumber } })
    await transaction.invoiceNumberSequenceOnboarding.create({ data: { ownerId, year, firstUnusedNumber, importedHighestNumber: imported.highest, importedCount: importedInvoiceNumbers.length, importedNumbersHash: imported.hash, confirmedBy: actorId } })
    return { ownerId, year, nextValue: sequence.nextValue, importedHighestNumber: imported.highest ?? null, importedCount: importedInvoiceNumbers.length, importedNumbersHash: imported.hash }
  })
}
export function requireAllocatableInvoiceSequence(nextValue: number) { if (!Number.isInteger(nextValue) || nextValue < 1 || nextValue > 999_999) throw new EInvoiceValidationError(['The configured six-digit invoice numbering series is exhausted for this year.']); return nextValue }

async function nextInvoiceNumber(ownerId: string, year: number, issuanceRequestId: string) {
  return prisma.$transaction(async transaction => {
    const configured = await transaction.invoiceNumberSequence.findUnique({ where: { ownerId_year: { ownerId, year } } })
    if (!configured) throw new EInvoiceValidationError(['Initialize and confirm the tenant invoice numbering series for this year before issuance.'])
    requireAllocatableInvoiceSequence(configured.nextValue)
    const advanced = await transaction.invoiceNumberSequence.updateMany({ where: { ownerId, year, nextValue: { lte: 999_999 } }, data: { nextValue: { increment: 1 } } })
    if (advanced.count !== 1) throw new EInvoiceValidationError(['The configured six-digit invoice numbering series is exhausted for this year.'])
    const sequence = await transaction.invoiceNumberSequence.findUniqueOrThrow({ where: { ownerId_year: { ownerId, year } } })
    const value = sequence.nextValue - 1
    const invoiceNumber = `${year}-${String(value).padStart(6, '0')}`
    const reservation = await transaction.invoiceNumberReservation.create({ data: { ownerId, year, sequenceValue: value, invoiceNumber, status: 'RESERVED' } })
    const linked = await transaction.invoiceIssuanceRequest.updateMany({ where: { id: issuanceRequestId, ownerId, status: 'PROCESSING', reservationId: null }, data: { reservationId: reservation.id } })
    if (linked.count !== 1) throw new EInvoiceValidationError(['The invoice issuance request is missing or already allocated.'])
    return { invoiceNumber, reservationId: reservation.id }
  })
}

async function voidInvoiceNumber(ownerId: string, reservationId: string, error: unknown) {
  await prisma.invoiceNumberReservation.updateMany({ where: { id: reservationId, ownerId, status: 'RESERVED' }, data: { status: 'VOID', failureReason: (error instanceof Error ? error.message : 'Issuance failed').slice(0, 500) } })
}

async function prepareIssuedInvoice(ownerId: string, input: StructuredInvoiceInput, issuanceRequestId: string) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new EInvoiceValidationError(['Structured invoice data must be an object.'])
  if (typeof input.issueDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(input.issueDate)) throw new EInvoiceValidationError(['A real issue date is required before allocating an invoice number.'])
  const issueDate = new Date(`${input.issueDate}T00:00:00.000Z`)
  if (Number.isNaN(issueDate.valueOf()) || issueDate.toISOString().slice(0, 10) !== input.issueDate) throw new EInvoiceValidationError(['A real issue date is required before allocating an invoice number.'])
  const year = Number(input.issueDate.slice(0, 4))
  const account = await prisma.accountRecord.findFirst({ where: { ownerId }, select: { payload: true } })
  if (!account) throw new EInvoiceValidationError(['Configure the tenant company and invoice-issuer master data before issuing invoices.'])
  const master = JSON.parse(account.payload) as { invoiceIssuer?: { name?: string; streetAndHouseNumber?: string; zipCode?: string; city?: string; country?: string }; companyProfile?: { companyName?: string; taxNumber?: string; vatId?: string } }
  const issuer = master.invoiceIssuer; const company = master.companyProfile
  if (!issuer?.name?.trim() || !issuer.streetAndHouseNumber?.trim() || !issuer.zipCode?.trim() || !issuer.city?.trim() || !issuer.country?.trim() || !company?.taxNumber?.trim()) throw new EInvoiceValidationError(['Tenant invoice-issuer master data is incomplete.'])
  const canonicalInput = { ...input, seller: { name: company.companyName?.trim() || issuer.name.trim(), street: issuer.streetAndHouseNumber.trim(), postalCode: issuer.zipCode.trim(), city: issuer.city.trim(), countryCode: issuer.country.trim().toUpperCase(), taxId: company.taxNumber.trim(), ...(company.vatId?.trim() ? { vatId: company.vatId.trim().toUpperCase() } : {}) } }
  generateUblInvoice({ ...canonicalInput, invoiceNumber: 'VALIDATION-PENDING' })
  const allocation = await nextInvoiceNumber(ownerId, year, issuanceRequestId)
  try {
    const xml = generateUblInvoice({ ...canonicalInput, invoiceNumber: allocation.invoiceNumber })
    return { ...allocation, invoice: receiveStructuredInvoice(xml) }
  } catch (error) { await voidInvoiceNumber(ownerId, allocation.reservationId, error); throw error }
}

async function claimInvoiceIssuance(ownerId: string, requestKey: string, fingerprint: unknown) {
  if (!/^[A-Za-z0-9._:-]{16,100}$/.test(requestKey)) throw new EInvoiceValidationError(['A canonical 16-100 character invoice issuance request key is required.'])
  const requestHash = createHash('sha256').update(stableJson(fingerprint)).digest('hex')
  const resolve = async (request: { id: string; requestHash: string; status: string; reservationId: string | null; storageKey: string | null; structuredInvoiceId: string | null; updatedAt: Date }) => {
    if (request.requestHash !== requestHash) throw new EInvoiceValidationError(['The invoice issuance request key is already bound to different invoice data.'])
    if (request.structuredInvoiceId) {
      const invoice = await prisma.structuredInvoice.findFirst({ where: { id: request.structuredInvoiceId, ownerId }, select: structuredInvoiceMetadataSelect })
      if (!invoice) throw new EInvoiceValidationError(['The completed invoice issuance request has no tenant-owned invoice.'])
      return { requestId: request.id, existing: publicStructuredInvoice(invoice), claimed: false }
    }
    if (request.status !== 'FAILED') {
      if (!['PROCESSING', 'RECOVERING'].includes(request.status) || Date.now() - request.updatedAt.getTime() <= 5 * 60_000) throw new EInvoiceValidationError(['This invoice issuance request is already being processed.'])
      const recovering = await prisma.invoiceIssuanceRequest.updateMany({ where: { id: request.id, ownerId, status: request.status, updatedAt: request.updatedAt }, data: { status: 'RECOVERING', error: 'Recovering stale invoice issuance request.' } })
      if (recovering.count !== 1) throw new EInvoiceValidationError(['This invoice issuance request is already being processed.'])
      if (request.storageKey) await getDocumentStorage().delete(request.storageKey)
      if (request.reservationId) await prisma.invoiceNumberReservation.updateMany({ where: { id: request.reservationId, ownerId, status: 'RESERVED' }, data: { status: 'VOID', failureReason: 'Stale issuance request recovered before retry.' } })
      await prisma.invoiceIssuanceRequest.updateMany({ where: { id: request.id, ownerId, status: 'RECOVERING' }, data: { status: 'PROCESSING', reservationId: null, storageKey: null, error: null } })
      return { requestId: request.id, existing: null, claimed: true }
    }
    if (request.storageKey) await getDocumentStorage().delete(request.storageKey)
    const reclaimed = await prisma.invoiceIssuanceRequest.updateMany({ where: { id: request.id, ownerId, status: 'FAILED', structuredInvoiceId: null }, data: { status: 'PROCESSING', reservationId: null, storageKey: null, error: null } })
    if (reclaimed.count !== 1) throw new EInvoiceValidationError(['This invoice issuance request is already being processed.'])
    return { requestId: request.id, existing: null, claimed: true }
  }
  const existing = await prisma.invoiceIssuanceRequest.findUnique({ where: { ownerId_requestKey: { ownerId, requestKey } } })
  if (existing) return resolve(existing)
  try {
    const created = await prisma.invoiceIssuanceRequest.create({ data: { ownerId, requestKey, requestHash } })
    return { requestId: created.id, existing: null, claimed: true }
  } catch {
    const winner = await prisma.invoiceIssuanceRequest.findUnique({ where: { ownerId_requestKey: { ownerId, requestKey } } })
    if (!winner) throw new EInvoiceValidationError(['The invoice issuance request could not be claimed.'])
    return resolve(winner)
  }
}

async function idempotentInvoiceIssuance<T>(ownerId: string, requestKey: string, fingerprint: unknown, execute: (requestId: string) => Promise<T>): Promise<T> {
  const claim = await claimInvoiceIssuance(ownerId, requestKey, fingerprint)
  if (claim.existing) return claim.existing as T
  try { return await execute(claim.requestId) }
  catch (error) {
    await prisma.invoiceIssuanceRequest.updateMany({ where: { id: claim.requestId, ownerId, status: 'PROCESSING', structuredInvoiceId: null }, data: { status: 'FAILED', error: (error instanceof Error ? error.message : 'Invoice issuance failed').slice(0, 500) } })
    throw error
  }
}

export async function issueStructuredInvoice(ownerId: string, input: StructuredInvoiceInput, requestKey: string) {
  if (input?.kind !== 'invoice') throw new EInvoiceValidationError(['Credit notes, corrections and cancellations must use the immutable correction workflow.'])
  return idempotentInvoiceIssuance(ownerId, requestKey, { operation: 'issue', input }, async issuanceRequestId => {
    const prepared = await prepareIssuedInvoice(ownerId, input, issuanceRequestId)
    try { return await storeStructuredInvoice(ownerId, prepared.invoice, `${prepared.invoiceNumber}.xml`, undefined, 'OUTGOING', prepared.reservationId, issuanceRequestId) }
    catch (error) { await voidInvoiceNumber(ownerId, prepared.reservationId, error); throw error }
  })
}

export async function correctStructuredInvoice(ownerId: string, targetId: string, input: Omit<StructuredInvoiceInput, 'kind' | 'correctedInvoiceNumber'> & { kind: Exclude<InvoiceDocumentKind, 'invoice'> }, requestKey: string) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new EInvoiceValidationError(['Structured correction data must be an object.'])
  if (!['credit-note', 'correction', 'cancellation'].includes(input.kind)) throw new EInvoiceValidationError(['A correction must use credit-note, correction or cancellation kind.'])
  return idempotentInvoiceIssuance(ownerId, requestKey, { operation: 'correct', targetId, input }, async issuanceRequestId => {
  const target = await prisma.structuredInvoice.findFirst({ where: { id: targetId, ownerId, direction: 'OUTGOING' } })
  if (!target) throw new EInvoiceValidationError(['The corrected invoice does not exist for this tenant.'])
  const rows = await prisma.structuredInvoice.findMany({ where: { ownerId }, orderBy: { createdAt: 'asc' } })
  const byId = new Map(rows.map(row => [row.id, row]))
  const lineage = [] as typeof rows
  let cursor: typeof target | undefined = target
  const seen = new Set<string>()
  while (cursor) {
    if (seen.has(cursor.id)) throw new EInvoiceValidationError(['The stored correction chain is cyclic.'])
    seen.add(cursor.id); lineage.unshift(cursor); cursor = cursor.correctsId ? byId.get(cursor.correctsId) : undefined
  }
  const chain = new InvoiceCorrectionChain(lineage.map(row => ({ id: row.id, kind: row.kind as InvoiceDocumentKind, sha256: row.structuredHash, ...(row.correctsId ? { corrects: row.correctsId } : {}) })))
  const prepared = await prepareIssuedInvoice(ownerId, { ...input, kind: input.kind, correctedInvoiceNumber: target.invoiceNumber }, issuanceRequestId)
  try {
    chain.append({ id: `prospective:${prepared.invoiceNumber}`, kind: input.kind, sha256: prepared.invoice.structuredOriginal.sha256, corrects: target.id })
    return await storeStructuredInvoice(ownerId, prepared.invoice, `${prepared.invoiceNumber}.xml`, target.id, 'OUTGOING', prepared.reservationId, issuanceRequestId)
  } catch (error) { await voidInvoiceNumber(ownerId, prepared.reservationId, error); throw error }
  })
}

export async function listStructuredInvoices(ownerId: string) {
  return (await prisma.structuredInvoice.findMany({ where: { ownerId }, orderBy: { createdAt: 'desc' }, select: structuredInvoiceMetadataSelect })).map(publicStructuredInvoice)
}

export async function getStructuredInvoiceRendering(ownerId: string, id: string) {
  return prisma.structuredInvoice.findFirst({ where: { id, ownerId }, select: { renderedHtml: true } })
}

const structuredInvoiceMetadataSelect = { id: true, documentId: true, syntax: true, kind: true, direction: true, invoiceNumber: true, issueDate: true, structuredHash: true, visualHash: true, correctsId: true, createdAt: true } as const
function publicStructuredInvoice(record: { id: string; documentId: string; syntax: string; kind: string; direction: string; invoiceNumber: string; issueDate: Date; structuredHash: string; visualHash: string | null; correctsId: string | null; createdAt: Date }) {
  return { id: record.id, documentId: record.documentId, syntax: record.syntax, kind: record.kind, direction: record.direction, invoiceNumber: record.invoiceNumber, issueDate: record.issueDate.toISOString().slice(0, 10), structuredHash: record.structuredHash, visualHash: record.visualHash, correctsId: record.correctsId, createdAt: record.createdAt.toISOString() }
}
