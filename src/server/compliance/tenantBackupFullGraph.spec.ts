import { DatabaseSync } from 'node:sqlite'
import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('@/server/storage', () => ({ getDocumentStorage: vi.fn() }))
import { snapshotStorageReferences, verifySnapshotInIsolatedDatabase } from './restoreVerification'
import { captureRegisteredTenantSnapshot, tenantBackupRegistry } from './tenantBackupRegistry'

type Column = { name: string; type: string; notnull: number; dflt_value: string | null; pk: number }
type ForeignKey = { id: number; seq: number; table: string; from: string; to: string }

function migratedDatabase() {
  const database = new DatabaseSync(':memory:')
  const root = resolve(process.cwd(), 'prisma/migrations')
  for (const directory of readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    database.exec(readFileSync(join(root, directory.name, 'migration.sql'), 'utf8'))
  }
  database.exec('PRAGMA foreign_keys = ON')
  return database
}

const instant = '2026-08-04T12:00:00.000Z'
const special: Record<string, Record<string, unknown>> = {
  TenantMembership: { role: 'ADMIN' },
  CompliancePolicy: { allowedStorageRegions: '["DE"]', operatorIds: '["tenant-a","tenant-b"]', recoveryPointObjectiveMinutes: 60, recoveryTimeObjectiveMinutes: 60, backupKeyId: 'backup-key' },
  CompliancePackage: { storageKey: 'objects/CompliancePackage' },
  RetainedArtifact: { storageKey: 'objects/RetainedArtifact' },
  InvoiceIssuanceRequest: { storageKey: 'objects/InvoiceIssuanceRequest' },
  BusinessPartner: { role: 'CUSTOMER', countryCode: 'DE', paymentTermDays: 14 },
  CommercialDocument: { direction: 'RECEIVABLE', kind: 'INVOICE', status: 'FINAL', currency: 'EUR', netAmountCents: 1, taxAmountCents: 0, grossAmountCents: 1, payableAmountCents: 1 },
  OpenItem: { side: 'DEBIT', currency: 'EUR', originalAmountCents: 2, allocatedAmountCents: 0, status: 'OPEN', version: 1 },
  PaymentSettlement: { direction: 'RECEIPT', currency: 'EUR', amountCents: 1, allocatedAmountCents: 0, status: 'UNALLOCATED', version: 1 },
  SettlementAllocation: { kind: 'APPLY', amountCents: 1, requestKey: 'allocation-request-key', requestHash: 'a'.repeat(64) },
  CorrectionNetting: { amountCents: 1, requestKey: 'correction-netting-request-key', requestHash: '8'.repeat(64), effectiveDate: instant, createdBy: 'backup-fixture' },
  ReceivablesReminder: { level: 1, requestKey: 'reminder-request-key', requestHash: 'f'.repeat(64), issuedOn: '2026-08-05T12:00:00.000Z', paymentDueDate: '2026-08-12T12:00:00.000Z', originalDueDate: instant, remainingAmountCents: 1, currency: 'EUR', invoiceNumber: 'R-1', partnerSnapshot: '{}', issuerSnapshot: '{}', printableHtml: '<html></html>' },
  ReceivablesReminderDeliveryAttempt: { requestKey: 'reminder-delivery-key', requestHash: '6'.repeat(64), recipient: 'billing@example.de', subject: 'Zahlungserinnerung', contentHash: '7'.repeat(64), attachmentFileName: 'reminder.html', attachmentHash: '8'.repeat(64) },
  ReceivablesReminderDeliveryResult: { status: 'SENT', providerMessageId: 'backup-provider-message' },
  ReceivablesReminderCancellation: { requestKey: 'reminder-cancel-key', requestHash: '9'.repeat(64), cancelledOn: '2026-08-06T12:00:00.000Z', reason: 'Fixture cancellation' },
  BankAccount: { name: 'Main bank', iban: 'DE12500105170648489890', currency: 'EUR' },
  BankStatement: { externalStatementId: 'statement', format: 'CAMT053', contentHash: 'b'.repeat(64), originalXml: Buffer.from('<Document/>'), currency: 'EUR', openingBalanceCents: 0, closingBalanceCents: 1 },
  BankTransaction: { externalKey: 'c'.repeat(64), factHash: 'd'.repeat(64), amountCents: 1, currency: 'EUR' },
  BankTransactionMatch: { kind: 'APPLY', amountCents: 1, requestKey: 'bank-match-request', requestHash: 'e'.repeat(64) },
  TaxAnnualCaseRecord: { year: 2025, status: 'PREPARED', ruleVersion: 'DE-UG-SIMPLE-2025.1', legalForm: 'UG', establishments: 1, municipalityCode: '11000000', hebesatzBasisPoints: 20000, foreignIncome: 0, groupOrConsolidation: 0, lossCarry: 0, specialRegime: 0, withholdingOrCredits: 0, payroll: 0 },
  TaxAssessmentRecord: { authority: 'FINANZAMT', evidenceStorageKey: 'objects/TaxAssessmentRecord' },
}

function fallbackValue(table: string, column: Column, ownerId: string): unknown {
  const override = special[table]?.[column.name]
  if (override !== undefined) return override
  if (column.name === 'ownerId') return ownerId
  if (column.name === 'id') return `${table}-${ownerId}`
  if (column.name === 'year') return 2025
  if (/currency/i.test(column.name)) return 'EUR'
  if (/countryCode/.test(column.name)) return 'DE'
  if (/Date|At$|startsAt|endsAt|periodStart|periodEnd|effectiveFrom|effectiveDate|occurredOn|taxPoint|lockedAt/i.test(column.name)) return instant
  if (/hash|checksum/i.test(column.name)) return `${table}-${column.name}-${ownerId}`.padEnd(64, '0').slice(0, 64)
  if (/payload|data|manifest|provenance|returnBoxes|sourceDocumentIds|evidenceIds/i.test(column.name)) return '{}'
  if (/storageKey/i.test(column.name)) return `objects/${table}-${ownerId}`
  if (/BLOB/i.test(column.type)) return Buffer.from(`${table}-${ownerId}`)
  if (/INT|BOOL/i.test(column.type)) return 1
  return `${table}-${column.name}-${ownerId}`
}

function referencedRow(database: DatabaseSync, foreign: ForeignKey[], ownerId: string) {
  const table = foreign[0].table
  if (table === 'JournalLine') return database.prepare('SELECT l.* FROM JournalLine l JOIN JournalEntry e ON e.id = l.journalEntryId WHERE e.ownerId = ? LIMIT 1').get(ownerId) as Record<string, unknown>
  const columns = database.prepare(`PRAGMA table_info("${table}")`).all() as Column[]
  const ownerColumn = columns.some(column => column.name === 'ownerId')
  return database.prepare(`SELECT * FROM "${table}"${ownerColumn ? ' WHERE ownerId = ?' : ''} LIMIT 1`).get(...(ownerColumn ? [ownerId] : [])) as Record<string, unknown>
}

function seedTable(database: DatabaseSync, table: string, ownerId: string) {
  if (table === 'TenantMembership' && !database.prepare('SELECT 1 FROM "user" LIMIT 1').get()) {
    database.prepare('INSERT INTO "user" (id,name,email,emailVerified,updatedAt) VALUES (?,?,?,?,?)').run('backup-membership-user', 'Backup membership fixture', 'backup-membership@invalid.example', 0, instant)
  }
  if (table === 'CorrectionNetting') {
    const original = database.prepare('SELECT d.id AS documentId,o.id AS openItemId,d.businessPartnerId,d.currency,d.evidenceDocumentId,d.postingJournalEntryId FROM CommercialDocument d JOIN OpenItem o ON o.ownerId=d.ownerId AND o.commercialDocumentId=d.id WHERE d.ownerId=? LIMIT 1').get(ownerId) as any
    const journal = database.prepare('SELECT id FROM JournalEntry WHERE ownerId=? LIMIT 1').get(ownerId) as any
    const correctionDocumentId = `CorrectionCommercialDocument-${ownerId}`; const creditOpenItemId = `CorrectionOpenItem-${ownerId}`
    database.prepare('INSERT INTO CommercialDocument (id,ownerId,businessPartnerId,evidenceDocumentId,postingJournalEntryId,correctsId,direction,kind,status,documentNumber,documentIdentityKey,issueDate,serviceDate,dueDate,description,currency,netAmountCents,taxAmountCents,grossAmountCents,payableAmountCents,counterpartySnapshot) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(correctionDocumentId, ownerId, original.businessPartnerId, original.evidenceDocumentId, journal.id, original.documentId, 'RECEIVABLE', 'CREDIT_NOTE', 'POSTED', `CN-${ownerId}`, `credit-identity-${ownerId}`, instant, instant, instant, 'Backup credit note', original.currency, 1, 0, 1, 1, '{}')
    database.prepare('INSERT INTO OpenItem (id,ownerId,commercialDocumentId,side,currency,originalAmountCents,allocatedAmountCents,status,version) VALUES (?,?,?,?,?,?,?,?,?)').run(creditOpenItemId, ownerId, correctionDocumentId, 'CREDIT', original.currency, 1, 0, 'OPEN', 1)
  }
  const columns = database.prepare(`PRAGMA table_info("${table}")`).all() as Column[]
  const foreignKeys = database.prepare(`PRAGMA foreign_key_list("${table}")`).all() as ForeignKey[]
  const row: Record<string, unknown> = {}
  for (const group of new Map(foreignKeys.map(item => [item.id, foreignKeys.filter(candidate => candidate.id === item.id)]))) {
    if (group[1].filter(foreign => foreign.from !== 'ownerId').every(foreign => !columns.find(column => column.name === foreign.from)?.notnull)) continue
    const referenced = referencedRow(database, group[1], ownerId)
    if (!referenced) throw new Error(`Missing ${group[1][0].table} fixture for ${table}`)
    for (const foreign of group[1]) row[foreign.from] = referenced[foreign.to]
  }
  for (const column of columns) {
    if (column.name === 'ownerId') { row.ownerId = ownerId; continue }
    if (Object.prototype.hasOwnProperty.call(special[table] ?? {}, column.name)) { row[column.name] = special[table][column.name]; continue }
    if (row[column.name] !== undefined || column.dflt_value !== null || (!column.notnull && !column.pk)) continue
    row[column.name] = fallbackValue(table, column, ownerId)
  }
  if (table === 'CompliancePolicy') row.operatorIds = JSON.stringify([ownerId])
  if (table === 'CommercialDocument') {
    row.documentNumber = `INV-${ownerId}`; row.documentIdentityKey = `identity-${ownerId}`; row.issueDate = instant
    row.evidenceDocumentId = `DocumentRecord-${ownerId}`; row.counterpartySnapshot = '{}'
  }
  if (table === 'CorrectionNetting') {
    const original = database.prepare('SELECT o.id AS openItemId FROM CommercialDocument d JOIN OpenItem o ON o.ownerId=d.ownerId AND o.commercialDocumentId=d.id WHERE d.ownerId=? AND d.kind=\'INVOICE\' LIMIT 1').get(ownerId) as any
    const journal = database.prepare('SELECT id FROM JournalEntry WHERE ownerId=? LIMIT 1').get(ownerId) as any
    row.correctionDocumentId = `CorrectionCommercialDocument-${ownerId}`; row.originalOpenItemId = original.openItemId; row.creditOpenItemId = `CorrectionOpenItem-${ownerId}`; row.journalEntryId = journal.id
  }
  for (const field of ['storageKey', 'evidenceStorageKey']) if (typeof row[field] === 'string' && !String(row[field]).endsWith(`-${ownerId}`)) row[field] = `${row[field]}-${ownerId}`
  const names = Object.keys(row)
  database.prepare(`INSERT INTO "${table}" (${names.map(name => `"${name}"`).join(',')}) VALUES (${names.map(() => '?').join(',')})`).run(...Object.values(row) as any[])
}

function seedOwner(database: DatabaseSync, ownerId: string) {
  for (const definition of [...tenantBackupRegistry].sort((a, b) => a.order - b.order)) {
    if (['AuditEvent', 'AuditHead'].includes(definition.model)) continue
    seedTable(database, definition.table, ownerId)
    if (definition.model === 'JournalEntry') {
      const entry = database.prepare('SELECT id FROM JournalEntry WHERE ownerId = ?').get(ownerId) as { id: string }
      const account = database.prepare('SELECT id FROM LedgerAccount WHERE ownerId = ?').get(ownerId) as { id: string }
      const document = database.prepare('SELECT id FROM DocumentRecord WHERE ownerId = ?').get(ownerId) as { id: string }
      database.prepare('INSERT INTO JournalLine (id,journalEntryId,accountId,debitCents,creditCents) VALUES (?,?,?,?,?)').run(`line-${ownerId}`, entry.id, account.id, 0, 0)
      database.prepare('INSERT INTO JournalDocumentAttachment (journalEntryId,documentId) VALUES (?,?)').run(entry.id, document.id)
    }
  }
}

function sqliteDelegates(database: DatabaseSync) {
  const delegates: Record<string, { findMany: (query: any) => Promise<any[]>; findUnique: (query: any) => Promise<any> }> = {}
  for (const definition of tenantBackupRegistry) delegates[definition.delegate] = {
    findMany: async (query: any) => {
      if (definition.model === 'AuditEvent') return []
      const ownerId = query.where.ownerId
      const rows = database.prepare(`SELECT * FROM "${definition.table}" WHERE ownerId = ?`).all(ownerId) as any[]
      if (definition.mode === 'journalGraph') for (const row of rows) {
        row.lines = database.prepare('SELECT * FROM JournalLine WHERE journalEntryId = ?').all(row.id)
        row.documents = database.prepare('SELECT * FROM JournalDocumentAttachment WHERE journalEntryId = ?').all(row.id)
      }
      return rows
    },
    findUnique: async (query: any) => definition.model === 'AuditHead' ? null : database.prepare(`SELECT * FROM "${definition.table}" WHERE ownerId = ? LIMIT 1`).get(query.where.ownerId),
  }
  return delegates
}

describe('complete tenant backup graph', () => {
  it('Given every tenant-owned accounting model in a real migrated database, when tenant A is captured and restored, then the full graph remains isolated and referentially valid', async () => {
    const source = migratedDatabase()
    try {
      seedOwner(source, 'tenant-a')
      seedOwner(source, 'tenant-b')
      expect(source.prepare('PRAGMA foreign_key_check').all()).toEqual([])

      const captured = await captureRegisteredTenantSnapshot(sqliteDelegates(source), 'tenant-a')
      const snapshot = { schemaVersion: 4, ownerId: 'tenant-a', recoveryPointAt: instant, ...captured } as any
      for (const definition of tenantBackupRegistry) {
        const values = definition.shape === 'singleton' ? [snapshot[definition.snapshotKey]].filter(Boolean) : snapshot[definition.snapshotKey]
        expect(values.every((row: any) => row.ownerId === 'tenant-a'), definition.model).toBe(true)
      }
      expect(JSON.stringify(snapshot)).not.toContain('tenant-b')
      expect(verifySnapshotInIsolatedDatabase(snapshot)).toMatchObject({ registeredCollections: tenantBackupRegistry.length })
      expect(snapshotStorageReferences(snapshot)).toEqual(expect.arrayContaining([
        'objects/CompliancePackage-tenant-a', 'objects/EBalanceLifecycleReport-tenant-a', 'objects/TaxAssessmentRecord-tenant-a',
      ]))
    } finally { source.close() }
  })
})
