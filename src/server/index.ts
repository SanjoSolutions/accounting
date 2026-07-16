import 'server-only'

import { randomUUID } from 'node:crypto'
import { BookingRecord } from '@/core/BookingRecord'
import { Document } from '@/core/Document'
import type { Invoice } from '@/core/Invoice'
import { Tax } from '@/core/Tax'
import { TaxAmount } from '@/core/TaxAmount'
import { Account } from '@/core/authentication/Account'
import fixture from './dataFixtures/results_11048337544652359545_0_Invoice_Example_English-0.json'
import { createPrismaPersistence } from './persistence/prisma'
import { getDocumentStorage } from './storage'

const persistence = createPrismaPersistence()
const companySettingsId = 'default'

export interface DocumentFileInput {
  content: Buffer
  contentType: string
  fileName: string
}

export async function createBookingRecord(data: any): Promise<void> {
  const { date, debitSide, creditSide } = data
  await persistence.bookingRecords.save(new BookingRecord(new Date(date), debitSide, creditSide))
}

export async function getSettings(): Promise<Account> {
  let account = await persistence.accounts.findOne(companySettingsId)

  if (!account) {
    account = new Account(companySettingsId)
    await persistence.accounts.save(account)
  }

  return account
}

export async function updateSettings(data: any): Promise<void> {
  const account = await getSettings()
  const invoiceIssuer = data.invoiceIssuer ?? {}

  Object.assign(account.invoiceIssuer, {
    name: invoiceIssuer.name,
    streetAndHouseNumber: invoiceIssuer.streetAndHouseNumber,
    zipCode: invoiceIssuer.zipCode,
    city: invoiceIssuer.city,
    country: invoiceIssuer.country,
  })
  await persistence.accounts.save(account)
}

export async function createDocument(input: DocumentFileInput, ownerId: string): Promise<Document> {
  validateDocumentFile(input)

  const id = randomUUID()
  const storageKey = `documents/${ encodeURIComponent(ownerId) }/${ id }.pdf`
  const fileName = sanitizeFileName(input.fileName)
  const contentType = 'application/pdf'
  const storage = getDocumentStorage()

  await storage.write(storageKey, input.content, { contentType, fileName })

  try {
    const document = new Document(
      id,
      `/api/documents/${ id }/file`,
      storageKey,
      fileName,
      contentType,
      input.content.length,
      ownerId,
    )
    await persistence.documents.save(document)
    return document
  } catch (error) {
    await storage.delete(storageKey).catch(() => undefined)
    throw error
  }
}

export async function readDocumentFile(documentId: string, ownerId: string): Promise<{
  content: Buffer
  contentType: string
  fileName: string
} | null> {
  const document = await persistence.documents.findOne(documentId)
  if (!document?.storageKey || document.ownerId !== ownerId) return null

  const storage = getDocumentStorage()
  if (!await storage.exists(document.storageKey)) return null

  return {
    content: await storage.read(document.storageKey),
    contentType: document.contentType || 'application/octet-stream',
    fileName: document.fileName || `${ document.id }.pdf`,
  }
}

export async function requestDocumentParsing(
  documentId: string,
  ownerId: string,
): Promise<Invoice | null> {
  const document = await persistence.documents.findOne(documentId)

  if (!document?.storageKey || document.ownerId !== ownerId) return null

  const invoice = document as Invoice
  invoice.netAmount = getMoneyValue(fixture, 'net_amount')!
  invoice.tax = new TaxAmount(
    getTaxAmount(fixture)!,
    new Tax('19% VAT', 0.19),
  )
  invoice.total = getMoneyValue(fixture, 'total_amount')!
  await persistence.documents.save(invoice)
  return invoice
}

export function getMaxDocumentUploadBytes(): number {
  const maxSize = Number(process.env.DOCUMENT_STORAGE_MAX_UPLOAD_BYTES || 20 * 1024 * 1024)
  if (!Number.isSafeInteger(maxSize) || maxSize <= 0) {
    throw new Error('DOCUMENT_STORAGE_MAX_UPLOAD_BYTES must be a positive integer')
  }
  return maxSize
}

function validateDocumentFile({ content, contentType, fileName }: DocumentFileInput): void {
  const maxSize = getMaxDocumentUploadBytes()
  if (content.length === 0) throw new DocumentUploadError('The document is empty')
  if (content.length > maxSize) {
    throw new DocumentUploadError(`The document exceeds ${ maxSize } bytes`)
  }
  if (!fileName.toLowerCase().endsWith('.pdf')) {
    throw new DocumentUploadError('Only PDF documents are supported')
  }
  if (contentType.split(';', 1)[0].trim() !== 'application/pdf') {
    throw new DocumentUploadError('Only PDF documents are supported')
  }
  if (content.subarray(0, 5).toString('ascii') !== '%PDF-') {
    throw new DocumentUploadError('The uploaded file is not a valid PDF document')
  }
}

function sanitizeFileName(fileName: string): string {
  const sanitized = fileName.replace(/[^a-zA-Z0-9._ -]/g, '_').slice(0, 200)
  return sanitized.toLowerCase().endsWith('.pdf') ? sanitized : `${ sanitized }.pdf`
}

export class DocumentUploadError extends Error {}

function getTaxAmount(data: any): number | null {
  const tax = getObjectWithType(data.entities, 'vat')
  const taxAmount = tax && getObjectWithType(tax.properties, 'vat/tax_amount')
  return taxAmount ? normalizedMoneyValue(taxAmount) : null
}

function getMoneyValue(data: any, type: string): number | null {
  const entity = getObjectWithType(data.entities, type)
  return entity ? normalizedMoneyValue(entity) : null
}

function getObjectWithType(items: any[], type: string): any | null {
  return items.find((item: any) => item.type === type) ?? null
}

function normalizedMoneyValue(entity: any): number {
  const { units, nanos = 0 } = entity.normalizedValue.moneyValue
  return Number(units) + Number(nanos) / 1_000_000_000
}
