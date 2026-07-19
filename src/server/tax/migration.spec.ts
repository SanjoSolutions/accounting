import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'

const directories: string[] = []
afterEach(() => directories.splice(0).forEach(directory => rmSync(directory, { recursive: true, force: true })))

describe('tax workflow integration migration', () => {
  it('creates tenant-scoped durable tax, VAT and structured-invoice storage', () => {
    const directory = mkdtempSync(join(tmpdir(), 'accounting-tax-migration-')); directories.push(directory)
    const database = new DatabaseSync(join(directory, 'migration.db'))
    const root = resolve(process.cwd(), 'prisma', 'migrations')
    for (const name of readdirSync(root, { withFileTypes: true }).filter(item => item.isDirectory()).map(item => item.name).sort()) database.exec(readFileSync(join(root, name, 'migration.sql'), 'utf8'))
    const tables = database.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => (row as { name: string }).name)
    expect(tables).toEqual(expect.arrayContaining(['StructuredInvoice', 'InvoiceNumberReservation', 'VatPostingRecord', 'VatReversalMarker', 'TaxWorkflowRecord', 'TaxSubmissionRequest', 'TaxAdjustmentRecord', 'TaxDatasetPreparationRecord', 'TaxAssessmentRecord']))
    const journalColumns = database.prepare("PRAGMA table_info('JournalLine')").all().map(row => (row as { name: string }).name)
    expect(journalColumns).toEqual(expect.arrayContaining(['taxPoint', 'taxJurisdiction', 'netBaseCents', 'taxRateBasisPoints', 'taxAmountCents', 'deductibleTaxCents', 'taxRuleId', 'taxRuleVersion', 'taxReason']))
    const indexes = database.prepare("SELECT name FROM sqlite_master WHERE type='index'").all().map(row => (row as { name: string }).name)
    expect(indexes).toEqual(expect.arrayContaining(['StructuredInvoice_ownerId_direction_issuerKey_invoiceNumber_key', 'InvoiceNumberReservation_ownerId_invoiceNumber_key', 'VatPostingRecord_ownerId_sourceId_key', 'TaxWorkflowRecord_ownerId_idempotencyKey_key', 'TaxSubmissionRequest_ownerId_requestKey_key']))
    database.exec("INSERT INTO DocumentRecord (id, ownerId, payload) VALUES ('document-1', 'tenant-a', '{}'), ('document-2', 'tenant-a', '{}')")
    const insert = database.prepare("INSERT INTO StructuredInvoice (id, ownerId, documentId, syntax, kind, direction, issuerKey, invoiceNumber, issueDate, structuredHash, originalMediaType, structuredOriginal, data, provenance, renderedHtml) VALUES (?, 'tenant-a', ?, 'UBL', 'invoice', 'INCOMING', ?, 'DUPLICATE-1', '2026-01-01', ?, 'application/xml', X'00', '{}', '{}', '<html></html>')")
    insert.run('invoice-1', 'document-1', 'supplier-a', 'a'.repeat(64)); insert.run('invoice-2', 'document-2', 'supplier-b', 'b'.repeat(64))
    expect(database.prepare("SELECT COUNT(*) AS count FROM StructuredInvoice WHERE invoiceNumber = 'DUPLICATE-1'").get()).toEqual({ count: 2 })
    database.close()
  })
  it('backfills VAT control accounts and every existing SKR04 mapping cohort', () => {
    const directory = mkdtempSync(join(tmpdir(), 'accounting-tax-upgrade-')); directories.push(directory)
    const database = new DatabaseSync(join(directory, 'upgrade.db'))
    const root = resolve(process.cwd(), 'prisma', 'migrations')
    const names = readdirSync(root, { withFileTypes: true }).filter(item => item.isDirectory()).map(item => item.name).sort()
    const latest = '20260719160000_tax_workflow_integration'
    for (const name of names.filter(name => name !== latest)) database.exec(readFileSync(join(root, name, 'migration.sql'), 'utf8'))
    database.exec("INSERT INTO LedgerProfile (ownerId, chart, accountLength) VALUES ('tenant-skr04', 'SKR04', 5)")
    database.exec("INSERT INTO AccountMappingVersion (id, ownerId, chartId, accountNumber, effectiveFrom, accountName, accountType, normalBalance, hgbPosition, eBilanzPosition, active) VALUES ('existing-map', 'tenant-skr04', 'SKR04', 44000, '2026-01-01', 'Erlöse', 'REVENUE', 'CREDIT', 'HGB.275.2.1', 'is.netIncome.regular.operatingTC.grossTradingProfit.totalOutput', 1)")
    database.exec(readFileSync(join(root, latest, 'migration.sql'), 'utf8'))
    expect(database.prepare("SELECT number FROM LedgerAccount WHERE ownerId = 'tenant-skr04' AND eBilanzPosition LIKE '%vat' ORDER BY number").all()).toEqual([{ number: 14060 }, { number: 38060 }])
    expect(database.prepare("SELECT accountNumber FROM AccountMappingVersion WHERE ownerId = 'tenant-skr04' AND effectiveFrom = '2026-01-01' AND eBilanzPosition LIKE '%vat' ORDER BY accountNumber").all()).toEqual([{ accountNumber: 14060 }, { accountNumber: 38060 }])
    database.close()
  })
})
