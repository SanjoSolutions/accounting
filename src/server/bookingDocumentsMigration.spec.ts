import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'

const temporaryDirectories: string[] = []
afterEach(() => temporaryDirectories.splice(0).forEach(directory => rmSync(directory, { recursive: true, force: true })))

describe('booking document inbox migration', () => {
  it('removes existing and newly booked documents from the booking inbox', () => {
    const directory = mkdtempSync(join(tmpdir(), 'accounting-booking-documents-migration-'))
    temporaryDirectories.push(directory)
    const database = new DatabaseSync(join(directory, 'migration.db'))
    const root = resolve(process.cwd(), 'prisma', 'migrations')
    const migration = '20260721230000_booking_document_inbox'
    const names = readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name).sort()
    for (const name of names.filter(name => name < migration)) database.exec(readFileSync(join(root, name, 'migration.sql'), 'utf8'))

    database.exec("INSERT INTO FiscalYear (id, ownerId, year, startsAt, endsAt, updatedAt) VALUES ('fy', 'owner', 2026, '2026-01-01', '2026-12-31', CURRENT_TIMESTAMP)")
    database.exec("INSERT INTO JournalEntry (id, sequenceNumber, bookingDate, documentNumber, description, fiscalYearId) VALUES ('entry-1', 1, '2026-01-01', 'D-1', 'Booked', 'fy'), ('entry-2', 2, '2026-01-02', 'D-2', 'Booked later', 'fy')")
    database.exec("INSERT INTO DocumentRecord (id, ownerId, payload) VALUES ('booked', 'owner', '{}'), ('available', 'owner', '{}'), ('booked-later', 'owner', '{}')")
    database.exec("INSERT INTO JournalDocumentAttachment (journalEntryId, documentId) VALUES ('entry-1', 'booked')")

    database.exec(readFileSync(join(root, migration, 'migration.sql'), 'utf8'))
    expect(database.prepare('SELECT id FROM DocumentRecord WHERE availableForBooking = true ORDER BY id').all()).toEqual([
      { id: 'available' },
      { id: 'booked-later' },
    ])

    database.exec("INSERT INTO JournalDocumentAttachment (journalEntryId, documentId) VALUES ('entry-2', 'booked-later')")
    expect(database.prepare("SELECT availableForBooking FROM DocumentRecord WHERE id = 'booked-later'").get()).toEqual({ availableForBooking: 0 })
    database.close()
  }, 15_000)
})
