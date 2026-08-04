import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function migratedDatabase() {
  const directory = mkdtempSync(join(tmpdir(), 'accounting-posted-journal-'))
  temporaryDirectories.push(directory)
  const database = new DatabaseSync(join(directory, 'journal.db'))
  const migrations = resolve(process.cwd(), 'prisma', 'migrations')
  for (const name of readdirSync(migrations, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name).sort()) {
    database.exec(readFileSync(join(migrations, name, 'migration.sql'), 'utf8'))
  }
  database.exec(`
    INSERT INTO FiscalYear (id, ownerId, year, startsAt, endsAt, status, updatedAt)
      VALUES ('fy', 'tenant', 2026, '2026-01-01', '2026-12-31', 'OPEN', CURRENT_TIMESTAMP);
    INSERT INTO LedgerAccount (id, ownerId, number, name, category, active, createdAt, updatedAt)
      VALUES ('cash', 'tenant', 1000, 'Cash', 'ASSET', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
             ('revenue', 'tenant', 8400, 'Revenue', 'REVENUE', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
    INSERT INTO DocumentRecord (id, ownerId, payload)
      VALUES ('document-1', 'tenant', '{}'),
             ('document-2', 'tenant', '{}');
    INSERT INTO JournalEntry (id, ownerId, sequenceNumber, bookingDate, documentNumber, description, source, state, fiscalYearId, createdAt)
      VALUES ('posted', 'tenant', 1, '2026-08-04', 'INV-1', 'Original posting', 'MANUAL', 'POSTED', 'fy', CURRENT_TIMESTAMP),
             ('draft', 'tenant', 2, '2026-08-05', 'DRAFT-1', 'Draft posting', 'MANUAL', 'DRAFT', 'fy', CURRENT_TIMESTAMP);
    INSERT INTO JournalLine (id, journalEntryId, accountId, debitCents, creditCents)
      VALUES ('posted-debit', 'posted', 'cash', 11900, 0),
             ('posted-credit', 'posted', 'revenue', 0, 11900),
             ('draft-debit', 'draft', 'cash', 100, 0),
             ('draft-credit', 'draft', 'revenue', 0, 100);
    INSERT INTO JournalDocumentAttachment (journalEntryId, documentId)
      VALUES ('posted', 'document-1');
    INSERT INTO VatPostingRecord (
      id, ownerId, sourceId, journalLineId, documentId, taxPoint, jurisdiction,
      netBaseCents, rateBasisPoints, taxCents, deductibleTaxCents, grossCents,
      outputTaxCents, inputTaxCents, ruleId, ruleVersion, vatCase, reason,
      returnBoxes, source, createdAt
    ) VALUES (
      'vat-1', 'tenant', 'source-1', 'posted-credit', 'document-1', '2026-08-04', 'DE',
      10000, 1900, 1900, 1900, 11900, 1900, 0, 'DE_STANDARD', 1, 'standard',
      'UStG §12(1)', '[]', '{}', CURRENT_TIMESTAMP
    );
  `)
  return database
}

describe('posted journal append-only migration', () => {
  it('Given a posted journal, when SQL attempts to change or delete its entry, lines, VAT facts or evidence links, then every original fact remains immutable', () => {
    const database = migratedDatabase()

    expect(() => database.exec("UPDATE JournalEntry SET description='tampered' WHERE id='posted'")).toThrow(/posted journal entries are append-only/)
    expect(() => database.exec("DELETE FROM JournalEntry WHERE id='posted'")).toThrow(/posted journal entries are append-only/)
    expect(() => database.exec("UPDATE JournalLine SET debitCents=999 WHERE id='posted-debit'")).toThrow(/posted journal lines are append-only/)
    expect(() => database.exec("DELETE FROM JournalLine WHERE id='posted-credit'")).toThrow(/posted journal lines are append-only/)
    expect(() => database.exec("UPDATE JournalDocumentAttachment SET documentId='document-2' WHERE journalEntryId='posted' AND documentId='document-1'")).toThrow(/posted journal evidence links are append-only/)
    expect(() => database.exec("DELETE FROM JournalDocumentAttachment WHERE journalEntryId='posted' AND documentId='document-1'")).toThrow(/posted journal evidence links are append-only/)
    expect(() => database.exec("UPDATE VatPostingRecord SET taxCents=1 WHERE id='vat-1'")).toThrow(/VAT posting facts are append-only/)
    expect(() => database.exec("DELETE FROM VatPostingRecord WHERE id='vat-1'")).toThrow(/VAT posting facts are append-only/)

    expect(database.prepare("SELECT description FROM JournalEntry WHERE id='posted'").get()).toEqual({ description: 'Original posting' })
    expect(database.prepare("SELECT debitCents FROM JournalLine WHERE id='posted-debit'").get()).toEqual({ debitCents: 11900 })
    expect(database.prepare("SELECT taxCents FROM VatPostingRecord WHERE id='vat-1'").get()).toEqual({ taxCents: 1900 })
    database.close()
  }, 30_000)

  it('Given an editable draft, when it is completed and posted, then editing is allowed only before the one-way POSTED transition', () => {
    const database = migratedDatabase()
    database.exec("UPDATE JournalLine SET debitCents=200 WHERE id='draft-debit'")
    database.exec("UPDATE JournalLine SET creditCents=200 WHERE id='draft-credit'")
    database.exec("UPDATE JournalEntry SET description='Reviewed draft', state='POSTED' WHERE id='draft'")

    expect(database.prepare("SELECT state, description FROM JournalEntry WHERE id='draft'").get()).toEqual({ state: 'POSTED', description: 'Reviewed draft' })
    expect(() => database.exec("UPDATE JournalEntry SET state='DRAFT' WHERE id='draft'")).toThrow(/posted journal entries are append-only/)
    expect(() => database.exec("UPDATE JournalLine SET debitCents=300 WHERE id='draft-debit'")).toThrow(/posted journal lines are append-only/)
    database.close()
  }, 30_000)

  it('Given an immutable posted journal, when an explicit storno is appended, then the original survives and the reversal is stored as a separate posted entry', () => {
    const database = migratedDatabase()
    database.exec(`
      INSERT INTO JournalEntry (id, ownerId, sequenceNumber, bookingDate, documentNumber, description, source, state, reversalOfId, fiscalYearId, createdAt)
        VALUES ('storno', 'tenant', 3, '2026-08-06', 'STORNO-1', 'Reversal of INV-1', 'STORNO', 'POSTED', 'posted', 'fy', CURRENT_TIMESTAMP);
      INSERT INTO JournalLine (id, journalEntryId, accountId, debitCents, creditCents)
        VALUES ('storno-debit', 'storno', 'revenue', 11900, 0),
               ('storno-credit', 'storno', 'cash', 0, 11900);
    `)

    expect(database.prepare("SELECT reversalOfId, state FROM JournalEntry WHERE id='storno'").get()).toEqual({ reversalOfId: 'posted', state: 'POSTED' })
    expect(database.prepare("SELECT COUNT(*) AS count FROM JournalEntry WHERE id IN ('posted','storno')").get()).toEqual({ count: 2 })
    database.close()
  }, 30_000)
})
