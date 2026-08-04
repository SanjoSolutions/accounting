import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { PrismaClient } from '@/generated/prisma/client'
import type { InvoiceExtractionProvider } from './pdfTextInvoiceProvider'

vi.mock('server-only', () => ({}))
const directory = mkdtempSync(join(tmpdir(), 'accounting-document-extraction-'))
const databasePath = join(directory, 'test.db').replace(/\\/g, '/')
const storageRoot = join(directory, 'storage')
let api: typeof import('./documentExtraction')
let prisma: typeof import('@/server/persistence/client').prisma

beforeAll(async () => {
  const database = new DatabaseSync(databasePath)
  const migrations = resolve(process.cwd(), 'prisma', 'migrations')
  for (const name of readdirSync(migrations, { withFileTypes: true }).filter(item => item.isDirectory()).map(item => item.name).sort()) database.exec(readFileSync(join(migrations, name, 'migration.sql'), 'utf8'))
  database.close()
  process.env.DATABASE_URL = `file:${databasePath}`
  process.env.DOCUMENT_STORAGE_DRIVER = 'fs'
  process.env.DOCUMENT_STORAGE_ROOT = storageRoot
  process.env.AUDIT_INTEGRITY_SECRET = 'test-document-extraction-audit-secret'
  api = await import('./documentExtraction')
  prisma = (await import('@/server/persistence/client')).prisma
  const content = readFileSync('e2e/fixtures/invoice.pdf')
  for (const id of ['invoice-a', 'timeout-a']) {
    const storageKey = `documents/tenant-a/${id}.pdf`
    mkdirSync(join(storageRoot, 'documents', 'tenant-a'), { recursive: true })
    writeFileSync(join(storageRoot, storageKey), content)
    await prisma.documentRecord.create({ data: { id, ownerId: 'tenant-a', payload: JSON.stringify({ id, ownerId: 'tenant-a', storageKey, url: `/api/documents/${id}/file`, fileName: `${id}.pdf`, contentType: 'application/pdf', size: content.length }) } })
  }
})

afterAll(async () => {
  await prisma.$disconnect()
  delete process.env.DATABASE_URL
  delete process.env.DOCUMENT_STORAGE_DRIVER
  delete process.env.DOCUMENT_STORAGE_ROOT
  delete process.env.AUDIT_INTEGRITY_SECRET
  rmSync(directory, { recursive: true, force: true })
})

describe('persistent document extraction workflow', () => {
  it('Given authoritative structured facts, when review attempts to change them, then mutation is rejected and exact confirmation retains structured provenance', async () => {
    const facts = { supplierName: 'UBL Supplier GmbH', invoiceNumber: 'UBL-1', issueDate: '2026-08-01', netAmountCents: 10_000, taxAmountCents: 1_900, grossAmountCents: 11_900, currency: 'EUR', confidence: { supplierName: 1, invoiceNumber: 1, issueDate: 1, netAmountCents: 1, taxAmountCents: 1, grossAmountCents: 1 }, provenance: 'STRUCTURED_INVOICE' }
    await prisma.documentRecord.create({ data: { id: 'structured-a', ownerId: 'tenant-a', payload: '{}' } })
    await prisma.documentExtraction.create({ data: { ownerId: 'tenant-a', documentId: 'structured-a', status: 'NEEDS_REVIEW', provider: 'structured-invoice', providerVersion: 'EN16931-parser-1', inputHash: 'a'.repeat(64), extractedData: JSON.stringify(facts) } })
    await expect(api.confirmDocumentExtraction('tenant-a', 'structured-a', 'user-a', { ...facts, netAmountCents: 9_999, grossAmountCents: 11_899 })).rejects.toThrow(/authoritative/)
    await expect(api.confirmDocumentExtraction('tenant-a', 'structured-a', 'user-a', facts)).resolves.toMatchObject({ status: 'CONFIRMED', data: { provenance: 'STRUCTURED_INVOICE', netAmountCents: 10_000 } })
  })

  it('Given retained tenant PDF bytes, when extraction is retried and reviewed, then one hash-bound result persists with audit provenance', async () => {
    const first = await api.extractDocumentInvoice('tenant-a', 'invoice-a', 'user-a')
    const replay = await api.extractDocumentInvoice('tenant-a', 'invoice-a', 'user-a')
    expect(first).toMatchObject({ status: 'NEEDS_REVIEW', provider: 'local-pdf-text', attempt: 1, data: { invoiceNumber: 'E2E-2026-001', grossAmountCents: 11900 } })
    expect(replay.id).toBe(first.id)
    expect(replay.attempt).toBe(1)
    await expect(api.getDocumentExtraction('tenant-b', 'invoice-a')).resolves.toBeNull()

    const confirmed = await api.confirmDocumentExtraction('tenant-a', 'invoice-a', 'user-a', { ...first.data, supplierName: 'Reviewed Supplier GmbH' })
    expect(confirmed).toMatchObject({ status: 'CONFIRMED', data: { supplierName: 'Reviewed Supplier GmbH', provenance: 'HUMAN_REVIEW' } })
    await expect(prisma.auditEvent.count({ where: { ownerId: 'tenant-a', objectId: 'invoice-a' } })).resolves.toBe(3)

    const reopened = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: `file:${databasePath}` }) })
    await expect(reopened.documentExtraction.findUnique({ where: { documentId: 'invoice-a' } })).resolves.toMatchObject({ status: 'CONFIRMED', inputHash: first.inputHash, reviewedBy: 'user-a' })
    await reopened.$disconnect()
  })

  it('Given a parser that exceeds its budget, when extraction runs, then a retryable timeout is durable and no facts are invented', async () => {
    const provider: InvoiceExtractionProvider = { id: 'hanging-provider', version: '1', extract: () => new Promise(() => undefined) }
    const result = await api.extractDocumentInvoice('tenant-a', 'timeout-a', 'user-a', provider, 100)
    expect(result).toMatchObject({ status: 'FAILED', failureCode: 'PARSER_TIMEOUT', retryable: true, data: null })
    await expect(prisma.documentExtraction.findUnique({ where: { documentId: 'timeout-a' } })).resolves.toMatchObject({ status: 'FAILED', provider: 'hanging-provider' })
  })
})
