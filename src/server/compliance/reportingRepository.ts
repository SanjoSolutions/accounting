import 'server-only'

import { createHash, createHmac, randomUUID } from 'node:crypto'
import { canonicalJson, createAuditPackage, verifyAuditPackage, type AuditExportSource, type MigrationPackageAuthenticator } from '@/core/compliance/auditExport'
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

export async function downloadReportingPackage(ownerId: string, actorId: string, packageId: string) {
  const record = await prisma.compliancePackage.findFirst({ where: { id: packageId, ownerId, kind: { in: ['AUDIT_EXPORT', 'MIGRATION_EXPORT'] } } })
  if (!record?.storageKey) throw new ComplianceRuntimeError('Audit or migration package not found', 404)
  const artifact = await prisma.retainedArtifact.findFirst({ where: { ownerId, objectType: 'CompliancePackage', objectId: record.id, version: record.version, disposedAt: null, storageDeletedAt: null } })
  if (!artifact) throw new ComplianceRuntimeError('The retained export registration is unavailable', 409)
  const storage = getDocumentStorage(); if (!await storage.exists(record.storageKey)) throw new ComplianceRuntimeError('The retained export bytes are unavailable', 409)
  const content = await storage.read(record.storageKey); if (createHash('sha256').update(content).digest('hex') !== artifact.contentHash) throw new ComplianceRuntimeError('The retained export failed its fixity check', 409)
  let auditPackage: unknown; try { auditPackage = JSON.parse(content.toString('utf8')) } catch { throw new ComplianceRuntimeError('The retained export is not valid JSON', 409) }
  const issues = verifyAuditPackage(auditPackage); if (issues.length) throw new ComplianceRuntimeError(`The retained export is invalid: ${issues.join('; ')}`, 409)
  const period = record.fiscalPeriodId ? await prisma.fiscalYear.findFirst({ where: { id: record.fiscalPeriodId, ownerId }, select: { year: true } }) : null
  await prisma.$transaction(transaction => appendAuditEvent(transaction, { ownerId, actorId, action: 'EXPORT_DOWNLOADED', reason: 'Authenticated download of retained GoBD package', objectType: 'CompliancePackage', objectId: record.id, after: { kind: record.kind, version: record.version, contentHash: artifact.contentHash } }))
  return { content, fileName: `gobd-${record.kind === 'AUDIT_EXPORT' ? 'audit' : 'migration'}-${period?.year ?? 'all'}-v${record.version}.json`, contentHash: artifact.contentHash }
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
function requirePayloadDate(value: unknown, label: string) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new ComplianceRuntimeError(`${label} must be a real ISO date`, 409)
  const parsed = new Date(`${value}T00:00:00.000Z`)
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) throw new ComplianceRuntimeError(`${label} must be a real ISO date`, 409)
  return value
}

async function loadAuthoritativeAuditSource(ownerId: string, period: AuthoritativePeriod): Promise<AuditExportSource> {
  const [profiles, mappings, year, priorEntries, auditEvents, taxSubmissions, documents, businessPartners, commercialDocuments, openItems, paymentSettlements, settlementAllocations, correctionNettings, bankAccounts, bankStatements, bankTransactions, bankTransactionMatches, fixedAssets, assetEvents, cashBooks, cashEntries, cashCloses] = await Promise.all([
    prisma.companyProfileVersion.findMany({ where: { ownerId, effectiveFrom: { lte: period.endsAt } }, orderBy: { effectiveFrom: 'asc' } }),
    prisma.accountMappingVersion.findMany({ where: { ownerId, effectiveFrom: { lte: period.endsAt } }, orderBy: [{ accountNumber: 'asc' }, { effectiveFrom: 'asc' }] }),
    prisma.fiscalYear.findFirst({ where: { id: period.id, ownerId }, include: { journalEntries: { where: { state: 'POSTED' }, include: { lines: { include: { account: true, vatPosting: true } }, documents: true } } } }),
    prisma.journalEntry.findMany({ where: { ownerId, state: 'POSTED', bookingDate: { lt: period.startsAt } }, include: { lines: { include: { account: true } } }, orderBy: [{ bookingDate: 'asc' }, { sequenceNumber: 'asc' }] }),
    prisma.auditEvent.findMany({ where: { ownerId }, orderBy: { occurredAt: 'asc' } }),
    prisma.taxWorkflowRecord.findMany({ where: { ownerId } }),
    prisma.documentRecord.findMany({ where: { ownerId } }),
    prisma.businessPartner.findMany({ where: { ownerId }, orderBy: { partnerNumber: 'asc' } }),
    prisma.commercialDocument.findMany({ where: { ownerId, serviceDate: { lte: period.endsAt } }, orderBy: [{ serviceDate: 'asc' }, { id: 'asc' }] }),
    prisma.openItem.findMany({ where: { ownerId, commercialDocument: { serviceDate: { lte: period.endsAt } } }, orderBy: { createdAt: 'asc' } }),
    prisma.paymentSettlement.findMany({ where: { ownerId, occurredOn: { lte: period.endsAt } }, orderBy: [{ occurredOn: 'asc' }, { id: 'asc' }] }),
    prisma.settlementAllocation.findMany({ where: { ownerId, effectiveDate: { lte: period.endsAt } }, orderBy: [{ effectiveDate: 'asc' }, { id: 'asc' }] }),
    prisma.correctionNetting.findMany({ where: { ownerId, effectiveDate: { lte: period.endsAt } }, orderBy: [{ effectiveDate: 'asc' }, { id: 'asc' }] }),
    prisma.bankAccount.findMany({ where: { ownerId }, include: { ledgerAccount: true }, orderBy: { id: 'asc' } }),
    prisma.bankStatement.findMany({ where: { ownerId, periodStart: { lte: period.endsAt }, periodEnd: { gte: period.startsAt } }, orderBy: [{ periodStart: 'asc' }, { id: 'asc' }] }),
    prisma.bankTransaction.findMany({ where: { ownerId, bookingDate: { gte: period.startsAt, lte: period.endsAt } }, orderBy: [{ bookingDate: 'asc' }, { id: 'asc' }] }),
    prisma.bankTransactionMatch.findMany({ where: { ownerId, effectiveDate: { gte: period.startsAt, lte: period.endsAt } }, orderBy: [{ effectiveDate: 'asc' }, { id: 'asc' }] }),
    prisma.fixedAssetRecord.findMany({ where: { ownerId }, orderBy: { createdAt: 'asc' } }), prisma.assetEventRecord.findMany({ where: { ownerId }, orderBy: [{ assetId: 'asc' }, { sequence: 'asc' }] }),
    prisma.cashBookRecord.findMany({ where: { ownerId } }), prisma.cashEntryRecord.findMany({ where: { ownerId, businessDate: { gte: period.startsAt, lte: period.endsAt } } }), prisma.cashCloseRecord.findMany({ where: { ownerId, businessDate: { gte: period.startsAt, lte: period.endsAt } } }),
  ])
  if (!year) throw new ComplianceRuntimeError('Fiscal period not found', 404)
  const tenant = <T extends object>(row: T) => ({ tenantId: ownerId, ...row })
  const chartAt = (date: Date) => { const version = [...profiles].filter(profile => profile.effectiveFrom <= date && (profile.effectiveTo === null || profile.effectiveTo >= date)).sort((left, right) => right.effectiveFrom.getTime() - left.effectiveFrom.getTime())[0]; return version ? (JSON.parse(version.payload) as Record<string, unknown>).chart : undefined }
  const mappingFor = (accountNumber: number, bookingDate: Date) => { const chart = chartAt(bookingDate); return [...mappings].filter(mapping => mapping.accountNumber === accountNumber && (chart === undefined || mapping.chartId === chart) && mapping.effectiveFrom <= bookingDate && (mapping.effectiveTo === null || mapping.effectiveTo >= bookingDate)).sort((left, right) => right.effectiveFrom.getTime() - left.effectiveFrom.getTime())[0] }
  const journal = year.journalEntries.map(entry => tenant({ id: entry.id, fiscalYearId: period.id, sequenceNumber: entry.sequenceNumber, bookingDate: dateOnly(entry.bookingDate), documentNumber: entry.documentNumber, description: entry.description }))
  const journalLines = year.journalEntries.flatMap(entry => entry.lines.map(line => { const mapping = mappingFor(line.account.number, entry.bookingDate); if (!mapping) throw new ComplianceRuntimeError(`No authoritative account mapping covers account ${line.account.number} on ${dateOnly(entry.bookingDate)}`, 409); return tenant({ id: line.id, journalEntryId: entry.id, accountId: mapping.id, debitCents: line.debitCents, creditCents: line.creditCents }) }))
  const chartMappings = mappings.map(mapping => tenant({ accountId: mapping.id, accountNumber: mapping.accountNumber, chartId: mapping.chartId, name: mapping.accountName, accountType: mapping.accountType, normalBalance: mapping.normalBalance, hgbPosition: mapping.hgbPosition, eBilanzPosition: mapping.eBilanzPosition, vatCode: mapping.vatCode, active: mapping.active, effectiveFrom: dateOnly(mapping.effectiveFrom), effectiveTo: mapping.effectiveTo ? dateOnly(mapping.effectiveTo) : null }))
  const openingByMapping = new Map<string, number>()
  for (const entry of priorEntries) for (const line of entry.lines) { const mapping = mappingFor(line.account.number, period.startsAt); if (mapping) openingByMapping.set(mapping.id, (openingByMapping.get(mapping.id) ?? 0) + line.debitCents - line.creditCents) }
  const movementByMapping = new Map<string, number>()
  for (const entry of year.journalEntries) for (const line of entry.lines) { const mapping = mappingFor(line.account.number, entry.bookingDate)!; movementByMapping.set(mapping.id, (movementByMapping.get(mapping.id) ?? 0) + line.debitCents - line.creditCents) }
  const openingClosing = mappings.map(mapping => { if (!['ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE'].includes(mapping.accountType)) throw new ComplianceRuntimeError(`Account mapping ${mapping.id} has an unsupported account type`, 409); const openingCents = ['REVENUE', 'EXPENSE'].includes(mapping.accountType) ? 0 : openingByMapping.get(mapping.id) ?? 0; return tenant({ fiscalYearId: period.id, accountId: mapping.id, openingCents, closingCents: openingCents + (movementByMapping.get(mapping.id) ?? 0) }) })
  const periodEnd = dateOnly(period.endsAt)
  const exportedFixedAssets = fixedAssets.filter(row => { const payload = JSON.parse(row.payload) as Record<string, unknown>; return requirePayloadDate(payload.acquisitionDate, `Fixed asset ${row.id} acquisitionDate`) <= periodEnd })
  const exportedAssetIds = new Set(exportedFixedAssets.map(row => row.id))
  const exportedAssetEvents = assetEvents.filter(row => { const payload = JSON.parse(row.payload) as Record<string, unknown>; const effectiveDate = requirePayloadDate(payload.effectiveDate, `Asset event ${row.id} effectiveDate`); return effectiveDate <= periodEnd && exportedAssetIds.has(row.assetId) })
  const referencedEvidenceIds = new Set<string>()
  for (const entry of year.journalEntries) for (const link of entry.documents) referencedEvidenceIds.add(link.documentId)
  for (const row of commercialDocuments) if (row.evidenceDocumentId) referencedEvidenceIds.add(row.evidenceDocumentId)
  for (const record of [...exportedFixedAssets, ...exportedAssetEvents]) { const payload = JSON.parse(record.payload) as Record<string, unknown>; if (typeof payload.evidenceDocumentId === 'string') referencedEvidenceIds.add(payload.evidenceDocumentId); if (Array.isArray(payload.evidenceIds)) for (const id of payload.evidenceIds) if (typeof id === 'string') referencedEvidenceIds.add(id) }
  for (const record of cashEntries) { const payload = JSON.parse(record.payload) as Record<string, unknown>; if (Array.isArray(payload.evidenceIds)) for (const id of payload.evidenceIds) if (typeof id === 'string') referencedEvidenceIds.add(id) }
  const missingEvidence = [...referencedEvidenceIds].filter(id => !documents.some(document => document.id === id)); if (missingEvidence.length) throw new ComplianceRuntimeError(`Referenced evidence is missing: ${missingEvidence.join(', ')}`, 409)
  const evidence = await Promise.all(documents.filter(document => referencedEvidenceIds.has(document.id)).map(async document => {
    let payload: Record<string, unknown>; try { payload = JSON.parse(document.payload) as Record<string, unknown> } catch { throw new ComplianceRuntimeError(`Evidence document ${document.id} has malformed storage metadata`, 409) }
    const storageKey = typeof payload.storageKey === 'string' ? payload.storageKey : ''; if (!storageKey) throw new ComplianceRuntimeError(`Evidence document ${document.id} has no retained original`, 409)
    const storage = getDocumentStorage(); if (!await storage.exists(storageKey)) throw new ComplianceRuntimeError(`Evidence document ${document.id} original is unavailable`, 409)
    const bytes = await storage.read(storageKey); const journalEntryId = year.journalEntries.find(entry => entry.documents.some(link => link.documentId === document.id))?.id
    return tenant({ id: document.id, ...(journalEntryId ? { journalEntryId } : {}), fileName: typeof payload.fileName === 'string' && payload.fileName.trim() ? payload.fileName : document.id, mediaType: typeof payload.contentType === 'string' && payload.contentType.trim() ? payload.contentType : 'application/octet-stream', sizeBytes: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: new Uint8Array(bytes) })
  }))
  const allocationNet = new Map<string, number>(); const settlementAllocationNet = new Map<string, number>(); for (const row of settlementAllocations) { allocationNet.set(row.openItemId, (allocationNet.get(row.openItemId) ?? 0) + row.amountCents); settlementAllocationNet.set(row.settlementId, (settlementAllocationNet.get(row.settlementId) ?? 0) + row.amountCents) } for (const row of correctionNettings) { allocationNet.set(row.originalOpenItemId, (allocationNet.get(row.originalOpenItemId) ?? 0) + row.amountCents); allocationNet.set(row.creditOpenItemId, (allocationNet.get(row.creditOpenItemId) ?? 0) + row.amountCents) }
  const allocationSnapshot = (allocatedAmountCents: number, originalAmountCents: number, label: string, statuses: readonly [string, string, string]) => { if (!Number.isSafeInteger(allocatedAmountCents) || allocatedAmountCents < 0 || allocatedAmountCents > originalAmountCents) throw new ComplianceRuntimeError(`${label} has an invalid period-end allocation balance`, 409); return { allocatedAmountCents, outstandingCents: originalAmountCents - allocatedAmountCents, status: allocatedAmountCents === 0 ? statuses[0] : allocatedAmountCents === originalAmountCents ? statuses[2] : statuses[1] } }
  const taxRows = taxSubmissions.filter(row => row.period === String(period.year) || (row.period >= dateOnly(period.startsAt).slice(0, 7) && row.period <= dateOnly(period.endsAt).slice(0, 7))).map(row => tenant({ id: row.submissionId, fiscalYearId: period.id, kind: row.kind === 'USTVA' ? 'VAT' : row.kind, ...(row.kind === 'USTVA' ? { returnPeriod: row.period } : {}), status: row.state, revision: row.revision, payload: JSON.parse(row.payload), receipt: row.receipt ? JSON.parse(row.receipt) : null }))
  const vatDetails = year.journalEntries.flatMap(entry => entry.lines.filter(line => line.vatPosting).map(line => { const posting = line.vatPosting!; const returnPeriod = dateOnly(posting.taxPoint).slice(0, 7); const submission = taxSubmissions.filter(row => row.kind === 'USTVA' && row.period === returnPeriod).sort((left, right) => right.revision - left.revision)[0]; if (!submission) throw new ComplianceRuntimeError(`VAT posting ${posting.id} has no authoritative UStVA workflow for ${returnPeriod}`, 409); return tenant({ id: posting.id, journalLineId: line.id, taxCode: line.taxCode ?? posting.vatCase, baseCents: posting.netBaseCents, taxAmountCents: posting.taxCents, returnPeriod, submissionId: submission.submissionId, returnBoxes: JSON.parse(posting.returnBoxes), ruleId: posting.ruleId, ruleVersion: posting.ruleVersion, source: JSON.parse(posting.source) }) }))
  return {
    masterData: profiles.map(row => tenant({ id: row.id, effectiveFrom: dateOnly(row.effectiveFrom), payload: JSON.parse(row.payload) })), chartMappings, fiscalYears: [tenant({ id: period.id, startDate: dateOnly(period.startsAt), endDate: dateOnly(period.endsAt) })], journal, journalLines, openingClosing,
    vatDetails, evidence,
    auditEvents: auditEvents.map(row => tenant({ id: row.id, action: row.action, occurredAt: row.occurredAt.toISOString(), objectType: row.objectType, targetId: row.objectId, actorId: row.actorId, reason: row.reason, semanticDelta: JSON.parse(row.semanticDelta), previousHash: row.previousHash, hash: row.hash, integrityKeyId: row.integrityKeyId })), taxSubmissions: taxRows,
    businessPartners: businessPartners.map(row => tenant({ id: row.id, partnerNumber: row.partnerNumber, role: row.role, name: row.name, contactName: row.contactName, email: row.email, street: row.street, houseNumber: row.houseNumber, postalCode: row.postalCode, city: row.city, countryCode: row.countryCode, vatId: row.vatId, taxId: row.taxId, paymentTermDays: row.paymentTermDays, active: row.active, version: row.version })),
    commercialDocuments: commercialDocuments.map(row => tenant({ id: row.id, businessPartnerId: row.businessPartnerId, structuredInvoiceId: row.structuredInvoiceId, evidenceDocumentId: row.evidenceDocumentId, postingJournalEntryId: row.postingJournalEntryId, postingJournalEntryIncluded: row.postingJournalEntryId !== null && journal.some(entry => entry.id === row.postingJournalEntryId), correctsId: row.correctsId, direction: row.direction, kind: row.kind, status: row.status, documentNumber: row.documentNumber, issueDate: row.issueDate ? dateOnly(row.issueDate) : null, serviceDate: dateOnly(row.serviceDate), dueDate: dateOnly(row.dueDate), description: row.description, currency: row.currency, netAmountCents: row.netAmountCents, taxAmountCents: row.taxAmountCents, grossAmountCents: row.grossAmountCents, payableAmountCents: row.payableAmountCents, counterpartySnapshot: row.counterpartySnapshot ? JSON.parse(row.counterpartySnapshot) : null, version: row.version })),
    openItems: openItems.map(row => tenant({ id: row.id, commercialDocumentId: row.commercialDocumentId, side: row.side, currency: row.currency, originalAmountCents: row.originalAmountCents, ...allocationSnapshot(allocationNet.get(row.id) ?? 0, row.originalAmountCents, `Open item ${row.id}`, ['OPEN', 'PARTIAL', 'SETTLED']), version: row.version })),
    paymentSettlements: paymentSettlements.map(row => { const snapshot = allocationSnapshot(settlementAllocationNet.get(row.id) ?? 0, row.amountCents, `Payment settlement ${row.id}`, ['UNALLOCATED', 'PARTIAL', 'ALLOCATED']); return tenant({ id: row.id, businessPartnerId: row.businessPartnerId, journalEntryId: row.journalEntryId, journalEntryIncluded: journal.some(entry => entry.id === row.journalEntryId), direction: row.direction, currency: row.currency, amountCents: row.amountCents, allocatedAmountCents: snapshot.allocatedAmountCents, status: snapshot.status, occurredOn: dateOnly(row.occurredOn), createdBy: row.createdBy }) }),
    settlementAllocations: settlementAllocations.map(row => tenant({ id: row.id, openItemId: row.openItemId, settlementId: row.settlementId, journalEntryId: row.journalEntryId, journalEntryIncluded: journal.some(entry => entry.id === row.journalEntryId), kind: row.kind, amountCents: row.amountCents, reversesAllocationId: row.reversesAllocationId, effectiveDate: dateOnly(row.effectiveDate), createdBy: row.createdBy, requestHash: row.requestHash })),
    correctionNettings: correctionNettings.map(row => tenant({ id: row.id, correctionDocumentId: row.correctionDocumentId, originalOpenItemId: row.originalOpenItemId, creditOpenItemId: row.creditOpenItemId, journalEntryId: row.journalEntryId, journalEntryIncluded: journal.some(entry => entry.id === row.journalEntryId), amountCents: row.amountCents, effectiveDate: dateOnly(row.effectiveDate), createdBy: row.createdBy, requestHash: row.requestHash })),
    bankAccounts: bankAccounts.map(row => { const mapping = mappingFor(row.ledgerAccount.number, period.endsAt); if (!mapping) throw new ComplianceRuntimeError(`No authoritative account mapping covers bank account ${row.name}`, 409); return tenant({ id: row.id, name: row.name, iban: row.iban, currency: row.currency, ledgerAccountId: mapping.id, active: row.active }) }),
    bankStatements: bankStatements.map(row => tenant({ id: row.id, bankAccountId: row.bankAccountId, externalStatementId: row.externalStatementId, format: row.format, contentHash: row.contentHash, originalXml: new Uint8Array(row.originalXml), periodStart: dateOnly(row.periodStart), periodEnd: dateOnly(row.periodEnd), openingBalanceCents: row.openingBalanceCents, closingBalanceCents: row.closingBalanceCents, currency: row.currency, importedBy: row.importedBy })),
    bankTransactions: bankTransactions.map(row => tenant({ id: row.id, bankAccountId: row.bankAccountId, statementId: row.statementId, externalKey: row.externalKey, factHash: row.factHash, amountCents: row.amountCents, currency: row.currency, bookingDate: dateOnly(row.bookingDate), valueDate: row.valueDate ? dateOnly(row.valueDate) : null, bankReference: row.bankReference, counterpartyName: row.counterpartyName, counterpartyIban: row.counterpartyIban, remittance: row.remittance, rawData: JSON.parse(row.rawData) })),
    bankTransactionMatches: bankTransactionMatches.map(row => tenant({ id: row.id, bankTransactionId: row.bankTransactionId, openItemId: row.openItemId, settlementId: row.settlementId, allocationId: row.allocationId, journalEntryId: row.journalEntryId, kind: row.kind, amountCents: row.amountCents, reversesMatchId: row.reversesMatchId, effectiveDate: dateOnly(row.effectiveDate), createdBy: row.createdBy, requestHash: row.requestHash })),
    fixedAssets: exportedFixedAssets.map(row => tenant({ ...JSON.parse(row.payload), id: row.id, acquisitionJournalLineId: row.acquisitionJournalLineId, createdBy: row.createdBy })), assetEvents: exportedAssetEvents.map(row => tenant({ ...JSON.parse(row.payload), id: row.id, assetId: row.assetId, sequence: row.sequence, postingId: row.postingId, approvedBy: row.approvedBy, approvedAt: row.approvedAt.toISOString() })),
    cashBooks: cashBooks.filter(row => cashEntries.some(entry => entry.cashBookId === row.id) || cashCloses.some(close => close.cashBookId === row.id)).map(row => tenant({ version: 1, id: row.id, glAccountId: row.glAccountId, location: row.location, register: row.register, timeZone: row.timeZone, currency: row.currency, retainedThrough: dateOnly(row.retainedThrough) })), cashBookEntries: cashEntries.map(row => tenant(JSON.parse(row.payload))), cashDailyCloses: cashCloses.map(row => tenant(JSON.parse(row.payload))),
  }
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
