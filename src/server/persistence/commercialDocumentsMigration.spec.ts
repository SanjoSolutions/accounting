import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const directory = mkdtempSync(join(tmpdir(), 'accounting-commercial-migration-'))
const databasePath = join(directory, 'test.db')
const database = new DatabaseSync(databasePath)

function insertPartner(ownerId: string, id: string, number: string, role = 'CUSTOMER') {
  database.prepare('INSERT INTO BusinessPartner (id, ownerId, partnerNumber, role, name) VALUES (?, ?, ?, ?, ?)').run(id, ownerId, number, role, `${number} GmbH`)
}

function insertEvidence(ownerId: string, id: string) {
  database.prepare('INSERT INTO DocumentRecord (id, ownerId, payload) VALUES (?, ?, ?)').run(id, ownerId, '{}')
}

function insertDraft(ownerId: string, id: string, partnerId: string, gross = 11_900) {
  database.prepare(`INSERT INTO CommercialDocument
    (id, ownerId, businessPartnerId, direction, kind, serviceDate, dueDate, description, currency, netAmountCents, taxAmountCents, grossAmountCents, payableAmountCents)
    VALUES (?, ?, ?, 'RECEIVABLE', 'INVOICE', '2026-08-01', '2026-08-15', 'Consulting', 'EUR', ?, ?, ?, ?)`)
    .run(id, ownerId, partnerId, gross - 1_900, 1_900, gross, gross)
}

beforeAll(() => {
  const migrations = resolve(process.cwd(), 'prisma', 'migrations')
  for (const name of readdirSync(migrations, { withFileTypes: true }).filter(item => item.isDirectory()).map(item => item.name).sort()) {
    if (name === '20260804150000_commercial_open_items') {
      database.prepare(`INSERT INTO FiscalYear (id, ownerId, year, startsAt, endsAt, updatedAt) VALUES ('legacy-fy', 'tenant-a', 2026, '2026-01-01', '2026-12-31', CURRENT_TIMESTAMP)`).run()
      database.prepare(`INSERT INTO JournalEntry (id, sequenceNumber, bookingDate, documentNumber, description, fiscalYearId) VALUES ('legacy-entry', 1, '2026-08-01', 'LEGACY-1', 'Legacy posting', 'legacy-fy')`).run()
    }
    database.exec(readFileSync(join(migrations, name, 'migration.sql'), 'utf8'))
  }
})

afterAll(() => {
  database.close()
  rmSync(directory, { recursive: true, force: true })
})

describe('commercial documents migration', () => {
  it('Given a legacy journal, when the migration runs, then ownership is backfilled and every foreign key is valid', () => {
    expect(database.prepare(`SELECT ownerId FROM JournalEntry WHERE id='legacy-entry'`).get()).toEqual({ ownerId: 'tenant-a' })
    expect(database.prepare('PRAGMA foreign_key_check').all()).toEqual([])
  })

  it('Given invalid partner and monetary facts, when they are persisted, then database constraints fail closed', () => {
    expect(() => insertPartner('tenant-a', 'bad-partner', 'BP-BAD', 'UNKNOWN')).toThrow(/CHECK constraint/)
    insertPartner('tenant-a', 'partner-a', 'BP-1')
    expect(() => database.prepare(`INSERT INTO CommercialDocument
      (id, ownerId, businessPartnerId, direction, kind, serviceDate, dueDate, description, currency, netAmountCents, taxAmountCents, grossAmountCents, payableAmountCents)
      VALUES ('bad-money', 'tenant-a', 'partner-a', 'RECEIVABLE', 'INVOICE', '2026-08-01', '2026-08-15', 'Invalid', 'eur', 10000, 1900, 11901, 11901)`).run()).toThrow(/CHECK constraint/)
  })

  it('Given tenant-owned records, when a cross-tenant document relation is attempted, then the compound foreign key rejects it', () => {
    insertPartner('tenant-b', 'partner-b', 'BP-1')
    expect(() => insertDraft('tenant-a', 'cross-tenant', 'partner-b')).toThrow(/FOREIGN KEY constraint/)
    insertEvidence('tenant-a', 'evidence-a')
    insertEvidence('tenant-b', 'evidence-b')
    database.prepare(`INSERT INTO StructuredInvoice (id, ownerId, documentId, syntax, kind, direction, issuerKey, invoiceNumber, issueDate, structuredHash, originalMediaType, structuredOriginal, data, provenance, renderedHtml) VALUES ('structured-a', 'tenant-a', 'evidence-a', 'UBL', 'invoice', 'OUTGOING', 'issuer-a', '2026-000001', '2026-08-01', ?, 'application/xml', X'3C2F3E', ?, '{}', '<p/>')`).run('a'.repeat(64), JSON.stringify({ currency: 'EUR', netAmountCents: 10000, taxAmountCents: 1900, grossAmountCents: 11900 }))
    expect(() => database.prepare(`INSERT INTO CommercialDocument (id, ownerId, businessPartnerId, structuredInvoiceId, evidenceDocumentId, direction, kind, status, documentNumber, documentIdentityKey, issueDate, serviceDate, dueDate, description, currency, netAmountCents, taxAmountCents, grossAmountCents, payableAmountCents, counterpartySnapshot) VALUES ('structured-mismatch', 'tenant-a', 'partner-a', 'structured-a', 'evidence-a', 'RECEIVABLE', 'INVOICE', 'FINAL', '2026-000001', 'mismatch', '2026-08-01', '2026-08-01', '2026-08-15', 'Mismatch', 'EUR', 9999, 1900, 11899, 11899, '{}')`).run()).toThrow(/structured invoice and commercial document facts differ/)
    insertDraft('tenant-a', 'document-a', 'partner-a')
    expect(() => database.prepare(`UPDATE CommercialDocument SET status='POSTED', documentNumber='RE-1', documentIdentityKey='identity-a', issueDate='2026-08-01', evidenceDocumentId='evidence-b', counterpartySnapshot='{}' WHERE id='document-a'`).run()).toThrow(/FOREIGN KEY constraint/)
  })

  it('Given a finalized document, when identity or amounts are edited or it is deleted, then the database preserves immutability', () => {
    database.prepare(`UPDATE CommercialDocument SET status='POSTED', documentNumber='RE-1', documentIdentityKey='identity-a', issueDate='2026-08-01', evidenceDocumentId='evidence-a', postingJournalEntryId='legacy-entry', counterpartySnapshot='{}' WHERE id='document-a'`).run()
    expect(() => database.prepare(`UPDATE CommercialDocument SET grossAmountCents=12000 WHERE id='document-a'`).run()).toThrow(/immutable/)
    expect(() => database.prepare(`DELETE FROM CommercialDocument WHERE id='document-a'`).run()).toThrow(/cannot be deleted/)
  })

  it('Given an open item and posted settlement journals, when allocations are appended, then the derived balance moves from partial to settled', () => {
    database.prepare(`INSERT INTO OpenItem (id, ownerId, commercialDocumentId, side, currency, originalAmountCents) VALUES ('open-a', 'tenant-a', 'document-a', 'DEBIT', 'EUR', 11900)`).run()
    database.prepare(`INSERT INTO JournalEntry (id, ownerId, sequenceNumber, bookingDate, documentNumber, description, fiscalYearId) VALUES ('payment-1', 'tenant-a', 2, '2026-08-10', 'PAY-1', 'Partial payment', 'legacy-fy')`).run()
    database.prepare(`INSERT INTO JournalEntry (id, ownerId, sequenceNumber, bookingDate, documentNumber, description, fiscalYearId) VALUES ('payment-2', 'tenant-a', 3, '2026-08-11', 'PAY-2', 'Final payment', 'legacy-fy')`).run()
    database.prepare(`INSERT INTO PaymentSettlement (id, ownerId, businessPartnerId, journalEntryId, direction, currency, amountCents, occurredOn, createdBy) VALUES ('settlement-1', 'tenant-a', 'partner-a', 'payment-1', 'RECEIPT', 'EUR', 5000, '2026-08-10', 'tester')`).run()
    database.prepare(`INSERT INTO PaymentSettlement (id, ownerId, businessPartnerId, journalEntryId, direction, currency, amountCents, occurredOn, createdBy) VALUES ('settlement-2', 'tenant-a', 'partner-a', 'payment-2', 'RECEIPT', 'EUR', 6900, '2026-08-11', 'tester')`).run()
    const apply = database.prepare(`INSERT INTO SettlementAllocation (id, ownerId, openItemId, settlementId, journalEntryId, kind, amountCents, requestKey, requestHash, effectiveDate, createdBy) VALUES (?, 'tenant-a', ?, ?, ?, 'APPLY', ?, ?, ?, '2026-08-10', 'tester')`)
    apply.run('allocation-1', 'open-a', 'settlement-1', 'payment-1', 5_000, 'request-1', 'hash-1')
    expect(database.prepare(`SELECT allocatedAmountCents, status, version FROM OpenItem WHERE id='open-a'`).get()).toEqual({ allocatedAmountCents: 5_000, status: 'PARTIAL', version: 2 })
    insertDraft('tenant-a', 'document-b', 'partner-a')
    database.prepare(`UPDATE CommercialDocument SET status='POSTED', documentNumber='RE-2', documentIdentityKey='identity-b', issueDate='2026-08-01', evidenceDocumentId='evidence-a', postingJournalEntryId='legacy-entry', counterpartySnapshot='{}' WHERE id='document-b'`).run()
    database.prepare(`INSERT INTO OpenItem (id, ownerId, commercialDocumentId, side, currency, originalAmountCents) VALUES ('open-b', 'tenant-a', 'document-b', 'DEBIT', 'EUR', 11900)`).run()
    expect(() => apply.run('allocation-payment-over', 'open-b', 'settlement-1', 'payment-1', 1, 'request-payment-over', 'hash-payment-over')).toThrow(/payment settlement scope or available amount/)
    expect(database.prepare(`SELECT allocatedAmountCents FROM OpenItem WHERE id='open-b'`).get()).toEqual({ allocatedAmountCents: 0 })
    expect(() => apply.run('allocation-over', 'open-a', 'settlement-2', 'payment-2', 6_901, 'request-over', 'hash-over')).toThrow()
    expect(database.prepare(`SELECT allocatedAmountCents FROM OpenItem WHERE id='open-a'`).get()).toEqual({ allocatedAmountCents: 5_000 })
    apply.run('allocation-2', 'open-a', 'settlement-2', 'payment-2', 6_900, 'request-2', 'hash-2')
    expect(database.prepare(`SELECT allocatedAmountCents, status, version FROM OpenItem WHERE id='open-a'`).get()).toEqual({ allocatedAmountCents: 11_900, status: 'SETTLED', version: 3 })
    expect(database.prepare(`SELECT allocatedAmountCents, status FROM PaymentSettlement WHERE id='settlement-2'`).get()).toEqual({ allocatedAmountCents: 6_900, status: 'ALLOCATED' })
  })

  it('Given a settlement allocation, when an exact reversal is appended, then the item reopens and history remains immutable', () => {
    database.prepare(`INSERT INTO JournalEntry (id, ownerId, sequenceNumber, bookingDate, documentNumber, description, fiscalYearId) VALUES ('reversal-journal', 'tenant-a', 4, '2026-08-12', 'REV-1', 'Payment reversal', 'legacy-fy')`).run()
    database.prepare(`INSERT INTO SettlementAllocation (id, ownerId, openItemId, settlementId, journalEntryId, kind, amountCents, requestKey, requestHash, reversesAllocationId, effectiveDate, createdBy) VALUES ('reversal-1', 'tenant-a', 'open-a', 'settlement-2', 'reversal-journal', 'REVERSAL', -6900, 'request-reversal', 'hash-reversal', 'allocation-2', '2026-08-12', 'tester')`).run()
    expect(database.prepare(`SELECT allocatedAmountCents, status FROM OpenItem WHERE id='open-a'`).get()).toEqual({ allocatedAmountCents: 5_000, status: 'PARTIAL' })
    expect(database.prepare(`SELECT allocatedAmountCents, status FROM PaymentSettlement WHERE id='settlement-2'`).get()).toEqual({ allocatedAmountCents: 0, status: 'UNALLOCATED' })
    expect(() => database.prepare(`DELETE FROM SettlementAllocation WHERE id='allocation-1'`).run()).toThrow(/immutable/)
    expect(() => database.prepare(`UPDATE SettlementAllocation SET amountCents=1 WHERE id='allocation-1'`).run()).toThrow(/immutable/)
    expect(() => database.prepare(`INSERT INTO SettlementAllocation (id, ownerId, openItemId, settlementId, journalEntryId, kind, amountCents, requestKey, requestHash, reversesAllocationId, effectiveDate, createdBy) VALUES ('reversal-2', 'tenant-a', 'open-a', 'settlement-2', 'reversal-journal', 'REVERSAL', -6900, 'request-reversal-2', 'hash-reversal-2', 'allocation-2', '2026-08-12', 'tester')`).run()).toThrow()
  })
})
