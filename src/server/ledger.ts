import 'server-only'

import { randomUUID } from 'node:crypto'
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
  validateManualAccountCombination,
  type AccountCategory,
  type LedgerBalance,
} from '@/core/doubleEntry'
import { createEBalanceXbrl, getEBalanceTaxonomy, type EBalanceMasterData } from '@/core/eBilanz'
import { createEBalancePackage, validateEBalanceConcepts } from '@/core/eBilanzPackage'
import { createElsterEBalanceEnvelope } from '@/core/elsterEnvelope'
import type { Prisma } from '@/generated/prisma/client'
import { createEricTicket, EricProcessingError, getEricConfiguration, hashEricRequest, runEric } from './eric'
import { appendAuditEvent } from './compliance/auditPersistence'
import { retentionDeadline, sha256 } from './compliance/retention'
import { profilePayloadWithConfirmedAddress, validateCompanyProfile, type CompanyProfile } from './compliance/companyProfile'
import { getDocumentStorage } from './storage'
import { persistComplianceObject } from './compliance/objectStorage'

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

export const DEFAULT_SKR04_ACCOUNTS = [
  [1600, 'Kasse', 'ASSET', 'bs.ass.currAss.cashEquiv.cash'],
  [1800, 'Bank', 'ASSET', 'bs.ass.currAss.cashEquiv.bank'],
  [1200, 'Forderungen aus Lieferungen und Leistungen', 'ASSET', 'bs.ass.currAss.receiv.trade'],
  [1406, 'Abziehbare Vorsteuer 19 %', 'ASSET', 'bs.ass.currAss.receiv.other.vat'],
  [3300, 'Verbindlichkeiten aus Lieferungen und Leistungen', 'LIABILITY', 'bs.eqLiab.liab.trade'],
  [3806, 'Umsatzsteuer 19 %', 'LIABILITY', 'bs.eqLiab.liab.other.theroffTax.vat'],
  [4400, 'Erlöse 19 % USt', 'REVENUE', 'is.netIncome.regular.operatingTC.grossTradingProfit.totalOutput'],
] as const

export function defaultAccountsForLedger(chart: string, accountLength: number | null) {
  const defaults = chart === 'SKR03' ? DEFAULT_ACCOUNTS : chart === 'SKR04' ? DEFAULT_SKR04_ACCOUNTS : []
  const scale = 10 ** ((accountLength ?? 4) - 4)
  return defaults.map(([number, name, category, eBilanzPosition]) => [
    number * scale, name, category, eBilanzPosition,
  ] as const)
}

export function selectPostingPeriod<T>(coveringPeriods: T[], existingPeriodCount: number): T | null {
  if (coveringPeriods.length > 1) throw new AccountingValidationError(['Die Buchungsperiode ist wegen überlappender Geschäftsjahre nicht eindeutig.'])
  if (!coveringPeriods.length && existingPeriodCount > 0) throw new AccountingValidationError(['Keine Geschäftsjahresperiode deckt das Buchungsdatum ab.'])
  return coveringPeriods[0] ?? null
}

export function validateSuccessorContiguity(expectedStartsAt: Date, actualStartsAt: Date) {
  if (actualStartsAt.getTime() !== expectedStartsAt.getTime()) throw new AccountingValidationError(['Das Folgegeschäftsjahr schließt nicht lückenlos an das Abschlussjahr an.'])
}

export function validateSuccessorOverlap(existingTargetId: string | undefined, overlappingPeriodIds: string[]) {
  if (overlappingPeriodIds.some(id => id !== existingTargetId)) throw new AccountingValidationError(['Das Folgegeschäftsjahr überschneidet sich mit einer bestehenden Geschäftsjahresperiode.'])
}

export function successorOverlapBounds(
  existingSuccessor: { startsAt: Date; endsAt: Date } | null,
  proposedStartsAt: Date,
  proposedEndsAt: Date,
) {
  return existingSuccessor ?? { startsAt: proposedStartsAt, endsAt: proposedEndsAt }
}

export function postingDateBoundary(bookingDate: string) { return new Date(`${bookingDate}T00:00:00.000Z`) }
export function nextCalendarDay(periodEnd: Date) { return new Date(Date.UTC(periodEnd.getUTCFullYear(), periodEnd.getUTCMonth(), periodEnd.getUTCDate() + 1)) }
export function selectedChartFromSettingsPayload(payload: string | undefined) {
  if (!payload) return 'SKR03'
  try { const value = JSON.parse(payload) as { activeChart?: unknown; chartOfAccounts?: unknown }; const candidate = value.activeChart ?? value.chartOfAccounts; return typeof candidate === 'string' && (candidate === 'SKR03' || candidate === 'SKR04' || /^CUSTOM:.+/.test(candidate)) ? candidate : 'SKR03' } catch { return 'SKR03' }
}
export function authoritativeEBalanceMasterDataFromSettings(payload: string | undefined, supplied: EBalanceMasterData): EBalanceMasterData {
  if (!payload) return supplied
  let settings: { companyProfile?: unknown; invoiceIssuer?: { streetAndHouseNumber?: unknown; zipCode?: unknown; city?: unknown } }
  try { settings = JSON.parse(payload) } catch { throw new AccountingValidationError(['Die maßgeblichen Unternehmenseinstellungen sind ungültig.']) }
  if (!settings.companyProfile) return supplied
  const profileIssues = validateCompanyProfile(settings.companyProfile)
  if (profileIssues.length) throw new AccountingValidationError([`Das maßgebliche Unternehmensprofil ist ungültig: ${profileIssues.join('; ')}`])
  const profile = settings.companyProfile as CompanyProfile
  const issuer = settings.invoiceIssuer
  const street = profile.registeredAddress?.streetAndHouseNumber ?? (typeof issuer?.streetAndHouseNumber === 'string' ? issuer.streetAndHouseNumber : undefined)
  const postalCode = profile.registeredAddress?.zipCode ?? (typeof issuer?.zipCode === 'string' ? issuer.zipCode : undefined)
  const city = profile.registeredAddress?.city ?? (typeof issuer?.city === 'string' ? issuer.city : undefined)
  if (!street?.trim() || !postalCode?.trim() || !city?.trim()) throw new AccountingValidationError(['Das maßgebliche historische Unternehmensprofil enthält keine vollständig versionierte Anschrift.'])
  const legalForm = profile.legalForm === 'SOLE_TRADER' ? 'EUN' : profile.legalForm === 'PARTNERSHIP' ? 'PG' : profile.legalForm
  if (!['EUN', 'GMBH', 'UG', 'AG', 'OHG', 'KG', 'GBR', 'PG'].includes(legalForm)) throw new AccountingValidationError(['Die maßgebliche Rechtsform benötigt eine konkrete E-Bilanz-Rechtsformzuordnung.'])
  return { ...supplied, companyName: profile.companyName, taxNumber: profile.taxNumber, legalForm: legalForm as EBalanceMasterData['legalForm'], street, postalCode, city }
}
export function settingsPayloadWithEffectiveProfile(settingsPayload: string | undefined, profilePayload: string | undefined): string | undefined {
  if (!profilePayload) return settingsPayload
  const settings = settingsPayload ? JSON.parse(settingsPayload) as Record<string, unknown> : {}
  // invoiceIssuer is mutable current state, not versioned history. A selected
  // profile version must contain its own registeredAddress; report generation
  // fails closed for older versions that predate this field.
  const { invoiceIssuer: _currentInvoiceIssuer, ...historicalSettings } = settings
  return JSON.stringify({ ...historicalSettings, companyProfile: JSON.parse(profilePayload) })
}
export function reportingSettingsPayload(settingsPayload: string | undefined, effectiveProfilePayload: string | undefined, hasVersionHistory: boolean): string | undefined {
  if (effectiveProfilePayload) return settingsPayloadWithEffectiveProfile(settingsPayload, effectiveProfilePayload)
  if (hasVersionHistory) throw new AccountingValidationError(['Für das Ende des Geschäftsjahres existiert kein gültiges historisches Unternehmensprofil.'])
  return settingsPayload
}
export function inferExistingLedgerProfile(accountNumbers: number[]): { chart: 'SKR03' | 'SKR04'; accountLength: 4 | 5 } | undefined {
  const signatures = [
    accountNumbers.includes(8400) && { chart: 'SKR03' as const, accountLength: 4 as const },
    accountNumbers.includes(84000) && { chart: 'SKR03' as const, accountLength: 5 as const },
    accountNumbers.includes(4400) && { chart: 'SKR04' as const, accountLength: 4 as const },
    accountNumbers.includes(44000) && { chart: 'SKR04' as const, accountLength: 5 as const },
  ].filter((signature): signature is { chart: 'SKR03' | 'SKR04'; accountLength: 4 | 5 } => Boolean(signature))
  const distinct = new Map(signatures.map(signature => [`${signature.chart}:${signature.accountLength}`, signature]))
  if (distinct.size > 1) throw new AccountingValidationError(['Der bestehende Kontenbestand enthält widersprüchliche Kontenrahmen- oder Kontenlängen-Signaturen. Ordnen Sie Kontenrahmen und Kontenlänge vor der Migration explizit zu.'])
  return distinct.values().next().value
}
export function inferExistingLedgerChart(accountNumbers: number[]): string | undefined {
  return inferExistingLedgerProfile(accountNumbers)?.chart
}
export function selectBootstrapChart(existingProfileChart: string | undefined, accountNumbers: number[], settingsPayload: string | undefined) {
  return existingProfileChart ?? requireLegacyLedgerProfile(accountNumbers, false)?.chart ?? selectedChartFromSettingsPayload(settingsPayload)
}
export function postingOrderPeriodYear(period: { year: number }) { return period.year }
export const isStandardPostingPeriod = (status: string) => status === 'OPEN'
export function accountSemanticFingerprint(chart: string, accounts: Array<{ id: string; number: number; name: string; category: string; eBilanzPosition: string | null; active: boolean }>) {
  return JSON.stringify({ chart, accounts: [...accounts].sort((a, b) => a.id.localeCompare(b.id)).map(account => ({ id: account.id, number: account.number, name: account.name, category: account.category, eBilanzPosition: account.eBilanzPosition, active: account.active })) })
}
export function validateNumericPeriodBootstrap(existingRequestedPeriod: boolean, existingPeriodCount: number) {
  if (!existingRequestedPeriod && existingPeriodCount > 0) throw new AccountingValidationError(['Ein Geschäftsjahr mit dieser Kennung existiert nicht; die bestehende abweichende Periodentopologie darf nicht durch ein Kalenderjahr überlagert werden.'])
}
export function validatePostingSuccessorBootstrap(
  existingPeriods: Array<{ year: number; startsAt: Date; endsAt: Date }>,
  requestedYear: number,
  proposedStartsAt: Date,
  proposedEndsAt: Date,
) {
  if (!existingPeriods.length) return
  if (existingPeriods.some(period => period.year === requestedYear)) throw new AccountingValidationError(['Ein Geschäftsjahr mit dieser Kennung existiert bereits, deckt das Buchungsdatum aber nicht ab.'])
  if (existingPeriods.some(period => period.startsAt <= proposedEndsAt && period.endsAt >= proposedStartsAt)) throw new AccountingValidationError(['Die neue Buchungsperiode würde sich mit einer bestehenden Geschäftsjahresperiode überschneiden.'])
  const latestPeriod = [...existingPeriods].sort((a, b) => b.endsAt.getTime() - a.endsAt.getTime())[0]
  validateSuccessorContiguity(nextCalendarDay(latestPeriod.endsAt), proposedStartsAt)
}
export function requireLegacyLedgerProfile(accountNumbers: number[], hasPostedEntries: boolean) {
  const inferred = inferExistingLedgerProfile(accountNumbers)
  if (!inferred && (accountNumbers.length > 0 || hasPostedEntries)) throw new AccountingValidationError(['Der bestehende Kontenbestand kann keinem eindeutigen Kontenrahmen und keiner eindeutigen Kontenlänge zugeordnet werden. Legen Sie das LedgerProfile vor einer Einstellungsänderung explizit fest.'])
  return inferred
}
export function validateLegacyLedgerClaim(configuredOwner: string | undefined, ownerId: string, userIds: string[]) {
  if (configuredOwner && configuredOwner !== ownerId) throw new AccountingValidationError(['Die Altdaten der Unternehmenseinstellungen sind einem anderen Mandanten zugeordnet.'])
  const noAuth = (process.env.AUTH_MODE ?? 'none') === 'none'
  const allowed = configuredOwner ? configuredOwner === 'local' && noAuth ? userIds.length === 0 : userIds.includes(configuredOwner) : noAuth && ownerId === 'local' && userIds.length === 0
  if (!allowed) throw new AccountingValidationError(['Die Altdaten der Unternehmenseinstellungen sind nicht eindeutig zugeordnet. Setzen Sie LEGACY_SETTINGS_OWNER_ID vor dem Start.'])
}
export function legacyLedgerClaimApplies(configuredOwner: string | undefined, ownerId: string) {
  return !configuredOwner || configuredOwner === ownerId
}

async function tenantSettingsPayload(transaction: Prisma.TransactionClient, ownerId: string): Promise<string | undefined> {
  await transaction.$executeRaw`UPDATE AccountRecord SET id = id WHERE id IN ('default', ${`company:${ownerId}`})`
  const scoped = await transaction.accountRecord.findUnique({ where: { ownerId }, select: { payload: true } })
  if (scoped) return scoped.payload
  const legacy = await transaction.accountRecord.findUnique({ where: { id: 'default' } })
  if (!legacy) return undefined
  const configuredOwner = process.env.LEGACY_SETTINGS_OWNER_ID?.trim()
  if (!legacyLedgerClaimApplies(configuredOwner, ownerId)) return undefined
  const localNoAuthSentinel = configuredOwner === 'local' && (process.env.AUTH_MODE ?? 'none') === 'none'
  const users = configuredOwner && !localNoAuthSentinel
    ? await transaction.user.findMany({ where: { id: configuredOwner }, select: { id: true } })
    : await transaction.user.findMany({ select: { id: true }, take: 2 })
  validateLegacyLedgerClaim(configuredOwner, ownerId, users.map((user: { id: string }) => user.id))
  const payload = JSON.parse(legacy.payload) as Record<string, unknown>; payload.id = `company:${ownerId}`
  const updated = await transaction.accountRecord.update({ where: { id: 'default' }, data: { id: `company:${ownerId}`, ownerId, payload: JSON.stringify(payload) }, select: { payload: true } })
  return updated.payload
}

async function ensureLedgerProfile(transaction: Prisma.TransactionClient, ownerId: string) {
  const existingProfile = await transaction.ledgerProfile.findUnique({ where: { ownerId } })
  if (existingProfile) return existingProfile
  const settingsPayload = await tenantSettingsPayload(transaction, ownerId)
  const existingAccountNumbers = (await transaction.ledgerAccount.findMany({ where: { ownerId }, select: { number: true } })).map(item => item.number)
  const inferredProfile = requireLegacyLedgerProfile(existingAccountNumbers, false)
  return transaction.ledgerProfile.upsert({
    where: { ownerId },
    create: { ownerId, chart: inferredProfile?.chart ?? selectedChartFromSettingsPayload(settingsPayload), accountLength: inferredProfile?.accountLength ?? 4 },
    update: {},
  })
}

export async function ensureLedger(ownerId: string, year: number) {
  if (!Number.isInteger(year) || year < 1900 || year > 2200) throw new AccountingValidationError(['Ungültiges Geschäftsjahr.'])
  return prisma.$transaction(async transaction => {
    const ledgerProfile = await ensureLedgerProfile(transaction, ownerId)
    let fiscalYear = await transaction.fiscalYear.findUnique({ where: { ownerId_year: { ownerId, year } } })
    validateNumericPeriodBootstrap(Boolean(fiscalYear), fiscalYear ? 1 : await transaction.fiscalYear.count({ where: { ownerId } }))
    fiscalYear ??= await transaction.fiscalYear.create({ data: { ownerId, year, startsAt: new Date(Date.UTC(year, 0, 1)), endsAt: new Date(Date.UTC(year, 11, 31, 23, 59, 59, 999)) } })
    for (const [number, name, category, eBilanzPosition] of defaultAccountsForLedger(ledgerProfile.chart, ledgerProfile.accountLength)) await transaction.ledgerAccount.upsert({ where: { ownerId_number: { ownerId, number } }, create: { ownerId, number, name, category, eBilanzPosition }, update: {} })
    return fiscalYear
  })
}

async function bootstrapLedgerForPosting(ownerId: string, year: number, bookingBoundary: Date) {
  if (!Number.isInteger(year) || year < 1900 || year > 2200) throw new AccountingValidationError(['Ungültiges Geschäftsjahr.'])
  const fiscalYear = await prisma.$transaction(async transaction => {
    await ensureLedgerProfile(transaction, ownerId)
    // Acquire SQLite's writer lock before rechecking. Concurrent first postings
    // therefore serialize and cannot create disjoint bootstrap periods.
    await transaction.$executeRaw`UPDATE LedgerProfile SET ownerId = ownerId WHERE ownerId = ${ownerId}`
    const concurrentlyCreated = await transaction.fiscalYear.findMany({ where: { ownerId, startsAt: { lte: bookingBoundary }, endsAt: { gte: bookingBoundary } } })
    if (concurrentlyCreated.length > 1) throw new AccountingValidationError(['Die Buchungsperiode ist wegen überlappender Geschäftsjahre nicht eindeutig.'])
    if (concurrentlyCreated[0]) return { fiscalYear: concurrentlyCreated[0], chart: (await transaction.ledgerProfile.findUniqueOrThrow({ where: { ownerId } })).chart, accountLength: (await transaction.ledgerProfile.findUniqueOrThrow({ where: { ownerId } })).accountLength }
    const proposedStartsAt = new Date(Date.UTC(year, 0, 1))
    const proposedEndsAt = new Date(Date.UTC(year, 11, 31, 23, 59, 59, 999))
    const existingPeriods = await transaction.fiscalYear.findMany({ where: { ownerId }, select: { year: true, startsAt: true, endsAt: true } })
    validatePostingSuccessorBootstrap(existingPeriods, year, proposedStartsAt, proposedEndsAt)
    const fiscalYear = await transaction.fiscalYear.create({ data: { ownerId, year, startsAt: proposedStartsAt, endsAt: proposedEndsAt } })
    const ledgerProfile = await transaction.ledgerProfile.findUniqueOrThrow({ where: { ownerId } })
    for (const [number, name, category, eBilanzPosition] of defaultAccountsForLedger(ledgerProfile.chart, ledgerProfile.accountLength)) await transaction.ledgerAccount.upsert({ where: { ownerId_number: { ownerId, number } }, create: { ownerId, number, name, category, eBilanzPosition }, update: {} })
    return { fiscalYear, chart: ledgerProfile.chart, accountLength: ledgerProfile.accountLength }
  })
  return fiscalYear.fiscalYear
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
    fiscalYear: { id: fiscalYear.id, year, startsAt: fiscalYear.startsAt.toISOString().slice(0, 10), endsAt: fiscalYear.endsAt.toISOString().slice(0, 10), status: fiscalYear.status, lockedAt: fiscalYear.lockedAt?.toISOString() ?? null },
    accounts,
    entries: entries.map(entry => ({
      ...entry,
      documents: entry.documents.flatMap(attachment => publicDocumentFromPayload(attachment.document.payload)),
    })),
    statements,
    closingIssues,
  }
}

export interface JournalPostMetadata {
  entryDate?: string
  lateReason?: string
  reversalOfId?: string
  replacementOfId?: string
  externalKey?: string
}

export function correctionPostingFingerprint(input: {
  fiscalYearId: string; bookingDate: string; documentNumber: string; description: string; source: string; entryDate: string | null; lateReason: string | null;
  reversalOfId: string | null; replacementOfId: string | null; externalKey: string | null;
  lines: Array<{ accountId: string; debitCents: number; creditCents: number; taxCode?: string | null }>;
  documentIds: string[]
}) {
  const lines = input.lines.map(line => ({ accountId: line.accountId, debitCents: line.debitCents, creditCents: line.creditCents, taxCode: line.taxCode ?? null })).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))
  return JSON.stringify({ ...input, documentNumber: input.documentNumber.trim(), description: input.description.trim(), lateReason: input.lateReason?.trim() || null, lines, documentIds: [...input.documentIds].sort() })
}
export function resolveCorrectionEntryDate(requested: unknown, originalEntryDate: Date | null, now = new Date(), persistedCorrectionDate?: string): string {
  if (persistedCorrectionDate) {
    if (requested !== undefined && requested !== persistedCorrectionDate) throw new AccountingValidationError(['Das Erfassungsdatum widerspricht der bereits gespeicherten Korrektur.'])
    return persistedCorrectionDate
  }
  const today = now.toISOString().slice(0, 10)
  if (requested !== undefined && requested !== today) throw new AccountingValidationError(['Das Erfassungsdatum der Korrektur wird serverseitig festgelegt und muss dem heutigen Datum entsprechen.'])
  if (originalEntryDate && (!Number.isFinite(originalEntryDate.getTime()) || originalEntryDate.toISOString().slice(0, 10) > today)) throw new AccountingValidationError(['Die ursprüngliche Buchung weist ein zukünftiges Erfassungsdatum auf und kann nicht automatisch korrigiert werden.'])
  return today
}

export function documentRetentionExtension(existingPeriodEndsAt: Date, existingRetainUntil: Date, authoritativePeriodEndsAt: Date) {
  const deadline = new Date(`${retentionDeadline('INVOICE', authoritativePeriodEndsAt.toISOString().slice(0, 10)).retainUntil}T23:59:59.999Z`)
  const periodEndsAt = existingPeriodEndsAt < authoritativePeriodEndsAt ? authoritativePeriodEndsAt : existingPeriodEndsAt
  const retainUntil = existingRetainUntil < deadline ? deadline : existingRetainUntil
  return periodEndsAt > existingPeriodEndsAt || retainUntil > existingRetainUntil ? { periodEndsAt, retainUntil } : null
}

async function extendAttachedDocumentRetention(transaction: Prisma.TransactionClient, ownerId: string, documentIds: string[], authoritativePeriodEndsAt: Date) {
  if (!documentIds.length) return
  const artifacts = await transaction.retainedArtifact.findMany({
    where: { ownerId, objectType: 'Document', objectId: { in: documentIds }, disposedAt: null, storageDeletedAt: null },
    select: { id: true, periodEndsAt: true, retainUntil: true },
  })
  for (const artifact of artifacts) {
    const extension = documentRetentionExtension(artifact.periodEndsAt, artifact.retainUntil, authoritativePeriodEndsAt)
    if (extension) await transaction.retainedArtifact.update({ where: { id: artifact.id }, data: extension })
  }
}

export async function postJournalEntry(ownerId: string, input: unknown, source = 'MANUAL', metadata: JournalPostMetadata = {}) {
  const manualEntryId = source === 'MANUAL' ? randomUUID() : undefined
  const validationInput = journalEntryInputForSource(source, input, manualEntryId)
  const validated = validateJournalEntry(validationInput)
  if (metadata.reversalOfId && metadata.replacementOfId) throw new AccountingValidationError(['Eine Buchung kann nicht zugleich Storno und Ersatzbuchung sein.'])
  if (metadata.entryDate) {
    const entryDate = new Date(`${metadata.entryDate}T00:00:00.000Z`)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(metadata.entryDate) || !Number.isFinite(entryDate.getTime()) || entryDate.toISOString().slice(0, 10) !== metadata.entryDate) throw new AccountingValidationError(['Das Erfassungsdatum ist ungültig.'])
  }
  const documentIds = normalizeDocumentIds(input)
  requireManualDocumentSelection(source, documentIds)
  validateDocumentNamespace(source, validated.documentNumber)
  const year = Number(validated.bookingDate.slice(0, 4))
  const bookingInstant = new Date(`${validated.bookingDate}T12:00:00.000Z`)
  const bookingBoundary = postingDateBoundary(validated.bookingDate)
  const coveringPeriods = await prisma.fiscalYear.findMany({ where: { ownerId, startsAt: { lte: bookingBoundary }, endsAt: { gte: bookingBoundary } } })
  const selectedPeriod = selectPostingPeriod(coveringPeriods, 0)
  const fiscalYear = selectedPeriod ?? await bootstrapLedgerForPosting(ownerId, year, bookingBoundary)
  if (!isStandardPostingPeriod(fiscalYear.status)) throw new AccountingValidationError(['Wiedereröffnete Geschäftsjahre dürfen nur über den kontrollierten Korrekturworkflow geändert werden.'])

  const accountIds = [...new Set(validated.lines.map(line => line.accountId))]
  const accounts = await prisma.ledgerAccount.findMany({ where: { id: { in: accountIds }, ownerId, active: true } })
  if (accounts.length !== accountIds.length) throw new AccountingValidationError(['Mindestens ein Konto ist ungültig oder gehört zu einem anderen Mandanten.'])
  if (source === 'MANUAL') validateManualAccountCombination(accounts, validated.lines)
  const postingLedgerProfile = await prisma.ledgerProfile.findUniqueOrThrow({ where: { ownerId } })
  const postingAccountFingerprint = accountSemanticFingerprint(postingLedgerProfile.chart, accounts)
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
    const currentAccounts = await transaction.ledgerAccount.findMany({ where: { id: { in: accountIds }, ownerId, active: true } })
    const currentLedgerProfile = await transaction.ledgerProfile.findUniqueOrThrow({ where: { ownerId } })
    if (currentAccounts.length !== accountIds.length || accountSemanticFingerprint(currentLedgerProfile.chart, currentAccounts) !== postingAccountFingerprint) throw new AccountingValidationError(['Der aktive Kontenrahmen oder seine Kontenzuordnung wurde geändert; laden Sie die Buchung neu und wählen Sie gültige Konten.'])
    const periodYear = postingOrderPeriodYear(fiscalYear)
    const closedSuccessors = await transaction.fiscalYear.findMany({ where: { ownerId, year: { gt: periodYear }, status: 'CLOSED' }, select: { year: true }, orderBy: { year: 'asc' } })
    validatePostingOrder(periodYear, closedSuccessors.map(item => item.year))
    const duplicateDocument = await transaction.journalEntry.findFirst({ where: { fiscalYearId: fiscalYear.id, documentNumber: validated.documentNumber.trim() } })
    if (duplicateDocument) throw new AccountingValidationError(['Die Belegnummer ist in diesem Geschäftsjahr bereits vergeben.'])
    const last = await transaction.journalEntry.findFirst({
      where: { fiscalYearId: fiscalYear.id }, orderBy: { sequenceNumber: 'desc' }, select: { sequenceNumber: true },
    })
    const entry = await transaction.journalEntry.create({
      data: {
        id: manualEntryId,
        sequenceNumber: (last?.sequenceNumber ?? 0) + 1,
        bookingDate: bookingInstant,
        documentNumber: validated.documentNumber.trim(),
        description: validated.description.trim(), fiscalYearId: fiscalYear.id,
        source,
        entryDate: metadata.entryDate ? new Date(`${metadata.entryDate}T12:00:00.000Z`) : undefined,
        lateReason: metadata.lateReason?.trim() || null,
        reversalOfId: metadata.reversalOfId ?? null,
        replacementOfId: metadata.replacementOfId ?? null,
        externalKey: metadata.externalKey ?? null,
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
    await extendAttachedDocumentRetention(transaction, ownerId, documentIds, fiscalYear.endsAt)
    return entry
  }) } catch (error) {
    if ((error as { code?: string }).code === 'P2002') throw new AccountingValidationError(['Belegnummer oder Journalnummer ist in diesem Geschäftsjahr bereits vergeben.'])
    throw error
  }
}

export async function postJournalCorrection(ownerId: string, actorId: string, originalId: string, stornoInput: unknown, replacementInput: unknown, entryDate: string, reason: string) {
  const prepare = async (input: unknown, source: 'STORNO' | 'CORRECTION', metadata: JournalPostMetadata) => {
    const validated = validateJournalEntry(input)
    validateDocumentNamespace(source, validated.documentNumber)
    const documentIds = normalizeDocumentIds(input)
    const bookingBoundary = postingDateBoundary(validated.bookingDate)
    const coveringPeriods = await prisma.fiscalYear.findMany({ where: { ownerId, startsAt: { lte: bookingBoundary }, endsAt: { gte: bookingBoundary } } })
    const fiscalYear = selectPostingPeriod(coveringPeriods, 0)
    if (!fiscalYear) throw new AccountingValidationError(['Für die Korrekturbuchung existiert keine eindeutige Buchungsperiode.'])
    const accountIds = [...new Set(validated.lines.map(line => line.accountId))]
    const requiresActiveAccounts = source === 'CORRECTION'
    const accounts = await prisma.ledgerAccount.findMany({ where: { id: { in: accountIds }, ownerId, ...(requiresActiveAccounts ? { active: true } : {}) } })
    if (accounts.length !== accountIds.length) throw new AccountingValidationError(['Mindestens ein Konto ist ungültig oder gehört zu einem anderen Mandanten.'])
    if (documentIds.length && await prisma.documentRecord.count({ where: { id: { in: documentIds }, ownerId } }) !== documentIds.length) throw new AccountingValidationError(['Mindestens ein ausgewählter Beleg ist ungültig oder gehört zu einem anderen Mandanten.'])
    const ledgerProfile = await prisma.ledgerProfile.findUniqueOrThrow({ where: { ownerId } })
    return { validated, documentIds, fiscalYear, accountIds, accountFingerprint: accountSemanticFingerprint(ledgerProfile.chart, accounts), requiresActiveAccounts, source, metadata }
  }
  const entryInstant = new Date(`${entryDate}T00:00:00.000Z`)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(entryDate) || !Number.isFinite(entryInstant.getTime()) || entryInstant.toISOString().slice(0, 10) !== entryDate) throw new AccountingValidationError(['Das Erfassungsdatum ist ungültig.'])
  const reversalKey = `CORRECTION:${originalId}:REVERSAL`
  const replacementKey = `CORRECTION:${originalId}:REPLACEMENT`
  const reversalPlan = await prepare(stornoInput, 'STORNO', { entryDate, reversalOfId: originalId, lateReason: reason, externalKey: reversalKey })
  const replacementPlan = await prepare(replacementInput, 'CORRECTION', { entryDate, replacementOfId: originalId, lateReason: reason, externalKey: replacementKey })

  try {
    return await prisma.$transaction(async transaction => {
      const original = await transaction.journalEntry.findFirst({ where: { id: originalId, fiscalYear: { ownerId }, state: 'POSTED' } })
      if (!original) throw new AccountingValidationError(['Die zu korrigierende Buchung wurde nicht gefunden.'])
      const [existingReversal, existingReplacement] = await Promise.all([
        transaction.journalEntry.findUnique({ where: { externalKey: reversalKey }, include: { lines: true, documents: true } }),
        transaction.journalEntry.findUnique({ where: { externalKey: replacementKey }, include: { lines: true, documents: true } }),
      ])
      if (existingReversal || existingReplacement) {
        const matches = (entry: NonNullable<typeof existingReversal>, plan: typeof reversalPlan) => correctionPostingFingerprint({
          fiscalYearId: entry.fiscalYearId, bookingDate: entry.bookingDate.toISOString().slice(0, 10), documentNumber: entry.documentNumber, description: entry.description, source: entry.source,
          entryDate: entry.entryDate?.toISOString().slice(0, 10) ?? null, lateReason: entry.lateReason, reversalOfId: entry.reversalOfId, replacementOfId: entry.replacementOfId, externalKey: entry.externalKey,
          lines: entry.lines, documentIds: entry.documents.map(document => document.documentId),
        }) === correctionPostingFingerprint({
          fiscalYearId: plan.fiscalYear.id, bookingDate: plan.validated.bookingDate, documentNumber: plan.validated.documentNumber, description: plan.validated.description, source: plan.source,
          entryDate, lateReason: reason, reversalOfId: plan.metadata.reversalOfId ?? null, replacementOfId: plan.metadata.replacementOfId ?? null, externalKey: plan.metadata.externalKey ?? null,
          lines: plan.validated.lines, documentIds: plan.documentIds,
        })
        if (existingReversal && existingReplacement && matches(existingReversal, reversalPlan) && matches(existingReplacement, replacementPlan)) return { originalId, reversal: existingReversal, replacement: existingReplacement }
        if (existingReversal && existingReplacement) throw new AccountingValidationError(['Die vorhandene Korrektur widerspricht den erneut übermittelten Korrekturdaten.'])
        throw new AccountingValidationError(['Der frühere Korrekturversuch ist unvollständig und muss administrativ geprüft werden.'])
      }

      const create = async (plan: typeof reversalPlan) => {
        const openYear = await transaction.fiscalYear.updateMany({ where: { id: plan.fiscalYear.id, ownerId, status: { in: ['OPEN', 'REOPENED'] } }, data: { updatedAt: new Date() } })
        if (openYear.count !== 1) throw new AccountingValidationError(['Das Geschäftsjahr ist gesperrt.'])
        const currentAccounts = await transaction.ledgerAccount.findMany({ where: { id: { in: plan.accountIds }, ownerId, ...(plan.requiresActiveAccounts ? { active: true } : {}) } })
        const currentProfile = await transaction.ledgerProfile.findUniqueOrThrow({ where: { ownerId } })
        if (currentAccounts.length !== plan.accountIds.length || accountSemanticFingerprint(currentProfile.chart, currentAccounts) !== plan.accountFingerprint) throw new AccountingValidationError(['Der aktive Kontenrahmen oder seine Kontenzuordnung wurde geändert; laden Sie die Buchung neu und wählen Sie gültige Konten.'])
        if (plan.documentIds.length && await transaction.documentRecord.count({ where: { id: { in: plan.documentIds }, ownerId } }) !== plan.documentIds.length) throw new AccountingValidationError(['Mindestens ein ausgewählter Beleg ist ungültig oder gehört zu einem anderen Mandanten.'])
        const periodYear = postingOrderPeriodYear(plan.fiscalYear)
        const closedSuccessors = await transaction.fiscalYear.findMany({ where: { ownerId, year: { gt: periodYear }, status: 'CLOSED' }, select: { year: true }, orderBy: { year: 'asc' } })
        validatePostingOrder(periodYear, closedSuccessors.map(item => item.year))
        if (await transaction.journalEntry.findFirst({ where: { fiscalYearId: plan.fiscalYear.id, documentNumber: plan.validated.documentNumber.trim() } })) throw new AccountingValidationError(['Die Belegnummer ist in diesem Geschäftsjahr bereits vergeben.'])
        const last = await transaction.journalEntry.findFirst({ where: { fiscalYearId: plan.fiscalYear.id }, orderBy: { sequenceNumber: 'desc' }, select: { sequenceNumber: true } })
        const entry = await transaction.journalEntry.create({ data: {
          sequenceNumber: (last?.sequenceNumber ?? 0) + 1,
          bookingDate: new Date(`${plan.validated.bookingDate}T12:00:00.000Z`),
          documentNumber: plan.validated.documentNumber.trim(), description: plan.validated.description.trim(), fiscalYearId: plan.fiscalYear.id,
          source: plan.source, entryDate: new Date(`${entryDate}T12:00:00.000Z`), lateReason: reason,
          reversalOfId: plan.metadata.reversalOfId ?? null, replacementOfId: plan.metadata.replacementOfId ?? null, externalKey: plan.metadata.externalKey ?? null,
          lines: { create: plan.validated.lines.map(line => ({ accountId: line.accountId, debitCents: line.debitCents, creditCents: line.creditCents, taxCode: line.taxCode || null })) },
          documents: { create: plan.documentIds.map(documentId => ({ documentId })) },
        }, include: { lines: true, documents: true } })
        await extendAttachedDocumentRetention(transaction, ownerId, plan.documentIds, plan.fiscalYear.endsAt)
        return entry
      }

      const reversal = await create(reversalPlan)
      const replacement = await create(replacementPlan)
      await appendAuditEvent(transaction, { ownerId, actorId, action: 'JOURNAL_ENTRY_CORRECTED', reason, objectType: 'JournalEntry', objectId: originalId, before: { originalId }, after: { reversalId: reversal.id, replacementId: replacement.id } })
      return { originalId, reversal, replacement }
    })
  } catch (error) {
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

export function requireManualDocumentSelection(source: string, documentIds: string[]) {
  if (source === 'MANUAL' && documentIds.length === 0) {
    throw new AccountingValidationError(['Wählen Sie mindestens einen Beleg für die Buchung aus.'])
  }
}

export function manualJournalReference(entryId: string) {
  return `JOURNAL-${entryId}`
}

export function journalEntryInputForSource(source: string, input: unknown, entryId?: string) {
  return source === 'MANUAL' && entryId && input && typeof input === 'object'
    ? { ...input, documentNumber: manualJournalReference(entryId) }
    : input
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
  if (fiscalYear.status === 'CLOSED') {
    if (fiscalYear.closingSnapshot) return JSON.parse(fiscalYear.closingSnapshot)
    throw new AccountingValidationError(['Der Abschlusssnapshot wurde nach Ablauf der Aufbewahrungsfrist entsorgt.'])
  }
  validateClosingDate(fiscalYear.endsAt)
  let snapshotStorageKey: string | undefined
  try { return await prisma.$transaction(async transaction => {
    const claimed = await transaction.fiscalYear.updateMany({
      where: { id: fiscalYear.id, status: { in: ['OPEN', 'REOPENED'] } }, data: { status: 'CLOSING' },
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
    const snapshotId = randomUUID()
    snapshotStorageKey = await persistComplianceObject({ ownerId, category: 'closing-snapshots', objectId: snapshotId, extension: 'json', content: Buffer.from(snapshot), contentType: 'application/json', fileName: `closing-snapshot-${year}-${snapshotId}.json` })
    const nextYear = year + 1
    const nextStartsAt = nextCalendarDay(fiscalYear.endsAt)
    const nextEndsAt = new Date(nextStartsAt.getTime())
    nextEndsAt.setUTCFullYear(nextEndsAt.getUTCFullYear() + 1)
    nextEndsAt.setUTCMilliseconds(nextEndsAt.getUTCMilliseconds() - 1)
    const existingSuccessor = await transaction.fiscalYear.findUnique({
      where: { ownerId_year: { ownerId, year: nextYear } },
      select: { id: true, startsAt: true, endsAt: true },
    })
    const overlapBounds = successorOverlapBounds(existingSuccessor, nextStartsAt, nextEndsAt)
    const overlappingPeriods = await transaction.fiscalYear.findMany({
      where: { ownerId, startsAt: { lte: overlapBounds.endsAt }, endsAt: { gte: overlapBounds.startsAt } },
      select: { id: true },
    })
    validateSuccessorOverlap(existingSuccessor?.id, overlappingPeriods.map(period => period.id))
    const nextFiscalYear = await transaction.fiscalYear.upsert({
      where: { ownerId_year: { ownerId, year: nextYear } },
      create: { ownerId, year: nextYear, startsAt: nextStartsAt, endsAt: nextEndsAt },
      update: {},
    })
    if (nextFiscalYear.status !== 'OPEN') {
      throw new AccountingValidationError([`Der Saldenvortrag kann nicht in das bereits gesperrte Geschäftsjahr ${nextYear} geschrieben werden. Schließen Sie Geschäftsjahre in zeitlicher Reihenfolge.`])
    }
    validateSuccessorContiguity(nextStartsAt, nextFiscalYear.startsAt)
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
          bookingDate: new Date(nextFiscalYear.startsAt.getTime() + 12 * 60 * 60 * 1000), documentNumber: `SYS-EB-${nextYear}-${fiscalYear.id.slice(-6)}`,
          description: `Automatischer Saldenvortrag aus ${year}`, source: 'OPENING', externalKey: openingKey,
          lines: { create: openingLines },
        } })
      }
    }
    await transaction.fiscalYear.update({
      where: { id: fiscalYear.id }, data: { status: 'CLOSED', lockedAt: new Date(), closingSnapshot: snapshot },
    })
    const deadline = retentionDeadline('JOURNAL', fiscalYear.endsAt.toISOString().slice(0, 10))
    const existingSnapshot = await transaction.retainedArtifact.findFirst({ where: { ownerId, objectType: 'ClosingSnapshot', objectId: fiscalYear.id }, orderBy: { version: 'desc' } })
    await transaction.retainedArtifact.create({ data: { ownerId, objectType: 'ClosingSnapshot', objectId: fiscalYear.id, version: (existingSnapshot?.version ?? 0) + 1, retentionClass: 'JOURNAL', contentHash: sha256(snapshot), provenance: 'fiscal period close', storageKey: snapshotStorageKey, periodEndsAt: fiscalYear.endsAt, retainUntil: new Date(`${deadline.retainUntil}T23:59:59.999Z`) } })
    await appendAuditEvent(transaction, { ownerId, actorId: ownerId, action: 'FISCAL_PERIOD_CLOSED', reason: 'Authenticated fiscal period close', objectType: 'FiscalYear', objectId: fiscalYear.id, before: { status: fiscalYear.status }, after: { status: 'CLOSED', snapshotHash: sha256(snapshot), successorId: nextFiscalYear.id } })
    return JSON.parse(snapshot)
  }) } catch (error) {
    if (snapshotStorageKey) {
      try { await getDocumentStorage().delete(snapshotStorageKey) }
      catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Fiscal close failed and its staged retained snapshot could not be cleaned up') }
    }
    throw error
  }
}

export function validateDocumentNamespace(source: string, documentNumber: string) {
  if (source === 'MANUAL' && /^SYS-/i.test(documentNumber.trim())) {
    throw new AccountingValidationError(['Belegnummern mit dem Präfix SYS- sind für automatische Systembuchungen reserviert.'])
  }
}

export async function exportEBalance(ownerId: string, year: number, masterData: EBalanceMasterData) {
  const { xml, officialArchive } = await prepareEBalance(ownerId, year, masterData, false)
  const archive = createEBalancePackage(xml, year, officialArchive)
  const fiscalYear = await prisma.fiscalYear.findUniqueOrThrow({ where: { ownerId_year: { ownerId, year } } })
  const exportId = randomUUID()
  const storage = getDocumentStorage()
  const storageKey = await persistComplianceObject({ ownerId, category: 'tax-exports', objectId: exportId, extension: 'zip', content: archive, contentType: 'application/zip', fileName: `e-bilanz-${year}-${exportId}.zip` })
  try {
    await prisma.$transaction(async transaction => {
      const deadline = retentionDeadline('TAX_RECORD', fiscalYear.endsAt.toISOString().slice(0, 10))
      const objectId = `E-BILANZ:${fiscalYear.id}`
      const latest = await transaction.retainedArtifact.findFirst({ where: { ownerId, objectType: 'TaxExport', objectId }, orderBy: { version: 'desc' } })
      const artifact = await transaction.retainedArtifact.create({ data: { ownerId, objectType: 'TaxExport', objectId, version: (latest?.version ?? 0) + 1, retentionClass: 'TAX_RECORD', contentHash: sha256(archive), provenance: 'authenticated E-Bilanz export', storageKey, periodEndsAt: fiscalYear.endsAt, retainUntil: new Date(`${deadline.retainUntil}T23:59:59.999Z`) } })
      await appendAuditEvent(transaction, { ownerId, actorId: ownerId, action: 'E_BILANZ_EXPORTED', reason: 'Authenticated report export', objectType: 'TaxExport', objectId, after: { artifactId: artifact.id, contentHash: artifact.contentHash, storageKey } })
    })
  } catch (error) {
    try { await storage.delete(storageKey) }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], 'E-Bilanz retention registration failed and its staged archive could not be cleaned up') }
    throw error
  }
  return archive
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
    balanceSheetDate: fiscalYear.endsAt.toISOString().slice(0, 10),
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
  const reportDate = new Date(`${workspace.fiscalYear.endsAt}T23:59:59.999Z`)
  const [settings, profileVersion, profileVersionCount] = await Promise.all([
    prisma.accountRecord.findUnique({ where: { ownerId }, select: { payload: true } }),
    prisma.companyProfileVersion.findFirst({ where: { ownerId, effectiveFrom: { lte: reportDate }, OR: [{ effectiveTo: null }, { effectiveTo: { gte: reportDate } }] }, orderBy: { effectiveFrom: 'desc' }, select: { id: true, payload: true } }),
    prisma.companyProfileVersion.count({ where: { ownerId } }),
  ])
  const addressConfirmation = profileVersion ? await prisma.companyProfileAddressConfirmation.findUnique({ where: { profileVersionId: profileVersion.id }, select: { payload: true } }) : null
  const effectiveProfilePayload = profileVersion ? profilePayloadWithConfirmedAddress(profileVersion.payload, addressConfirmation?.payload) : undefined
  masterData = authoritativeEBalanceMasterDataFromSettings(reportingSettingsPayload(settings?.payload, effectiveProfilePayload, profileVersionCount > 0), masterData)
  const issues = getEBalanceBlockingIssues(workspace.fiscalYear.status, workspace.closingIssues)
  if (issues.length) throw new AccountingValidationError(issues)
  if (!masterData.companyName.trim() || !masterData.street.trim() || !masterData.postalCode.trim() || !masterData.city.trim() || !masterData.taxNumber.trim()) throw new AccountingValidationError(['Firmenname, Straße, PLZ, Ort und Steuernummer sind für den Export erforderlich.'])
  const taxonomy = getEBalanceTaxonomy(year)
  const xml = createEBalanceXbrl({
    name: masterData.companyName, street: masterData.street, postalCode: masterData.postalCode, city: masterData.city,
    taxNumber: masterData.taxNumber, legalForm: masterData.legalForm, fiscalYear: year,
    fiscalYearStart: workspace.fiscalYear.startsAt, fiscalYearEnd: workspace.fiscalYear.endsAt, taxonomyVersion: taxonomy.version,
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
