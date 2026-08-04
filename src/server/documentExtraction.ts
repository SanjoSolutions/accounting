import 'server-only'

import { createHash } from 'node:crypto'
import type { InvoiceExtractionData } from '@/core/documentExtraction'
import { validateReviewedInvoiceExtraction } from '@/core/documentExtraction'
import { prisma } from './persistence/client'
import { readDocumentFile } from './index'
import { appendAuditEvent } from './compliance/auditPersistence'
import { LocalPdfTextInvoiceProvider, type InvoiceExtractionProvider } from './pdfTextInvoiceProvider'

export class DocumentExtractionError extends Error {
  constructor(message: string, readonly status: number) { super(message) }
}

export type PublicDocumentExtraction = {
  id: string
  documentId: string
  status: string
  provider: string
  providerVersion: string
  inputHash: string
  attempt: number
  data: InvoiceExtractionData | null
  rawTextHash: string | null
  failureCode: string | null
  failureMessage: string | null
  retryable: boolean
  reviewedAt: string | null
}

export async function getDocumentExtraction(ownerId: string, documentId: string): Promise<PublicDocumentExtraction | null> {
  const row = await prisma.documentExtraction.findFirst({ where: { ownerId, documentId } })
  return row ? publicExtraction(row) : null
}

export async function extractDocumentInvoice(
  ownerId: string,
  documentId: string,
  actorId = ownerId,
  provider: InvoiceExtractionProvider = new LocalPdfTextInvoiceProvider(),
  timeoutMs = configuredTimeout(),
): Promise<PublicDocumentExtraction> {
  const file = await readDocumentFile(documentId, ownerId)
  if (!file) throw new DocumentExtractionError('Document not found.', 404)
  const inputHash = createHash('sha256').update(file.content).digest('hex')
  const current = await prisma.documentExtraction.findFirst({ where: { ownerId, documentId } })
  if (current?.status === 'CONFIRMED') return publicExtraction(current)
  if (current?.status === 'NEEDS_REVIEW' && current.provider === 'structured-invoice') return publicExtraction(current)
  if (current?.status === 'NEEDS_REVIEW' && current.inputHash === inputHash && current.provider === provider.id && current.providerVersion === provider.version) return publicExtraction(current)
  if (current?.status === 'PROCESSING') throw new DocumentExtractionError('Document extraction is already processing.', 409)
  const attempt = (current?.attempt ?? 0) + 1
  const processing = await prisma.documentExtraction.upsert({
    where: { documentId },
    create: { ownerId, documentId, status: 'PROCESSING', provider: provider.id, providerVersion: provider.version, inputHash, attempt },
    update: { status: 'PROCESSING', provider: provider.id, providerVersion: provider.version, inputHash, attempt, extractedData: null, rawTextHash: null, failureCode: null, failureMessage: null, retryable: false, reviewedBy: null, reviewedAt: null },
  })
  await audit(ownerId, actorId, 'DOCUMENT_EXTRACTION_STARTED', documentId, current ? publicExtraction(current) : undefined, publicExtraction(processing))

  try {
    const controller = new AbortController()
    const result = await withTimeout(provider.extract({ content: file.content, fileName: file.fileName, signal: controller.signal }), timeoutMs, controller)
    if (!result.data) {
      const code = result.failureCode ?? 'UNRECOGNIZED_INVOICE'
      return await fail(ownerId, actorId, documentId, code, code === 'NEEDS_OCR' ? 'This PDF has no readable text layer. Configure an OCR provider or enter the invoice manually.' : 'No complete, arithmetically consistent invoice facts were found.', false, result.rawTextHash)
    }
    const completed = await prisma.documentExtraction.update({ where: { documentId }, data: { status: 'NEEDS_REVIEW', extractedData: JSON.stringify(result.data), rawTextHash: result.rawTextHash, failureCode: null, failureMessage: null, retryable: false } })
    await audit(ownerId, actorId, 'DOCUMENT_EXTRACTION_COMPLETED', documentId, publicExtraction(processing), publicExtraction(completed))
    return publicExtraction(completed)
  } catch (error) {
    const timedOut = error instanceof ParserTimeoutError
    return fail(ownerId, actorId, documentId, timedOut ? 'PARSER_TIMEOUT' : 'PARSER_FAILURE', timedOut ? error.message : 'The local PDF parser could not extract this document.', true)
  }
}

export async function confirmDocumentExtraction(ownerId: string, documentId: string, actorId: string, value: unknown): Promise<PublicDocumentExtraction> {
  const data = validateReviewedInvoiceExtraction(value)
  const current = await prisma.documentExtraction.findFirst({ where: { ownerId, documentId } })
  if (!current) throw new DocumentExtractionError('Document extraction not found.', 404)
  if (current.status !== 'NEEDS_REVIEW') throw new DocumentExtractionError('Only an extraction awaiting review can be confirmed.', 409)
  const authoritative = current.provider === 'structured-invoice' ? validateReviewedInvoiceExtraction(JSON.parse(current.extractedData ?? 'null')) : null
  if (authoritative && !sameInvoiceFacts(data, authoritative)) throw new DocumentExtractionError('Structured invoice facts are authoritative and cannot be changed during review.', 409)
  const reviewedAt = new Date()
  const confirmedData = authoritative ? { ...authoritative, provenance: 'STRUCTURED_INVOICE' as const } : data
  const updated = await prisma.documentExtraction.update({ where: { documentId }, data: { status: 'CONFIRMED', extractedData: JSON.stringify(confirmedData), reviewedBy: actorId, reviewedAt, failureCode: null, failureMessage: null, retryable: false } })
  await audit(ownerId, actorId, 'DOCUMENT_EXTRACTION_CONFIRMED', documentId, publicExtraction(current), publicExtraction(updated))
  return publicExtraction(updated)
}

function sameInvoiceFacts(left: InvoiceExtractionData, right: InvoiceExtractionData) {
  return ['supplierName', 'invoiceNumber', 'issueDate', 'netAmountCents', 'taxAmountCents', 'grossAmountCents', 'currency'].every(key => left[key as keyof InvoiceExtractionData] === right[key as keyof InvoiceExtractionData])
}

async function fail(ownerId: string, actorId: string, documentId: string, failureCode: string, failureMessage: string, retryable: boolean, rawTextHash: string | null = null) {
  const before = await prisma.documentExtraction.findFirstOrThrow({ where: { ownerId, documentId } })
  const updated = await prisma.documentExtraction.update({ where: { documentId }, data: { status: 'FAILED', extractedData: null, rawTextHash, failureCode, failureMessage, retryable } })
  await audit(ownerId, actorId, 'DOCUMENT_EXTRACTION_FAILED', documentId, publicExtraction(before), publicExtraction(updated))
  return publicExtraction(updated)
}

async function audit(ownerId: string, actorId: string, action: string, documentId: string, before: unknown, after: unknown) {
  await prisma.$transaction(transaction => appendAuditEvent(transaction, { ownerId, actorId, action, reason: 'Authenticated document extraction workflow', objectType: 'DocumentExtraction', objectId: documentId, before, after }))
}

function publicExtraction(row: { id: string; documentId: string; status: string; provider: string; providerVersion: string; inputHash: string; attempt: number; extractedData: string | null; rawTextHash: string | null; failureCode: string | null; failureMessage: string | null; retryable: boolean; reviewedAt: Date | null }): PublicDocumentExtraction {
  return { id: row.id, documentId: row.documentId, status: row.status, provider: row.provider, providerVersion: row.providerVersion, inputHash: row.inputHash, attempt: row.attempt, data: row.extractedData ? JSON.parse(row.extractedData) as InvoiceExtractionData : null, rawTextHash: row.rawTextHash, failureCode: row.failureCode, failureMessage: row.failureMessage, retryable: row.retryable, reviewedAt: row.reviewedAt?.toISOString() ?? null }
}

export function configuredTimeout(env: Readonly<Record<string, string | undefined>> = process.env) {
  const value = Number(env.DOCUMENT_EXTRACTION_TIMEOUT_MS ?? 10_000)
  if (!Number.isSafeInteger(value) || value < 100 || value > 60_000) throw new Error('DOCUMENT_EXTRACTION_TIMEOUT_MS must be between 100 and 60000.')
  return value
}

class ParserTimeoutError extends Error {}

async function withTimeout<T>(work: Promise<T>, timeoutMs: number, controller: AbortController): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => { const error = new ParserTimeoutError(`Document extraction exceeded ${timeoutMs} ms.`); controller.abort(error); reject(error) }, timeoutMs) })])
  } finally { if (timer) clearTimeout(timer) }
}
