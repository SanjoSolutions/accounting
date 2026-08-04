import { beforeEach, describe, expect, it, vi } from 'vitest'

const captured = vi.hoisted(() => ({ snapshot: null as Record<string, unknown> | null }))

const tenantRows = vi.hoisted(() => ({
  businessPartner: [{ id: 'partner-a', ownerId: 'tenant-a' }, { id: 'partner-b', ownerId: 'tenant-b' }],
  commercialDocument: [{ id: 'commercial-a', ownerId: 'tenant-a' }, { id: 'commercial-b', ownerId: 'tenant-b' }],
  openItem: [{ id: 'open-a', ownerId: 'tenant-a' }, { id: 'open-b', ownerId: 'tenant-b' }],
  paymentSettlement: [{ id: 'payment-a', ownerId: 'tenant-a' }, { id: 'payment-b', ownerId: 'tenant-b' }],
  settlementAllocation: [{ id: 'allocation-a', ownerId: 'tenant-a' }, { id: 'allocation-b', ownerId: 'tenant-b' }],
  structuredInvoice: [
    { id: 'structured-a', ownerId: 'tenant-a', structuredOriginal: Buffer.from('a'), visualOriginal: null },
    { id: 'structured-b', ownerId: 'tenant-b', structuredOriginal: Buffer.from('b'), visualOriginal: null },
  ],
  invoiceNumberSequence: [{ ownerId: 'tenant-a', year: 2026 }, { ownerId: 'tenant-b', year: 2026 }],
  invoiceNumberSequenceOnboarding: [{ ownerId: 'tenant-a', year: 2026 }, { ownerId: 'tenant-b', year: 2026 }],
  invoiceNumberReservation: [{ id: 'reservation-a', ownerId: 'tenant-a' }, { id: 'reservation-b', ownerId: 'tenant-b' }],
  invoiceIssuanceRequest: [{ id: 'request-a', ownerId: 'tenant-a' }, { id: 'request-b', ownerId: 'tenant-b' }],
  documentExtraction: [{ id: 'extraction-a', ownerId: 'tenant-a' }, { id: 'extraction-b', ownerId: 'tenant-b' }],
  bankAccount: [{ id: 'bank-account-a', ownerId: 'tenant-a' }, { id: 'bank-account-b', ownerId: 'tenant-b' }],
  bankStatement: [
    { id: 'bank-statement-a', ownerId: 'tenant-a', originalXml: Buffer.from('<a/>') },
    { id: 'bank-statement-b', ownerId: 'tenant-b', originalXml: Buffer.from('<b/>') },
  ],
  bankTransaction: [{ id: 'bank-transaction-a', ownerId: 'tenant-a' }, { id: 'bank-transaction-b', ownerId: 'tenant-b' }],
}))

function tenantDelegate(rows: Array<Record<string, unknown>>) {
  return {
    findMany: vi.fn(async (query?: { where?: { ownerId?: string } }) => {
      const ownerId = query?.where?.ownerId
      return ownerId ? rows.filter(row => row.ownerId === ownerId) : rows
    }),
  }
}

function emptyDelegate() { return { findMany: vi.fn(async () => []) } }
const policy = vi.hoisted(() => ({ ownerId: 'tenant-a', operatorIds: '["operator-a"]', allowedStorageRegions: '["DE"]', backupKeyId: 'backup-key' }))
const transaction = vi.hoisted(() => ({
  accountRecord: emptyDelegate(), companyProfileVersion: emptyDelegate(), companyProfileAddressConfirmation: emptyDelegate(),
  fiscalYear: { ...emptyDelegate(), findFirst: vi.fn(async () => null) }, ledgerProfile: { findUnique: vi.fn(async () => null) },
  ledgerAccount: emptyDelegate(), accountMappingVersion: emptyDelegate(),
  journalEntry: emptyDelegate(), documentRecord: emptyDelegate(), documentStorageClaim: emptyDelegate(),
  retainedArtifact: emptyDelegate(), fixityCheck: emptyDelegate(), auditEvent: emptyDelegate(),
  auditHead: { findUnique: vi.fn(async () => null) }, journalDraft: emptyDelegate(), periodReopenRequest: emptyDelegate(),
  filingAmendment: emptyDelegate(), eBalanceSubmission: emptyDelegate(),
  businessPartner: tenantDelegate(tenantRows.businessPartner), commercialDocument: tenantDelegate(tenantRows.commercialDocument),
  openItem: tenantDelegate(tenantRows.openItem), paymentSettlement: tenantDelegate(tenantRows.paymentSettlement),
  settlementAllocation: tenantDelegate(tenantRows.settlementAllocation), structuredInvoice: tenantDelegate(tenantRows.structuredInvoice),
  invoiceNumberSequence: tenantDelegate(tenantRows.invoiceNumberSequence),
  invoiceNumberSequenceOnboarding: tenantDelegate(tenantRows.invoiceNumberSequenceOnboarding),
  invoiceNumberReservation: tenantDelegate(tenantRows.invoiceNumberReservation),
  invoiceIssuanceRequest: tenantDelegate(tenantRows.invoiceIssuanceRequest),
  documentExtraction: tenantDelegate(tenantRows.documentExtraction),
  bankAccount: tenantDelegate(tenantRows.bankAccount), bankStatement: tenantDelegate(tenantRows.bankStatement),
  bankTransaction: tenantDelegate(tenantRows.bankTransaction),
  backupManifest: { ...emptyDelegate(), create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'backup-a', ...data })) },
  compliancePolicy: { findUnique: vi.fn(async () => policy) },
  journalDocumentAttachment: emptyDelegate(),
}))

const prismaMock = vi.hoisted(() => ({
  compliancePolicy: { findUnique: vi.fn(async () => policy) },
  documentRecord: emptyDelegate(), retainedArtifact: emptyDelegate(), journalDocumentAttachment: emptyDelegate(),
  fiscalYear: { findFirst: vi.fn(async () => null) },
  $transaction: vi.fn(async (callback: (value: typeof transaction) => Promise<unknown>) => callback(new Proxy(transaction, {
    get(target, property) {
      if (property in target) return target[property as keyof typeof target]
      return { findMany: vi.fn(async () => []), findUnique: vi.fn(async () => null) }
    },
  }))),
}))

vi.mock('server-only', () => ({}))
vi.mock('@/server/persistence/client', () => ({ prisma: prismaMock }))
vi.mock('@/server/ledger', () => ({ postJournalEntry: vi.fn(), postJournalCorrection: vi.fn() }))
vi.mock('@/server/storage', () => ({ getDocumentStorage: () => ({ read: vi.fn(), delete: vi.fn() }) }))
vi.mock('@/server/storage/config', () => ({ getAuthoritativeStorageRegion: () => 'DE' }))
vi.mock('./auditPersistence', () => ({ verifyAuditChain: () => true, appendAuditEvent: vi.fn() }))
vi.mock('./objectStorage', () => ({ persistComplianceObject: vi.fn(async () => 'backups/backup-a.json') }))
vi.mock('./restoreVerification', () => ({
  excludeBackupPayloadLocators: (rows: unknown[]) => rows,
  snapshotStorageReferences: () => [],
  verifyRestoredStorageObjects: vi.fn(),
  verifySnapshotInIsolatedDatabase: vi.fn(),
  exerciseIsolatedObjectRestore: vi.fn(),
}))
vi.mock('./retention', () => ({
  createBackup: vi.fn((input: { database: Buffer; ownerId: string; recoveryPointAt: string; region: string; keyId: string }) => {
    captured.snapshot = JSON.parse(input.database.toString()) as Record<string, unknown>
    return { backupId: 'backup-a', ownerId: input.ownerId, recoveryPointAt: input.recoveryPointAt, region: input.region, keyId: input.keyId, databaseHash: 'database-hash', objectsHash: 'objects-hash', iv: 'iv', tag: 'tag', encrypted: 'encrypted' }
  }),
  resolveBackupKey: () => Buffer.alloc(32),
  retentionDeadline: vi.fn(), sha256: vi.fn(), restoreBackup: vi.fn(), backupMatchesManifest: vi.fn(), assertRecoveryObjectives: vi.fn(),
}))

import { createTenantBackup } from './runtime'

describe('tenant backup runtime snapshot capture', () => {
  beforeEach(() => { captured.snapshot = null; vi.clearAllMocks() })

  it('Given two tenants, when tenant A is backed up, then schema v2 captures every operational collection for tenant A only', async () => {
    await createTenantBackup('tenant-a', 'operator-a', 'DE', 'scheduled recovery point')

    expect(captured.snapshot).toMatchObject({ schemaVersion: 4, ownerId: 'tenant-a' })
    const collections = {
      businessPartners: 'partner-a', commercialDocuments: 'commercial-a', openItems: 'open-a',
      paymentSettlements: 'payment-a', settlementAllocations: 'allocation-a', structuredInvoices: 'structured-a',
      invoiceNumberSequences: undefined, invoiceNumberOnboarding: undefined,
      invoiceNumberReservations: 'reservation-a', invoiceIssuanceRequests: 'request-a',
      documentExtractions: 'extraction-a', bankAccounts: 'bank-account-a',
      bankStatements: 'bank-statement-a', bankTransactions: 'bank-transaction-a',
    } as const
    for (const [name, expectedId] of Object.entries(collections)) {
      const rows = (captured.snapshot as Record<string, Array<Record<string, unknown>>>)[name]
      expect(rows, `${name} must be present`).toHaveLength(1)
      expect(rows[0].ownerId).toBe('tenant-a')
      if (expectedId) expect(rows[0].id).toBe(expectedId)
      expect(JSON.stringify(rows)).not.toContain('tenant-b')
    }
    expect((captured.snapshot as { structuredInvoices: Array<{ structuredOriginal: string }> }).structuredInvoices[0].structuredOriginal).toBe(Buffer.from('a').toString('base64'))
    expect((captured.snapshot as { bankStatements: Array<{ originalXml: string }> }).bankStatements[0].originalXml).toBe(Buffer.from('<a/>').toString('base64'))
  })
})
