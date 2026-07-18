import 'server-only'

import { randomUUID } from 'node:crypto'
import { BookingRecord } from '@/core/BookingRecord'
import { isChartOfAccountsStandard } from '@/core/ChartOfAccounts'
import { CompanyProfileValidationError, isIdempotentProfileRetry, mergeInvoiceIssuerFields, profilesSemanticallyEqual, validateAtomicChartTransition, validateChartActivation, validateCompanyProfile, validateEffectiveDate, validateLiveEffectiveDate, validateProfileVersions, validateSettingsSnapshot } from './compliance/companyProfile'
import { isIdempotentMappingCohort, resolveTargetChart, scaleMappingsForAccountLength, seedChart, shouldGuardActiveRevision, validateActiveChartRevision, validateActiveRevisionEffectiveDate, validateChartSwitch, validateImportedChart, type AccountMapping } from './compliance/chartLifecycle'
import { prisma } from './persistence/client'
import { Document } from '@/core/Document'
import type { Invoice } from '@/core/Invoice'
import { Tax } from '@/core/Tax'
import { TaxAmount } from '@/core/TaxAmount'
import { Account } from '@/core/authentication/Account'
import fixture from './dataFixtures/results_11048337544652359545_0_Invoice_Example_English-0.json'
import { generateDocumentThumbnail } from './documentThumbnail'
import { createPrismaPersistence } from './persistence/prisma'
import { getDocumentStorage } from './storage'
import { requireLegacyLedgerProfile } from './ledger'

const persistence = createPrismaPersistence()
const companySettingsId = (ownerId: string) => `company:${ownerId}`

export interface DocumentFileInput {
  content: Buffer
  contentType: string
  fileName: string
}

export async function createBookingRecord(data: any): Promise<void> {
  const { date, debitSide, creditSide } = data
  await persistence.bookingRecords.save(new BookingRecord(new Date(date), debitSide, creditSide))
}

export async function getSettings(ownerId: string): Promise<Account> {
  const scopedId = companySettingsId(ownerId)
  let account = await persistence.accounts.findOne(scopedId)

  if (!account) {
    const claimed = await persistence.accounts.claimLegacyDefault(scopedId, ownerId)
    if (claimed) return claimed
    account = new Account(scopedId)
    await persistence.accounts.save(account)
  }

  return account
}

export async function updateSettings(data: any, ownerId: string, actorId = ownerId): Promise<void> {
  const account = await getSettings(ownerId)
  const originalPayload = account.persistencePayload ?? JSON.stringify(account)

  if (data.chartOfAccounts !== undefined && !isChartOfAccountsStandard(data.chartOfAccounts)) {
    throw new TypeError('chartOfAccounts must be SKR03 or SKR04')
  }
  const consistencyIssues = validateAtomicChartTransition(data.chartOfAccounts, data.companyProfile?.chart, account.companyProfile?.chart)
  if (consistencyIssues.length) throw new CompanyProfileValidationError(consistencyIssues.join('; '))
  const importedIssues = data.importedChart === undefined ? [] : validateImportedChart(data.importedChart)
  const mappingEffectiveFrom = data.mappingEffectiveFrom ?? data.companyProfileEffectiveFrom
  if (data.importedChart !== undefined) importedIssues.push(...validateEffectiveDate(mappingEffectiveFrom))
  if (importedIssues.length) throw new CompanyProfileValidationError(importedIssues.join('; '))
  const importedChart = data.importedChart as { id: string; mappings: AccountMapping[] } | undefined
  const profileChanging = data.companyProfile !== undefined && !profilesSemanticallyEqual(data.companyProfile, account.companyProfile)
  const profileRetryRequested = data.companyProfile !== undefined && (data.companyProfileEffectiveFrom !== undefined || data.changeReason !== undefined)
  const profileVersionWrite = profileChanging || profileRetryRequested
  const availableImportedCharts = [...new Set([...account.importedCharts, ...(importedChart ? [importedChart.id] : [])])]
  if (data.invoiceIssuer !== undefined) mergeInvoiceIssuerFields(account.invoiceIssuer, data.invoiceIssuer)
  if (data.chartOfAccounts !== undefined) {
    account.chartOfAccounts = data.chartOfAccounts
    account.activeChart = data.chartOfAccounts
  }
  if (profileChanging) {
    const issues = [...validateCompanyProfile(data.companyProfile), ...validateChartActivation(data.companyProfile?.chart, account.activeChart, availableImportedCharts)]
    if (issues.length) throw new CompanyProfileValidationError(issues.join('; '))
    account.companyProfile = structuredClone(data.companyProfile)
    account.activeChart = data.companyProfile.chart
    if (data.companyProfile.chart === 'SKR03' || data.companyProfile.chart === 'SKR04') account.chartOfAccounts = data.companyProfile.chart
  }
  const effectiveFrom = data.companyProfileEffectiveFrom
  const reason = data.changeReason
  if (profileVersionWrite) {
    const profileIssues = validateCompanyProfile(data.companyProfile)
    const profileDateIssues = validateProfileVersions([{ id: 'candidate', ownerId, effectiveFrom, profile: data.companyProfile, actorId, reason }])
    const liveDateIssues = validateLiveEffectiveDate(effectiveFrom)
    if (profileIssues.length || profileDateIssues.length || liveDateIssues.length || typeof reason !== 'string' || !reason.trim()) throw new CompanyProfileValidationError([...profileIssues, ...profileDateIssues, ...liveDateIssues, ...((typeof reason !== 'string' || !reason.trim()) ? ['Company profile change reason is required'] : [])].join('; '))
  }
  const activatedChart = data.companyProfile?.chart ?? data.chartOfAccounts ?? account.activeChart
  const today = new Date().toISOString().slice(0, 10)
  const chartEffectiveFrom = effectiveFrom ?? data.chartEffectiveFrom ?? today
  if (data.chartOfAccounts !== undefined) {
    const chartDateIssues = [...validateEffectiveDate(chartEffectiveFrom), ...validateLiveEffectiveDate(chartEffectiveFrom, today)]
    if (chartDateIssues.length) throw new CompanyProfileValidationError(chartDateIssues.join('; '))
  }
  const activationDateValue = profileChanging ? effectiveFrom : data.chartOfAccounts !== undefined ? chartEffectiveFrom : mappingEffectiveFrom ?? today
  const activationDate = new Date(`${activationDateValue}T00:00:00.000Z`)
  await prisma.$transaction(async transaction => {
    await transaction.$executeRaw`UPDATE AccountRecord SET id = id WHERE id = ${account.id}`
    const currentSettings = await transaction.accountRecord.findUniqueOrThrow({ where: { id: account.id }, select: { payload: true } })
    validateSettingsSnapshot(originalPayload, currentSettings.payload)
    let importedCohortCreated = false
    if (importedChart) {
      const cohortDate = new Date(`${mappingEffectiveFrom}T00:00:00.000Z`)
      const existingRows = await transaction.accountMappingVersion.findMany({ where: { ownerId, chartId: importedChart.id, effectiveFrom: cohortDate } })
      const existingMappings: AccountMapping[] = existingRows.map(existing => ({ accountNumber: existing.accountNumber, name: existing.accountName, accountType: existing.accountType as AccountMapping['accountType'], normalBalance: existing.normalBalance as AccountMapping['normalBalance'], hgbPosition: existing.hgbPosition, eBilanzPosition: existing.eBilanzPosition, vatCode: existing.vatCode ?? undefined, active: existing.active }))
      const candidates = importedChart.mappings.map(mapping => ({ ...mapping, active: mapping.active !== false }))
      if (existingRows.length && !isIdempotentMappingCohort(existingMappings, candidates)) throw new CompanyProfileValidationError('A different mapping cohort already exists for this chart and effective date')
      if (!existingRows.length) {
        importedCohortCreated = true
        for (const mapping of importedChart.mappings) await transaction.accountMappingVersion.create({ data: { ownerId, chartId: importedChart.id, accountNumber: mapping.accountNumber, effectiveFrom: cohortDate, accountName: mapping.name, accountType: mapping.accountType, normalBalance: mapping.normalBalance, hgbPosition: mapping.hgbPosition, eBilanzPosition: mapping.eBilanzPosition, vatCode: mapping.vatCode ?? null, active: mapping.active !== false } })
      }
    }
    let currentLedgerProfile = await transaction.ledgerProfile.findUnique({ where: { ownerId } })
    if (!currentLedgerProfile) {
      const existingAccounts = await transaction.ledgerAccount.findMany({ where: { ownerId }, select: { number: true } })
      const hasPostedEntries = await transaction.journalEntry.count({ where: { fiscalYear: { ownerId } } }) > 0
      try {
        const inferredProfile = requireLegacyLedgerProfile(existingAccounts.map(item => item.number), hasPostedEntries)
        if (inferredProfile) currentLedgerProfile = await transaction.ledgerProfile.create({ data: { ownerId, ...inferredProfile } })
      } catch (error) {
        throw new CompanyProfileValidationError(error instanceof Error ? error.message : 'Existing ledger profile is ambiguous')
      }
    }
    await transaction.$executeRaw`UPDATE LedgerProfile SET ownerId = ownerId WHERE ownerId = ${ownerId}`
    const explicitlyChangesChart = profileChanging || data.chartOfAccounts !== undefined
    const targetChart = resolveTargetChart(explicitlyChangesChart ? activatedChart : undefined, profileChanging, currentLedgerProfile?.chart, account.activeChart)
    const switchingChart = currentLedgerProfile?.chart !== targetChart
    const revisesActiveChart = shouldGuardActiveRevision(Boolean(importedChart && importedChart.id === currentLedgerProfile?.chart), importedCohortCreated)
    const activatesRevisionNow = revisesActiveChart && mappingEffectiveFrom <= today
    const scheduleIssues = validateActiveRevisionEffectiveDate(revisesActiveChart, mappingEffectiveFrom, today)
    if (scheduleIssues.length) throw new CompanyProfileValidationError(scheduleIssues.join('; '))
    if (switchingChart || revisesActiveChart) {
      const hasPostedEntries = await transaction.journalEntry.count({ where: { fiscalYear: { ownerId } } }) > 0
      const switchIssues = validateChartSwitch(hasPostedEntries, currentLedgerProfile?.chart, targetChart)
      const revisionIssues = validateActiveChartRevision(hasPostedEntries, revisesActiveChart)
      if (switchIssues.length || revisionIssues.length) throw new CompanyProfileValidationError([...switchIssues, ...revisionIssues].join('; '))
    }
    if (switchingChart || activatesRevisionNow) {
      let activatedMappings: AccountMapping[]
      if (targetChart === 'SKR03' || targetChart === 'SKR04') {
        activatedMappings = scaleMappingsForAccountLength(seedChart(targetChart), currentLedgerProfile?.accountLength)
        const versionDate = new Date(`${effectiveFrom ?? new Date().toISOString().slice(0, 10)}T00:00:00.000Z`)
        for (const mapping of activatedMappings) await transaction.accountMappingVersion.upsert({ where: { ownerId_chartId_accountNumber_effectiveFrom: { ownerId, chartId: targetChart, accountNumber: mapping.accountNumber, effectiveFrom: versionDate } }, create: { ownerId, chartId: targetChart, accountNumber: mapping.accountNumber, effectiveFrom: versionDate, accountName: mapping.name, accountType: mapping.accountType, normalBalance: mapping.normalBalance, hgbPosition: mapping.hgbPosition, eBilanzPosition: mapping.eBilanzPosition, vatCode: mapping.vatCode ?? null, active: mapping.active !== false }, update: {} })
      } else {
        const latest = await transaction.accountMappingVersion.findFirst({ where: { ownerId, chartId: targetChart, effectiveFrom: { lte: activationDate }, OR: [{ effectiveTo: null }, { effectiveTo: { gte: activationDate } }] }, orderBy: { effectiveFrom: 'desc' }, select: { effectiveFrom: true } })
        const rows = latest ? await transaction.accountMappingVersion.findMany({ where: { ownerId, chartId: targetChart, effectiveFrom: latest.effectiveFrom, OR: [{ effectiveTo: null }, { effectiveTo: { gte: activationDate } }] } }) : []
        activatedMappings = rows.filter(row => row.active).map(row => ({ accountNumber: row.accountNumber, name: row.accountName, accountType: row.accountType as AccountMapping['accountType'], normalBalance: row.normalBalance as AccountMapping['normalBalance'], hgbPosition: row.hgbPosition, eBilanzPosition: row.eBilanzPosition, vatCode: row.vatCode ?? undefined, active: true }))
      }
      if (!activatedMappings.length) throw new CompanyProfileValidationError('Activated chart has no persisted mappings')
      await transaction.ledgerAccount.updateMany({ where: { ownerId }, data: { active: false } })
      for (const mapping of activatedMappings) await transaction.ledgerAccount.upsert({ where: { ownerId_number: { ownerId, number: mapping.accountNumber } }, create: { ownerId, number: mapping.accountNumber, name: mapping.name, category: mapping.accountType, eBilanzPosition: mapping.eBilanzPosition, active: mapping.active !== false }, update: { name: mapping.name, category: mapping.accountType, eBilanzPosition: mapping.eBilanzPosition, active: mapping.active !== false } })
    }
    await transaction.ledgerProfile.upsert({ where: { ownerId }, create: { ownerId, chart: targetChart, accountLength: 4 }, update: { chart: targetChart } })
    if (!explicitlyChangesChart) {
      account.activeChart = targetChart as typeof account.activeChart
      if (targetChart === 'SKR03' || targetChart === 'SKR04') account.chartOfAccounts = targetChart
    }
    if (profileVersionWrite) {
      const versionKey = { ownerId_effectiveFrom: { ownerId, effectiveFrom: new Date(`${effectiveFrom}T00:00:00.000Z`) } }
      const candidate = { payload: JSON.stringify(data.companyProfile), createdBy: actorId, reason: reason.trim() }
      const existing = await transaction.companyProfileVersion.findUnique({ where: versionKey })
      if (existing && !isIdempotentProfileRetry(existing, candidate)) throw new CompanyProfileValidationError('A different company profile version already exists for this effective date')
      if (!existing) await transaction.companyProfileVersion.create({ data: { ownerId, effectiveFrom: versionKey.ownerId_effectiveFrom.effectiveFrom, ...candidate } })
    }
    const canonicalImportedCharts = await transaction.accountMappingVersion.findMany({ where: { ownerId, chartId: { startsWith: 'CUSTOM:' } }, select: { chartId: true }, distinct: ['chartId'] })
    account.importedCharts = [...new Set([...account.importedCharts, ...canonicalImportedCharts.map(item => item.chartId)])]
    const payload = JSON.stringify(account)
    await transaction.accountRecord.upsert({ where: { id: account.id }, create: { id: account.id, ownerId, payload }, update: { ownerId, payload } })
  })
}

export async function createDocument(input: DocumentFileInput, ownerId: string): Promise<Document> {
  validateDocumentFile(input)

  const id = randomUUID()
  const storageKey = `documents/${ encodeURIComponent(ownerId) }/${ id }.pdf`
  const fileName = sanitizeFileName(input.fileName)
  const contentType = 'application/pdf'
  const storage = getDocumentStorage()

  await storage.write(storageKey, input.content, { contentType, fileName })
  const candidateThumbnailStorageKey = `documents/${ encodeURIComponent(ownerId) }/${ id }.webp`
  let thumbnailStorageKey: string | undefined

  try {
    const thumbnail = await generateDocumentThumbnail(input.content)
    await storage.write(candidateThumbnailStorageKey, thumbnail, {
      contentType: 'image/webp',
      fileName: `${ fileName.replace(/\.pdf$/i, '') }.webp`,
    })
    thumbnailStorageKey = candidateThumbnailStorageKey
  } catch {
    await storage.delete(candidateThumbnailStorageKey).catch(() => undefined)
    thumbnailStorageKey = undefined
  }

  try {
    const document = new Document(
      id,
      `/api/documents/${ id }/file`,
      storageKey,
      fileName,
      contentType,
      input.content.length,
      ownerId,
      thumbnailStorageKey,
      thumbnailStorageKey ? `/api/documents/${ id }/thumbnail` : undefined,
    )
    await persistence.documents.save(document)
    return toPublicDocument(document)
  } catch (error) {
    await storage.delete(storageKey).catch(() => undefined)
    if (thumbnailStorageKey) await storage.delete(thumbnailStorageKey).catch(() => undefined)
    throw error
  }
}

export async function listDocuments(ownerId: string): Promise<Document[]> {
  return (await persistence.documents.findAllByOwner(ownerId)).map(toPublicDocument)
}

function toPublicDocument(document: Document): Document {
  return new Document(
    document.id,
    document.url,
    undefined,
    document.fileName,
    document.contentType,
    document.size,
    undefined,
    undefined,
    document.thumbnailStorageKey ? `/api/documents/${ document.id }/thumbnail` : undefined,
  )
}

export async function readDocumentFile(documentId: string, ownerId: string): Promise<{
  content: Buffer
  contentType: string
  fileName: string
} | null> {
  const document = await persistence.documents.findOne(documentId)
  if (!document?.storageKey || document.ownerId !== ownerId) return null

  const storage = getDocumentStorage()
  if (!await storage.exists(document.storageKey)) return null

  return {
    content: await storage.read(document.storageKey),
    contentType: document.contentType || 'application/octet-stream',
    fileName: document.fileName || `${ document.id }.pdf`,
  }
}

export async function readDocumentThumbnail(documentId: string, ownerId: string): Promise<{
  content: Buffer
  contentType: string
} | null> {
  const document = await persistence.documents.findOne(documentId)
  if (!document?.thumbnailStorageKey || document.ownerId !== ownerId) return null

  const storage = getDocumentStorage()
  if (!await storage.exists(document.thumbnailStorageKey)) return null

  return {
    content: await storage.read(document.thumbnailStorageKey),
    contentType: 'image/webp',
  }
}

export async function requestDocumentParsing(
  documentId: string,
  ownerId: string,
): Promise<Invoice | null> {
  const document = await persistence.documents.findOne(documentId)

  if (!document?.storageKey || document.ownerId !== ownerId) return null

  const invoice = document as Invoice
  invoice.netAmount = getMoneyValue(fixture, 'net_amount')!
  invoice.tax = new TaxAmount(
    getTaxAmount(fixture)!,
    new Tax('19% VAT', 0.19),
  )
  invoice.total = getMoneyValue(fixture, 'total_amount')!
  await persistence.documents.save(invoice)
  return invoice
}

export function getMaxDocumentUploadBytes(): number {
  const maxSize = Number(process.env.DOCUMENT_STORAGE_MAX_UPLOAD_BYTES || 20 * 1024 * 1024)
  if (!Number.isSafeInteger(maxSize) || maxSize <= 0) {
    throw new Error('DOCUMENT_STORAGE_MAX_UPLOAD_BYTES must be a positive integer')
  }
  return maxSize
}

function validateDocumentFile({ content, contentType, fileName }: DocumentFileInput): void {
  const maxSize = getMaxDocumentUploadBytes()
  if (content.length === 0) throw new DocumentUploadError('The document is empty')
  if (content.length > maxSize) {
    throw new DocumentUploadError(`The document exceeds ${ maxSize } bytes`)
  }
  if (!fileName.toLowerCase().endsWith('.pdf')) {
    throw new DocumentUploadError('Only PDF documents are supported')
  }
  if (contentType.split(';', 1)[0].trim() !== 'application/pdf') {
    throw new DocumentUploadError('Only PDF documents are supported')
  }
  if (content.subarray(0, 5).toString('ascii') !== '%PDF-') {
    throw new DocumentUploadError('The uploaded file is not a valid PDF document')
  }
}

function sanitizeFileName(fileName: string): string {
  const sanitized = fileName.replace(/[^a-zA-Z0-9._ -]/g, '_').slice(0, 200)
  return sanitized.toLowerCase().endsWith('.pdf') ? sanitized : `${ sanitized }.pdf`
}

export class DocumentUploadError extends Error {}

function getTaxAmount(data: any): number | null {
  const tax = getObjectWithType(data.entities, 'vat')
  const taxAmount = tax && getObjectWithType(tax.properties, 'vat/tax_amount')
  return taxAmount ? normalizedMoneyValue(taxAmount) : null
}

function getMoneyValue(data: any, type: string): number | null {
  const entity = getObjectWithType(data.entities, type)
  return entity ? normalizedMoneyValue(entity) : null
}

function getObjectWithType(items: any[], type: string): any | null {
  return items.find((item: any) => item.type === type) ?? null
}

function normalizedMoneyValue(entity: any): number {
  const { units, nanos = 0 } = entity.normalizedValue.moneyValue
  return Number(units) + Number(nanos) / 1_000_000_000
}
