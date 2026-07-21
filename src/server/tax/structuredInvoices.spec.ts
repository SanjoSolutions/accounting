import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { generateUblInvoice, receiveStructuredInvoice } from '@/core/eInvoice'

const mocks = vi.hoisted(() => ({ write: vi.fn(), delete: vi.fn(), transaction: vi.fn(), rendering: vi.fn(), list: vi.fn(), void: vi.fn(), account: vi.fn(), issuanceFind: vi.fn(), issuanceCreate: vi.fn(), issuanceUpdate: vi.fn() }))
vi.mock('server-only', () => ({}))
vi.mock('@/server/storage', () => ({ getDocumentStorage: () => ({ write: mocks.write, delete: mocks.delete }) }))
vi.mock('@/server/persistence/client', () => ({ prisma: { $transaction: mocks.transaction, structuredInvoice: { findFirst: mocks.rendering, findMany: mocks.list }, invoiceNumberReservation: { updateMany: mocks.void }, invoiceIssuanceRequest: { findUnique: mocks.issuanceFind, create: mocks.issuanceCreate, updateMany: mocks.issuanceUpdate }, accountRecord: { findFirst: mocks.account } } }))

import { configureInvoiceNumberSequence, correctStructuredInvoice, getStructuredInvoiceRendering, invoiceIssuerKey, issueStructuredInvoice, listStructuredInvoices, looksLikeHybridInvoice, parseImportedInvoiceSequence, parseStructuredUpload, reconcileInvoiceNumberSequence, requireAllocatableInvoiceSequence, requireInvoiceIssuanceBody, storeStructuredInvoice, StructuredInvoiceConflictError } from './structuredInvoices'

describe('structured invoice persistence boundary', () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.delete.mockResolvedValue(undefined); mocks.void.mockResolvedValue({ count: 1 }); mocks.issuanceFind.mockResolvedValue(null); mocks.issuanceCreate.mockResolvedValue({ id: 'issuance-request-1' }); mocks.issuanceUpdate.mockResolvedValue({ count: 1 }); mocks.account.mockResolvedValue({ payload: JSON.stringify({ invoiceIssuer: { name: 'Seller GmbH', streetAndHouseNumber: 'Main 1', zipCode: '10115', city: 'Berlin', country: 'DE' }, companyProfile: { companyName: 'Seller GmbH', taxNumber: '12/345/67890', vatId: 'DE123456789' } }) }) })

  it('validates representative EN-16931 XML while preserving the exact original bytes and provenance', () => {
    const bytes = readFileSync(resolve('src/core/data_fixtures/eInvoice/valid-ubl.xml'))
    const invoice = parseStructuredUpload(bytes, 'application/xml; charset=utf-8', 'incoming.xml')
    expect(invoice?.data).toMatchObject({ syntax: 'UBL', invoiceNumber: 'RE-2026-0001', grossAmountCents: 11900 })
    expect(Buffer.from(invoice!.structuredOriginal.bytes)).toEqual(bytes)
    expect(invoice?.provenance.grossAmountCents).toBe('structured-original:grossAmountCents')
  })
  it('uses a stable registered seller identity despite mutable name and address changes', () => {
    const invoice = parseStructuredUpload(readFileSync(resolve('src/core/data_fixtures/eInvoice/valid-ubl.xml')), 'application/xml', 'incoming.xml')!
    const moved = { ...invoice, data: { ...invoice.data, seller: { ...invoice.data.seller, name: `  ${invoice.data.seller.name.toUpperCase()}  `, street: 'New address 9' } } }
    expect(invoiceIssuerKey(moved, 'INCOMING', 'tenant-a')).toBe(invoiceIssuerKey(invoice, 'INCOMING', 'tenant-a'))
  })

  it('does not classify an ordinary PDF with unrelated embedded files as a hybrid invoice', () => {
    expect(looksLikeHybridInvoice(Buffer.from('%PDF-1.7 /EmbeddedFiles (terms.txt)'), 'invoice.pdf')).toBe(false)
    expect(looksLikeHybridInvoice(Buffer.from('%PDF-1.7 /AFRelationship /Alternative (factur-x.xml)'), 'invoice.pdf')).toBe(true)
    expect(looksLikeHybridInvoice(Buffer.from('%PDF-1.7 /EmbeddedFiles (terms.txt)'), 'factur-x.pdf')).toBe(false)
  })
  it('preserves ordinary XML uploads outside the recognized invoice namespaces', () => {
    expect(parseStructuredUpload(Buffer.from('<?xml version="1.0"?><Report xmlns="urn:example:report"/>'), 'application/xml', 'report.xml')).toBeNull()
  })
  it('recognizes a valid structured invoice whose root follows a long legal prolog', () => {
    const xml = readFileSync(resolve('src/core/data_fixtures/eInvoice/valid-ubl.xml'), 'utf8').replace(/^<\?xml[^>]+>\s*/, '')
    expect(parseStructuredUpload(Buffer.from(`${' '.repeat(20_000)}<?audit legal?>${xml}`), 'application/xml', 'invoice.xml')?.data.syntax).toBe('UBL')
  })
  it('rejects null and array issuance bodies before route destructuring', () => {
    expect(() => requireInvoiceIssuanceBody(null)).toThrow(/JSON object/)
    expect(() => requireInvoiceIssuanceBody([])).toThrow(/JSON object/)
  })
  it('maps duplicate structured identities to a deterministic conflict after storage cleanup', async () => {
    const invoice = parseStructuredUpload(readFileSync(resolve('src/core/data_fixtures/eInvoice/valid-ubl.xml')), 'application/xml', 'incoming.xml')!
    mocks.transaction.mockRejectedValueOnce(Object.assign(new Error('unique'), { code: 'P2002' }))
    await expect(storeStructuredInvoice('tenant-a', invoice, 'incoming.xml')).rejects.toBeInstanceOf(StructuredInvoiceConflictError)
    expect(mocks.delete).toHaveBeenCalledOnce()
  })
  it('cleans the intended object key when object storage write fails', async () => {
    const invoice = parseStructuredUpload(readFileSync(resolve('src/core/data_fixtures/eInvoice/valid-ubl.xml')), 'application/xml', 'incoming.xml')!
    mocks.write.mockRejectedValueOnce(new Error('partial write'))
    await expect(storeStructuredInvoice('tenant-a', invoice, 'incoming.xml')).rejects.toThrow(/partial write/)
    expect(mocks.delete).toHaveBeenCalledWith(expect.stringContaining('documents/tenant-a/'))
  })
  it('does not apply the structured-invoice limit to a large ordinary PDF', () => {
    expect(parseStructuredUpload(new Uint8Array(20 * 1024 * 1024 + 1), 'application/pdf', 'ordinary.pdf')).toBeNull()
  })

  it('rejects non-string and impossible issue dates before allocating an invoice number', async () => {
    await expect(issueStructuredInvoice('tenant-a', { kind: 'invoice', issueDate: 20260101 } as never, 'invalid-date-request-1')).rejects.toThrow(/real issue date/)
    await expect(issueStructuredInvoice('tenant-a', { kind: 'invoice', issueDate: '2026-02-30' } as never, 'invalid-date-request-2')).rejects.toThrow(/real issue date/)
    expect(mocks.transaction).not.toHaveBeenCalled()
  })
  it('requires non-invoice issuance to pass through the immutable correction workflow', async () => {
    await expect(issueStructuredInvoice('tenant-a', { kind: 'credit-note' } as never, 'invalid-kind-request')).rejects.toThrow(/immutable correction workflow/)
    expect(mocks.account).not.toHaveBeenCalled()
    expect(mocks.transaction).not.toHaveBeenCalled()
  })
  it('initializes numbering only from an explicitly confirmed first unused number', async () => {
    const create = vi.fn().mockResolvedValue({ ownerId: 'tenant-a', year: 2026, nextValue: 42 })
    mocks.transaction.mockImplementationOnce(async callback => callback({ invoiceNumberSequence: { findUnique: vi.fn().mockResolvedValue(null), create }, invoiceNumberReservation: { count: vi.fn().mockResolvedValue(0) }, structuredInvoice: { count: vi.fn().mockResolvedValue(0) } }))
    await expect(configureInvoiceNumberSequence('tenant-a', 2026, 42, true)).resolves.toMatchObject({ nextValue: 42 })
    expect(create).toHaveBeenCalledWith({ data: { ownerId: 'tenant-a', year: 2026, nextValue: 42 } })
    await expect(configureInvoiceNumberSequence('tenant-a', 2026, 1, false)).rejects.toThrow(/Explicitly confirm/)
    expect(requireAllocatableInvoiceSequence(999_999)).toBe(999_999)
    expect(() => requireAllocatableInvoiceSequence(1_000_000)).toThrow(/exhausted/)
  })
  it('reconciles imported numbers without reusing imported, reserved, or voided values', async () => {
    expect(parseImportedInvoiceSequence(2026, ['2026-000040', '2026-000041'], 42)).toMatchObject({ highest: 41 })
    expect(() => parseImportedInvoiceSequence(2026, ['2026-000000'], 1)).toThrow(/1-999999/)
    expect(() => parseImportedInvoiceSequence(2026, ['2026-000040'], 40)).toThrow(/immediately follow/)
    expect(() => parseImportedInvoiceSequence(2026, ['2026-000040'], 42)).toThrow(/immediately follow/)
    expect(() => parseImportedInvoiceSequence(2026, ['INV-40'], 41)).toThrow(/canonical/)
    const update = vi.fn().mockResolvedValue({ ownerId: 'tenant-a', year: 2026, nextValue: 45 })
    const createOnboarding = vi.fn().mockResolvedValue({})
    mocks.transaction.mockImplementationOnce(async callback => callback({
      structuredInvoice: { findMany: vi.fn().mockResolvedValue([{ invoiceNumber: '2026-000042' }]) },
      invoiceNumberReservation: { findMany: vi.fn().mockResolvedValue([{ sequenceValue: 43 }]) },
      invoiceNumberSequence: { findUnique: vi.fn().mockResolvedValue({ nextValue: 44 }), update, create: vi.fn() },
      invoiceNumberSequenceOnboarding: { findUnique: vi.fn().mockResolvedValue(null), create: createOnboarding },
    }))
    await expect(reconcileInvoiceNumberSequence('tenant-a', 'admin-a', 2026, 45, ['2026-000044'], true)).resolves.toMatchObject({ nextValue: 45, importedHighestNumber: 44 })
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ data: { nextValue: 45 } }))
    expect(createOnboarding).toHaveBeenCalledWith({ data: expect.objectContaining({ confirmedBy: 'admin-a', importedCount: 1 }) })
  })
  it('never overwrites existing invoice-number onboarding evidence', async () => {
    const update = vi.fn()
    const createOnboarding = vi.fn()
    mocks.transaction.mockImplementationOnce(async callback => callback({
      structuredInvoice: { findMany: vi.fn().mockResolvedValue([]) },
      invoiceNumberReservation: { findMany: vi.fn().mockResolvedValue([]) },
      invoiceNumberSequence: { findUnique: vi.fn(), update, create: vi.fn() },
      invoiceNumberSequenceOnboarding: { findUnique: vi.fn().mockResolvedValue({ firstUnusedNumber: 10 }), create: createOnboarding },
    }))
    await expect(reconcileInvoiceNumberSequence('tenant-a', 'admin-b', 2026, 12, ['2026-000011'], true)).rejects.toThrow(/immutable/)
    expect(update).not.toHaveBeenCalled()
    expect(createOnboarding).not.toHaveBeenCalled()
  })
  it('recovers a stale processing request by deleting orphaned storage and voiding its reservation', async () => {
    const input = { kind: 'invoice', issueDate: 'invalid' } as never
    await expect(issueStructuredInvoice('tenant-a', input, 'stale-issuance-request')).rejects.toThrow(/real issue date/)
    const requestHash = mocks.issuanceCreate.mock.calls[0][0].data.requestHash
    mocks.issuanceFind.mockResolvedValue({ id: 'issuance-request-1', requestHash, status: 'PROCESSING', reservationId: 'reservation-stale', storageKey: 'documents/tenant-a/orphan.xml', structuredInvoiceId: null, updatedAt: new Date(Date.now() - 6 * 60_000) })

    await expect(issueStructuredInvoice('tenant-a', input, 'stale-issuance-request')).rejects.toThrow(/real issue date/)

    expect(mocks.delete).toHaveBeenCalledWith('documents/tenant-a/orphan.xml')
    expect(mocks.void).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ id: 'reservation-stale', status: 'RESERVED' }), data: expect.objectContaining({ status: 'VOID' }) }))
  })

  it('returns a completed issuance retry before allocating another invoice number', async () => {
    const base = parseStructuredUpload(readFileSync(resolve('src/core/data_fixtures/eInvoice/valid-ubl.xml')), 'application/xml', 'incoming.xml')!.data
    const { syntax: _syntax, invoiceNumber: _number, correctedInvoiceNumber: _corrected, ...input } = base
    let createdRaw: Record<string, unknown> = {}
    mocks.transaction
      .mockImplementationOnce(async callback => callback({ invoiceNumberSequence: { findUnique: vi.fn().mockResolvedValue({ nextValue: 1 }), updateMany: vi.fn().mockResolvedValue({ count: 1 }), findUniqueOrThrow: vi.fn().mockResolvedValue({ nextValue: 2 }) }, invoiceNumberReservation: { create: vi.fn().mockResolvedValue({ id: 'reservation-1' }) }, invoiceIssuanceRequest: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) } }))
      .mockImplementationOnce(async callback => callback({ documentRecord: { create: vi.fn() }, structuredInvoice: { findFirst: vi.fn(), create: vi.fn().mockImplementation(({ data }) => { createdRaw = { ...data, createdAt: new Date('2026-01-01T00:00:00Z') }; return createdRaw }) }, invoiceNumberReservation: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) }, invoiceIssuanceRequest: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) } }))
    const first = await issueStructuredInvoice('tenant-a', input, 'durable-issuance-request')
    const requestHash = mocks.issuanceCreate.mock.calls[0][0].data.requestHash
    mocks.issuanceFind.mockResolvedValue({ id: 'issuance-request-1', requestHash, status: 'ISSUED', structuredInvoiceId: first.id })
    mocks.rendering.mockResolvedValue(createdRaw)

    const retry = await issueStructuredInvoice('tenant-a', input, 'durable-issuance-request')

    expect(retry.id).toBe(first.id)
    expect(mocks.transaction).toHaveBeenCalledTimes(2)
  })

  it('validates the prospective correction link before any invoice records or objects are written', async () => {
    const base = parseStructuredUpload(readFileSync(resolve('src/core/data_fixtures/eInvoice/valid-ubl.xml')), 'application/xml', 'incoming.xml')!.data
    mocks.account.mockResolvedValueOnce({ payload: JSON.stringify({ invoiceIssuer: { name: base.seller.name, streetAndHouseNumber: base.seller.street, zipCode: base.seller.postalCode, city: base.seller.city, country: base.seller.countryCode }, companyProfile: { companyName: base.seller.name, taxNumber: base.seller.taxId ?? '12/345/67890', vatId: base.seller.vatId } }) })
    const { syntax: _syntax, invoiceNumber: _number, correctedInvoiceNumber: _corrected, ...common } = base
    const input = { ...common, seller: { ...common.seller, taxId: common.seller.taxId ?? '12/345/67890' }, kind: 'credit-note' as const }
    const expected = receiveStructuredInvoice(generateUblInvoice({ ...input, invoiceNumber: '2026-000001', correctedInvoiceNumber: base.invoiceNumber }))
    const target = { id: 'invoice-root', kind: 'invoice', invoiceNumber: base.invoiceNumber, structuredHash: expected.structuredOriginal.sha256, correctsId: null }
    mocks.rendering.mockResolvedValueOnce(target); mocks.list.mockResolvedValueOnce([target])
    mocks.transaction.mockImplementationOnce(async callback => callback({ invoiceNumberSequence: { findUnique: vi.fn().mockResolvedValue({ nextValue: 1 }), updateMany: vi.fn().mockResolvedValue({ count: 1 }), findUniqueOrThrow: vi.fn().mockResolvedValue({ nextValue: 2 }) }, invoiceNumberReservation: { create: vi.fn().mockResolvedValue({ id: 'reservation-1' }) }, invoiceIssuanceRequest: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) } }))
    await expect(correctStructuredInvoice('tenant-a', target.id, input, 'correction-request-key')).rejects.toThrow(/immutable and unique/)
    expect(mocks.transaction).toHaveBeenCalledTimes(1)
    expect(mocks.write).not.toHaveBeenCalled()
    expect(mocks.void).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'VOID' }) }))
  })

  it('stores the original and safe rendering under the authenticated owner without replacing the structured original', async () => {
    const bytes = readFileSync(resolve('src/core/data_fixtures/eInvoice/valid-ubl.xml'))
    const invoice = parseStructuredUpload(bytes, 'application/xml', 'incoming.xml')!
    const create = vi.fn().mockImplementation(({ data }) => ({ ...data, createdAt: new Date('2026-01-01T00:00:00Z') }))
    mocks.transaction.mockImplementationOnce(async callback => callback({ documentRecord: { create: vi.fn() }, structuredInvoice: { create, findFirst: vi.fn() } }))
    const stored = await storeStructuredInvoice('tenant-a', invoice, 'incoming.xml')
    expect(mocks.write).toHaveBeenCalledWith(expect.stringContaining('tenant-a'), bytes, expect.objectContaining({ contentType: 'application/xml' }))
    expect(create).toHaveBeenCalledWith({ data: expect.objectContaining({ ownerId: 'tenant-a', structuredOriginal: bytes, renderedHtml: expect.not.stringMatching(/<script|javascript:/i) }) })
    expect(stored.invoiceNumber).toBe('RE-2026-0001')
  })

  it('tenant-scopes rendering lookups', async () => {
    mocks.rendering.mockResolvedValueOnce(null)
    await getStructuredInvoiceRendering('tenant-b', 'invoice-a')
    expect(mocks.rendering).toHaveBeenCalledWith({ where: { id: 'invoice-a', ownerId: 'tenant-b' }, select: { renderedHtml: true } })
  })
  it('lists only bounded metadata and never returns original blobs or internal payloads', async () => {
    mocks.list.mockResolvedValueOnce([{ id: 'i', documentId: 'd', syntax: 'UBL', kind: 'invoice', invoiceNumber: 'N-1', issueDate: new Date('2026-01-01'), structuredHash: 'a'.repeat(64), visualHash: null, correctsId: null, createdAt: new Date('2026-01-01') }])
    expect(await listStructuredInvoices('tenant-a')).toEqual([expect.not.objectContaining({ structuredOriginal: expect.anything(), data: expect.anything(), ownerId: expect.anything() })])
    expect(mocks.list).toHaveBeenCalledWith(expect.objectContaining({ where: { ownerId: 'tenant-a' }, select: expect.not.objectContaining({ structuredOriginal: true, visualOriginal: true, data: true, renderedHtml: true }) }))
  })
})
