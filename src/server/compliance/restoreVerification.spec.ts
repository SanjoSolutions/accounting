import { beforeEach, describe, expect, it, vi } from 'vitest'

const objects = vi.hoisted(() => new Map<string, Buffer>())
const storageState = vi.hoisted(() => ({ failDelete: false }))
vi.mock('server-only', () => ({}))
vi.mock('@/server/storage', () => ({ getDocumentStorage: () => ({
  write: vi.fn(async (key: string, content: Buffer) => { objects.set(key, Buffer.from(content)) }),
  read: vi.fn(async (key: string) => Buffer.from(objects.get(key)!)),
  delete: vi.fn(async (key: string) => { if (storageState.failDelete) throw new Error('delete failed'); objects.delete(key) }),
  exists: vi.fn(async (key: string) => objects.has(key)),
}) }))
import { excludeBackupPayloadLocators, exerciseIsolatedObjectRestore, snapshotStorageReferences, verifyRestoredArtifactObjects, verifyRestoredStorageObjects, verifySnapshotInIsolatedDatabase } from './restoreVerification'
import { tenantBackupRegistry } from './tenantBackupRegistry'

const snapshot = () => ({
  schemaVersion: 1, ownerId: 'tenant', settings: [], profiles: [], profileAddressConfirmations: [], periods: [], ledgerProfile: null,
  accounts: [], mappings: [], entries: [], documents: [], storageClaims: [], artifacts: [], fixityChecks: [],
  audit: [], auditHead: null, drafts: [], reopenRequests: [], amendments: [], eBalanceSubmissions: [], backupManifests: [], policy: null,
})

const commercialSnapshot = () => ({
  ...snapshot(),
  ...Object.fromEntries(tenantBackupRegistry.map(definition => [definition.snapshotKey, definition.shape === 'singleton' ? null : []])),
  schemaVersion: 4,
  periods: [{ id: 'fy', ownerId: 'tenant', year: 2026, startsAt: '2026-01-01', endsAt: '2026-12-31', status: 'OPEN', updatedAt: '2026-01-01' }],
  accounts: [{ id: 'bank-ledger', ownerId: 'tenant', number: 1200, name: 'Bank', category: 'ASSET', active: true, updatedAt: '2026-01-01' }],
  documents: [{ id: 'evidence', ownerId: 'tenant', payload: '{}' }],
  entries: [{ id: 'payment-journal', ownerId: 'tenant', sequenceNumber: 1, bookingDate: '2026-08-04', documentNumber: 'PAY-1', description: 'Receipt', source: 'MANUAL', state: 'POSTED', fiscalYearId: 'fy', lines: [], documents: [] }],
  businessPartners: [{ id: 'customer', ownerId: 'tenant', partnerNumber: 'K-1', role: 'CUSTOMER', name: 'Customer GmbH', countryCode: 'DE', paymentTermDays: 14, active: true, version: 1, updatedAt: '2026-08-01' }],
  structuredInvoices: [{ id: 'invoice', ownerId: 'tenant', documentId: 'evidence', syntax: 'UBL', kind: 'INVOICE', direction: 'OUTGOING', issuerKey: 'issuer', invoiceNumber: '2026-000001', issueDate: '2026-08-01', structuredHash: 'structured-hash', visualHash: null, originalMediaType: 'application/xml', structuredOriginal: Buffer.from('<Invoice/>').toString('base64'), visualOriginal: null, data: JSON.stringify({ currency: 'EUR', netAmountCents: 10000, taxAmountCents: 1900, grossAmountCents: 11900 }), provenance: '{}', renderedHtml: '<p>Invoice</p>', correctsId: null }],
  invoiceNumberSequences: [{ ownerId: 'tenant', year: 2026, nextValue: 2 }],
  invoiceNumberOnboarding: [{ ownerId: 'tenant', year: 2026, firstUnusedNumber: 1, importedHighestNumber: null, importedCount: 0, importedNumbersHash: 'empty', confirmedBy: 'actor', reconciledAt: '2026-01-01' }],
  invoiceNumberReservations: [{ id: 'reservation', ownerId: 'tenant', year: 2026, sequenceValue: 1, invoiceNumber: '2026-000001', status: 'ISSUED', structuredInvoiceId: 'invoice', failureReason: null, updatedAt: '2026-08-01' }],
  invoiceIssuanceRequests: [{ id: 'request', ownerId: 'tenant', requestKey: 'request-1', requestHash: 'request-hash', status: 'COMPLETED', reservationId: 'reservation', storageKey: 'invoices/invoice.xml', structuredInvoiceId: 'invoice', error: null, updatedAt: '2026-08-01' }],
  commercialDocuments: [{ id: 'commercial', ownerId: 'tenant', businessPartnerId: 'customer', structuredInvoiceId: 'invoice', evidenceDocumentId: 'evidence', postingJournalEntryId: null, correctsId: null, direction: 'RECEIVABLE', kind: 'INVOICE', status: 'FINAL', documentNumber: '2026-000001', documentIdentityKey: '2026-000001', issueDate: '2026-08-01', serviceDate: '2026-08-01', dueDate: '2026-08-15', description: 'Consulting', currency: 'EUR', netAmountCents: 10000, taxAmountCents: 1900, grossAmountCents: 11900, payableAmountCents: 11900, counterpartySnapshot: '{}', version: 1, updatedAt: '2026-08-01' }],
  openItems: [{ id: 'open-item', ownerId: 'tenant', commercialDocumentId: 'commercial', side: 'DEBIT', currency: 'EUR', originalAmountCents: 11900, allocatedAmountCents: 11900, status: 'SETTLED', version: 2, updatedAt: '2026-08-04' }],
  paymentSettlements: [{ id: 'payment', ownerId: 'tenant', businessPartnerId: 'customer', journalEntryId: 'payment-journal', direction: 'RECEIPT', currency: 'EUR', amountCents: 11900, allocatedAmountCents: 11900, status: 'ALLOCATED', version: 2, occurredOn: '2026-08-04', createdBy: 'actor', updatedAt: '2026-08-04' }],
  settlementAllocations: [{ id: 'allocation', ownerId: 'tenant', openItemId: 'open-item', settlementId: 'payment', journalEntryId: 'payment-journal', kind: 'APPLY', amountCents: 11900, requestKey: 'allocation-1', requestHash: 'allocation-hash', reversesAllocationId: null, effectiveDate: '2026-08-04', createdBy: 'actor', createdAt: '2026-08-04T12:00:00Z' }],
  documentExtractions: [{ id: 'extraction', ownerId: 'tenant', documentId: 'evidence', status: 'REVIEWED', provider: 'LOCAL_PDF_TEXT', providerVersion: '1', inputHash: 'd'.repeat(64), attempt: 1, extractedData: '{}', rawTextHash: 'e'.repeat(64), retryable: false, reviewedBy: 'actor', reviewedAt: '2026-08-04', updatedAt: '2026-08-04' }],
  bankAccounts: [{ id: 'bank-account', ownerId: 'tenant', name: 'Main bank', iban: 'DE12500105170648489890', currency: 'EUR', ledgerAccountId: 'bank-ledger', active: true, updatedAt: '2026-08-04' }],
  bankStatements: [{ id: 'statement', ownerId: 'tenant', bankAccountId: 'bank-account', externalStatementId: 'CAMT-1', format: 'CAMT053', contentHash: 'a'.repeat(64), originalXml: Buffer.from('<Document/>').toString('base64'), periodStart: '2026-08-01', periodEnd: '2026-08-04', openingBalanceCents: 100000, closingBalanceCents: 111900, currency: 'EUR', importedBy: 'actor' }],
  bankTransactions: [{ id: 'bank-transaction', ownerId: 'tenant', bankAccountId: 'bank-account', statementId: 'statement', externalKey: 'b'.repeat(64), factHash: 'c'.repeat(64), amountCents: 11900, currency: 'EUR', bookingDate: '2026-08-04', valueDate: '2026-08-04', bankReference: 'ref', counterpartyName: 'Customer GmbH', counterpartyIban: 'DE44500105175407324931', remittance: '2026-000001', rawData: '{}' }],
  tenantMemberships: [{ ownerId: 'tenant', userId: 'member-user', role: 'ACCOUNTANT', createdAt: '2026-08-01T00:00:00Z', updatedAt: '2026-08-01T00:00:00Z' }],
})

describe('isolated restore verification', () => {
  beforeEach(() => { objects.clear(); storageState.failDelete = false })
  it('loads the canonical snapshot through the real migration chain and rejects rows that do not satisfy the deployed schema', () => {
    expect(verifySnapshotInIsolatedDatabase(snapshot())).toEqual({ periods: 0, entries: 0, documents: 0, eBalanceSubmissions: 0 })
    expect(() => verifySnapshotInIsolatedDatabase({ ...snapshot(), settings: [{ id: 's', ownerId: 'tenant' }] })).toThrow(/NOT NULL/)
  })
  it('keeps legacy schema-v2 backups restorable while schema v3 enforces the complete registry', () => {
    expect(verifySnapshotInIsolatedDatabase({ ...snapshot(), schemaVersion: 2 })).toMatchObject({ registeredCollections: tenantBackupRegistry.length })
    const incompleteV4 = commercialSnapshot() as Record<string, unknown>
    delete incompleteV4.lexwareCompanySetups
    expect(() => verifySnapshotInIsolatedDatabase(incompleteV4 as any)).toThrow(/lexwareCompanySetups is missing/)
  })
  it('restores the complete invoice, numbering, open-item and payment graph and rebuilds derived balances from immutable allocations', () => {
    expect(verifySnapshotInIsolatedDatabase(commercialSnapshot())).toEqual({
      periods: 1, entries: 1, documents: 1, eBalanceSubmissions: 0,
      structuredInvoices: 1, businessPartners: 1, commercialDocuments: 1, openItems: 1,
      paymentSettlements: 1, settlementAllocations: 1, invoiceNumberControls: 4,
      documentExtractions: 1, bankAccounts: 1, bankStatements: 1, bankTransactions: 1,
      bankTransactionMatches: 0, receivablesReminders: 0, receivablesReminderDeliveryAttempts: 0, receivablesReminderDeliveryResults: 0, receivablesReminderCancellations: 0,
      fixedAssets: 0, assetEvents: 0, vatPostings: 0, taxWorkflows: 0,
      registeredCollections: tenantBackupRegistry.length,
    })
  })
  it('restores tenant role assignments with isolated non-production principals so authorization rows satisfy the migrated foreign-key graph', () => {
    expect(() => verifySnapshotInIsolatedDatabase(commercialSnapshot())).not.toThrow()
  })
  it('rejects tenant-crossing rows in every v2 commercial collection', () => {
    const value = commercialSnapshot()
    value.businessPartners[0].ownerId = 'other-tenant'
    expect(() => verifySnapshotInIsolatedDatabase(value)).toThrow(/businessPartners crosses tenant scope/)
  })
  it('refuses to certify balances that cannot be rebuilt from the immutable allocation history', () => {
    const value = commercialSnapshot()
    value.settlementAllocations = []
    expect(() => verifySnapshotInIsolatedDatabase(value)).toThrow(/does not match its allocation history/)
  })
  it('binds every restored byte stream to retained-artifact fixity metadata', () => {
    const content = Buffer.from('exact')
    expect(verifyRestoredArtifactObjects([{ storageKey: 'document', contentHash: 'fa79d4746c21cd960a17b92db8976ddef95a7e20b590721f8e0fa7847a05e486' }], { document: content })).toEqual({ objectCount: 1 })
    expect(() => verifyRestoredArtifactObjects([{ storageKey: 'document', contentHash: '0'.repeat(64) }], { document: content })).toThrow(/fixity/)
  })
  it('requires every live document, thumbnail and storage claim without recursively embedding prior backups', () => {
    const value = { ...snapshot(),
      documents: [{ id: 'document', ownerId: 'tenant', payload: JSON.stringify({ storageKey: 'document.pdf', thumbnailStorageKey: 'document.webp' }) }],
      storageClaims: [{ id: 'claim', ownerId: 'tenant', storageKey: 'claimed.pdf' }],
      backupManifests: [{ id: 'prior', ownerId: 'tenant', payloadStorageKey: 'prior-backup.json' }],
      invoiceIssuanceRequests: [{ storageKey: 'invoices/invoice.xml' }],
    }
    const references = snapshotStorageReferences(value)
    expect(references).toEqual(['claimed.pdf', 'document.pdf', 'document.webp', 'invoices/invoice.xml'])
    expect(() => verifyRestoredStorageObjects([], { 'document.pdf': Buffer.from('only one') }, references)).toThrow(/live storage references/)
  })
  it('marks historical manifests as unavailable when their encrypted payloads are excluded', () => {
    expect(excludeBackupPayloadLocators([{ id: 'prior', payloadStorageKey: 'prior.json', status: 'RESTORE_VERIFIED' }])).toEqual([
      { id: 'prior', payloadStorageKey: null, status: 'PAYLOAD_EXCLUDED' },
    ])
  })
  it('excludes document references after their last retained version is disposed', () => {
    const value = { ...snapshot(),
      documents: [{ id: 'document', ownerId: 'tenant', payload: JSON.stringify({ storageKey: 'deleted.pdf', thumbnailStorageKey: 'deleted.webp' }) }],
      artifacts: [{ id: 'artifact', ownerId: 'tenant', objectType: 'Document', objectId: 'document', storageKey: 'deleted.pdf', storageDeletedAt: '2026-01-01', disposedAt: '2026-01-01', contentHash: '0'.repeat(64) }],
    }
    expect(snapshotStorageReferences(value)).toEqual([])
  })
  it('writes, rereads, verifies and removes restored objects in an isolated namespace', async () => {
    await expect(exerciseIsolatedObjectRestore('tenant', 'backup', { 'documents/a.pdf': Buffer.from('exact') })).resolves.toEqual({ objectCount: 1 })
    expect(objects.size).toBe(0)
  })
  it('blocks certification when decrypted object cleanup fails', async () => {
    storageState.failDelete = true
    await expect(exerciseIsolatedObjectRestore('tenant', 'backup', { document: Buffer.from('sensitive') })).rejects.toThrow(/cleanup failed/)
    expect(objects.size).toBe(1)
  })
})
