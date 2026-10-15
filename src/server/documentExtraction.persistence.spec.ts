import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3'
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest'
import { PrismaClient } from '@/generated/prisma/client'
import type { InvoiceExtractionData } from '@/core/documentExtraction'
import type { InvoiceExtractionProvider } from './pdfTextInvoiceProvider'
import { verifyAuditChain } from './compliance/auditPersistence'

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
  expect(verifyAuditChain(await prisma.auditEvent.findMany({ where: { ownerId: 'tenant-a' } }), await prisma.auditHead.findUnique({ where: { ownerId: 'tenant-a' } }))).toBe(true)
  await prisma.$disconnect()
  delete process.env.DATABASE_URL
  delete process.env.DOCUMENT_STORAGE_DRIVER
  delete process.env.DOCUMENT_STORAGE_ROOT
  delete process.env.AUDIT_INTEGRITY_SECRET
  rmSync(directory, { recursive: true, force: true })
})

afterEach(() => vi.restoreAllMocks())

const facts: InvoiceExtractionData = { supplierName: 'Synthetic Supplier GmbH', invoiceNumber: 'SYNTHETIC-48', issueDate: '2026-08-01', netAmountCents: 10_000, taxAmountCents: 1_900, grossAmountCents: 11_900, currency: 'EUR', confidence: { supplierName: 1, invoiceNumber: 1, issueDate: 1, netAmountCents: 1, taxAmountCents: 1, grossAmountCents: 1 }, provenance: 'PDF_TEXT' }
const parsed = { data: facts, rawTextHash: 'f'.repeat(64) }
const provider: InvoiceExtractionProvider = { id: 'synthetic-provider', version: '1', extract: async () => parsed }

async function createPdfDocument(id: string) {
  const content = readFileSync('e2e/fixtures/invoice.pdf')
  const storageKey = `documents/tenant-a/${id}.pdf`
  writeFileSync(join(storageRoot, storageKey), content)
  await prisma.documentRecord.create({ data: { id, ownerId: 'tenant-a', payload: JSON.stringify({ id, ownerId: 'tenant-a', storageKey, url: `/api/documents/${id}/file`, fileName: `${id}.pdf`, contentType: 'application/pdf', size: content.length }) } })
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function pausedProvider() {
  const started = deferred<void>()
  const result = deferred<Awaited<ReturnType<InvoiceExtractionProvider['extract']>>>()
  return { started, result, provider: { ...provider, extract: vi.fn(() => { started.resolve(); return result.promise }) } }
}

// Hold a real persisted snapshot while another request commits. This exercises
// conditional writes deterministically without mocking transactions or writes.
function pauseNextSnapshot() {
  const read = prisma.documentExtraction.findFirst.bind(prisma.documentExtraction)
  const captured = deferred<void>()
  const release = deferred<void>()
  const reader: { findFirst: (args: Parameters<typeof read>[0]) => Promise<Awaited<ReturnType<typeof read>>> } = prisma.documentExtraction
  vi.spyOn(reader, 'findFirst').mockImplementationOnce(async args => {
    const row = await read(args)
    captured.resolve()
    await release.promise
    return row
  })
  return { captured, release }
}

async function rejectAudit(action: string) {
  // Test-only trigger in the private migrated database. Fail the real INSERT,
  // after AuditHead has been advanced, to prove the entire transaction rolls back.
  await prisma.$executeRawUnsafe(`CREATE TRIGGER reject_extraction_audit BEFORE INSERT ON AuditEvent WHEN NEW.action = '${action}' BEGIN SELECT RAISE(ABORT, 'synthetic audit failure'); END`)
}

function extractionRow(documentId: string) {
  return prisma.documentExtraction.findUniqueOrThrow({ where: { documentId } })
}

function auditEvents(documentId: string) {
  return prisma.auditEvent.findMany({ where: { ownerId: 'tenant-a', objectId: documentId } })
}

describe('persistent document extraction workflow', () => {
  test('Given an audit insert failure, when an attempt is claimed, then both the claim and audit head roll back', async () => {
    await createPdfDocument('audit-start')
    const head = await prisma.auditHead.findUnique({ where: { ownerId: 'tenant-a' } })
    await rejectAudit('DOCUMENT_EXTRACTION_STARTED')
    try {
      await expect(api.extractDocumentInvoice('tenant-a', 'audit-start', 'user-a')).rejects.toThrow()
      await expect(prisma.documentExtraction.findUnique({ where: { documentId: 'audit-start' } })).resolves.toBeNull()
      await expect(prisma.auditHead.findUnique({ where: { ownerId: 'tenant-a' } })).resolves.toEqual(head)
    } finally { await prisma.$executeRawUnsafe('DROP TRIGGER reject_extraction_audit') }
    await expect(api.extractDocumentInvoice('tenant-a', 'audit-start', 'user-a', provider)).resolves.toMatchObject({ status: 'NEEDS_REVIEW', attempt: 1 })
  })

  test.each(['expired', 'legacy'] as const)('Given an abandoned %s attempt, when a new process retries the retained PDF, then a new leased attempt and recovery audit persist', async kind => {
    const documentId = `restart-${kind}`
    await createPdfDocument(documentId)
    const previousProcess = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: `file:${databasePath}` }) })
    await previousProcess.documentExtraction.create({ data: { ownerId: 'tenant-a', documentId, status: 'PROCESSING', provider: provider.id, providerVersion: provider.version, inputHash: 'a'.repeat(64), attempt: 7, attemptId: kind === 'legacy' ? null : 'abandoned-attempt', leaseExpiresAt: kind === 'legacy' ? null : new Date('2000-01-01'), updatedAt: new Date('2000-01-01') } })
    await previousProcess.$disconnect()
    const result = await api.extractDocumentInvoice('tenant-a', documentId, 'recovery-actor', provider)
    expect(result).toMatchObject({ status: 'NEEDS_REVIEW', attempt: 8, leaseExpiresAt: null })
    expect(result.attemptId).toBeTruthy()
    expect(result.attemptId).not.toBe('abandoned-attempt')
    const events = await auditEvents(documentId)
    expect(events.map(event => event.action).sort()).toEqual(['DOCUMENT_EXTRACTION_COMPLETED', 'DOCUMENT_EXTRACTION_RECOVERED'])
    const recovery = events.find(event => event.action === 'DOCUMENT_EXTRACTION_RECOVERED')!
    expect(recovery.actorId).toBe('recovery-actor')
    expect(JSON.parse(recovery.semanticDelta)).toMatchObject({ before: { status: 'PROCESSING', attempt: 7 }, after: { status: 'PROCESSING', attempt: 8, attemptId: result.attemptId, leaseExpiresAt: expect.any(String) } })
  })

  test('Given an active durable lease with an old updatedAt, when another process retries, then it cannot steal the attempt', async () => {
    const documentId = 'active-lease'
    await createPdfDocument(documentId)
    await prisma.documentExtraction.create({ data: { ownerId: 'tenant-a', documentId, status: 'PROCESSING', provider: provider.id, providerVersion: provider.version, inputHash: 'a'.repeat(64), attemptId: 'active', leaseExpiresAt: new Date(Date.now() + 60_000), updatedAt: new Date('2000-01-01') } })
    const before = await extractionRow(documentId)
    await expect(api.extractDocumentInvoice('tenant-a', documentId, 'user-a', provider)).rejects.toMatchObject({ status: 409 })
    expect(await extractionRow(documentId)).toEqual(before)
    expect(await auditEvents(documentId)).toHaveLength(0)
  })

  test.each(['new', 'expired'] as const)('Given two starts reading the same %s state, when they claim concurrently, then only one parser and start audit win', async kind => {
    const documentId = `concurrent-${kind}`
    await createPdfDocument(documentId)
    if (kind === 'expired') await prisma.documentExtraction.create({ data: { ownerId: 'tenant-a', documentId, status: 'PROCESSING', provider: provider.id, providerVersion: provider.version, inputHash: 'a'.repeat(64), attemptId: 'expired', leaseExpiresAt: new Date('2000-01-01') } })
    const snapshot = pauseNextSnapshot()
    const parser = pausedProvider()
    const first = api.extractDocumentInvoice('tenant-a', documentId, 'first-actor', parser.provider)
    await snapshot.captured.promise
    const winner = api.extractDocumentInvoice('tenant-a', documentId, 'winner-actor', parser.provider)
    await parser.started.promise
    const rejected = expect(first).rejects.toMatchObject({ status: 409 })
    snapshot.release.resolve()
    await rejected
    parser.result.resolve(parsed)
    await expect(winner).resolves.toMatchObject({ status: 'NEEDS_REVIEW', attempt: kind === 'new' ? 1 : 2 })
    expect(parser.provider.extract).toHaveBeenCalledTimes(1)
    expect((await auditEvents(documentId)).map(event => event.actorId)).toEqual(['winner-actor', 'winner-actor'])
  })

  test.each(['completion', 'unrecognized', 'exception'] as const)('Given a superseded parser %s, when a recovered result has been confirmed, then the stale worker cannot change facts or audit history', async outcome => {
    const documentId = `stale-${outcome}`
    await createPdfDocument(documentId)
    const parser = pausedProvider()
    const stale = api.extractDocumentInvoice('tenant-a', documentId, 'old-actor', parser.provider)
    await parser.started.promise
    const old = await extractionRow(documentId)
    await prisma.documentExtraction.update({ where: { documentId }, data: { leaseExpiresAt: new Date('2000-01-01') } })
    const replacement = await api.extractDocumentInvoice('tenant-a', documentId, 'new-actor', provider)
    expect(replacement.attemptId).not.toBe(old.attemptId)
    await api.confirmDocumentExtraction('tenant-a', documentId, 'reviewer', { ...facts, supplierName: 'Confirmed Supplier GmbH' })
    const before = await extractionRow(documentId)
    const events = await auditEvents(documentId)
    const rejected = expect(stale).rejects.toMatchObject({ status: 409 })
    if (outcome === 'exception') parser.result.reject(new Error('late parser failure'))
    else parser.result.resolve(outcome === 'unrecognized' ? { data: null, rawTextHash: null } : parsed)
    await rejected
    expect(await extractionRow(documentId)).toEqual(before)
    expect(await auditEvents(documentId)).toEqual(events)
  })

  test('Given an expired worker with no replacement yet, when it completes, then its expired lease prevents a commit and retry can recover', async () => {
    const documentId = 'expired-completion'
    await createPdfDocument(documentId)
    const parser = pausedProvider()
    const stale = api.extractDocumentInvoice('tenant-a', documentId, 'old-actor', parser.provider)
    await parser.started.promise
    await prisma.documentExtraction.update({ where: { documentId }, data: { leaseExpiresAt: new Date('2000-01-01') } })
    const before = await extractionRow(documentId)
    const rejected = expect(stale).rejects.toMatchObject({ status: 409 })
    parser.result.resolve(parsed)
    await rejected
    expect(await extractionRow(documentId)).toEqual(before)
    expect(await auditEvents(documentId)).toHaveLength(1)
    await expect(api.extractDocumentInvoice('tenant-a', documentId, 'new-actor', provider)).resolves.toMatchObject({ status: 'NEEDS_REVIEW', attempt: 2 })
  })

  test.each(['completion', 'exception'] as const)('Given two workers for successive attempts, when the old %s arrives during the newer lease, then attempt identity fences the old write', async outcome => {
    const documentId = `overlapping-${outcome}`
    await createPdfDocument(documentId)
    const oldParser = pausedProvider()
    const stale = api.extractDocumentInvoice('tenant-a', documentId, 'old-actor', oldParser.provider)
    await oldParser.started.promise
    await prisma.documentExtraction.update({ where: { documentId }, data: { leaseExpiresAt: new Date('2000-01-01') } })
    const newParser = pausedProvider()
    const current = api.extractDocumentInvoice('tenant-a', documentId, 'new-actor', newParser.provider)
    await newParser.started.promise
    const before = await extractionRow(documentId)
    const events = await auditEvents(documentId)
    const rejected = expect(stale).rejects.toMatchObject({ status: 409 })
    if (outcome === 'exception') oldParser.result.reject(new Error('late parser failure'))
    else oldParser.result.resolve(parsed)
    await rejected
    expect(await extractionRow(documentId)).toEqual(before)
    expect(await auditEvents(documentId)).toEqual(events)
    newParser.result.resolve(parsed)
    await expect(current).resolves.toMatchObject({ status: 'NEEDS_REVIEW', attempt: 2, attemptId: before.attemptId })
  })

  test.each(['COMPLETED', 'FAILED'] as const)('Given a %s audit failure, when a parser finishes, then state and audit head roll back and expiry permits recovery', async action => {
    const documentId = `audit-${action}`
    await createPdfDocument(documentId)
    const parser = pausedProvider()
    const extraction = api.extractDocumentInvoice('tenant-a', documentId, 'user-a', parser.provider)
    await parser.started.promise
    const before = await extractionRow(documentId)
    const head = await prisma.auditHead.findUnique({ where: { ownerId: 'tenant-a' } })
    await rejectAudit(`DOCUMENT_EXTRACTION_${action}`)
    try {
      const rejected = expect(extraction).rejects.toThrow()
      parser.result.resolve(action === 'COMPLETED' ? parsed : { data: null, rawTextHash: null })
      await rejected
      expect(await extractionRow(documentId)).toEqual(before)
      expect(await prisma.auditHead.findUnique({ where: { ownerId: 'tenant-a' } })).toEqual(head)
      expect((await auditEvents(documentId)).map(event => event.action)).toEqual(['DOCUMENT_EXTRACTION_STARTED'])
    } finally { await prisma.$executeRawUnsafe('DROP TRIGGER reject_extraction_audit') }
    await prisma.documentExtraction.update({ where: { documentId }, data: { leaseExpiresAt: new Date('2000-01-01') } })
    await expect(api.extractDocumentInvoice('tenant-a', documentId, 'user-a', provider)).resolves.toMatchObject({ status: 'NEEDS_REVIEW', attempt: 2 })
  })

  test.each(['CONFIRMED', 'RECOVERED'] as const)('Given a %s audit failure, when the transition is attempted, then its previous state and audit head remain intact', async action => {
    const documentId = `audit-${action}`
    await createPdfDocument(documentId)
    await api.extractDocumentInvoice('tenant-a', documentId, 'user-a', provider)
    if (action === 'RECOVERED') await prisma.documentExtraction.update({ where: { documentId }, data: { status: 'PROCESSING', leaseExpiresAt: new Date('2000-01-01') } })
    const before = await extractionRow(documentId)
    const head = await prisma.auditHead.findUnique({ where: { ownerId: 'tenant-a' } })
    const events = await auditEvents(documentId)
    const act = () => action === 'CONFIRMED' ? api.confirmDocumentExtraction('tenant-a', documentId, 'reviewer', facts) : api.extractDocumentInvoice('tenant-a', documentId, 'user-a', provider)
    await rejectAudit(`DOCUMENT_EXTRACTION_${action}`)
    try {
      await expect(act()).rejects.toThrow()
      expect(await extractionRow(documentId)).toEqual(before)
      expect(await prisma.auditHead.findUnique({ where: { ownerId: 'tenant-a' } })).toEqual(head)
      expect(await auditEvents(documentId)).toEqual(events)
    } finally { await prisma.$executeRawUnsafe('DROP TRIGGER reject_extraction_audit') }
    await expect(act()).resolves.toMatchObject({ status: action === 'CONFIRMED' ? 'CONFIRMED' : 'NEEDS_REVIEW' })
  })

  test.each(['confirmation', 'restart'] as const)('Given a delayed confirmation snapshot, when another %s wins, then the delayed review cannot overwrite it', async winner => {
    const documentId = `confirm-race-${winner}`
    await createPdfDocument(documentId)
    await api.extractDocumentInvoice('tenant-a', documentId, 'user-a', provider)
    const snapshot = pauseNextSnapshot()
    const stale = api.confirmDocumentExtraction('tenant-a', documentId, 'old-reviewer', { ...facts, supplierName: 'Stale Review GmbH' })
    await snapshot.captured.promise
    if (winner === 'confirmation') await api.confirmDocumentExtraction('tenant-a', documentId, 'new-reviewer', facts)
    else await api.extractDocumentInvoice('tenant-a', documentId, 'new-actor', { ...provider, version: '2' })
    const before = await extractionRow(documentId)
    const events = await auditEvents(documentId)
    const rejected = expect(stale).rejects.toMatchObject({ status: 409 })
    snapshot.release.resolve()
    await rejected
    expect(await extractionRow(documentId)).toEqual(before)
    expect(await auditEvents(documentId)).toEqual(events)
  })

  test('Given a delayed restart snapshot, when review is confirmed first, then the restart cannot overwrite the confirmed result', async () => {
    const documentId = 'restart-confirm-race'
    await createPdfDocument(documentId)
    await api.extractDocumentInvoice('tenant-a', documentId, 'user-a', provider)
    const snapshot = pauseNextSnapshot()
    const stale = api.extractDocumentInvoice('tenant-a', documentId, 'old-actor', { ...provider, version: '2' })
    await snapshot.captured.promise
    await api.confirmDocumentExtraction('tenant-a', documentId, 'reviewer', facts)
    const before = await extractionRow(documentId)
    const events = await auditEvents(documentId)
    const rejected = expect(stale).rejects.toMatchObject({ status: 409 })
    snapshot.release.resolve()
    await rejected
    expect(await extractionRow(documentId)).toEqual(before)
    expect(await auditEvents(documentId)).toEqual(events)
  })

  test('Given authoritative structured facts, when review attempts to change them, then mutation is rejected and exact confirmation retains structured provenance', async () => {
    const facts = { supplierName: 'UBL Supplier GmbH', invoiceNumber: 'UBL-1', issueDate: '2026-08-01', netAmountCents: 10_000, taxAmountCents: 1_900, grossAmountCents: 11_900, currency: 'EUR', confidence: { supplierName: 1, invoiceNumber: 1, issueDate: 1, netAmountCents: 1, taxAmountCents: 1, grossAmountCents: 1 }, provenance: 'STRUCTURED_INVOICE' }
    await prisma.documentRecord.create({ data: { id: 'structured-a', ownerId: 'tenant-a', payload: '{}' } })
    await prisma.documentExtraction.create({ data: { ownerId: 'tenant-a', documentId: 'structured-a', status: 'NEEDS_REVIEW', provider: 'structured-invoice', providerVersion: 'EN16931-parser-1', inputHash: 'a'.repeat(64), extractedData: JSON.stringify(facts) } })
    await expect(api.confirmDocumentExtraction('tenant-a', 'structured-a', 'user-a', { ...facts, netAmountCents: 9_999, grossAmountCents: 11_899 })).rejects.toThrow(/authoritative/)
    await expect(api.confirmDocumentExtraction('tenant-a', 'structured-a', 'user-a', facts)).resolves.toMatchObject({ status: 'CONFIRMED', data: { provenance: 'STRUCTURED_INVOICE', netAmountCents: 10_000 } })
  })

  test('Given retained tenant PDF bytes, when extraction is retried and reviewed, then one hash-bound result persists with audit provenance', async () => {
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

  test('Given a parser that exceeds its budget, when extraction runs, then a retryable timeout is durable and no facts are invented', async () => {
    const provider: InvoiceExtractionProvider = { id: 'hanging-provider', version: '1', extract: () => new Promise(() => undefined) }
    const result = await api.extractDocumentInvoice('tenant-a', 'timeout-a', 'user-a', provider, 100)
    expect(result).toMatchObject({ status: 'FAILED', failureCode: 'PARSER_TIMEOUT', retryable: true, data: null })
    await expect(prisma.documentExtraction.findUnique({ where: { documentId: 'timeout-a' } })).resolves.toMatchObject({ status: 'FAILED', provider: 'hanging-provider' })
  })
})
