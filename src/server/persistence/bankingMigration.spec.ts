import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const directory = mkdtempSync(join(tmpdir(), 'accounting-banking-migration-')); const path = join(directory, 'test.db'); const db = new DatabaseSync(path)
beforeAll(() => { for (const name of readdirSync(resolve('prisma/migrations'), { withFileTypes: true }).filter(item => item.isDirectory()).map(item => item.name).sort()) db.exec(readFileSync(resolve('prisma/migrations', name, 'migration.sql'), 'utf8')); db.exec(`INSERT INTO LedgerAccount(id,ownerId,number,name,category,updatedAt) VALUES ('ledger-a','tenant-a',1200,'Bank','ASSET',CURRENT_TIMESTAMP),('ledger-b','tenant-b',1200,'Bank','ASSET',CURRENT_TIMESTAMP); INSERT INTO BankAccount(id,ownerId,name,iban,ledgerAccountId) VALUES ('bank-a','tenant-a','Bank','DE44500105175407324931','ledger-a');`) })
afterAll(() => { db.close(); rmSync(directory, { recursive: true, force: true }) })

describe('banking persistence migration', () => {
  it('Given tenant-owned ledger accounts, when a cross-tenant bank relation is inserted, then the compound foreign key rejects it', () => {
    expect(() => db.prepare(`INSERT INTO BankAccount(id,ownerId,name,iban,ledgerAccountId) VALUES ('bad','tenant-a','Bad','DE12500105170648489890','ledger-b')`).run()).toThrow(/FOREIGN KEY/)
  })
  it('Given an imported statement and transaction, when facts are changed or deleted, then immutable evidence is preserved', () => {
    db.prepare(`INSERT INTO BankStatement(id,ownerId,bankAccountId,externalStatementId,contentHash,originalXml,periodStart,periodEnd,openingBalanceCents,closingBalanceCents,importedBy) VALUES ('stmt','tenant-a','bank-a','S-1',?,X'3C2F3E','2026-08-01','2026-08-31',0,100,'user')`).run('a'.repeat(64))
    db.prepare(`INSERT INTO BankTransaction(id,ownerId,bankAccountId,statementId,externalKey,factHash,amountCents,bookingDate,rawData) VALUES ('tx','tenant-a','bank-a','stmt',?,?,100,'2026-08-01','{}')`).run('b'.repeat(64), 'c'.repeat(64))
    expect(() => db.prepare(`UPDATE BankTransaction SET amountCents=99 WHERE id='tx'`).run()).toThrow(/immutable/)
    expect(() => db.prepare(`DELETE FROM BankStatement WHERE id='stmt'`).run()).toThrow(/cannot be deleted/)
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
  })
  it('Given the reconciliation migration, when schema controls are inspected, then append-only and one-active-match triggers are installed', () => {
    const controls = db.prepare(`SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'BankTransactionMatch_%' ORDER BY name`).all()
    expect(controls).toEqual([{ name: 'BankTransactionMatch_immutable_delete' }, { name: 'BankTransactionMatch_immutable_update' }, { name: 'BankTransactionMatch_validate_insert' }])
    const columns = db.prepare(`PRAGMA table_info('BankTransactionMatch')`).all() as Array<{ name: string }>
    expect(columns.map(column => column.name)).toEqual(expect.arrayContaining(['requestKey', 'requestHash', 'reversesMatchId', 'journalEntryId', 'allocationId']))
  })
})
