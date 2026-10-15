import 'server-only'

import { createHash, randomUUID } from 'node:crypto'
import type { DocumentExtraction, Prisma } from '@/generated/prisma/client'
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
  attemptId: string | null
  leaseExpiresAt: string | null
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
  const now = new Date()
  if (current?.status === 'PROCESSING' && current.leaseExpiresAt && current.leaseExpiresAt > now) {
    throw new DocumentExtractionError(`Document extraction is already processing. Retry after ${current.leaseExpiresAt.toISOString()}.`, 409)
  }
  // The lease covers the parser budget plus time to persist its outcome. A
  // crashed process needs no cleanup job: POST can reclaim an expired lease.
  // Pre-lease PROCESSING rows (NULL expiry) are recoverable after deployment.
  const claim = {
    status: 'PROCESSING', provider: provider.id, providerVersion: provider.version, inputHash,
    attempt: (current?.attempt ?? 0) + 1, attemptId: randomUUID(),
    leaseExpiresAt: new Date(now.getTime() + timeoutMs + 30_000),
  }
  const processing = await prisma.$transaction(async transaction => {
    let row: DocumentExtraction
    if (current) {
      row = await transition(transaction, current, actorId,
        current.status === 'PROCESSING' ? 'DOCUMENT_EXTRACTION_RECOVERED' : 'DOCUMENT_EXTRACTION_STARTED',
        { ...claim, extractedData: null, rawTextHash: null, failureCode: null, failureMessage: null, retryable: false, reviewedBy: null, reviewedAt: null },
        current.status === 'PROCESSING' ? { OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: now } }] } : {},
      )
    } else {
      try {
        // The unique documentId is the conditional claim for the first attempt.
        row = await transaction.documentExtraction.create({ data: { ownerId, documentId, ...claim } })
      } catch (error) {
        if (error && typeof error === 'object' && 'code' in error && error.code === 'P2002') throw extractionChanged()
        throw error
      }
      await audit(transaction, actorId, 'DOCUMENT_EXTRACTION_STARTED', undefined, row)
    }
    return row
  })

  let result: Awaited<ReturnType<InvoiceExtractionProvider['extract']>>
  try {
    const controller = new AbortController()
    result = await withTimeout(provider.extract({ content: file.content, fileName: file.fileName, signal: controller.signal }), timeoutMs, controller)
  } catch (error) {
    const timedOut = error instanceof ParserTimeoutError
    return fail(processing, actorId, timedOut ? 'PARSER_TIMEOUT' : 'PARSER_FAILURE', timedOut ? error.message : 'The local PDF parser could not extract this document.', true)
  }
  // Persistence/audit failures must propagate, not become parser failures. The
  // transaction rolls back and the attempt remains recoverable by lease expiry.
  if (!result.data) {
    const code = result.failureCode ?? 'UNRECOGNIZED_INVOICE'
    return fail(processing, actorId, code, code === 'NEEDS_OCR' ? 'This PDF has no readable text layer. Configure an OCR provider or enter the invoice manually.' : 'No complete, arithmetically consistent invoice facts were found.', false, result.rawTextHash)
  }
  return finishAttempt(processing, actorId, 'DOCUMENT_EXTRACTION_COMPLETED', { status: 'NEEDS_REVIEW', extractedData: JSON.stringify(result.data), rawTextHash: result.rawTextHash, failureCode: null, failureMessage: null, retryable: false })
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
  const updated = await prisma.$transaction(transaction => transition(transaction, current, actorId, 'DOCUMENT_EXTRACTION_CONFIRMED', {
    status: 'CONFIRMED', extractedData: JSON.stringify(confirmedData), reviewedBy: actorId, reviewedAt, leaseExpiresAt: null, failureCode: null, failureMessage: null, retryable: false,
  }))
  return publicExtraction(updated)
}

function sameInvoiceFacts(left: InvoiceExtractionData, right: InvoiceExtractionData) {
  return ['supplierName', 'invoiceNumber', 'issueDate', 'netAmountCents', 'taxAmountCents', 'grossAmountCents', 'currency'].every(key => left[key as keyof InvoiceExtractionData] === right[key as keyof InvoiceExtractionData])
}

async function fail(processing: DocumentExtraction, actorId: string, failureCode: string, failureMessage: string, retryable: boolean, rawTextHash: string | null = null) {
  return finishAttempt(processing, actorId, 'DOCUMENT_EXTRACTION_FAILED', { status: 'FAILED', extractedData: null, rawTextHash, failureCode, failureMessage, retryable })
}

async function finishAttempt(processing: DocumentExtraction, actorId: string, action: string, data: Prisma.DocumentExtractionUpdateManyMutationInput) {
  const updated = await prisma.$transaction(transaction => transition(transaction, processing, actorId, action,
    { ...data, leaseExpiresAt: null }, { leaseExpiresAt: { gt: new Date() } },
  ))
  return publicExtraction(updated)
}

function extractionChanged() {
  return new DocumentExtractionError('Document extraction changed or its lease expired. Reload and retry.', 409)
}

async function transition(transaction: Prisma.TransactionClient, before: DocumentExtraction, actorId: string, action: string, data: Prisma.DocumentExtractionUpdateManyMutationInput, condition: Prisma.DocumentExtractionWhereInput = {}) {
  // Write first to avoid upgrading a SQLite read transaction. Status and attempt
  // fencing also protect confirmations from snapshots read before a new claim.
  const changed = await transaction.documentExtraction.updateMany({
    where: { id: before.id, ownerId: before.ownerId, status: before.status, attempt: before.attempt, attemptId: before.attemptId, ...condition }, data,
  })
  if (changed.count !== 1) throw extractionChanged()
  const after = await transaction.documentExtraction.findUniqueOrThrow({ where: { id: before.id } })
  await audit(transaction, actorId, action, before, after)
  return after
}

async function audit(transaction: Prisma.TransactionClient, actorId: string, action: string, before: DocumentExtraction | undefined, after: DocumentExtraction) {
  await appendAuditEvent(transaction, { ownerId: after.ownerId, actorId, action, reason: 'Authenticated document extraction workflow', objectType: 'DocumentExtraction', objectId: after.documentId, before: before ? publicExtraction(before) : undefined, after: publicExtraction(after) })
}

function publicExtraction(row: DocumentExtraction): PublicDocumentExtraction {
  return { id: row.id, documentId: row.documentId, status: row.status, provider: row.provider, providerVersion: row.providerVersion, inputHash: row.inputHash, attempt: row.attempt, attemptId: row.attemptId, leaseExpiresAt: row.leaseExpiresAt?.toISOString() ?? null, data: row.extractedData ? JSON.parse(row.extractedData) as InvoiceExtractionData : null, rawTextHash: row.rawTextHash, failureCode: row.failureCode, failureMessage: row.failureMessage, retryable: row.retryable, reviewedAt: row.reviewedAt?.toISOString() ?? null }
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
