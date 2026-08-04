import 'server-only'

import { createHash } from 'node:crypto'
import { applyAssetEvents, type AssetEvent } from '@/core/compliance/assetsInventory'
import { createMonthlyDepreciationSchedule, fixedAssetFullRetirementFacts, fixedAssetFullSaleFacts, scheduledDepreciationForPeriod, type RegisteredFixedAsset } from '@/core/fixedAssets'
import type { VatPostingDetail } from '@/core/vatEngine'
import { appendAuditEvent } from '@/server/compliance/auditPersistence'
import { commercialDocumentIdentity } from '@/server/commercialAccountingRepository'
import { prisma } from '@/server/persistence/client'
import { journalLineVatData, vatPostingCreateData, withCalculatedOriginalVatPostings } from '@/server/tax/vatPostingCalculation'

export class FixedAssetError extends Error {
  constructor(message: string, readonly status = 400) { super(message) }
}

export type CreateFixedAssetInput = {
  requestKey: string
  description: string; costCents: number; acquisitionDate: string; availableForUseDate: string; location: string; usefulLifeMonths: number
  assetAccountId: string; depreciationExpenseAccountId: string; sourceDocumentId: string; acquisitionJournalLineId: string; method?: string; taxMethod?: string; taxUsefulLifeMonths?: number
}

export async function getFixedAssetWorkspace(ownerId: string) {
  const [records, eventRecords, accounts, documents, acquisitionLines, customers] = await Promise.all([
    prisma.fixedAssetRecord.findMany({ where: { ownerId }, orderBy: { createdAt: 'asc' } }),
    prisma.assetEventRecord.findMany({ where: { ownerId }, orderBy: [{ assetId: 'asc' }, { sequence: 'asc' }] }),
    prisma.ledgerAccount.findMany({ where: { ownerId, active: true, category: { in: ['ASSET', 'EXPENSE', 'REVENUE', 'LIABILITY'] } }, select: { id: true, number: true, name: true, category: true }, orderBy: { number: 'asc' } }),
    prisma.documentRecord.findMany({ where: { ownerId }, select: { id: true, payload: true }, orderBy: { id: 'asc' } }),
    prisma.journalLine.findMany({ where: { debitCents: { gt: 0 }, creditCents: 0, account: { ownerId, active: true, category: 'ASSET' }, journalEntry: { ownerId, state: 'POSTED' } }, include: { account: { select: { number: true, name: true } }, journalEntry: { select: { id: true, bookingDate: true, documentNumber: true, description: true, documents: { select: { documentId: true } } } } }, orderBy: { journalEntry: { bookingDate: 'desc' } } }),
    prisma.businessPartner.findMany({ where: { ownerId, active: true, role: { in: ['CUSTOMER', 'BOTH'] } }, select: { id: true, partnerNumber: true, name: true, countryCode: true, paymentTermDays: true }, orderBy: [{ name: 'asc' }, { partnerNumber: 'asc' }] }),
  ])
  const events = eventRecords.map(record => parseEvent(record.payload))
  return {
    assets: records.map(record => { const asset = parseAsset(record.payload); const assetEvents = events.filter(event => event.assetId === asset.id); const disposal = assetEvents.find(event => event.type === 'DISPOSAL') as PersistedDisposalEvent | PersistedSaleEvent | undefined; const through = assetEvents.reduce((latest, event) => event.effectiveDate > latest ? event.effectiveDate : latest, asset.acquisitionDate); const lifecycle = applyAssetEvents(asset, assetEvents, through); return { ...asset, schedule: createMonthlyDepreciationSchedule(asset, assetEvents), events: assetEvents, lifecycle: { disposed: lifecycle.disposed, disposedOn: disposal?.effectiveDate ?? null, disposalKind: disposal && 'disposalKind' in disposal ? disposal.disposalKind : disposal ? 'RETIREMENT' : null, carryingAmountCents: lifecycle.bookValueCents, ...((disposal && 'netProceedsCents' in disposal) ? { netProceedsCents: disposal.netProceedsCents, outputVatCents: disposal.outputVatCents, gainLossCents: disposal.gainLossCents, result: disposal.result } : {}) } } }),
    accounts,
    documents: documents.map(document => { const payload = safePayload(document.payload); return { id: document.id, fileName: typeof payload.fileName === 'string' ? payload.fileName : document.id } }),
    acquisitionCandidates: acquisitionLines.filter(line => !records.some(record => record.acquisitionJournalLineId === line.id)).map(line => ({ id: line.id, journalEntryId: line.journalEntry.id, bookingDate: line.journalEntry.bookingDate.toISOString().slice(0, 10), documentNumber: line.journalEntry.documentNumber, description: line.journalEntry.description, debitCents: line.debitCents, accountId: line.accountId, accountNumber: line.account.number, accountName: line.account.name, documentIds: line.journalEntry.documents.map(document => document.documentId) })),
    customers,
  }
}

export async function createFixedAsset(ownerId: string, actorId: string, input: CreateFixedAssetInput) {
  required(ownerId, 'ownerId'); required(actorId, 'actorId')
  const requestKey = required(input.requestKey, 'Registration request key')
  if (!/^[A-Za-z0-9._:-]{16,100}$/.test(requestKey)) throw new FixedAssetError('Registration request key must contain 16-100 safe characters.')
  const id = `asset-${hash(`${ownerId}:${requestKey}`)}`
  const method = input.method ?? 'STRAIGHT_LINE'; const taxMethod = input.taxMethod ?? 'STRAIGHT_LINE'
  const assetFacts: RegisteredFixedAsset = {
    id, tenantId: ownerId, description: required(input.description, 'Description'), costCents: cents(input.costCents, 'Acquisition cost'),
    acquisitionDate: dateOnly(input.acquisitionDate, 'Acquisition date'), availableForUseDate: dateOnly(input.availableForUseDate, 'Available-for-use date'), location: required(input.location, 'Location'),
    usefulLifeMonths: positiveInteger(input.usefulLifeMonths, 'Useful life'), method: method as RegisteredFixedAsset['method'], taxUsefulLifeMonths: input.taxUsefulLifeMonths ?? input.usefulLifeMonths, taxMethod: taxMethod as RegisteredFixedAsset['taxMethod'],
    evidenceIds: [required(input.sourceDocumentId, 'Source document')], sourceDocumentId: input.sourceDocumentId, acquisitionJournalLineId: required(input.acquisitionJournalLineId, 'Acquisition journal line'), assetAccountId: required(input.assetAccountId, 'Asset account'), depreciationExpenseAccountId: required(input.depreciationExpenseAccountId, 'Depreciation expense account'),
  }
  const registrationRequestHash = createHash('sha256').update(JSON.stringify(assetFacts)).digest('hex')
  const asset: RegisteredFixedAsset = { ...assetFacts, registrationRequestKey: requestKey, registrationRequestHash }
  createMonthlyDepreciationSchedule(asset)
  const run = () => prisma.$transaction(async transaction => {
    const existing = await transaction.fixedAssetRecord.findUnique({ where: { id } })
    if (existing) {
      if (existing.ownerId !== ownerId) throw new FixedAssetError('The registration request key is unavailable.', 409)
      const prior = parseAsset(existing.payload)
      if (prior.registrationRequestHash !== registrationRequestHash) throw new FixedAssetError('The registration request key was already used with different acquisition facts.', 409)
      return { ...prior, schedule: createMonthlyDepreciationSchedule(prior, []), events: [], createdAt: existing.createdAt.toISOString() }
    }
    const [document, assetAccount, expenseAccount, acquisitionLine, priorLineUse] = await Promise.all([
      transaction.documentRecord.findFirst({ where: { ownerId, id: asset.sourceDocumentId } }),
      transaction.ledgerAccount.findFirst({ where: { ownerId, id: asset.assetAccountId, active: true, category: 'ASSET' } }),
      transaction.ledgerAccount.findFirst({ where: { ownerId, id: asset.depreciationExpenseAccountId, active: true, category: 'EXPENSE' } }),
      transaction.journalLine.findFirst({ where: { id: asset.acquisitionJournalLineId, journalEntry: { ownerId, state: 'POSTED' } }, include: { account: true, journalEntry: { include: { documents: true } } } }),
      transaction.fixedAssetRecord.findFirst({ where: { acquisitionJournalLineId: asset.acquisitionJournalLineId } }),
    ])
    if (!document) throw new FixedAssetError('The acquisition evidence document does not belong to this tenant.', 409)
    if (!assetAccount || !expenseAccount || assetAccount.id === expenseAccount.id) throw new FixedAssetError('Active tenant asset and depreciation-expense accounts are required.', 409)
    if (!acquisitionLine || acquisitionLine.account.ownerId !== ownerId) throw new FixedAssetError('The acquisition journal line must belong to a posted tenant journal entry.', 409)
    if (acquisitionLine.accountId !== asset.assetAccountId || acquisitionLine.account.category !== 'ASSET' || acquisitionLine.creditCents !== 0 || acquisitionLine.debitCents !== asset.costCents) throw new FixedAssetError('The acquisition journal line must debit the selected asset account for the exact acquisition cost.', 409)
    if (!acquisitionLine.journalEntry.documents.some(attachment => attachment.documentId === asset.sourceDocumentId)) throw new FixedAssetError('The acquisition journal entry must be linked to the selected acquisition evidence.', 409)
    if (acquisitionLine.journalEntry.bookingDate.toISOString().slice(0, 10) !== asset.acquisitionDate) throw new FixedAssetError('The acquisition journal booking date must match the acquisition date.', 409)
    if (priorLineUse) throw new FixedAssetError('The acquisition journal line is already assigned to another fixed asset.', 409)
    const created = await transaction.fixedAssetRecord.create({ data: { id, ownerId, payload: JSON.stringify(asset), acquisitionJournalLineId: asset.acquisitionJournalLineId, createdBy: actorId } })
    await appendAuditEvent(transaction, { ownerId, actorId, action: 'FIXED_ASSET_REGISTERED', reason: 'Evidenced fixed-asset acquisition registered', objectType: 'FixedAssetRecord', objectId: id, after: asset })
    return { ...asset, schedule: createMonthlyDepreciationSchedule(asset), events: [], createdAt: created.createdAt.toISOString() }
  })
  try { return await run() }
  catch (error) {
    if (!(error && typeof error === 'object' && 'code' in error && error.code === 'P2002')) throw error
    const winner = await prisma.fixedAssetRecord.findUnique({ where: { id } })
    if (!winner || winner.ownerId !== ownerId) throw error
    const prior = parseAsset(winner.payload)
    if (prior.registrationRequestHash !== registrationRequestHash) throw new FixedAssetError('The registration request key was already used with different acquisition facts.', 409)
    return { ...prior, schedule: createMonthlyDepreciationSchedule(prior, []), events: [], createdAt: winner.createdAt.toISOString() }
  }
}

export async function postFixedAssetDepreciation(ownerId: string, actorId: string, assetId: string, period: string, reason: string) {
  required(reason, 'Posting reason')
  const run = () => prisma.$transaction(async transaction => {
    const record = await transaction.fixedAssetRecord.findFirst({ where: { ownerId, id: assetId } })
    if (!record) throw new FixedAssetError('The fixed asset does not belong to this tenant.', 404)
    await transaction.fixedAssetRecord.update({ where: { id: record.id }, data: { payload: record.payload } })
    const asset = parseAsset(record.payload)
    const eventRecords = await transaction.assetEventRecord.findMany({ where: { ownerId, assetId }, orderBy: { sequence: 'asc' } })
    const events = eventRecords.map(row => parseEvent(row.payload))
    if (events.some(event => event.type === 'DISPOSAL')) throw new FixedAssetError('No depreciation posting is allowed after full retirement.', 409)
    const active = events.find(event => event.type === 'DEPRECIATION' && event.effectiveDate.startsWith(period) && !events.some(candidate => candidate.type === 'REVERSAL' && candidate.reversesEventId === event.id))
    if (active) return eventResult(active, await transaction.journalEntry.findFirstOrThrow({ where: { ownerId, id: active.postingId }, include: { lines: { include: { account: true } }, documents: true } }))
    const scheduled = scheduledDepreciationForPeriod(asset, period)
    const effectiveDate = new Date(`${scheduled.postingDate}T00:00:00.000Z`)
    const fiscalYear = await uniqueOpenPeriod(transaction, ownerId, effectiveDate)
    const [assetAccount, expenseAccount] = await Promise.all([
      transaction.ledgerAccount.findFirst({ where: { ownerId, id: asset.assetAccountId, active: true, category: 'ASSET' } }),
      transaction.ledgerAccount.findFirst({ where: { ownerId, id: asset.depreciationExpenseAccountId, active: true, category: 'EXPENSE' } }),
    ])
    if (!assetAccount || !expenseAccount) throw new FixedAssetError('The configured active depreciation accounts are unavailable.', 409)
    const generation = events.filter(event => event.type === 'DEPRECIATION' && event.effectiveDate.startsWith(period)).length + 1
    const key = hash(`${ownerId}:${assetId}:${period}:${generation}`); const eventId = `asset-depr-${key}`
    const sequence = (eventRecords.at(-1)?.sequence ?? 0) + 1
    const event: AssetEvent = { id: eventId, assetId, sequence, type: 'DEPRECIATION', effectiveDate: scheduled.postingDate, amountCents: scheduled.amountCents, bookAmountCents: scheduled.amountCents, taxAmountCents: scheduled.amountCents, approvedBy: actorId, approvedAt: new Date().toISOString(), postingId: `asset-journal-${key}`, evidenceIds: [asset.sourceDocumentId] }
    applyAssetEvents(asset, [...events, event], scheduled.postingDate)
    const last = await transaction.journalEntry.findFirst({ where: { fiscalYearId: fiscalYear.id }, orderBy: { sequenceNumber: 'desc' }, select: { sequenceNumber: true } })
    const journal = await transaction.journalEntry.create({ data: {
      id: event.postingId, ownerId, fiscalYearId: fiscalYear.id, sequenceNumber: (last?.sequenceNumber ?? 0) + 1, bookingDate: effectiveDate, documentNumber: `AFA-${period.replace('-', '')}-${key.slice(0, 8).toUpperCase()}`,
      description: `Monthly depreciation: ${asset.description}`, source: 'FIXED_ASSET', externalKey: `FIXED-ASSET-DEPRECIATION:${key}`,
      lines: { create: [{ accountId: expenseAccount.id, debitCents: scheduled.amountCents }, { accountId: assetAccount.id, creditCents: scheduled.amountCents }] }, documents: { create: { documentId: asset.sourceDocumentId } },
    }, include: { lines: { include: { account: true } }, documents: true } })
    await transaction.assetEventRecord.create({ data: { id: event.id, ownerId, assetId, sequence, payload: JSON.stringify(event), postingId: journal.id, approvedBy: actorId, approvedAt: new Date(event.approvedAt) } })
    await appendAuditEvent(transaction, { ownerId, actorId, action: 'FIXED_ASSET_DEPRECIATION_POSTED', reason, objectType: 'AssetEventRecord', objectId: event.id, after: event })
    return eventResult(event, journal)
  })
  try { return await run() } catch (error) { return concurrencyWinner(error, ownerId, assetId, period, run) }
}

export async function reverseFixedAssetDepreciation(ownerId: string, actorId: string, assetId: string, eventId: string, effectiveDateValue: string, reason: string) {
  required(reason, 'Reversal reason'); const effectiveDate = new Date(`${dateOnly(effectiveDateValue, 'Reversal date')}T00:00:00.000Z`)
  const run = () => prisma.$transaction(async transaction => {
    const record = await transaction.fixedAssetRecord.findFirst({ where: { ownerId, id: assetId } })
    if (!record) throw new FixedAssetError('The fixed asset does not belong to this tenant.', 404)
    await transaction.fixedAssetRecord.update({ where: { id: record.id }, data: { payload: record.payload } })
    const eventRecords = await transaction.assetEventRecord.findMany({ where: { ownerId, assetId }, orderBy: { sequence: 'asc' } }); const events = eventRecords.map(row => parseEvent(row.payload))
    if (events.some(event => event.type === 'DISPOSAL')) throw new FixedAssetError('No depreciation correction is allowed after full retirement.', 409)
    const target = events.find(event => event.id === eventId && event.type === 'DEPRECIATION')
    if (!target) throw new FixedAssetError('The depreciation event does not belong to this asset.', 404)
    const existing = events.find(event => event.type === 'REVERSAL' && event.reversesEventId === eventId)
    if (existing) return eventResult(existing, await transaction.journalEntry.findFirstOrThrow({ where: { ownerId, id: existing.postingId }, include: { lines: { include: { account: true } }, documents: true } }))
    if (effectiveDate < new Date(`${target.effectiveDate}T00:00:00.000Z`)) throw new FixedAssetError('A reversal cannot predate the original depreciation.')
    const fiscalYear = await uniqueOpenPeriod(transaction, ownerId, effectiveDate)
    const originalJournal = await transaction.journalEntry.findFirst({ where: { ownerId, id: target.postingId }, include: { lines: true } })
    if (!originalJournal) throw new FixedAssetError('The original depreciation journal is unavailable.', 409)
    const key = hash(`${ownerId}:${assetId}:reverse:${eventId}`); const sequence = (eventRecords.at(-1)?.sequence ?? 0) + 1
    const reversal: AssetEvent = { id: `asset-reversal-${key}`, assetId, sequence, type: 'REVERSAL', effectiveDate: effectiveDateValue, amountCents: target.amountCents, bookAmountCents: target.bookAmountCents ?? target.amountCents, taxAmountCents: target.taxAmountCents ?? target.amountCents, reversesEventId: target.id, approvedBy: actorId, approvedAt: new Date().toISOString(), postingId: `asset-journal-reversal-${key}`, evidenceIds: target.evidenceIds }
    applyAssetEvents(parseAsset(record.payload), [...events, reversal], effectiveDateValue)
    const last = await transaction.journalEntry.findFirst({ where: { fiscalYearId: fiscalYear.id }, orderBy: { sequenceNumber: 'desc' }, select: { sequenceNumber: true } })
    const journal = await transaction.journalEntry.create({ data: { id: reversal.postingId, ownerId, fiscalYearId: fiscalYear.id, sequenceNumber: (last?.sequenceNumber ?? 0) + 1, bookingDate: effectiveDate, documentNumber: `AFA-STORNO-${key.slice(0, 8).toUpperCase()}`, description: `Reversal: ${originalJournal.description}`, source: 'FIXED_ASSET_REVERSAL', externalKey: `FIXED-ASSET-REVERSAL:${key}`, reversalOfId: originalJournal.id, lines: { create: originalJournal.lines.map(line => ({ accountId: line.accountId, debitCents: line.creditCents, creditCents: line.debitCents })) }, documents: { create: { documentId: parseAsset(record.payload).sourceDocumentId } } }, include: { lines: { include: { account: true } }, documents: true } })
    await transaction.assetEventRecord.create({ data: { id: reversal.id, ownerId, assetId, sequence, payload: JSON.stringify(reversal), postingId: journal.id, approvedBy: actorId, approvedAt: new Date(reversal.approvedAt) } })
    await appendAuditEvent(transaction, { ownerId, actorId, action: 'FIXED_ASSET_DEPRECIATION_REVERSED', reason, objectType: 'AssetEventRecord', objectId: reversal.id, after: reversal })
    return eventResult(reversal, journal)
  })
  try { return await run() } catch (error) { return concurrencyWinner(error, ownerId, assetId, targetPeriodFallback(eventId), run, eventId) }
}

export type DisposeFixedAssetInput = { requestKey: string; effectiveDate: string; evidenceDocumentId: string; disposalExpenseAccountId: string; reason: string }
type PersistedDisposalEvent = AssetEvent & { disposalKind?: 'RETIREMENT'; requestKey: string; requestHash: string; carryingAmountCents: number; disposalExpenseAccountId: string; reason: string }
type PersistedSaleEvent = AssetEvent & { disposalKind: 'SALE'; requestKey: string; requestHash: string; carryingAmountCents: number; netProceedsCents: number; outputVatCents: number; grossProceedsCents: number; gainLossCents: number; result: 'GAIN' | 'LOSS'; businessPartnerId: string; invoiceNumber: string; receivableAccountId: string; proceedsAccountId: string; carryingValueAccountId: string; outputVatAccountId: string; reason: string }

export async function disposeFixedAsset(ownerId: string, actorId: string, assetId: string, input: DisposeFixedAssetInput) {
  required(ownerId, 'ownerId'); required(actorId, 'actorId')
  const requestKey = required(input.requestKey, 'Retirement request key')
  if (!/^[A-Za-z0-9._:-]{16,100}$/.test(requestKey)) throw new FixedAssetError('Retirement request key must contain 16-100 safe characters.')
  const effectiveDateValue = dateOnly(input.effectiveDate, 'Retirement date')
  const evidenceDocumentId = required(input.evidenceDocumentId, 'Retirement evidence')
  const disposalExpenseAccountId = required(input.disposalExpenseAccountId, 'Retirement expense account')
  const reason = required(input.reason, 'Retirement reason')
  const requestHash = createHash('sha256').update(JSON.stringify({ assetId, effectiveDate: effectiveDateValue, evidenceDocumentId, disposalExpenseAccountId, reason })).digest('hex')
  const key = hash(`${ownerId}:${assetId}:dispose:${requestKey}`); const eventId = `asset-disposal-${key}`; const postingId = `asset-journal-disposal-${key}`
  const run = () => prisma.$transaction(async transaction => {
    const record = await transaction.fixedAssetRecord.findFirst({ where: { ownerId, id: assetId } })
    if (!record) throw new FixedAssetError('The fixed asset does not belong to this tenant.', 404)
    await transaction.fixedAssetRecord.update({ where: { id: record.id }, data: { payload: record.payload } })
    const asset = parseAsset(record.payload)
    const eventRecords = await transaction.assetEventRecord.findMany({ where: { ownerId, assetId }, orderBy: { sequence: 'asc' } })
    const events = eventRecords.map(row => parseEvent(row.payload))
    const existingById = eventRecords.find(row => row.id === eventId)
    if (existingById) {
      const existing = JSON.parse(existingById.payload) as PersistedDisposalEvent
      if (existing.requestHash !== requestHash) throw new FixedAssetError('The retirement request key was already used with different facts.', 409)
      return eventResult(existing, await transaction.journalEntry.findFirstOrThrow({ where: { ownerId, id: existing.postingId }, include: { lines: { include: { account: true } }, documents: true } }))
    }
    if (events.some(event => event.type === 'DISPOSAL')) throw new FixedAssetError('The fixed asset is already retired.', 409)
    const facts = fixedAssetFullRetirementFacts(asset, events, effectiveDateValue)
    const effectiveDate = new Date(`${effectiveDateValue}T00:00:00.000Z`)
    const fiscalYear = await uniqueOpenPeriod(transaction, ownerId, effectiveDate)
    const [document, assetAccount, expenseAccount, profile] = await Promise.all([
      transaction.documentRecord.findFirst({ where: { ownerId, id: evidenceDocumentId } }),
      transaction.ledgerAccount.findFirst({ where: { ownerId, id: asset.assetAccountId, active: true, category: 'ASSET' } }),
      transaction.ledgerAccount.findFirst({ where: { ownerId, id: disposalExpenseAccountId, active: true, category: 'EXPENSE' } }),
      transaction.ledgerProfile.findUnique({ where: { ownerId } }),
    ])
    if (!document) throw new FixedAssetError('The retirement evidence document does not belong to this tenant.', 409)
    const scale = 10 ** ((profile?.accountLength ?? 4) - 4); const expectedExpenseNumber = profile?.chart === 'SKR03' ? 2310 * scale : profile?.chart === 'SKR04' ? 6895 * scale : null
    if (!assetAccount || !expenseAccount || assetAccount.id === expenseAccount.id || expectedExpenseNumber === null || expenseAccount.number !== expectedExpenseNumber) throw new FixedAssetError('The active chart-specific retirement-loss account (SKR03 2310 or SKR04 6895) is required.', 409)
    const sequence = (eventRecords.at(-1)?.sequence ?? 0) + 1; const approvedAt = new Date().toISOString()
    const event: PersistedDisposalEvent = { id: eventId, assetId, sequence, type: 'DISPOSAL', disposalKind: 'RETIREMENT', effectiveDate: effectiveDateValue, amountCents: 0, bookAmountCents: 0, taxAmountCents: 0, approvedBy: actorId, approvedAt, postingId, evidenceIds: [evidenceDocumentId], requestKey, requestHash, carryingAmountCents: facts.carryingAmountCents, disposalExpenseAccountId, reason }
    applyAssetEvents(asset, [...events, event], effectiveDateValue)
    const last = await transaction.journalEntry.findFirst({ where: { fiscalYearId: fiscalYear.id }, orderBy: { sequenceNumber: 'desc' }, select: { sequenceNumber: true } })
    const journal = await transaction.journalEntry.create({ data: {
      id: postingId, ownerId, fiscalYearId: fiscalYear.id, sequenceNumber: (last?.sequenceNumber ?? 0) + 1, bookingDate: effectiveDate,
      documentNumber: `ANL-ABG-${key.slice(0, 8).toUpperCase()}`, description: `Full retirement: ${asset.description}`, source: 'FIXED_ASSET_DISPOSAL', externalKey: `FIXED-ASSET-DISPOSAL:${key}`,
      lines: { create: [{ accountId: expenseAccount.id, debitCents: facts.carryingAmountCents }, { accountId: assetAccount.id, creditCents: facts.carryingAmountCents }] }, documents: { create: { documentId: evidenceDocumentId } },
    }, include: { lines: { include: { account: true } }, documents: true } })
    await transaction.assetEventRecord.create({ data: { id: event.id, ownerId, assetId, sequence, payload: JSON.stringify(event), postingId: journal.id, approvedBy: actorId, approvedAt: new Date(approvedAt) } })
    await appendAuditEvent(transaction, { ownerId, actorId, action: 'FIXED_ASSET_DISPOSED', reason, objectType: 'AssetEventRecord', objectId: event.id, after: event })
    return eventResult(event, journal)
  })
  try { return await run() } catch (error) {
    if (!(error && typeof error === 'object' && 'code' in error && error.code === 'P2002')) throw error
    const winner = await prisma.assetEventRecord.findFirst({ where: { ownerId, assetId, id: eventId } })
    if (!winner) throw error
    const event = JSON.parse(winner.payload) as PersistedDisposalEvent
    if (event.requestHash !== requestHash) throw new FixedAssetError('The retirement request key was already used with different facts.', 409)
    const journal = await prisma.journalEntry.findFirstOrThrow({ where: { ownerId, id: event.postingId }, include: { lines: { include: { account: true } }, documents: true } })
    return eventResult(event, journal)
  }
}

export type SellFixedAssetInput = {
  requestKey: string; effectiveDate: string; evidenceDocumentId: string; netProceedsCents: number; vatRateBasisPoints: number
  businessPartnerId: string; invoiceNumber: string; receivableAccountId: string; proceedsAccountId: string; carryingValueAccountId: string; outputVatAccountId: string; reason: string
}

export async function sellFixedAsset(ownerId: string, actorId: string, assetId: string, input: SellFixedAssetInput) {
  required(ownerId, 'ownerId'); required(actorId, 'actorId')
  const requestKey = required(input.requestKey, 'Sale request key')
  if (!/^[A-Za-z0-9._:-]{16,100}$/.test(requestKey)) throw new FixedAssetError('Sale request key must contain 16-100 safe characters.')
  const effectiveDateValue = dateOnly(input.effectiveDate, 'Sale date')
  const evidenceDocumentId = required(input.evidenceDocumentId, 'Sale evidence')
  const netProceedsCents = cents(input.netProceedsCents, 'Net sale proceeds')
  if (input.vatRateBasisPoints !== 1900) throw new FixedAssetError('The supported domestic fixed-asset sale requires the German standard 19% VAT rate.')
  const businessPartnerId = required(input.businessPartnerId, 'Customer')
  const invoiceNumber = required(input.invoiceNumber, 'Sale invoice number')
  if (invoiceNumber.length > 80) throw new FixedAssetError('Sale invoice number must not exceed 80 characters.')
  const receivableAccountId = required(input.receivableAccountId, 'Receivable account')
  const proceedsAccountId = required(input.proceedsAccountId, 'Sale-proceeds account')
  const carryingValueAccountId = required(input.carryingValueAccountId, 'Carrying-value account')
  const outputVatAccountId = required(input.outputVatAccountId, 'Output-VAT account')
  const reason = required(input.reason, 'Sale approval reason')
  const normalizedInput = { assetId, effectiveDate: effectiveDateValue, evidenceDocumentId, netProceedsCents, vatRateBasisPoints: input.vatRateBasisPoints, businessPartnerId, invoiceNumber, receivableAccountId, proceedsAccountId, carryingValueAccountId, outputVatAccountId, reason }
  const requestHash = createHash('sha256').update(JSON.stringify(normalizedInput)).digest('hex')
  const key = hash(`${ownerId}:${assetId}:sale:${requestKey}`); const eventId = `asset-sale-${key}`; const postingId = `asset-journal-sale-${key}`; const proceedsLineId = `asset-sale-proceeds-${key}`
  const replay = await prisma.assetEventRecord.findFirst({ where: { ownerId, assetId, id: eventId } })
  if (replay) return saleReplayResult(replay.payload, requestHash, await prisma.journalEntry.findFirstOrThrow({ where: { ownerId, id: replay.postingId }, include: { lines: { include: { account: true } }, documents: true } }), await prisma.commercialDocument.findFirstOrThrow({ where: { ownerId, postingJournalEntryId: replay.postingId }, include: { openItem: true, businessPartner: true } }))

  const vatSourceId = `fixed-asset-sale:${eventId}:vat`
  const persist = (vatDetails: readonly VatPostingDetail[], markers: readonly string[]) => prisma.$transaction(async transaction => {
    const record = await transaction.fixedAssetRecord.findFirst({ where: { ownerId, id: assetId } })
    if (!record) throw new FixedAssetError('The fixed asset does not belong to this tenant.', 404)
    await transaction.fixedAssetRecord.update({ where: { id: record.id }, data: { payload: record.payload } })
    const asset = parseAsset(record.payload)
    const eventRecords = await transaction.assetEventRecord.findMany({ where: { ownerId, assetId }, orderBy: { sequence: 'asc' } })
    const events = eventRecords.map(row => parseEvent(row.payload))
    if (eventRecords.some(row => row.id === eventId)) throw new FixedAssetError('The fixed-asset sale was concurrently posted; retry the identical request.', 409)
    if (events.some(event => event.type === 'DISPOSAL')) throw new FixedAssetError('The fixed asset is already disposed.', 409)
    const facts = fixedAssetFullSaleFacts(asset, events, effectiveDateValue, netProceedsCents, input.vatRateBasisPoints)
    const vat = vatDetails.length === 1 ? vatDetails[0] : undefined
    if (!vat || vat.sourceId !== vatSourceId || vat.netBaseCents !== facts.netProceedsCents || vat.taxCents !== facts.outputVatCents || vat.grossCents !== facts.grossProceedsCents || vat.ruleId !== 'DE_STANDARD') throw new FixedAssetError('The calculated fixed-asset sale VAT facts do not reconcile.', 409)
    const effectiveDate = new Date(`${effectiveDateValue}T00:00:00.000Z`)
    const fiscalYear = await uniqueOpenPeriod(transaction, ownerId, effectiveDate)
    const [document, profile, selectedAccounts, customer] = await Promise.all([
      transaction.documentRecord.findFirst({ where: { ownerId, id: evidenceDocumentId } }),
      transaction.ledgerProfile.findUnique({ where: { ownerId } }),
      transaction.ledgerAccount.findMany({ where: { ownerId, active: true, id: { in: [asset.assetAccountId, receivableAccountId, proceedsAccountId, carryingValueAccountId, outputVatAccountId] } } }),
      transaction.businessPartner.findFirst({ where: { ownerId, id: businessPartnerId, active: true, role: { in: ['CUSTOMER', 'BOTH'] } } }),
    ])
    if (!document) throw new FixedAssetError('The sale evidence document does not belong to this tenant.', 409)
    if (!customer || customer.countryCode !== 'DE') throw new FixedAssetError('The sale requires an active domestic tenant customer.', 409)
    if (!profile || !['SKR03', 'SKR04'].includes(profile.chart)) throw new FixedAssetError('An active SKR03 or SKR04 ledger profile is required for fixed-asset sale posting.', 409)
    const scale = 10 ** ((profile.accountLength ?? 4) - 4)
    const numbers = profile.chart === 'SKR03'
      ? { receivable: 1400, outputVat: 1776, gainProceeds: 8820, gainCarrying: 2315, lossProceeds: 8801, lossCarrying: 2310 }
      : { receivable: 1200, outputVat: 3806, gainProceeds: 4845, gainCarrying: 4855, lossProceeds: 6885, lossCarrying: 6895 }
    const expected = {
      receivable: numbers.receivable * scale, outputVat: numbers.outputVat * scale,
      proceeds: (facts.result === 'GAIN' ? numbers.gainProceeds : numbers.lossProceeds) * scale,
      carrying: (facts.result === 'GAIN' ? numbers.gainCarrying : numbers.lossCarrying) * scale,
    }
    const account = (id: string) => selectedAccounts.find(candidate => candidate.id === id)
    const assetAccount = account(asset.assetAccountId); const receivable = account(receivableAccountId); const proceeds = account(proceedsAccountId); const carryingValue = account(carryingValueAccountId); const outputVat = account(outputVatAccountId)
    const resultCategory = facts.result === 'GAIN' ? 'REVENUE' : 'EXPENSE'
    if (!assetAccount || assetAccount.category !== 'ASSET' || !receivable || receivable.number !== expected.receivable || receivable.category !== 'ASSET' || !outputVat || outputVat.number !== expected.outputVat || outputVat.category !== 'LIABILITY' || !proceeds || proceeds.number !== expected.proceeds || proceeds.category !== resultCategory || !carryingValue || carryingValue.number !== expected.carrying || carryingValue.category !== resultCategory || new Set([assetAccount.id, receivable.id, outputVat.id, proceeds.id, carryingValue.id]).size !== 5) throw new FixedAssetError(`The active DATEV ${profile.chart} ${facts.result === 'GAIN' ? 'book-gain' : 'book-loss'} sale accounts are required.`, 409)
    const sequence = (eventRecords.at(-1)?.sequence ?? 0) + 1; const approvedAt = new Date().toISOString()
    const event: PersistedSaleEvent = { id: eventId, assetId, sequence, type: 'DISPOSAL', disposalKind: 'SALE', effectiveDate: effectiveDateValue, amountCents: 0, bookAmountCents: 0, taxAmountCents: 0, approvedBy: actorId, approvedAt, postingId, evidenceIds: [evidenceDocumentId], requestKey, requestHash, carryingAmountCents: facts.carryingAmountCents, netProceedsCents: facts.netProceedsCents, outputVatCents: facts.outputVatCents, grossProceedsCents: facts.grossProceedsCents, gainLossCents: facts.gainLossCents, result: facts.result, businessPartnerId, invoiceNumber, receivableAccountId, proceedsAccountId, carryingValueAccountId, outputVatAccountId, reason }
    applyAssetEvents(asset, [...events, event], effectiveDateValue)
    const last = await transaction.journalEntry.findFirst({ where: { fiscalYearId: fiscalYear.id }, orderBy: { sequenceNumber: 'desc' }, select: { sequenceNumber: true } })
    const journal = await transaction.journalEntry.create({ data: {
      id: postingId, ownerId, fiscalYearId: fiscalYear.id, sequenceNumber: (last?.sequenceNumber ?? 0) + 1, bookingDate: effectiveDate,
      documentNumber: `ANL-VERK-${key.slice(0, 8).toUpperCase()}`, description: `Full asset sale: ${asset.description}`, source: 'FIXED_ASSET_SALE', externalKey: `FIXED-ASSET-SALE:${key}`,
      lines: { create: [
        { accountId: receivable.id, debitCents: facts.grossProceedsCents },
        { accountId: carryingValue.id, debitCents: facts.carryingAmountCents },
        { id: proceedsLineId, accountId: proceeds.id, creditCents: facts.netProceedsCents, ...journalLineVatData(vat) },
        { accountId: outputVat.id, creditCents: facts.outputVatCents },
        { accountId: assetAccount.id, creditCents: facts.carryingAmountCents },
      ] }, documents: { create: { documentId: evidenceDocumentId } },
    }, include: { lines: { include: { account: true } }, documents: true } })
    for (const marker of markers) await transaction.vatReversalMarker.create({ data: { ownerId, marker } })
    await transaction.vatPostingRecord.create({ data: vatPostingCreateData(ownerId, proceedsLineId, vat, evidenceDocumentId) })
    const dueDate = new Date(effectiveDate); dueDate.setUTCDate(dueDate.getUTCDate() + customer.paymentTermDays)
    const commercialDocument = await transaction.commercialDocument.create({ data: {
      id: `asset-sale-receivable-${key}`, ownerId, businessPartnerId: customer.id, evidenceDocumentId, postingJournalEntryId: journal.id,
      direction: 'RECEIVABLE', kind: 'INVOICE', status: 'POSTED', documentNumber: invoiceNumber,
      documentIdentityKey: commercialDocumentIdentity('RECEIVABLE', ownerId, invoiceNumber), issueDate: effectiveDate, serviceDate: effectiveDate, dueDate,
      description: `Full asset sale: ${asset.description}`, currency: 'EUR', netAmountCents: facts.netProceedsCents, taxAmountCents: facts.outputVatCents, grossAmountCents: facts.grossProceedsCents, payableAmountCents: facts.grossProceedsCents,
      counterpartySnapshot: JSON.stringify({ id: customer.id, partnerNumber: customer.partnerNumber, name: customer.name, countryCode: customer.countryCode, paymentTermDays: customer.paymentTermDays }),
      openItem: { create: { id: `asset-sale-open-item-${key}`, side: 'DEBIT', currency: 'EUR', originalAmountCents: facts.grossProceedsCents } },
    }, include: { openItem: true, businessPartner: true } })
    await transaction.assetEventRecord.create({ data: { id: event.id, ownerId, assetId, sequence, payload: JSON.stringify(event), postingId: journal.id, approvedBy: actorId, approvedAt: new Date(approvedAt) } })
    await appendAuditEvent(transaction, { ownerId, actorId, action: 'FIXED_ASSET_SOLD', reason, objectType: 'AssetEventRecord', objectId: event.id, after: event })
    return { ...eventResult(event, journal), commercialDocument }
  })
  try {
    return await withCalculatedOriginalVatPostings(ownerId, [{ ownerId, sourceId: vatSourceId, amountCents: netProceedsCents, mode: 'net', direction: 'sale', taxPoint: effectiveDateValue, ruleId: 'DE_STANDARD' }], persist)
  } catch (error) {
    const winner = await prisma.assetEventRecord.findFirst({ where: { ownerId, assetId, id: eventId } })
    if (!winner) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'P2002') throw new FixedAssetError('The sale invoice number is already used by another tenant receivable.', 409)
      throw error
    }
    const journal = await prisma.journalEntry.findFirstOrThrow({ where: { ownerId, id: winner.postingId }, include: { lines: { include: { account: true } }, documents: true } })
    const commercialDocument = await prisma.commercialDocument.findFirstOrThrow({ where: { ownerId, postingJournalEntryId: winner.postingId }, include: { openItem: true, businessPartner: true } })
    return saleReplayResult(winner.payload, requestHash, journal, commercialDocument)
  }
}

function saleReplayResult<T, C>(payload: string, requestHash: string, journal: T, commercialDocument: C) { const event = JSON.parse(payload) as PersistedSaleEvent; if (event.requestHash !== requestHash) throw new FixedAssetError('The sale request key was already used with different facts.', 409); return { ...eventResult(event, journal), commercialDocument } }

function parseAsset(payload: string) { const asset = JSON.parse(payload) as RegisteredFixedAsset; createMonthlyDepreciationSchedule(asset); return asset }
function parseEvent(payload: string) { return JSON.parse(payload) as AssetEvent }
function safePayload(payload: string) { try { const value: unknown = JSON.parse(payload); return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {} } catch { return {} } }
function eventResult<T>(event: AssetEvent, journal: T) { return { event, journal } }
function hash(value: string) { return createHash('sha256').update(value).digest('hex').slice(0, 24) }
function required(value: unknown, label: string) { if (typeof value !== 'string' || !value.trim()) throw new FixedAssetError(`${label} is required.`); return value.trim() }
function cents(value: unknown, label: string) { if (!Number.isSafeInteger(value) || Number(value) <= 0) throw new FixedAssetError(`${label} must be positive integer cents.`); return Number(value) }
function positiveInteger(value: unknown, label: string) { if (!Number.isSafeInteger(value) || Number(value) <= 0 || Number(value) > 1200) throw new FixedAssetError(`${label} must be between 1 and 1200 months.`); return Number(value) }
function dateOnly(value: unknown, label: string) { const text = required(value, label); const date = new Date(`${text}T00:00:00.000Z`); if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || Number.isNaN(date.valueOf()) || date.toISOString().slice(0, 10) !== text) throw new FixedAssetError(`${label} must be a valid ISO date.`); return text }
async function uniqueOpenPeriod(transaction: Parameters<Parameters<typeof prisma.$transaction>[0]>[0], ownerId: string, date: Date) { const periods = await transaction.fiscalYear.findMany({ where: { ownerId, status: 'OPEN', startsAt: { lte: date }, endsAt: { gte: date } } }); if (periods.length !== 1) throw new FixedAssetError('Exactly one open fiscal year must cover the posting date.', 409); await transaction.fiscalYear.updateMany({ where: { ownerId, id: periods[0].id, status: 'OPEN' }, data: { updatedAt: new Date() } }); return periods[0] }
async function concurrencyWinner<T>(error: unknown, ownerId: string, assetId: string, period: string, retry: () => Promise<T>, reversesEventId?: string): Promise<T> { if (!(error && typeof error === 'object' && 'code' in error && error.code === 'P2002')) throw error; const rows = await prisma.assetEventRecord.findMany({ where: { ownerId, assetId } }); const winner = rows.map(row => parseEvent(row.payload)).find(event => reversesEventId ? event.type === 'REVERSAL' && event.reversesEventId === reversesEventId : event.type === 'DEPRECIATION' && event.effectiveDate.startsWith(period)); if (!winner) return retry(); const journal = await prisma.journalEntry.findFirstOrThrow({ where: { ownerId, id: winner.postingId }, include: { lines: { include: { account: true } }, documents: true } }); return eventResult(winner, journal) as T }
function targetPeriodFallback(value: string) { return value.slice(0, 7) }
