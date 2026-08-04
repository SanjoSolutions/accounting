import 'server-only'

import { createHash, createHmac, randomUUID } from 'node:crypto'
import { canonicalJson, createAuditPackage, type AuditExportSource, type MigrationPackageAuthenticator } from '@/core/compliance/auditExport'
import { BALANCE_SHEET_ORDER, GKV_ORDER, MICRO_BALANCE_SHEET_ORDER, SMALL_BALANCE_SHEET_ORDER, UKV_ORDER, prepareAnnualAccounts, type AnnualPackageInput } from '@/core/compliance/annualAccounts'
import { buildHgbStatements, createHgbStatementRuleSet, type HgbStatementLineResult, type HgbTrialBalanceAccount } from '@/core/hgbStatements'
import { hgbWorkpaperChecksum, validateHgbWorkpaper, type HgbWorkpaperDraft, type OpeningBalanceSchedule, type PolicyElectionsSchedule, type NotesQuestionnaireSchedule } from '@/core/hgbWorkpapers'
import { closePhysicalInventory, createAssetSchedules, type AssetEvent, type FixedAsset, type InventoryCount, type InventoryItem } from '@/core/compliance/assetsInventory'
import { exportCashAudit, type CashBook } from '@/core/compliance/cashBook'
import { validateProcedureVersion, type ProcedureDocumentVersion } from '@/core/compliance/procedureDocumentation'
import { prisma } from '@/server/persistence/client'
import { getDocumentStorage } from '@/server/storage'
import { appendAuditEvent } from './auditPersistence'
import { persistComplianceObject } from './objectStorage'
import { ComplianceRuntimeError } from './runtime'
import { complianceReferenceDate } from './referenceDate'

const PACKAGE_KINDS = ['AUDIT_EXPORT', 'MIGRATION_EXPORT', 'PROCEDURE_PACKAGE', 'ANNUAL_ACCOUNTS', 'DISCLOSURE_PACKAGE', 'ASSET_SCHEDULE', 'INVENTORY_CLOSE', 'CASH_AUDIT'] as const
export type CompliancePackageKind = typeof PACKAGE_KINDS[number]

function required(value: unknown, label: string) {
  if (typeof value !== 'string' || !value.trim()) throw new ComplianceRuntimeError(`${label} is required`)
  return value.trim()
}
function packageKind(value: unknown): CompliancePackageKind {
  if (typeof value !== 'string' || !PACKAGE_KINDS.includes(value as CompliancePackageKind)) throw new ComplianceRuntimeError('Unsupported reporting package kind')
  return value as CompliancePackageKind
}
function safePayload(value: unknown) {
  try { return canonicalJson(value) } catch { throw new ComplianceRuntimeError('Package payload must be JSON-compatible') }
}

/**
 * Stores the immutable bytes first and removes them if the database transaction
 * cannot atomically register the package, retention record and audit event.
 */
type AuthoritativePeriod = { id: string; year: number; startsAt: Date; endsAt: Date }

async function requireFiscalPeriod(ownerId: string, value: unknown): Promise<AuthoritativePeriod> {
  const id = required(value, 'fiscalPeriodId')
  const period = await prisma.fiscalYear.findFirst({ where: { id, ownerId }, select: { id: true, year: true, startsAt: true, endsAt: true } })
  if (!period) throw new ComplianceRuntimeError('Fiscal period not found', 404)
  return period
}

type InventorySnapshotRegistration = { payload: string; checksum: string; closedAt: Date }

async function createReportingPackage(ownerId: string, actorId: string, period: AuthoritativePeriod, input: Record<string, unknown>, inventorySnapshot?: InventorySnapshotRegistration) {
  const kind = packageKind(input.kind)
  const reason = required(input.reason, 'reason')
  const fiscalPeriodId = period.id
  const authorityRef = typeof input.authorityReference === 'string' ? input.authorityReference.trim() || null : null
  const payload = safePayload(input.payload)
  const checksum = createHash('sha256').update(canonicalJson({ kind, fiscalPeriodId, authorityRef, payload: JSON.parse(payload) })).digest('hex')
  const existing = await prisma.compliancePackage.findUnique({ where: { ownerId_checksum: { ownerId, checksum } } })
  if (existing) return existing
  const id = randomUUID()
  const content = Buffer.from(payload)
  const storageKey = await persistComplianceObject({ ownerId, category: 'closing-snapshots', objectId: id, extension: 'json', content, contentType: 'application/json', fileName: `${kind.toLowerCase()}-${id}.json` })
  try {
    return await prisma.$transaction(async transaction => {
      const latest = await transaction.compliancePackage.findFirst({ where: { ownerId, kind, fiscalPeriodId }, orderBy: { version: 'desc' }, select: { version: true, id: true } })
      const version = (latest?.version ?? 0) + 1
      if (inventorySnapshot) await transaction.inventoryCountSnapshot.create({ data: { id: randomUUID(), ownerId, fiscalPeriodId, payload: inventorySnapshot.payload, checksum: inventorySnapshot.checksum, closedBy: actorId, closedAt: inventorySnapshot.closedAt } })
      const record = await transaction.compliancePackage.create({ data: { id, ownerId, kind, fiscalPeriodId, version, status: 'CREATED', payload, checksum, storageKey, supersedesId: latest?.id, authorityRef, createdBy: actorId } })
      const periodEndsAt = period.endsAt
      const retainUntil = new Date(periodEndsAt); retainUntil.setUTCFullYear(retainUntil.getUTCFullYear() + 10)
      await transaction.retainedArtifact.create({ data: { ownerId, objectType: 'CompliancePackage', objectId: id, version, retentionClass: 'ACCOUNTING_RECORDS', contentHash: createHash('sha256').update(content).digest('hex'), provenance: kind, storageKey, periodEndsAt, retainUntil } })
      await appendAuditEvent(transaction, { ownerId, actorId, action: kind === 'AUDIT_EXPORT' || kind === 'MIGRATION_EXPORT' ? 'EXPORT_CREATED' : 'PACKAGE_CREATED', reason, objectType: 'CompliancePackage', objectId: id, after: { kind, version, checksum, storageKey } })
      return record
    })
  } catch (error) {
    await getDocumentStorage().delete(storageKey).catch(() => undefined)
    throw error
  }
}

/** Runs reviewed deterministic domain generation before the durable adapter. */
export async function createDomainReportingPackage(ownerId: string, actorId: string, kind: CompliancePackageKind, input: Record<string, unknown>) {
  const period = await requireFiscalPeriod(ownerId, input.fiscalPeriodId)
  let payload: unknown
  let inventorySnapshot: InventorySnapshotRegistration | undefined
  if (kind === 'AUDIT_EXPORT' || kind === 'MIGRATION_EXPORT') {
    const authorityReference = required(input.authorityReference, 'authorityReference')
    const purpose = kind === 'AUDIT_EXPORT' ? 'AUDIT' as const : 'MIGRATION' as const
    const source = await loadAuthoritativeAuditSource(ownerId, period)
    payload = await createAuditPackage(source, { tenantId: ownerId, actorId, authorityReference, accessedAt: new Date().toISOString(), purpose }, { record: () => undefined }, purpose === 'MIGRATION' ? migrationAuthenticator() : undefined)
  } else if (kind === 'ANNUAL_ACCOUNTS') {
    const annualInput = await loadAuthoritativeAnnualInput(ownerId, actorId, period, input)
    const latest = await prisma.compliancePackage.findFirst({ where: { ownerId, fiscalPeriodId: period.id, kind: 'ANNUAL_ACCOUNTS' }, orderBy: { version: 'desc' }, select: { id: true, version: true } })
    payload = prepareAnnualAccounts(annualInput, (latest?.version ?? 0) + 1, latest?.id)
  } else if (kind === 'ASSET_SCHEDULE') {
    const [assets, events] = await Promise.all([prisma.fixedAssetRecord.findMany({ where: { ownerId } }), prisma.assetEventRecord.findMany({ where: { ownerId }, orderBy: [{ assetId: 'asc' }, { sequence: 'asc' }] })])
    payload = createAssetSchedules(ownerId, assets.map(row => JSON.parse(row.payload) as FixedAsset), events.map(row => JSON.parse(row.payload) as AssetEvent), periodRange(period))
  } else if (kind === 'INVENTORY_CLOSE') {
    const existingClose = await prisma.inventoryCountSnapshot.findUnique({ where: { ownerId_fiscalPeriodId: { ownerId, fiscalPeriodId: period.id } }, select: { id: true } })
    if (existingClose) throw new ComplianceRuntimeError('Inventory for this fiscal period is already closed', 409)
    const items = await prisma.inventoryItemRecord.findMany({ where: { ownerId } })
    const closedAt = new Date()
    const inventoryClose = closePhysicalInventory(ownerId, { ...periodRange(period), timeZone: required(input.timeZone, 'timeZone') }, items.map(row => JSON.parse(row.payload) as InventoryItem), input.counts as InventoryCount[], closedAt.toISOString())
    payload = inventoryClose
    inventorySnapshot = { payload: inventoryClose.immutablePayload, checksum: inventoryClose.checksum, closedAt }
  } else if (kind === 'CASH_AUDIT') {
    const bookId = required(input.cashBookId, 'cashBookId')
    const [book, entries, closes] = await Promise.all([prisma.cashBookRecord.findFirst({ where: { id: bookId, ownerId } }), prisma.cashEntryRecord.findMany({ where: { ownerId, cashBookId: bookId }, orderBy: { sequence: 'asc' } }), prisma.cashCloseRecord.findMany({ where: { ownerId, cashBookId: bookId }, orderBy: { businessDate: 'asc' } })])
    if (!book) throw new ComplianceRuntimeError('Cash book not found', 404)
    const cashBook: CashBook = { id: book.id, tenantId: ownerId, location: book.location, register: book.register, timeZone: book.timeZone, currency: book.currency as CashBook['currency'], glAccountId: book.glAccountId, retainedThrough: dateOnly(book.retainedThrough), entries: entries.map(row => JSON.parse(row.payload)), closes: closes.map(row => JSON.parse(row.payload)) }
    payload = exportCashAudit(cashBook, [{ id: period.id, startDate: dateOnly(period.startsAt), endDate: dateOnly(period.endsAt) }])
  } else if (kind === 'DISCLOSURE_PACKAGE') {
    const annual = await prisma.compliancePackage.findFirst({ where: { ownerId, fiscalPeriodId: period.id, kind: 'ANNUAL_ACCOUNTS', status: 'APPROVED' }, orderBy: { version: 'desc' } })
    if (!annual) throw new ComplianceRuntimeError('An approved annual-accounts package is required', 409)
    payload = { destination: 'Unternehmensregister', annualAccountsId: annual.id, annualAccountsChecksum: annual.checksum, deadline: required(input.deadline, 'deadline'), reliefs: Array.isArray(input.reliefs) ? input.reliefs : [], generatedAt: new Date().toISOString() }
  } else throw new ComplianceRuntimeError('Unsupported domain reporting workflow')
  return createReportingPackage(ownerId, actorId, period, { ...input, kind, payload }, inventorySnapshot)
}

function migrationAuthenticator(): MigrationPackageAuthenticator {
  const secret = process.env.MIGRATION_PACKAGE_SIGNING_SECRET
  if (!secret || secret.length < 32) throw new ComplianceRuntimeError('MIGRATION_PACKAGE_SIGNING_SECRET must contain at least 32 characters')
  const keyId = process.env.MIGRATION_PACKAGE_SIGNING_KEY_ID?.trim() || 'migration-default'
  return { keyId, sign: payload => createHmac('sha256', secret).update(payload).digest('hex'), verify: (payload, signature, candidateKeyId) => candidateKeyId === keyId && signature === createHmac('sha256', secret).update(payload).digest('hex') }
}

export async function approveReportingPackage(ownerId: string, actorId: string, packageId: string, reasonValue: unknown) {
  const reason = required(reasonValue, 'reason')
  return prisma.$transaction(async transaction => {
    const record = await transaction.compliancePackage.findFirst({ where: { id: packageId, ownerId } })
    if (!record) throw new ComplianceRuntimeError('Reporting package not found', 404)
    if (record.status !== 'CREATED') throw new ComplianceRuntimeError('Only a created package can be approved')
    if (record.createdBy === actorId) throw new ComplianceRuntimeError('Independent approval is required', 403)
    const approvedAt = new Date()
    const approved = await transaction.compliancePackage.update({ where: { id: record.id }, data: { status: 'APPROVED', approvedBy: actorId, approvedAt } })
    await appendAuditEvent(transaction, { ownerId, actorId, action: 'PACKAGE_APPROVED', reason, objectType: 'CompliancePackage', objectId: record.id, before: { status: record.status }, after: { status: approved.status, approvedAt: approvedAt.toISOString() } })
    return approved
  })
}

export async function saveProcedureDocument(ownerId: string, actorId: string, input: Record<string, unknown>) {
  const reason = required(input.reason, 'reason')
  if (input.confirmApproval !== true) throw new ComplianceRuntimeError('Explicit procedure approval confirmation is required')
  const now = new Date()
  const document = { ...(input.document as ProcedureDocumentVersion), approvedBy: actorId, approvedAt: now.toISOString() }
  const issues = validateProcedureVersion(document)
  if (issues.length) throw new ComplianceRuntimeError(issues.join('; '))
  const payload = safePayload(document)
  const checksum = createHash('sha256').update(payload).digest('hex')
  return prisma.$transaction(async transaction => {
    const record = await transaction.procedureDocumentRecord.create({ data: { id: randomUUID(), ownerId, documentId: document.id, version: document.version, effectiveFrom: new Date(document.effectiveFrom), effectiveTo: document.effectiveTo ? new Date(document.effectiveTo) : null, payload, checksum, approvedBy: document.approvedBy, approvedAt: new Date(document.approvedAt) } })
    await appendAuditEvent(transaction, { ownerId, actorId, action: 'PROCEDURE_VERSION_CREATED', reason, objectType: 'ProcedureDocumentRecord', objectId: record.id, after: { documentId: document.id, version: document.version, checksum } })
    return record
  })
}

const dateOnly = (date: Date) => date.toISOString().slice(0, 10)
const periodRange = (period: AuthoritativePeriod) => ({ start: dateOnly(period.startsAt), end: dateOnly(period.endsAt) })

async function loadAuthoritativeAuditSource(ownerId: string, period: AuthoritativePeriod): Promise<AuditExportSource> {
  const [profiles, mappings, year, auditEvents, taxSubmissions, cashBooks, cashEntries, cashCloses] = await Promise.all([
    prisma.companyProfileVersion.findMany({ where: { ownerId, effectiveFrom: { lte: period.endsAt } }, orderBy: { effectiveFrom: 'asc' } }),
    prisma.accountMappingVersion.findMany({ where: { ownerId, effectiveFrom: { lte: period.endsAt } }, orderBy: [{ accountNumber: 'asc' }, { effectiveFrom: 'asc' }] }),
    prisma.fiscalYear.findFirst({ where: { id: period.id, ownerId }, include: { journalEntries: { include: { lines: { include: { account: true, vatPosting: true } }, documents: true } } } }),
    prisma.auditEvent.findMany({ where: { ownerId }, orderBy: { occurredAt: 'asc' } }),
    prisma.taxWorkflowRecord.findMany({ where: { ownerId } }),
    prisma.cashBookRecord.findMany({ where: { ownerId } }), prisma.cashEntryRecord.findMany({ where: { ownerId } }), prisma.cashCloseRecord.findMany({ where: { ownerId } }),
  ])
  if (!year) throw new ComplianceRuntimeError('Fiscal period not found', 404)
  const tenant = <T extends object>(row: T) => ({ tenantId: ownerId, ...row })
  const chartAt = (date: Date) => { const version = [...profiles].filter(profile => profile.effectiveFrom <= date && (profile.effectiveTo === null || profile.effectiveTo >= date)).sort((left, right) => right.effectiveFrom.getTime() - left.effectiveFrom.getTime())[0]; return version ? (JSON.parse(version.payload) as Record<string, unknown>).chart : undefined }
  const mappingFor = (accountNumber: number, bookingDate: Date) => { const chart = chartAt(bookingDate); return [...mappings].filter(mapping => mapping.accountNumber === accountNumber && (chart === undefined || mapping.chartId === chart) && mapping.effectiveFrom <= bookingDate && (mapping.effectiveTo === null || mapping.effectiveTo >= bookingDate)).sort((left, right) => right.effectiveFrom.getTime() - left.effectiveFrom.getTime())[0] }
  const journal = year.journalEntries.map(entry => tenant({ id: entry.id, fiscalYearId: period.id, sequenceNumber: entry.sequenceNumber, bookingDate: dateOnly(entry.bookingDate), documentNumber: entry.documentNumber, description: entry.description }))
  const journalLines = year.journalEntries.flatMap(entry => entry.lines.map(line => { const mapping = mappingFor(line.account.number, entry.bookingDate); if (!mapping) throw new ComplianceRuntimeError(`No authoritative account mapping covers account ${line.account.number} on ${dateOnly(entry.bookingDate)}`, 409); return tenant({ id: line.id, journalEntryId: entry.id, accountId: mapping.id, debitCents: line.debitCents, creditCents: line.creditCents }) }))
  const chartMappings = mappings.map(mapping => tenant({ accountId: mapping.id, accountNumber: mapping.accountNumber, chartId: mapping.chartId, name: mapping.accountName, accountType: mapping.accountType, normalBalance: mapping.normalBalance, hgbPosition: mapping.hgbPosition, eBilanzPosition: mapping.eBilanzPosition, vatCode: mapping.vatCode, active: mapping.active, effectiveFrom: dateOnly(mapping.effectiveFrom), effectiveTo: mapping.effectiveTo ? dateOnly(mapping.effectiveTo) : null }))
  const openingClosing = mappings.map(mapping => { const lines = year.journalEntries.flatMap(entry => entry.lines.filter(line => mappingFor(line.account.number, entry.bookingDate)?.id === mapping.id)); return tenant({ fiscalYearId: period.id, accountId: mapping.id, openingCents: 0, closingCents: lines.reduce((sum, line) => sum + line.debitCents - line.creditCents, 0) }) })
  return { masterData: profiles.map(row => tenant({ id: row.id, effectiveFrom: dateOnly(row.effectiveFrom), payload: JSON.parse(row.payload) })), chartMappings, fiscalYears: [tenant({ id: period.id, startDate: dateOnly(period.startsAt), endDate: dateOnly(period.endsAt) })], journal, journalLines, openingClosing, vatDetails: year.journalEntries.flatMap(entry => entry.lines.filter(line => line.vatPosting).map(line => tenant({ id: line.vatPosting!.id, journalLineId: line.id, ...JSON.parse(line.vatPosting!.returnBoxes) }))), evidence: [], auditEvents: auditEvents.map(row => tenant({ id: row.id, action: row.action, occurredAt: row.occurredAt.toISOString(), objectType: row.objectType, objectId: row.objectId })), taxSubmissions: taxSubmissions.map(row => tenant({ id: row.submissionId, kind: row.kind, period: row.period, state: row.state })), openItems: [], cashBooks: cashBooks.map(row => tenant({ id: row.id, glAccountId: row.glAccountId, location: row.location, register: row.register, timeZone: row.timeZone, currency: row.currency, retainedThrough: dateOnly(row.retainedThrough) })), cashBookEntries: cashEntries.map(row => tenant(JSON.parse(row.payload))), cashDailyCloses: cashCloses.map(row => tenant(JSON.parse(row.payload))) }
}

async function loadAuthoritativeAnnualInput(ownerId: string, actorId: string, period: AuthoritativePeriod, input: Record<string, unknown>): Promise<AnnualPackageInput> {
  const [profileVersion, previous] = await Promise.all([prisma.companyProfileVersion.findFirst({ where: { ownerId, effectiveFrom: { lte: period.endsAt }, OR: [{ effectiveTo: null }, { effectiveTo: { gte: period.endsAt } }] }, orderBy: { effectiveFrom: 'desc' } }), prisma.fiscalYear.findFirst({ where: { ownerId, endsAt: { lt: period.startsAt } }, orderBy: { endsAt: 'desc' }, include: { journalEntries: { where: { state: 'POSTED' }, include: { lines: { include: { account: true } } } } } })])
  if (!profileVersion || !previous) throw new ComplianceRuntimeError('Authoritative company profile and comparative fiscal period are required', 409)
  const current = await prisma.fiscalYear.findFirst({ where: { id: period.id, ownerId }, include: { journalEntries: { where: { state: 'POSTED' }, include: { lines: { include: { account: true } } } } } })
  if (!current) throw new ComplianceRuntimeError('Fiscal period not found', 404)
  const profile = JSON.parse(profileVersion.payload) as Record<string, unknown>
  const chart = required(profile.chart, 'Authoritative company profile chart')
  const [mappings, records] = await Promise.all([
    prisma.accountMappingVersion.findMany({ where: { ownerId, chartId: chart, active: true, effectiveFrom: { lte: period.endsAt }, OR: [{ effectiveTo: null }, { effectiveTo: { gte: previous.startsAt } }] }, orderBy: [{ accountNumber: 'asc' }, { effectiveFrom: 'asc' }] }),
    prisma.hgbWorkpaperRecord.findMany({ where: { ownerId, fiscalPeriodId: period.id }, orderBy: [{ kind: 'asc' }, { version: 'desc' }] }),
  ])
  const latest = records.filter((item, index) => records.findIndex(candidate => candidate.kind === item.kind) === index)
  const reviewed = new Map<string, HgbWorkpaperDraft>()
  for (const item of latest.filter(item => item.status === 'REVIEWED')) {
    let payload: ReturnType<typeof validateHgbWorkpaper>
    try { payload = validateHgbWorkpaper(JSON.parse(item.payload) as HgbWorkpaperDraft, { startsAt: dateOnly(period.startsAt), endsAt: dateOnly(period.endsAt) }) } catch { throw new ComplianceRuntimeError(`The reviewed ${item.kind} workpaper is malformed`, 409) }
    if (hgbWorkpaperChecksum({ ownerId, fiscalPeriodId: period.id, kind: item.kind, payload }) !== item.checksum) throw new ComplianceRuntimeError(`The reviewed ${item.kind} workpaper checksum is invalid`, 409)
    reviewed.set(item.kind, payload)
  }
  const adjustments = latest.length ? await prisma.hgbAdjustmentRecord.findMany({ where: { ownerId, workpaperId: { in: latest.map(item => item.id) } } }) : []
  if (adjustments.some(item => item.status !== 'POSTED')) throw new ComplianceRuntimeError('Every reviewed workpaper adjustment must be posted before annual-account generation', 409)
  const requireWorkpaper = (kind: string) => { const workpaper = reviewed.get(kind); if (!workpaper) throw new ComplianceRuntimeError(`A current independently reviewed ${kind} workpaper is required`, 409); return workpaper }
  const sizeSchedule = requireWorkpaper('SIZE_AND_APPLICABILITY').schedule
  if (sizeSchedule.type !== 'SIZE_APPLICABILITY') throw new ComplianceRuntimeError('The reviewed size workpaper is malformed', 409)
  const size = sizeSchedule.establishedSize
  const policySchedule = requireWorkpaper('POLICY_ELECTIONS').schedule as PolicyElectionsSchedule
  const methods = policySchedule.elections.filter(item => item.applicable && item.selected && (item.policy === 'TOTAL_COST_PNL' || item.policy === 'FUNCTION_OF_EXPENSE_PNL'))
  if (methods.length !== 1) throw new ComplianceRuntimeError('Exactly one reviewed income-statement method election is required', 409)
  const method = methods[0].policy === 'TOTAL_COST_PNL' ? 'GKV' as const : 'UKV' as const
  if (size === 'MICRO' && method !== 'GKV') throw new ComplianceRuntimeError('The initial micro-entity annual-package adapter supports the condensed HGB § 275a layout with total-cost presentation only', 409)
  const opening = requireWorkpaper('OPENING_BALANCE').schedule as OpeningBalanceSchedule
  requireWorkpaper('MAPPING_AND_PRESENTATION'); requireWorkpaper('RECOGNITION_AND_OWNERSHIP'); requireWorkpaper('CUT_OFF_AND_ACCRUAL_DEFERRAL'); requireWorkpaper('PROVISIONS_AND_CONTINGENCIES'); requireWorkpaper('RECEIVABLE_AND_MARKET_VALUATION')
  const ruleSet = createHgbStatementRuleSet(size, method)
  const trialBalance = (year: typeof current): HgbTrialBalanceAccount[] => {
    const accounts = new Map<string, HgbTrialBalanceAccount>()
    for (const entry of year.journalEntries) for (const line of entry.lines) {
      const key = String(line.account.number); const value = accounts.get(key) ?? { accountNumber: key, openingDebitCents: 0, openingCreditCents: 0, debitCents: 0, creditCents: 0 }
      value.debitCents += line.debitCents; value.creditCents += line.creditCents
      if (!Number.isSafeInteger(value.debitCents) || !Number.isSafeInteger(value.creditCents)) throw new ComplianceRuntimeError(`Trial balance arithmetic is unsafe for account ${key}`, 409)
      accounts.set(key, value)
    }
    return [...accounts.values()].sort((left, right) => left.accountNumber.localeCompare(right.accountNumber))
  }
  const statement = buildHgbStatements({
    ruleSet,
    current: { startsAt: dateOnly(current.startsAt), endsAt: dateOnly(current.endsAt), accounts: trialBalance(current) },
    comparative: { startsAt: dateOnly(previous.startsAt), endsAt: dateOnly(previous.endsAt), accounts: trialBalance(previous as typeof current) },
    mappings: mappings.map(mapping => ({ accountNumber: String(mapping.accountNumber), lineId: mapping.hgbPosition, normalBalance: mapping.normalBalance as 'DEBIT' | 'CREDIT', presentationSign: mapping.presentationSign as 1 | -1, effectiveFrom: dateOnly(mapping.effectiveFrom), ...(mapping.effectiveTo ? { effectiveTo: dateOnly(mapping.effectiveTo) } : {}) })),
    expectedComparativeLeaves: opening.approvedComparativeLeaves,
  })
  const accountIds = new Map<number, string>(); for (const year of [current, previous as typeof current]) for (const entry of year.journalEntries) for (const line of entry.lines) accountIds.set(line.account.number, line.accountId)
  const byId = new Map(statement.lines.map(line => [line.id, line]))
  const sourceAccounts = (lineId: string) => statement.mappedAccounts.filter(item => item.lineId === lineId).map(item => accountIds.get(Number(item.accountNumber))).filter((id): id is string => Boolean(id))
  const convert = (codes: readonly string[], map: Record<string, string>) => codes.map(code => { const line = byId.get(map[code]); const sign = line?.role === 'EXPENSE' ? -1 : 1; return { code, label: line?.label ?? code, amountCents: (line?.amountCents ?? 0) * sign, comparativeCents: (line?.comparativeAmountCents ?? 0) * sign, accountIds: line ? [...new Set(sourceAccounts(line.id))] : [] } })
  const balanceMap = hgbAnnualBalanceMap()
  const incomeMap = hgbAnnualIncomeMap(size, method)
  const balanceCodes = size === 'MICRO' ? MICRO_BALANCE_SHEET_ORDER : SMALL_BALANCE_SHEET_ORDER
  const incomeCodes = method === 'GKV' ? GKV_ORDER.filter(code => code !== 'GROSS_PROFIT') : UKV_ORDER
  const notesWorkpaper = reviewed.get('NOTES')?.schedule as NotesQuestionnaireSchedule | undefined
  const notes = notesWorkpaper?.type === 'NOTES_QUESTIONNAIRE' && Array.isArray(notesWorkpaper.questions) ? notesWorkpaper.questions.filter(item => item.answer === 'YES' && item.disclosureText?.trim()).map(item => item.disclosureText!.trim()) : ['Anhangangaben werden aufgrund der dokumentierten Kleinstkapitalgesellschaft-Erleichterung unter der Bilanz ausgewiesen.']
  return { profile: { tenantId: ownerId, legalName: String(profile.companyName ?? ''), legalForm: String(profile.legalForm ?? ''), registerCourt: String(profile.registerCourt ?? ''), registerNumber: String(profile.registerNumber ?? ''), registeredOffice: String((profile.registeredAddress as Record<string, unknown> | undefined)?.city ?? ''), size, currency: 'EUR', language: 'de' }, fiscalYear: period.year, previousFiscalYear: previous.year, previousFiscalPeriodStart: dateOnly(previous.startsAt), previousFiscalPeriodEnd: dateOnly(previous.endsAt), previousFiscalPeriodId: previous.id, fiscalPeriodStart: dateOnly(period.startsAt), fiscalPeriodEnd: dateOnly(period.endsAt), fiscalTimeZone: 'Europe/Berlin', method, balanceSheet: convert(balanceCodes, balanceMap), incomeStatement: convert(incomeCodes, incomeMap), policies: policySchedule.elections.filter(item => item.applicable && item.selected).map(item => `${item.policy}: ${item.rationale.trim()}`), notes, checks: { nonOffsetting: true, accrual: true, provisions: true, valuation: true, continuity: true }, preparedBy: actorId, preparedAt: `${complianceReferenceDate()}T12:00:00.000Z` }
}

function hgbAnnualBalanceMap(): Record<string, string> {
  return { 'A.ASSETS': 'BS.ASSETS', 'A.FIXED': 'BS.A.A', 'A.INTANGIBLE': 'BS.A.A.I', 'A.TANGIBLE': 'BS.A.A.II', 'A.FINANCIAL': 'BS.A.A.III', 'A.CURRENT': 'BS.A.B', 'A.INVENTORIES': 'BS.A.B.I', 'A.RECEIVABLES': 'BS.A.B.II', 'A.SECURITIES': 'BS.A.B.III', 'A.CASH': 'BS.A.B.IV', 'A.PREPAID': 'BS.A.C', 'A.DEFERRED_TAX': 'BS.A.D', 'A.PENSION_DIFFERENCE': 'BS.A.E', 'B.EQUITY_LIABILITIES': 'BS.EQUITY_LIABILITIES', 'B.EQUITY': 'BS.P.A', 'B.SUBSCRIBED_CAPITAL': 'BS.P.A.I', 'B.CAPITAL_RESERVE': 'BS.P.A.II', 'B.REVENUE_RESERVES': 'BS.P.A.III', 'B.CARRYFORWARD': 'BS.P.A.IV', 'B.NET_INCOME': 'BS.P.A.V', 'B.PROVISIONS': 'BS.P.B', 'B.LIABILITIES': 'BS.P.C', 'B.DEFERRED': 'BS.P.D', 'B.DEFERRED_TAX': 'BS.P.E' }
}

function hgbAnnualIncomeMap(size: 'MICRO' | 'SMALL', method: 'GKV' | 'UKV'): Record<string, string> {
  if (size === 'MICRO') return { REVENUE: 'IS.M.1', OTHER_INCOME: 'IS.M.2', MATERIAL_RAW: 'IS.M.3', PERSONNEL_WAGES: 'IS.M.4', DEPRECIATION_FIXED: 'IS.M.5', OTHER_EXPENSE: 'IS.M.6', INCOME_TAX: 'IS.M.7', RESULT_AFTER_TAX: 'IS.M.8', NET_INCOME: 'IS.M.8' }
  const prefix = `IS.${method}`
  return method === 'GKV'
    ? { REVENUE: 'IS.GKV.1', INVENTORY_CHANGE: 'IS.GKV.2', OWN_WORK: 'IS.GKV.3', OTHER_INCOME: 'IS.GKV.4', MATERIAL_RAW: 'IS.GKV.5.A', MATERIAL_SERVICES: 'IS.GKV.5.B', PERSONNEL_WAGES: 'IS.GKV.6.A', PERSONNEL_SOCIAL: 'IS.GKV.6.B', DEPRECIATION_FIXED: 'IS.GKV.7.A', DEPRECIATION_CURRENT: 'IS.GKV.7.B', OTHER_EXPENSE: 'IS.GKV.8', PARTICIPATION_INCOME: `${prefix}.FIN.1`, AFFILIATED_INCOME: `${prefix}.FIN.2`, INTEREST_INCOME: `${prefix}.FIN.3`, FINANCIAL_DEPRECIATION: `${prefix}.FIN.4`, INTEREST_EXPENSE: `${prefix}.FIN.5`, INCOME_TAX: `${prefix}.TAX.INCOME`, RESULT_AFTER_TAX: `${prefix}.AFTER_TAX`, OTHER_TAX: `${prefix}.TAX.OTHER`, NET_INCOME: `${prefix}.NET` }
    : { REVENUE: 'IS.UKV.1', COST_OF_SALES: 'IS.UKV.2', GROSS_SALES_PROFIT: 'IS.UKV.3', DISTRIBUTION: 'IS.UKV.4', ADMINISTRATION: 'IS.UKV.5', OTHER_INCOME: 'IS.UKV.6', OTHER_EXPENSE: 'IS.UKV.7', PARTICIPATION_INCOME: `${prefix}.FIN.1`, AFFILIATED_INCOME: `${prefix}.FIN.2`, INTEREST_INCOME: `${prefix}.FIN.3`, FINANCIAL_DEPRECIATION: `${prefix}.FIN.4`, INTEREST_EXPENSE: `${prefix}.FIN.5`, INCOME_TAX: `${prefix}.TAX.INCOME`, RESULT_AFTER_TAX: `${prefix}.AFTER_TAX`, OTHER_TAX: `${prefix}.TAX.OTHER`, NET_INCOME: `${prefix}.NET` }
}

export async function getReportingOverview(ownerId: string) {
  const [packages, procedures, assets, assetEvents, inventoryItems, inventoryCloses, cashBooks, cashEntries, cashCloses] = await prisma.$transaction([
    prisma.compliancePackage.findMany({ where: { ownerId }, orderBy: [{ kind: 'asc' }, { version: 'desc' }] }),
    prisma.procedureDocumentRecord.findMany({ where: { ownerId }, orderBy: { effectiveFrom: 'desc' } }),
    prisma.fixedAssetRecord.findMany({ where: { ownerId }, orderBy: { createdAt: 'asc' } }),
    prisma.assetEventRecord.findMany({ where: { ownerId }, orderBy: [{ assetId: 'asc' }, { sequence: 'asc' }] }),
    prisma.inventoryItemRecord.findMany({ where: { ownerId }, orderBy: { createdAt: 'asc' } }),
    prisma.inventoryCountSnapshot.findMany({ where: { ownerId }, orderBy: { closedAt: 'desc' } }),
    prisma.cashBookRecord.findMany({ where: { ownerId }, orderBy: { createdAt: 'asc' } }),
    prisma.cashEntryRecord.findMany({ where: { ownerId }, orderBy: [{ cashBookId: 'asc' }, { sequence: 'asc' }] }),
    prisma.cashCloseRecord.findMany({ where: { ownerId }, orderBy: [{ cashBookId: 'asc' }, { businessDate: 'asc' }] }),
  ])
  return { packages, procedures, assets, assetEvents, inventoryItems, inventoryCloses, cashBooks, cashEntries, cashCloses }
}
