import 'server-only'

import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { prisma } from './persistence/client'
import {
  AccountingValidationError,
  createOpeningBalanceLines,
  createFinancialStatements,
  validateClosing,
  validateClosingDate,
  validateClosingOrder,
  validatePostingOrder,
  validateJournalEntry,
  type AccountCategory,
  type LedgerBalance,
} from '@/core/doubleEntry'
import { createEBalanceXbrl, getEBalanceTaxonomy, type EBalanceMasterData } from '@/core/eBilanz'
import { createEBalancePackage, validateEBalanceConcepts } from '@/core/eBilanzPackage'
import { createElsterEBalanceEnvelope } from '@/core/elsterEnvelope'
import { createEricTicket, EricProcessingError, getEricConfiguration, hashEricRequest, runEric } from './eric'

export const DEFAULT_ACCOUNTS = [
  [1000, 'Kasse', 'ASSET', 'bs.ass.currAss.cashEquiv.cash'],
  [1200, 'Bank', 'ASSET', 'bs.ass.currAss.cashEquiv.bank'],
  [1400, 'Forderungen aus Lieferungen und Leistungen', 'ASSET', 'bs.ass.currAss.receiv.trade'],
  [1576, 'Abziehbare Vorsteuer 19 %', 'ASSET', 'bs.ass.currAss.receiv.other.vat'],
  [1600, 'Verbindlichkeiten aus Lieferungen und Leistungen', 'LIABILITY', 'bs.eqLiab.liab.trade'],
  [1776, 'Umsatzsteuer 19 %', 'LIABILITY', 'bs.eqLiab.liab.other.theroffTax.vat'],
  [2900, 'Eigenkapital', 'EQUITY', 'bs.eqLiab.equity'],
  [4930, 'Bürobedarf', 'EXPENSE', 'is.netIncome.regular.operatingTC.otherCost'],
  [8400, 'Erlöse 19 % USt', 'REVENUE', 'is.netIncome.regular.operatingTC.grossTradingProfit.totalOutput'],
] as const

export function defaultAccountsForLedger(chart: string, accountLength: number | null) {
  if (chart !== 'SKR03') return []
  const scale = 10 ** ((accountLength ?? 4) - 4)
  return DEFAULT_ACCOUNTS.map(([number, name, category, eBilanzPosition]) => [
    number * scale, name, category, eBilanzPosition,
  ] as const)
}

export async function ensureLedger(ownerId: string, year: number) {
  if (!Number.isInteger(year) || year < 1900 || year > 2200) throw new AccountingValidationError(['Ungültiges Geschäftsjahr.'])
  const ledgerProfile = await prisma.ledgerProfile.upsert({
    where: { ownerId }, create: { ownerId, chart: 'SKR03', accountLength: 4 }, update: {},
  })
  const fiscalYear = await prisma.fiscalYear.upsert({
    where: { ownerId_year: { ownerId, year } },
    create: {
      ownerId, year,
      startsAt: new Date(Date.UTC(year, 0, 1)),
      endsAt: new Date(Date.UTC(year, 11, 31, 23, 59, 59, 999)),
    },
    update: {},
  })
  for (const [number, name, category, eBilanzPosition] of defaultAccountsForLedger(ledgerProfile.chart, ledgerProfile.accountLength)) {
    await prisma.ledgerAccount.upsert({
      where: { ownerId_number: { ownerId, number } },
      create: { ownerId, number, name, category, eBilanzPosition },
      update: {},
    })
  }
  return fiscalYear
}

export async function getLedgerWorkspace(ownerId: string, year: number) {
  const fiscalYear = await ensureLedger(ownerId, year)
  const [accounts, entries, balances] = await Promise.all([
    prisma.ledgerAccount.findMany({ where: { ownerId, active: true }, orderBy: { number: 'asc' } }),
    prisma.journalEntry.findMany({
      where: { fiscalYearId: fiscalYear.id }, orderBy: { sequenceNumber: 'desc' },
      include: {
        lines: { include: { account: true } },
        documents: { include: { document: true } },
      },
    }),
    getTrialBalance(ownerId, year),
  ])
  const statements = createFinancialStatements(balances)
  const closingIssues = validateClosing(statements)
  try { validateClosingDate(fiscalYear.endsAt) } catch (error) { closingIssues.unshift((error as AccountingValidationError).issues[0]) }
  if (entries.length === 0) closingIssues.unshift('Das Geschäftsjahr enthält noch keine festgeschriebenen Buchungen.')
  const predecessors = await prisma.fiscalYear.findMany({
    where: { ownerId, year: { lt: year } }, select: { year: true, status: true, _count: { select: { journalEntries: true } } }, orderBy: { year: 'asc' },
  })
  try { validateClosingOrder(year, predecessors.map(item => ({ year: item.year, status: item.status, hasEntries: item._count.journalEntries > 0 }))) }
  catch (error) { closingIssues.unshift((error as AccountingValidationError).issues[0]) }
  const closedSuccessor = await prisma.fiscalYear.findFirst({ where: { ownerId, year: { gt: year }, status: 'CLOSED' }, orderBy: { year: 'asc' } })
  if (closedSuccessor) closingIssues.unshift(`Das bereits abgeschlossene Folgejahr ${closedSuccessor.year} verhindert einen nachträglichen Abschluss.`)
  return {
    fiscalYear: { year, status: fiscalYear.status, lockedAt: fiscalYear.lockedAt?.toISOString() ?? null },
    accounts,
    entries: entries.map(entry => ({
      ...entry,
      documents: entry.documents.flatMap(attachment => publicDocumentFromPayload(attachment.document.payload)),
    })),
    statements,
    closingIssues,
  }
}

export async function postJournalEntry(ownerId: string, input: unknown, source = 'MANUAL') {
  const validated = validateJournalEntry(input)
  const documentIds = normalizeDocumentIds(input)
  validateDocumentNamespace(source, validated.documentNumber)
  const year = Number(validated.bookingDate.slice(0, 4))
  const fiscalYear = await ensureLedger(ownerId, year)

  const accountIds = [...new Set(validated.lines.map(line => line.accountId))]
  const accounts = await prisma.ledgerAccount.findMany({ where: { id: { in: accountIds }, ownerId, active: true } })
  if (accounts.length !== accountIds.length) throw new AccountingValidationError(['Mindestens ein Konto ist ungültig oder gehört zu einem anderen Mandanten.'])
  if (documentIds.length) {
    const ownedDocumentCount = await prisma.documentRecord.count({ where: { id: { in: documentIds }, ownerId } })
    if (ownedDocumentCount !== documentIds.length) throw new AccountingValidationError(['Mindestens ein ausgewählter Beleg ist ungültig oder gehört zu einem anderen Mandanten.'])
  }

  try { return await prisma.$transaction(async transaction => {
    // This write acquires SQLite's writer lock before status/sequence checks. Closing
    // uses the same lock, so an entry can never slip into an already snapshotted year.
    const openYear = await transaction.fiscalYear.updateMany({
      where: { id: fiscalYear.id, status: 'OPEN' }, data: { updatedAt: new Date() },
    })
    if (openYear.count !== 1) throw new AccountingValidationError(['Das Geschäftsjahr ist gesperrt.'])
    const closedSuccessors = await transaction.fiscalYear.findMany({ where: { ownerId, year: { gt: year }, status: 'CLOSED' }, select: { year: true }, orderBy: { year: 'asc' } })
    validatePostingOrder(year, closedSuccessors.map(item => item.year))
    const duplicateDocument = await transaction.journalEntry.findFirst({ where: { fiscalYearId: fiscalYear.id, documentNumber: validated.documentNumber.trim() } })
    if (duplicateDocument) throw new AccountingValidationError(['Die Belegnummer ist in diesem Geschäftsjahr bereits vergeben.'])
    const last = await transaction.journalEntry.findFirst({
      where: { fiscalYearId: fiscalYear.id }, orderBy: { sequenceNumber: 'desc' }, select: { sequenceNumber: true },
    })
    return transaction.journalEntry.create({
      data: {
        sequenceNumber: (last?.sequenceNumber ?? 0) + 1,
        bookingDate: new Date(`${validated.bookingDate}T12:00:00.000Z`),
        documentNumber: validated.documentNumber.trim(),
        description: validated.description.trim(), fiscalYearId: fiscalYear.id,
        source,
        lines: { create: validated.lines.map(line => ({
          accountId: line.accountId,
          debitCents: line.debitCents,
          creditCents: line.creditCents,
          taxCode: line.taxCode || null,
        })) },
        documents: { create: documentIds.map(documentId => ({ documentId })) },
      },
      include: { lines: true, documents: true },
    })
  }) } catch (error) {
    if ((error as { code?: string }).code === 'P2002') throw new AccountingValidationError(['Belegnummer oder Journalnummer ist in diesem Geschäftsjahr bereits vergeben.'])
    throw error
  }
}

export function normalizeDocumentIds(input: unknown): string[] {
  if (!input || typeof input !== 'object') return []
  const documentIds = (input as { documentIds?: unknown }).documentIds
  if (documentIds === undefined) return []
  if (!Array.isArray(documentIds) || documentIds.some(id => typeof id !== 'string' || !id.trim())) {
    throw new AccountingValidationError(['Die ausgewählten Belege sind ungültig.'])
  }
  return [...new Set(documentIds.map(id => id.trim()))]
}

function publicDocumentFromPayload(payload: string) {
  try {
    const document = JSON.parse(payload) as { id: string; url: string; fileName?: string; contentType?: string; size?: number }
    return [{ id: document.id, url: document.url, fileName: document.fileName, contentType: document.contentType, size: document.size }]
  } catch { return [] }
}

export async function getTrialBalance(ownerId: string, year: number): Promise<LedgerBalance[]> {
  const fiscalYear = await ensureLedger(ownerId, year)
  const accounts = await prisma.ledgerAccount.findMany({
    where: { ownerId },
    include: { journalLines: { where: { journalEntry: { fiscalYearId: fiscalYear.id } } } },
    orderBy: { number: 'asc' },
  })
  return accounts.map(account => {
    const debitCents = account.journalLines.reduce((sum, line) => sum + line.debitCents, 0)
    const creditCents = account.journalLines.reduce((sum, line) => sum + line.creditCents, 0)
    return {
      accountId: account.id, number: account.number, name: account.name,
      category: account.category as AccountCategory, eBilanzPosition: account.eBilanzPosition,
      debitCents, creditCents, balanceCents: debitCents - creditCents,
    }
  })
}

export async function closeFiscalYear(ownerId: string, year: number) {
  const fiscalYear = await ensureLedger(ownerId, year)
  if (fiscalYear.status === 'CLOSED') return JSON.parse(fiscalYear.closingSnapshot!)
  validateClosingDate(fiscalYear.endsAt)
  return prisma.$transaction(async transaction => {
    const claimed = await transaction.fiscalYear.updateMany({
      where: { id: fiscalYear.id, status: 'OPEN' }, data: { status: 'CLOSING' },
    })
    if (claimed.count !== 1) {
      const current = await transaction.fiscalYear.findUnique({ where: { id: fiscalYear.id } })
      if (current?.status === 'CLOSED' && current.closingSnapshot) return JSON.parse(current.closingSnapshot)
      throw new AccountingValidationError(['Das Geschäftsjahr wird bereits abgeschlossen.'])
    }
    const predecessors = await transaction.fiscalYear.findMany({
      where: { ownerId, year: { lt: year } },
      select: { year: true, status: true, _count: { select: { journalEntries: true } } },
      orderBy: { year: 'asc' },
    })
    validateClosingOrder(year, predecessors.map(item => ({ year: item.year, status: item.status, hasEntries: item._count.journalEntries > 0 })))

    const accounts = await transaction.ledgerAccount.findMany({
      where: { ownerId },
      include: { journalLines: { where: { journalEntry: { fiscalYearId: fiscalYear.id } } } },
      orderBy: { number: 'asc' },
    })
    const balances: LedgerBalance[] = accounts.map(account => {
      const debitCents = account.journalLines.reduce((sum, line) => sum + line.debitCents, 0)
      const creditCents = account.journalLines.reduce((sum, line) => sum + line.creditCents, 0)
      return { accountId: account.id, number: account.number, name: account.name, category: account.category as AccountCategory, eBilanzPosition: account.eBilanzPosition, debitCents, creditCents, balanceCents: debitCents - creditCents }
    })
    const statements = createFinancialStatements(balances)
    const issues = validateClosing(statements)
    const entryCount = await transaction.journalEntry.count({ where: { fiscalYearId: fiscalYear.id } })
    if (entryCount === 0) issues.unshift('Das Geschäftsjahr enthält noch keine festgeschriebenen Buchungen.')
    if (issues.length) throw new AccountingValidationError(issues)
    const snapshot = JSON.stringify({ ...statements, closedAt: new Date().toISOString() })
    const nextYear = year + 1
    const nextFiscalYear = await transaction.fiscalYear.upsert({
      where: { ownerId_year: { ownerId, year: nextYear } },
      create: { ownerId, year: nextYear, startsAt: new Date(Date.UTC(nextYear, 0, 1)), endsAt: new Date(Date.UTC(nextYear, 11, 31, 23, 59, 59, 999)) },
      update: {},
    })
    if (nextFiscalYear.status !== 'OPEN') {
      throw new AccountingValidationError([`Der Saldenvortrag kann nicht in das bereits gesperrte Geschäftsjahr ${nextYear} geschrieben werden. Schließen Sie Geschäftsjahre in zeitlicher Reihenfolge.`])
    }
    const openingKey = `OPENING:${fiscalYear.id}`
    const existingOpening = await transaction.journalEntry.findUnique({ where: { externalKey: openingKey } })
    if (!existingOpening) {
      const openingLines = createOpeningBalanceLines(statements)
      const debit = openingLines.reduce((sum, line) => sum + line.debitCents, 0)
      const credit = openingLines.reduce((sum, line) => sum + line.creditCents, 0)
      if (debit !== credit) throw new AccountingValidationError(['Der automatische Saldenvortrag ist nicht ausgeglichen.'])
      if (openingLines.length) {
        const lastOpening = await transaction.journalEntry.findFirst({ where: { fiscalYearId: nextFiscalYear.id }, orderBy: { sequenceNumber: 'desc' } })
        await transaction.journalEntry.create({ data: {
          fiscalYearId: nextFiscalYear.id, sequenceNumber: (lastOpening?.sequenceNumber ?? 0) + 1,
          bookingDate: new Date(Date.UTC(nextYear, 0, 1, 12)), documentNumber: `SYS-EB-${nextYear}-${fiscalYear.id.slice(-6)}`,
          description: `Automatischer Saldenvortrag aus ${year}`, source: 'OPENING', externalKey: openingKey,
          lines: { create: openingLines },
        } })
      }
    }
    await transaction.fiscalYear.update({
      where: { id: fiscalYear.id }, data: { status: 'CLOSED', lockedAt: new Date(), closingSnapshot: snapshot },
    })
    return JSON.parse(snapshot)
  })
}

export function validateDocumentNamespace(source: string, documentNumber: string) {
  if (source === 'MANUAL' && /^SYS-/i.test(documentNumber.trim())) {
    throw new AccountingValidationError(['Belegnummern mit dem Präfix SYS- sind für automatische Systembuchungen reserviert.'])
  }
}

export async function exportEBalance(ownerId: string, year: number, masterData: EBalanceMasterData) {
  const { xml, officialArchive } = await prepareEBalance(ownerId, year, masterData, false)
  return createEBalancePackage(xml, year, officialArchive)
}

export async function processEBalanceWithEric(
  ownerId: string,
  year: number,
  masterData: EBalanceMasterData,
  options: { send: boolean; pin?: string; confirmed?: boolean; idempotencyKey?: string },
) {
  const fiscalYear = await ensureLedger(ownerId, year)
  if (options.send && fiscalYear.status !== 'CLOSED') {
    throw new AccountingValidationError(['Eine rechtswirksame Übermittlung ist erst nach dem verbindlichen Jahresabschluss möglich.'])
  }
  if (options.send && options.confirmed !== true) {
    throw new AccountingValidationError(['Bestätigen Sie die verbindliche Übermittlung ausdrücklich.'])
  }
  const configuration = getEricConfiguration()
  if (options.send && configuration.testMarker) {
    throw new AccountingValidationError(['Eine rechtswirksame Übermittlung ist bei aktivem ERIC_TESTMERKER gesperrt. Entfernen Sie den Testmerker für den Produktivversand.'])
  }
  if (options.send && (typeof options.idempotencyKey !== 'string' || !/^[A-Za-z0-9-]{16,100}$/.test(options.idempotencyKey))) {
    throw new AccountingValidationError(['Für die sichere Übermittlung fehlt ein gültiger Idempotenzschlüssel.'])
  }
  const idempotencyKey = options.idempotencyKey ?? `validation-${createEricTicket()}`
  const generationDate = fiscalYear.lockedAt?.toISOString().slice(0, 10) ?? new Date().toISOString().slice(0, 10)
  const { xml } = await prepareEBalance(ownerId, year, masterData, true, generationDate)
  const payloadHash = hashEricRequest(xml)
  const existingAttempt = await prisma.eBalanceSubmission.findUnique({ where: { ownerId_idempotencyKey: { ownerId, idempotencyKey } } })
  if (existingAttempt) {
    if (existingAttempt.year !== year || existingAttempt.payloadHash !== payloadHash) throw new AccountingValidationError(['Der Übermittlungsschlüssel gehört zu einem anderen Datensatz. Er kann nicht wiederverwendet werden.'])
    if (existingAttempt.status === 'ACCEPTED') return {
      statusCode: existingAttempt.ericCode ?? 0, statusText: existingAttempt.ericMessage ?? 'Bereits angenommen.', sent: true,
      resultXml: existingAttempt.resultXml ?? '', serverResponseXml: existingAttempt.serverResponseXml ?? '',
    }
    throw new AccountingValidationError(['Für diesen Übermittlungsschlüssel existiert bereits ein protokollierter Versuch. Prüfen Sie die Historie, bevor Sie erneut übermitteln.'])
  }
  const envelope = createElsterEBalanceEnvelope(xml, {
    manufacturerId: configuration.manufacturerId,
    dataSupplier: masterData.companyName,
    clientVersion: 'Accounting 0.1.0 / ERiC 44',
    ticket: createEricTicket(),
    taxNumber: masterData.taxNumber.replace(/[\s/-]/g, ''),
    balanceSheetDate: `${year}-12-31`,
    testMarker: configuration.testMarker,
  })
  const kind = options.send ? 'SUBMISSION' : 'VALIDATION'
  const requestHash = hashEricRequest(envelope)
  let attempt
  try {
    attempt = await prisma.eBalanceSubmission.create({ data: {
      ownerId, year, fiscalYearId: fiscalYear.id, kind, status: 'PENDING', idempotencyKey, payloadHash, requestHash, requestXml: envelope,
    } })
  } catch (error) {
    const winner = await prisma.eBalanceSubmission.findUnique({ where: { ownerId_idempotencyKey: { ownerId, idempotencyKey } } })
    if (!winner) {
      const activeSubmission = options.send ? await prisma.eBalanceSubmission.findFirst({
        where: { ownerId, year, kind: 'SUBMISSION', status: { in: ['PENDING', 'UNKNOWN', 'ACCEPTED'] } },
        orderBy: { createdAt: 'desc' },
      }) : null
      if (activeSubmission) throw new AccountingValidationError([activeSubmission.status === 'ACCEPTED'
        ? 'Für dieses Geschäftsjahr wurde bereits eine E-Bilanz angenommen. Korrekturen benötigen einen gesonderten Korrekturworkflow.'
        : 'Für dieses Geschäftsjahr läuft bereits eine Übermittlung oder ihr Ausgang ist unklar. Vor einem erneuten Versand ist eine manuelle Klärung erforderlich.'])
      throw error
    }
    if (winner.year !== year || winner.payloadHash !== payloadHash) throw new AccountingValidationError(['Der Übermittlungsschlüssel gehört zu einem anderen Datensatz.'])
    if (winner.status === 'ACCEPTED') return {
      statusCode: winner.ericCode ?? 0, statusText: winner.ericMessage ?? 'Bereits angenommen.', sent: true,
      resultXml: winner.resultXml ?? '', serverResponseXml: winner.serverResponseXml ?? '',
    }
    throw new AccountingValidationError(['Für diesen Übermittlungsschlüssel wird bereits ein Versuch verarbeitet.'])
  }
  try {
    const result = await runEric(envelope, { send: options.send, pin: options.pin, configuration })
    await prisma.eBalanceSubmission.update({ where: { id: attempt.id }, data: {
      status: submissionResultStatus(options.send, result.sent),
      ericCode: result.statusCode, ericMessage: result.statusText,
      resultXml: result.resultXml || null, serverResponseXml: result.serverResponseXml || null,
    } })
    return result
  } catch (error) {
    if (error instanceof EricProcessingError) {
      await prisma.eBalanceSubmission.update({ where: { id: attempt.id }, data: {
        status: options.send ? 'UNKNOWN' : 'REJECTED',
        ericCode: error.statusCode, ericMessage: error.message,
        resultXml: error.resultXml || null, serverResponseXml: error.serverResponseXml || null,
      } })
      throw new AccountingValidationError([options.send
        ? `ERiC ${error.statusCode}: ${error.message} Der Versandstatus ist unklar und muss vor einem erneuten Versuch manuell geklärt werden.`
        : `ERiC ${error.statusCode}: ${error.message}`])
    }
    if (error instanceof AccountingValidationError) {
      await prisma.eBalanceSubmission.update({ where: { id: attempt.id }, data: { status: 'FAILED', ericMessage: error.issues.join(' ') } })
      throw error
    }
    await prisma.eBalanceSubmission.update({ where: { id: attempt.id }, data: { status: 'UNKNOWN', ericMessage: 'Der Ausgang des ERiC-Prozesses ist unklar; vor einem erneuten Versand ist eine manuelle Klärung erforderlich.' } })
    throw error
  }
}

export async function getEBalanceSubmissionHistory(ownerId: string, year: number, idempotencyKey?: string) {
  await ensureLedger(ownerId, year)
  const select = { id: true, kind: true, status: true, idempotencyKey: true, requestHash: true, ericCode: true, ericMessage: true, createdAt: true } as const
  const [recent, active, matching] = await Promise.all([
    prisma.eBalanceSubmission.findMany({ where: { ownerId, year }, orderBy: { createdAt: 'desc' }, take: 20, select }),
    prisma.eBalanceSubmission.findMany({ where: { ownerId, year, kind: 'SUBMISSION', status: { in: ['PENDING', 'UNKNOWN', 'ACCEPTED'] } }, orderBy: { createdAt: 'desc' }, select }),
    idempotencyKey ? prisma.eBalanceSubmission.findFirst({ where: { ownerId, year, idempotencyKey }, select }) : null,
  ])
  return mergeSubmissionHistory(recent, active, matching)
}

export function mergeSubmissionHistory<T extends { id: string; createdAt: Date }>(recent: T[], relevant: T[], matching: T | null) {
  const merged = new Map([...recent, ...relevant, ...(matching ? [matching] : [])].map(item => [item.id, item]))
  return [...merged.values()].sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())
}

async function prepareEBalance(ownerId: string, year: number, masterData: EBalanceMasterData, remoteSchemaReferences: boolean, generationDate = new Date().toISOString().slice(0, 10)) {
  const workspace = await getLedgerWorkspace(ownerId, year)
  const issues = getEBalanceBlockingIssues(workspace.fiscalYear.status, workspace.closingIssues)
  if (issues.length) throw new AccountingValidationError(issues)
  if (!masterData.companyName.trim() || !masterData.street.trim() || !masterData.postalCode.trim() || !masterData.city.trim() || !masterData.taxNumber.trim()) throw new AccountingValidationError(['Firmenname, Straße, PLZ, Ort und Steuernummer sind für den Export erforderlich.'])
  const taxonomy = getEBalanceTaxonomy(year)
  const xml = createEBalanceXbrl({
    name: masterData.companyName, street: masterData.street, postalCode: masterData.postalCode, city: masterData.city,
    taxNumber: masterData.taxNumber, legalForm: masterData.legalForm, fiscalYear: year,
    fiscalYearStart: `${year}-01-01`, fiscalYearEnd: `${year}-12-31`, taxonomyVersion: taxonomy.version,
    gaapNamespace: taxonomy.gaapNamespace, gcdNamespace: taxonomy.gcdNamespace,
    entryPoint: remoteSchemaReferences ? `${taxonomy.gaapNamespace}/${taxonomy.entryPoint.split('/').at(-1)}` : taxonomy.entryPoint,
    gcdEntryPoint: remoteSchemaReferences ? `${taxonomy.gcdNamespace}/${taxonomy.gcdEntryPoint.split('/').at(-1)}` : taxonomy.gcdEntryPoint,
    generationDate,
  }, workspace.statements)
  const officialArchive = await readFile(path.join(process.cwd(), 'public', 'taxonomies', 'german-gaap-taxonomy-v6.9-2025-04-01-xbrl.zip'))
  validateEBalanceConcepts(xml, officialArchive)
  return { xml, officialArchive }
}

export function getEBalanceBlockingIssues(fiscalYearStatus: string, closingIssues: string[]) {
  return fiscalYearStatus === 'CLOSED'
    ? closingIssues.filter(issue => !issue.includes('bereits abgeschlossene Folgejahr'))
    : closingIssues
}

export function submissionResultStatus(send: boolean, sent: boolean) {
  return send ? (sent ? 'ACCEPTED' : 'REJECTED') : 'VALID'
}
