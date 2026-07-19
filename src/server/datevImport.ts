import 'server-only'

import { createHash, randomUUID } from 'node:crypto'
import { parseDatevFiles, type DatevFile, type DatevImport } from '@/core/datev'
import { AccountingValidationError } from '@/core/doubleEntry'
import { prisma } from './persistence/client'
import { DEFAULT_ACCOUNTS, isStandardPostingPeriod } from './ledger'
import { appendAuditEvent } from './compliance/auditPersistence'

const MAX_BOOKINGS = 200
const MAX_ACCOUNTS = 1_000

export interface DatevFiscalPeriod { id: string; startsAt: Date; endsAt: Date }
export function resolveDatevPeriods<T extends DatevFiscalPeriod>(periods: T[], bookingDates: string[]): Map<string, T> {
  const resolved = new Map<string, T>()
  for (const bookingDate of bookingDates) {
    const instant = new Date(`${bookingDate}T00:00:00.000Z`)
    const matches = periods.filter(period => period.startsAt <= instant && period.endsAt >= instant)
    if (matches.length !== 1) throw new AccountingValidationError([matches.length ? `Die DATEV-Buchung am ${bookingDate} fällt in überlappende Geschäftsjahre.` : `Keine Geschäftsjahresperiode deckt die DATEV-Buchung am ${bookingDate} ab.`])
    resolved.set(bookingDate, matches[0])
  }
  return resolved
}

export async function importDatev(ownerId: string, files: DatevFile[]) {
  const parsed = parseDatevFiles(files)
  validateDatevImportSize(parsed)
  const prepared = parsed.bookings.map(booking => {
    const digest = createHash('sha256').update(`${ownerId}\0${booking.identity ?? randomUUID()}`).digest('hex')
    return { ...booking, externalKey: booking.identity ? `DATEV:${digest}` : null, digest }
  })
  const identifiedByKey = new Map<string, typeof prepared[number]>()
  for (const booking of prepared.filter(booking => booking.externalKey !== null)) {
    const previous = identifiedByKey.get(booking.externalKey!)
    if (previous && bookingFingerprint(previous) !== bookingFingerprint(booking)) {
      throw new AccountingValidationError([`Die DATEV-Buchungs-GUID ${booking.identity} wird für unterschiedliche Buchungen verwendet.`])
    }
    identifiedByKey.set(booking.externalKey!, booking)
  }
  const identified = [...identifiedByKey.values()]
  const unidentified = prepared.filter(booking => booking.externalKey === null)
  const unique = [...identified, ...unidentified]
  const years = [...new Set(unique.map(booking => Number(booking.bookingDate.slice(0, 4))))].sort((left, right) => left - right)
  if (years.some(year => !Number.isInteger(year) || year < 1900 || year > 2200)) {
    throw new AccountingValidationError(['DATEV-Buchungen werden nur für Geschäftsjahre von 1900 bis 2200 unterstützt.'])
  }

  return prisma.$transaction(async transaction => {
    const bookingDates = [...new Set(unique.map(booking => booking.bookingDate))].sort()
    const existingPeriods = await transaction.fiscalYear.findMany({ where: { ownerId }, orderBy: { startsAt: 'asc' } })
    if (!existingPeriods.length) for (const year of years) existingPeriods.push(await transaction.fiscalYear.upsert({
      where: { ownerId_year: { ownerId, year } },
      create: { ownerId, year, startsAt: new Date(Date.UTC(year, 0, 1)), endsAt: new Date(Date.UTC(year, 11, 31, 23, 59, 59, 999)) }, update: {},
    }))
    const periodByBookingDate = resolveDatevPeriods(existingPeriods, bookingDates)
    const fiscalYears = new Map<string, { id: string; status: string; year: number; endsAt: Date }>()
    for (const fiscalYear of [...new Map([...periodByBookingDate.values()].map(period => [period.id, period])).values()].sort((left, right) => left.startsAt.getTime() - right.startsAt.getTime())) {
      // Acquire the fiscal-year write locks in chronological order before the
      // idempotency query, so concurrent imports cannot use the same GUID.
      await transaction.fiscalYear.updateMany({ where: { id: fiscalYear.id }, data: { updatedAt: new Date() } })
      fiscalYears.set(fiscalYear.id, await transaction.fiscalYear.findUniqueOrThrow({ where: { id: fiscalYear.id }, select: { id: true, status: true, year: true, endsAt: true } }))
    }
    const ledgerProfile = await transaction.ledgerProfile.upsert({
      where: { ownerId },
      create: {
        ownerId, chart: parsed.chart, consultantNumber: parsed.consultantNumber,
        clientNumber: parsed.clientNumber, accountLength: parsed.accountLength,
      },
      update: {},
    })
    if (ledgerProfile.chart !== parsed.chart) {
      throw new AccountingValidationError([`Der Mandant verwendet bereits ${ledgerProfile.chart}; ein Import mit ${parsed.chart} ist nicht möglich.`])
    }
    if (ledgerProfile.consultantNumber && ledgerProfile.consultantNumber !== parsed.consultantNumber) {
      throw new AccountingValidationError(['Die Beraternummer passt nicht zu früheren DATEV-Importen dieses Mandanten.'])
    }
    if (ledgerProfile.clientNumber && ledgerProfile.clientNumber !== parsed.clientNumber) {
      throw new AccountingValidationError(['Die Mandantennummer passt nicht zu früheren DATEV-Importen dieses Mandanten.'])
    }
    if (ledgerProfile.accountLength && ledgerProfile.accountLength !== parsed.accountLength) {
      throw new AccountingValidationError(['Die Sachkontenlänge passt nicht zu früheren DATEV-Importen dieses Mandanten.'])
    }
    if (!ledgerProfile.consultantNumber || !ledgerProfile.clientNumber || !ledgerProfile.accountLength) {
      await transaction.ledgerProfile.update({
        where: { ownerId },
        data: {
          consultantNumber: ledgerProfile.consultantNumber ?? parsed.consultantNumber,
          clientNumber: ledgerProfile.clientNumber ?? parsed.clientNumber,
          accountLength: ledgerProfile.accountLength ?? parsed.accountLength,
        },
      })
    }
    const existingEntries = await transaction.journalEntry.findMany({
      where: { externalKey: { in: identified.map(booking => booking.externalKey!) } },
      select: { externalKey: true, bookingDate: true, documentNumber: true, description: true, lines: { select: { debitCents: true, creditCents: true, taxCode: true, account: { select: { number: true } } } } },
    })
    const existing = new Map(existingEntries.flatMap(entry => entry.externalKey ? [[entry.externalKey, entry] as const] : []))
    for (const booking of identified) {
      const stored = existing.get(booking.externalKey!)
      if (stored && storedBookingFingerprint(stored) !== importedBookingFingerprint(booking)) {
        throw new AccountingValidationError([`Die bereits importierte DATEV-Buchungs-GUID ${booking.identity} hat abweichende Buchungsdaten.`])
      }
    }
    const pending = unique.filter(booking => booking.externalKey === null || !existing.has(booking.externalKey))
    const pendingPeriodIds = new Set(pending.map(booking => periodByBookingDate.get(booking.bookingDate)!.id))
    for (const periodId of pendingPeriodIds) {
      const period = fiscalYears.get(periodId)!
      if (!isStandardPostingPeriod(period.status)) throw new AccountingValidationError([`Das Geschäftsjahr ${period.year} ist gesperrt; wiedereröffnete Perioden dürfen nur über den kontrollierten Korrekturworkflow geändert werden.`])
      const closedSuccessor = await transaction.fiscalYear.findFirst({ where: { ownerId, startsAt: { gt: period.endsAt }, status: 'CLOSED' }, select: { year: true }, orderBy: { startsAt: 'asc' } })
      if (closedSuccessor) throw new AccountingValidationError([`In ${period.year} kann nicht mehr importiert werden, weil das Folgejahr ${closedSuccessor.year} bereits abgeschlossen ist.`])
    }

    const defaults = new Map<number, typeof DEFAULT_ACCOUNTS[number]>(DEFAULT_ACCOUNTS.map(account => [account[0], account]))
    const masterAccountNumbers = new Set(parsed.masterAccountNumbers)
    const accountScale = 10 ** (parsed.accountLength - 4)
    for (const account of parsed.accounts) {
      const normalizedNumber = account.number / accountScale
      const standard = parsed.chart === 'SKR03' && Number.isInteger(normalizedNumber) ? defaults.get(normalizedNumber) : undefined
      const name = standard && account.name === `DATEV-Konto ${account.number}` ? standard[1] : account.name
      await transaction.ledgerAccount.upsert({
        where: { ownerId_number: { ownerId, number: account.number } },
        create: {
          ownerId, number: account.number,
          name,
          category: standard?.[2] ?? account.category,
          eBilanzPosition: standard?.[3] ?? null,
        },
        update: masterAccountNumbers.has(account.number) ? { name } : {},
      })
    }
    const accountRows = await transaction.ledgerAccount.findMany({
      where: { ownerId, number: { in: parsed.accounts.map(account => account.number) }, active: true }, select: { id: true, number: true, category: true },
    })
    const expectedCategories = new Map(parsed.accounts.map(account => [account.number, account.category]))
    const conflict = accountRows.find(account => account.category !== expectedCategories.get(account.number))
    if (conflict) throw new AccountingValidationError([`Konto ${conflict.number} ist bereits mit der Kategorie ${conflict.category} angelegt und passt nicht zum DATEV-Kontenrahmen.`])
    const accountIds = new Map(accountRows.map(account => [account.number, account.id]))
    if (accountIds.size !== parsed.accounts.length) throw new AccountingValidationError(['Mindestens ein DATEV-Konto ist inaktiv und kann nicht bebucht werden.'])

    let imported = 0
    for (const fiscalYear of fiscalYears.values()) {
      let sequenceNumber = (await transaction.journalEntry.findFirst({
        where: { fiscalYearId: fiscalYear.id }, orderBy: { sequenceNumber: 'desc' }, select: { sequenceNumber: true },
      }))?.sequenceNumber ?? 0
      for (const booking of pending.filter(booking => periodByBookingDate.get(booking.bookingDate)!.id === fiscalYear.id)) {
        if (booking.accountNumber === booking.contraAccountNumber) throw new AccountingValidationError([`DATEV-Buchung ${booking.documentNumber || booking.digest.slice(0, 8)} verwendet dasselbe Konto auf beiden Seiten.`])
        const lines = createDatevLines(booking).map(line => ({
          accountId: accountIds.get(line.accountNumber)!, debitCents: line.debitCents, creditCents: line.creditCents, taxCode: booking.taxCode ?? null,
        }))
        sequenceNumber++
        await transaction.journalEntry.create({ data: {
          fiscalYearId: fiscalYear.id, sequenceNumber,
          bookingDate: new Date(`${booking.bookingDate}T12:00:00.000Z`),
          documentNumber: datevDocumentNumber(booking.documentNumber, booking.digest),
          description: booking.description, source: 'DATEV', externalKey: booking.externalKey,
          lines: { create: lines },
        } })
        imported++
      }
    }
    const result = { imported, skipped: parsed.bookings.length - imported, accounts: parsed.accounts.length, years }
    await appendAuditEvent(transaction, { ownerId, actorId: ownerId, action: 'DATEV_IMPORT_COMPLETED', reason: 'Authenticated DATEV import', objectType: 'AccountingImport', objectId: `DATEV:${prepared[0]?.digest ?? randomUUID()}`, after: result })
    return result
  })
}

export function validateDatevImportSize(parsed: Pick<DatevImport, 'bookings' | 'accounts'>) {
  if (parsed.bookings.length > MAX_BOOKINGS) throw new AccountingValidationError([`Ein Import darf höchstens ${MAX_BOOKINGS} Buchungen enthalten.`])
  if (parsed.accounts.length > MAX_ACCOUNTS) throw new AccountingValidationError([`Ein Import darf höchstens ${MAX_ACCOUNTS} Konten enthalten.`])
}

function bookingFingerprint(booking: ReturnType<typeof parseDatevFiles>['bookings'][number]) {
  return JSON.stringify({
    bookingDate: booking.bookingDate, amountCents: booking.amountCents, side: booking.side,
    accountNumber: booking.accountNumber, contraAccountNumber: booking.contraAccountNumber,
    documentNumber: booking.documentNumber, description: booking.description, taxCode: booking.taxCode,
    automaticTax: booking.automaticTax, reverseCharge: booking.reverseCharge, generalReversal: Boolean(booking.generalReversal),
  })
}

function importedBookingFingerprint(booking: ReturnType<typeof parseDatevFiles>['bookings'][number] & { digest: string }) {
  return persistenceFingerprint(booking.bookingDate, datevDocumentNumber(booking.documentNumber, booking.digest), booking.description, createDatevLines(booking).map(line => ({
    number: line.accountNumber, debitCents: line.debitCents, creditCents: line.creditCents, taxCode: booking.taxCode ?? null,
  })))
}

function storedBookingFingerprint(booking: { bookingDate: Date; documentNumber: string; description: string; lines: Array<{ debitCents: number; creditCents: number; taxCode: string | null; account: { number: number } }> }) {
  return persistenceFingerprint(booking.bookingDate.toISOString().slice(0, 10), booking.documentNumber, booking.description, booking.lines.map(line => ({
    number: line.account.number, debitCents: line.debitCents, creditCents: line.creditCents, taxCode: line.taxCode,
  })))
}

function persistenceFingerprint(bookingDate: string, documentNumber: string, description: string, lines: Array<{ number: number; debitCents: number; creditCents: number; taxCode: string | null }>) {
  return JSON.stringify({ bookingDate, documentNumber, description, lines: lines.sort((left, right) =>
    left.number - right.number || left.debitCents - right.debitCents || left.creditCents - right.creditCents || String(left.taxCode).localeCompare(String(right.taxCode)),
  ) })
}

function datevDocumentNumber(source: string, digest: string) {
  const label = source.trim().replace(/\s+/g, '-').slice(0, 40) || 'OHNE-BELEG'
  return `DATEV-${label}-${digest.slice(0, 10)}`
}

export function createDatevLines(booking: ReturnType<typeof parseDatevFiles>['bookings'][number]) {
  const direction = booking.generalReversal ? -1 : 1
  const line = (accountNumber: number, amount: number, side: 'S' | 'H') => ({
    accountNumber, debitCents: side === 'S' ? amount * direction : 0, creditCents: side === 'H' ? amount * direction : 0,
  })
  const opposite = booking.side === 'S' ? 'H' : 'S'
  if (booking.reverseCharge) {
    const baseSide = booking.reverseCharge.baseSide === 'ACCOUNT' ? booking.side : opposite
    const taxCents = Math.round(booking.amountCents * booking.reverseCharge.rate / 100)
    return [
      line(booking.accountNumber, booking.amountCents, booking.side),
      line(booking.contraAccountNumber, booking.amountCents, opposite),
      ...(taxCents > 0 ? [
        line(booking.reverseCharge.inputTaxAccountNumber, taxCents, baseSide),
        line(booking.reverseCharge.outputTaxAccountNumber, taxCents, baseSide === 'S' ? 'H' : 'S'),
      ] : []),
    ]
  }
  if (!booking.automaticTax) return [line(booking.accountNumber, booking.amountCents, booking.side), line(booking.contraAccountNumber, booking.amountCents, opposite)]
  const taxCents = Math.round(booking.amountCents * booking.automaticTax.rate / (100 + booking.automaticTax.rate))
  const netCents = booking.amountCents - taxCents
  if (taxCents === 0) return [line(booking.accountNumber, booking.amountCents, booking.side), line(booking.contraAccountNumber, booking.amountCents, opposite)]
  if (booking.automaticTax.splitSide === 'ACCOUNT') return [
    line(booking.accountNumber, netCents, booking.side),
    line(booking.automaticTax.accountNumber, taxCents, booking.side),
    line(booking.contraAccountNumber, booking.amountCents, opposite),
  ]
  return [
    line(booking.accountNumber, booking.amountCents, booking.side),
    line(booking.contraAccountNumber, netCents, opposite),
    line(booking.automaticTax.accountNumber, taxCents, opposite),
  ]
}
