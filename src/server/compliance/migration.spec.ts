import { readFileSync, readdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'

const temporaryDirectories: string[] = []
afterEach(() => temporaryDirectories.splice(0).forEach(directory => rmSync(directory, { recursive: true, force: true })))

describe('compliance foundations migration', () => {
  it('migrates a populated journal and represents unknown historic entry dates as null', () => {
    const directory = mkdtempSync(join(tmpdir(), 'accounting-compliance-migration-')); temporaryDirectories.push(directory)
    const database = new DatabaseSync(join(directory, 'migration.db'))
    const root = resolve(process.cwd(), 'prisma', 'migrations')
    const names = readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name).sort()
    for (const name of names.filter(name => name < '20260717210000_compliance_foundations')) database.exec(readFileSync(join(root, name, 'migration.sql'), 'utf8'))
    database.exec("INSERT INTO FiscalYear (id, ownerId, year, startsAt, endsAt, updatedAt) VALUES ('fy', 'owner', 2025, '2025-01-01', '2025-12-31', CURRENT_TIMESTAMP)")
    database.exec("INSERT INTO JournalEntry (id, sequenceNumber, bookingDate, documentNumber, description, fiscalYearId) VALUES ('entry', 1, '2025-01-02', 'D-1', 'historic', 'fy')")
    database.exec(readFileSync(join(root, '20260717210000_compliance_foundations', 'migration.sql'), 'utf8'))
    expect(database.prepare("SELECT state, entryDate FROM JournalEntry WHERE id = 'entry'").get()).toEqual({ state: 'POSTED', entryDate: null })
    database.close()
  })
})
