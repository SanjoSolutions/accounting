import 'server-only'

import {
  VatValidationError,
  attachVatDocument,
  calculateVat,
  reconcileVat,
  restoreVatPosting,
  type VatPostingDetail,
  type VatSourceSplit,
} from '@/core/vatEngine'
import { prisma } from '@/server/persistence/client'
import { annualVatDataset, declarationDatasetHash, taxFormRegistry, type DeclarationDataset } from '@/core/taxDeclarations'
import { isIdempotentMappingCohort, scaleMappingsForAccountLength, seedChart, type AccountMapping } from '@/server/compliance/chartLifecycle'
import { parseIncomingEuAcquisitionAccounts, parseIncomingReverseChargeAccounts } from '@/core/incomingReverseCharge'
import { datevRecipientAssessedProfile, type DatevChart } from '@/core/datev'
import { companyProfileForPeriod } from './profileRepository'
import { isPrismaInt } from './persistenceLimits'
import { germanVatRuleBook, journalLineVatData, vatPostingCreateData, vatReversalContext, withVatOwnerLock, type VatReversalContext } from './vatPostingCalculation'

export interface PersistentVatInput extends Omit<VatSourceSplit, 'ownerId'> { journalLineId?: string; documentId?: string }

export function parsePersistentVatInput(value: unknown): PersistentVatInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new VatValidationError(['VAT posting input must be an object.'])
  const input = value as Partial<PersistentVatInput>
  if (typeof input.sourceId !== 'string' || !input.sourceId.trim() || !isPrismaInt(input.amountCents) || input.amountCents! < 0 || !['net', 'gross'].includes(input.mode ?? '') || typeof input.taxPoint !== 'string' || typeof input.ruleId !== 'string' || !input.ruleId.trim()) throw new VatValidationError(['VAT posting requires a source ID, non-negative signed-32-bit amount, mode, tax point and rule ID.'])
  if (input.direction !== undefined && !['sale', 'purchase'].includes(input.direction) || input.journalLineId !== undefined && (typeof input.journalLineId !== 'string' || !input.journalLineId.trim()) || input.documentId !== undefined && (typeof input.documentId !== 'string' || !input.documentId.trim()) || input.reversalOf !== undefined && (typeof input.reversalOf !== 'string' || !input.reversalOf.trim()) || input.originalTaxPoint !== undefined && typeof input.originalTaxPoint !== 'string') throw new VatValidationError(['VAT posting optional discriminants and link IDs are invalid.'])
  return input as PersistentVatInput
}

function sourceShape(value: VatSourceSplit) {
  return { ownerId: value.ownerId, sourceId: value.sourceId, amountCents: value.reversalOf ? Math.abs(value.amountCents) : value.amountCents, mode: value.mode, taxPoint: value.taxPoint, ruleId: value.ruleId, ...(value.direction !== undefined ? { direction: value.direction } : {}), ...(value.reversalOf !== undefined ? { reversalOf: value.reversalOf } : {}), ...(value.originalTaxPoint !== undefined ? { originalTaxPoint: value.originalTaxPoint } : {}), ...(value.customerVatId !== undefined ? { customerVatId: value.customerVatId } : {}), ...(value.customerCountry !== undefined ? { customerCountry: value.customerCountry } : {}), ...(value.customerType !== undefined ? { customerType: value.customerType } : {}), ...(value.customerVatIdValidation !== undefined ? { customerVatIdValidation: value.customerVatIdValidation } : {}), ...(value.supplyKind !== undefined ? { supplyKind: value.supplyKind } : {}), ...(value.transportEvidence !== undefined ? { transportEvidence: value.transportEvidence } : {}) }
}


async function assertLinks(ownerId: string, amountCents: number, taxPoint: string, journalLineId?: string, documentId?: string) {
  let linkedLine: { debitCents: number; creditCents: number } | undefined
  if (journalLineId) {
    const line = await prisma.journalLine.findFirst({ where: { id: journalLineId, journalEntry: { fiscalYear: { ownerId } } }, include: { journalEntry: true } })
    if (!line) throw new VatValidationError(['The journal line does not belong to this tenant.'])
    if (line.journalEntry.state === 'POSTED') throw new VatValidationError(['Tax attributes on a posted journal entry are immutable; create a traceable reversal or persist VAT detail without mutating the journal line.'])
    if (Math.abs(line.debitCents - line.creditCents) !== amountCents) throw new VatValidationError(['The VAT source amount must exactly match the linked mutable journal line amount.'])
    if (line.journalEntry.bookingDate.toISOString().slice(0, 7) !== taxPoint.slice(0, 7)) throw new VatValidationError(['The VAT tax point and linked ledger booking date must belong to the same monthly tax period.'])
    linkedLine = { debitCents: line.debitCents, creditCents: line.creditCents }
  }
  if (documentId) {
    const document = await prisma.documentRecord.findFirst({ where: { id: documentId, ownerId } })
    if (!document) throw new VatValidationError(['The VAT source document does not belong to this tenant.'])
  }
  return linkedLine
}

async function restoreExistingPosting(ownerId: string, input: PersistentVatInput, existing: { source: string; journalLineId: string | null; documentId: string | null }, context: VatReversalContext) {
  if (existing.journalLineId !== (input.journalLineId ?? null) || existing.documentId !== (input.documentId ?? null)) throw new VatValidationError(['The VAT source ID is already bound to different journal or document provenance.'])
  const candidate = JSON.parse(existing.source) as VatPostingDetail
  const requested: VatSourceSplit = { ...input, ownerId }; delete (requested as PersistentVatInput).journalLineId; delete (requested as PersistentVatInput).documentId
  if (JSON.stringify(sourceShape(candidate)) !== JSON.stringify(sourceShape(requested))) throw new VatValidationError(['The VAT source ID is already bound to a different immutable posting.'])
  let original: VatPostingDetail | undefined
  if (candidate.reversalOf) {
    const originalRow = await prisma.vatPostingRecord.findFirst({ where: { ownerId, sourceId: candidate.reversalOf } })
    if (!originalRow) throw new VatValidationError(['The immutable original VAT posting does not exist for this tenant.'])
    original = restoreVatPosting(JSON.parse(originalRow.source) as VatPostingDetail, germanVatRuleBook, context.registry)
  }
  const restored = restoreVatPosting(candidate, germanVatRuleBook, context.registry, original)
  return existing.documentId ? attachVatDocument(restored, existing.documentId) : restored
}

export async function persistVatPosting(ownerId: string, value: unknown) {
  const input = parsePersistentVatInput(value)
  return withVatOwnerLock(ownerId, async () => {
    const existing = await prisma.vatPostingRecord.findUnique({ where: { ownerId_sourceId: { ownerId, sourceId: input.sourceId } } })
    const context = await vatReversalContext(ownerId)
    if (existing) return restoreExistingPosting(ownerId, input, existing, context)
    const linkedLine = await assertLinks(ownerId, input.amountCents, input.taxPoint, input.journalLineId, input.documentId)
    context.pending = new Set()
    try {
      let original: VatPostingDetail | undefined
      if (input.reversalOf) {
        const row = await prisma.vatPostingRecord.findFirst({ where: { ownerId, sourceId: input.reversalOf } })
        if (!row) throw new VatValidationError(['The immutable original VAT posting does not exist for this tenant.'])
        original = restoreVatPosting(JSON.parse(row.source) as VatPostingDetail, germanVatRuleBook, context.registry)
      }
      const split: VatSourceSplit = { ...input, ownerId }
      delete (split as PersistentVatInput).journalLineId
      delete (split as PersistentVatInput).documentId
      const calculated = calculateVat(split, germanVatRuleBook, original, context.registry)
      const persistedAmounts = [calculated.netBaseCents, calculated.rateBasisPoints, calculated.taxCents, calculated.deductibleTaxCents, calculated.grossCents, calculated.outputTaxCents, calculated.inputTaxCents]
      if (persistedAmounts.some(amount => !isPrismaInt(amount))) throw new VatValidationError(['Calculated VAT facts exceed signed 32-bit integer storage. Split the source into smaller traceable postings.'])
      const attached = input.documentId ? attachVatDocument(calculated, input.documentId) : calculated
      const data = vatPostingCreateData(ownerId, input.journalLineId, calculated, input.documentId)
      const newMarkers = [...context.pending]
      await prisma.$transaction(async transaction => {
        await transaction.vatPostingRecord.create({ data })
        for (const marker of newMarkers) await transaction.vatReversalMarker.create({ data: { ownerId, marker } })
        if (input.journalLineId && linkedLine) {
          const updated = await transaction.journalLine.updateMany({ where: { id: input.journalLineId, debitCents: linkedLine.debitCents, creditCents: linkedLine.creditCents, journalEntry: { state: { not: 'POSTED' }, fiscalYear: { ownerId } } }, data: {
          ...journalLineVatData(calculated),
          } })
          if (updated.count !== 1) throw new VatValidationError(['The linked journal line became posted or changed before VAT attributes could be persisted.'])
        }
      })
      newMarkers.forEach(marker => context.values.add(marker)); context.pending = undefined
      return attached
    } catch (error) {
      context.pending = undefined
      if (error && typeof error === 'object' && 'code' in error && error.code === 'P2002') {
        const winner = await prisma.vatPostingRecord.findUnique({ where: { ownerId_sourceId: { ownerId, sourceId: input.sourceId } } })
        if (winner) return restoreExistingPosting(ownerId, input, winner, context)
        throw new VatValidationError(['A concurrent VAT reversal or source reservation already exists; reload the immutable posting before retrying.'])
      }
      throw error
    }
  })
}

async function restoreTenantPostings(ownerId: string, from?: string, to?: string) {
  const rows = await prisma.vatPostingRecord.findMany({ where: { ownerId } })
  const context = await vatReversalContext(ownerId)
  const bySourceId = new Map(rows.map(row => [row.sourceId, row]))
  const restored = new Map<string, VatPostingDetail>()
  const visiting = new Set<string>()
  const restoreRow = (sourceId: string): VatPostingDetail & { documentId?: string } => {
    const known = restored.get(sourceId); const row = bySourceId.get(sourceId)
    if (known) return row?.documentId ? attachVatDocument(known, row.documentId) : known
    if (!row || visiting.has(sourceId)) throw new VatValidationError(['VAT posting reversal dependencies are missing or cyclic.'])
    visiting.add(sourceId)
    const candidate = JSON.parse(row.source) as VatPostingDetail
    const original = candidate.reversalOf ? restoreRow(candidate.reversalOf) : undefined
    const posting = restoreVatPosting(candidate, germanVatRuleBook, context.registry, original)
    restored.set(posting.sourceId, posting)
    visiting.delete(sourceId)
    return row.documentId ? attachVatDocument(posting, row.documentId) : posting
  }
  return rows.filter(row => (!from || row.taxPoint >= new Date(`${from}T00:00:00.000Z`)) && (!to || row.taxPoint <= new Date(`${to}T23:59:59.999Z`))).map(row => restoreRow(row.sourceId))
}

async function reconciledTenantVat(ownerId: string, from: string, to: string) {
  const unfinished = await prisma.vatPostingRecord.count({ where: { ownerId, taxPoint: { gte: new Date(`${from}T00:00:00.000Z`), lte: new Date(`${to}T23:59:59.999Z`) }, journalLine: { journalEntry: { state: { not: 'POSTED' } } } } })
  if (unfinished) throw new VatValidationError(['Binding VAT reconciliation excludes detail linked to mutable draft journal entries.'])
  const nativeDetails = await restoreTenantPostings(ownerId, from, to)
  const { outputAccounts, inputAccounts, datevChart, accountLength } = await tenantVatControlAccounts(ownerId, from, to)
  const lines = await prisma.journalLine.findMany({ where: { journalEntry: { state: 'POSTED', fiscalYear: { ownerId }, bookingDate: { gte: new Date(`${from}T00:00:00.000Z`), lte: new Date(`${to}T23:59:59.999Z`) } }, account: { number: { in: [...outputAccounts, ...inputAccounts] } } }, include: { account: true } })
  const importedEntries = await prisma.journalEntry.findMany({ where: { ownerId, source: 'DATEV', state: 'POSTED', bookingDate: { gte: new Date(`${from}T00:00:00.000Z`), lte: new Date(`${to}T23:59:59.999Z`) } }, include: { lines: { include: { account: true, vatPosting: true } } } })
  const importedDetails = datevImportedVatDetails(ownerId, importedEntries, inputAccounts, outputAccounts, datevChart ? { chart: datevChart, accountLength } : undefined)
  const details = [...nativeDetails, ...importedDetails]
  const outputTaxCents = lines.filter(line => outputAccounts.includes(line.account.number)).reduce((sum, line) => sum + line.creditCents - line.debitCents, 0)
  const inputTaxCents = lines.filter(line => inputAccounts.includes(line.account.number)).reduce((sum, line) => sum + line.debitCents - line.creditCents, 0)
  return { details, reconciliation: reconcileVat(details, { outputTaxCents, inputTaxCents }, 0, ownerId) }
}

type DatevImportedEntry = {
  id: string; source: string; bookingDate: Date
  lines: Array<{ id: string; debitCents: number; creditCents: number; taxCode: string | null; vatPosting: unknown; account: { number: number; category: string } }>
}

/**
 * Reconstructs canonical VAT detail from immutable DATEV journal metadata.
 * The derived detail is accepted only when the official rule calculation
 * exactly reproduces the imported net, tax, and gross amounts.
 */
export function datevImportedVatDetails(ownerId: string, entries: readonly DatevImportedEntry[], inputAccounts: readonly number[], outputAccounts: readonly number[], datev?: { chart: DatevChart; accountLength: number }) {
  const definitions: Readonly<Record<string, { direction: 'purchase' | 'sale'; ruleId: 'DE_STANDARD' | 'DE_REDUCED'; rate: number }>> = {
    '9': { direction: 'purchase', ruleId: 'DE_STANDARD', rate: 1900 },
    '8': { direction: 'purchase', ruleId: 'DE_REDUCED', rate: 700 },
    '3': { direction: 'sale', ruleId: 'DE_STANDARD', rate: 1900 },
    '2': { direction: 'sale', ruleId: 'DE_REDUCED', rate: 700 },
  }
  return entries.flatMap(entry => {
    if (entry.source !== 'DATEV') return []
    const assessed = datev ? entry.lines.flatMap(line => {
      const profile = datevRecipientAssessedProfile(line.account.number, datev.chart, datev.accountLength)
      return profile ? [{ line, profile }] : []
    }) : []
    if (assessed.length) {
      if (assessed.length !== 1 || entry.lines.some(line => line.vatPosting)) throw new VatValidationError([`DATEV recipient-assessed VAT detail for journal entry ${entry.id} is ambiguous.`])
      const [{ line: base, profile }] = assessed
      const input = entry.lines.filter(line => line.account.number === profile.inputTaxAccountNumber)
      const output = entry.lines.filter(line => line.account.number === profile.outputTaxAccountNumber)
      const baseCents = base.debitCents - base.creditCents
      const inputCents = input.reduce((sum, line) => sum + line.debitCents - line.creditCents, 0)
      const outputCents = output.reduce((sum, line) => sum + line.creditCents - line.debitCents, 0)
      if (baseCents <= 0 || input.length !== 1 || output.length !== 1 || inputCents <= 0 || inputCents !== outputCents) throw new VatValidationError([`DATEV recipient-assessed VAT detail for journal entry ${entry.id} does not match its posted control amounts.`])
      const detail = calculateVat({ ownerId, sourceId: `datev:${entry.id}:vat:${base.id}`, amountCents: baseCents, mode: 'net', direction: 'purchase', taxPoint: entry.bookingDate.toISOString().slice(0, 10), ruleId: profile.ruleId }, germanVatRuleBook)
      if (detail.inputTaxCents !== inputCents || detail.outputTaxCents !== outputCents) throw new VatValidationError([`DATEV recipient-assessed VAT detail for journal entry ${entry.id} does not reproduce its posted control amounts.`])
      return [detail]
    }
    return entry.lines.flatMap(control => {
      if (control.vatPosting) return []
      const isInputControl = inputAccounts.includes(control.account.number)
      const isOutputControl = outputAccounts.includes(control.account.number)
      if (isInputControl === isOutputControl) return []
      const direction = isInputControl ? 'purchase' : 'sale'
      const controlCents = direction === 'purchase' ? control.debitCents - control.creditCents : control.creditCents - control.debitCents
      if (controlCents <= 0) return []
      const taxCodes = [...new Set(entry.lines.flatMap(line => line.taxCode ? [line.taxCode] : []))]
      const candidates = taxCodes.length
        ? taxCodes.flatMap(taxCode => definitions[taxCode] ? [{ taxCode, ...definitions[taxCode] }] : []).filter(definition => definition.direction === direction)
        : Object.entries(definitions).filter(([, definition]) => definition.direction === direction).map(([taxCode, definition]) => ({ taxCode, ...definition }))
      if (!candidates.length) return []
      const matchingDetails = candidates.flatMap(definition => {
        const baseCents = entry.lines
          .filter(line => line.id !== control.id
            && !inputAccounts.includes(line.account.number)
            && !outputAccounts.includes(line.account.number)
            && (!taxCodes.length || line.taxCode === definition.taxCode)
            && (direction === 'purchase' ? ['EXPENSE', 'ASSET'].includes(line.account.category) : line.account.category === 'REVENUE'))
          .reduce((sum, line) => sum + (direction === 'purchase' ? line.debitCents - line.creditCents : line.creditCents - line.debitCents), 0)
        if (baseCents <= 0) return []
        const detail = calculateVat({ ownerId, sourceId: `datev:${entry.id}:vat:${control.id}`, amountCents: baseCents + controlCents, mode: 'gross', direction, taxPoint: entry.bookingDate.toISOString().slice(0, 10), ruleId: definition.ruleId }, germanVatRuleBook)
        return detail.rateBasisPoints === definition.rate && detail.taxCents === controlCents && detail.netBaseCents === baseCents ? [detail] : []
      })
      if (matchingDetails.length === 1) return matchingDetails
      if (taxCodes.length) throw new VatValidationError([`DATEV automatic-tax detail for journal entry ${entry.id} does not match its posted control amount.`])
      if (matchingDetails.length > 1) throw new VatValidationError([`DATEV automatic-tax detail for journal entry ${entry.id} does not identify one unambiguous posted control amount.`])
      return []
    })
  })
}

export async function reconcileTenantVat(ownerId: string, from: string, to: string) {
  return withVatOwnerLock(ownerId, async () => (await reconciledTenantVat(ownerId, from, to)).reconciliation)
}

const INPUT_VAT_POSITION = 'bs.ass.currAss.receiv.other.vat'
const OUTPUT_VAT_POSITION = 'bs.eqLiab.liab.other.theroffTax.vat'

export function vatControlAccountsFromMappings(mappings: readonly Pick<AccountMapping, 'accountNumber' | 'eBilanzPosition' | 'active'>[]) {
  const active = mappings.filter(mapping => mapping.active !== false)
  const inputAccounts = [...new Set(active.filter(mapping => mapping.eBilanzPosition === INPUT_VAT_POSITION).map(mapping => mapping.accountNumber))]
  const outputAccounts = [...new Set(active.filter(mapping => mapping.eBilanzPosition === OUTPUT_VAT_POSITION).map(mapping => mapping.accountNumber))]
  if (!inputAccounts.length || !outputAccounts.length) throw new VatValidationError(['The effective tenant chart must map active input-VAT and output-VAT control accounts before binding reconciliation.'])
  return { outputAccounts, inputAccounts }
}

type VatMappingVersionRow = Pick<Awaited<ReturnType<typeof prisma.accountMappingVersion.findFirst>> extends infer Row ? NonNullable<Row> : never, 'accountNumber' | 'accountName' | 'accountType' | 'normalBalance' | 'presentationSign' | 'hgbPosition' | 'eBilanzPosition' | 'vatCode' | 'active' | 'effectiveFrom'>

function vatMappingFromRow(row: VatMappingVersionRow): AccountMapping {
  return { accountNumber: row.accountNumber, name: row.accountName, accountType: row.accountType as AccountMapping['accountType'], normalBalance: row.normalBalance as AccountMapping['normalBalance'], presentationSign: row.presentationSign as 1 | -1, hgbPosition: row.hgbPosition, eBilanzPosition: row.eBilanzPosition, vatCode: row.vatCode ?? undefined, active: row.active }
}

export function hasDifferentVatMappingTransition(rows: readonly VatMappingVersionRow[], selectedStart: string, endsAt: Date) {
  const selected = rows.filter(row => row.effectiveFrom.toISOString() === selectedStart).map(vatMappingFromRow)
  const laterStarts = [...new Set(rows.map(row => row.effectiveFrom.toISOString()))].filter(start => start > selectedStart && new Date(start) <= endsAt)
  return laterStarts.some(start => !isIdempotentMappingCohort(rows.filter(row => row.effectiveFrom.toISOString() === start).map(vatMappingFromRow), selected))
}

async function tenantVatControlAccounts(ownerId: string, from: string, to: string) {
  const startsAt = new Date(`${from}T00:00:00.000Z`); const endsAt = new Date(`${to}T23:59:59.999Z`)
  const profile = await companyProfileForPeriod(ownerId, startsAt, endsAt)
  const ledgerProfile = await prisma.ledgerProfile.findUnique({ where: { ownerId } })
  const datevChart = profile.chart === 'SKR03' || profile.chart === 'SKR04' ? profile.chart : undefined
  const accountLength = ledgerProfile?.accountLength ?? 4
  const rows = await prisma.accountMappingVersion.findMany({ where: { ownerId, chartId: profile.chart, effectiveFrom: { lte: endsAt } }, orderBy: { effectiveFrom: 'desc' } })
  const starts = [...new Set(rows.map(row => row.effectiveFrom.toISOString()))]
  const selectedStart = starts.find(start => {
    const cohort = rows.filter(row => row.effectiveFrom.toISOString() === start)
    return new Date(start) <= startsAt && cohort.length > 0 && cohort.every(row => !row.effectiveTo || row.effectiveTo >= endsAt)
  })
  if (selectedStart) {
    if (hasDifferentVatMappingTransition(rows, selectedStart, endsAt)) throw new VatValidationError(['Account-mapping transitions inside a filing period must be resolved before binding VAT reconciliation.'])
    const controls = await mergeConfiguredRecipientAssessedControls(ownerId, profile.chart, vatControlAccountsFromMappings(rows.filter(row => row.effectiveFrom.toISOString() === selectedStart).map(row => ({ accountNumber: row.accountNumber, eBilanzPosition: row.eBilanzPosition, active: row.active }))))
    return { ...await mergeDatevRecipientAssessedControls(ownerId, datevChart, accountLength, controls), datevChart, accountLength }
  }
  if (rows.length) throw new VatValidationError(['No effective account-mapping cohort covers the complete VAT filing period for the tenant chart.'])
  if (profile.chart === 'SKR03' || profile.chart === 'SKR04') {
    const controls = vatControlAccountsFromMappings(scaleMappingsForAccountLength(seedChart(profile.chart), ledgerProfile?.accountLength))
    const expected = new Map<number, { category: string; position: string }>([
      ...controls.inputAccounts.map(number => [number, { category: 'ASSET', position: INPUT_VAT_POSITION }] as const),
      ...controls.outputAccounts.map(number => [number, { category: 'LIABILITY', position: OUTPUT_VAT_POSITION }] as const),
    ])
    const accounts = await prisma.ledgerAccount.findMany({ where: { ownerId, number: { in: [...expected.keys()] } }, select: { number: true, category: true, eBilanzPosition: true, active: true } })
    if (accounts.length !== expected.size || accounts.some(account => !account.active || account.category !== expected.get(account.number)?.category || account.eBilanzPosition !== expected.get(account.number)?.position)) throw new VatValidationError(['Persisted VAT control accounts conflict with the canonical tenant chart semantics. Configure a valid mapping cohort before binding reconciliation.'])
    const configured = await mergeConfiguredRecipientAssessedControls(ownerId, profile.chart, controls)
    return { ...await mergeDatevRecipientAssessedControls(ownerId, datevChart, accountLength, configured), datevChart, accountLength }
  }
  throw new VatValidationError(['No effective account-mapping cohort covers the VAT filing period for the tenant chart.'])
}

async function mergeDatevRecipientAssessedControls(ownerId: string, chart: DatevChart | undefined, accountLength: number, controls: { outputAccounts: number[]; inputAccounts: number[] }) {
  if (!chart) return controls
  const base = chart === 'SKR03' ? 3123 : 5923
  const profile = datevRecipientAssessedProfile(base * 10 ** (accountLength - 4), chart, accountLength)!
  const accounts = await prisma.ledgerAccount.findMany({ where: { ownerId, number: { in: [profile.inputTaxAccountNumber, profile.outputTaxAccountNumber] } }, select: { number: true, category: true, active: true } })
  if (!accounts.length) return controls
  const input = accounts.find(account => account.number === profile.inputTaxAccountNumber)
  const output = accounts.find(account => account.number === profile.outputTaxAccountNumber)
  if (!input?.active || input.category !== 'ASSET' || !output?.active || output.category !== 'LIABILITY') throw new VatValidationError(['Persisted DATEV recipient-assessed VAT controls conflict with the tenant chart semantics.'])
  return { inputAccounts: [...new Set([...controls.inputAccounts, input.number])], outputAccounts: [...new Set([...controls.outputAccounts, output.number])] }
}

async function mergeConfiguredRecipientAssessedControls(ownerId: string, chart: string, controls: { outputAccounts: number[]; inputAccounts: number[] }) {
  const settings = await prisma.accountRecord.findUnique({ where: { ownerId }, select: { payload: true } })
  if (!settings) return controls
  let payload: Record<string, unknown>
  try { payload = JSON.parse(settings.payload) as Record<string, unknown> } catch { throw new VatValidationError(['Tenant settings contain invalid VAT-control configuration JSON.']) }
  let configured
  try { configured = [parseIncomingReverseChargeAccounts(payload.incomingReverseChargeAccounts), parseIncomingEuAcquisitionAccounts(payload.incomingEuAcquisitionAccounts)].filter(item => item?.chart === chart) }
  catch (error) { throw new VatValidationError([error instanceof Error ? error.message : 'Tenant recipient-assessed VAT controls are invalid.']) }
  if (!configured.length) return controls
  const inputAccounts = [...new Set([...controls.inputAccounts, ...configured.map(item => item!.inputVatAccountNumber)])]
  const outputAccounts = [...new Set([...controls.outputAccounts, ...configured.map(item => item!.outputVatAccountNumber)])]
  const expected = new Map<number, { category: 'ASSET' | 'LIABILITY'; position: string }>([
    ...inputAccounts.map(number => [number, { category: 'ASSET' as const, position: INPUT_VAT_POSITION }] as const),
    ...outputAccounts.map(number => [number, { category: 'LIABILITY' as const, position: OUTPUT_VAT_POSITION }] as const),
  ])
  const accounts = await prisma.ledgerAccount.findMany({ where: { ownerId, number: { in: [...expected.keys()] } }, select: { number: true, category: true, eBilanzPosition: true, active: true } })
  if (accounts.length !== expected.size || accounts.some(account => !account.active || account.category !== expected.get(account.number)?.category || account.eBilanzPosition !== expected.get(account.number)?.position)) throw new VatValidationError(['Persisted recipient-assessed VAT control accounts conflict with the configured tenant chart semantics.'])
  return { inputAccounts, outputAccounts }
}

async function reconciledVatDataset(ownerId: string, period: string, persist: boolean) {
  const monthly = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(period)
  const quarterly = /^(\d{4})-Q([1-4])$/.exec(period)
  if (!monthly && !quarterly) throw new VatValidationError(['USTVA preparation requires a canonical monthly or quarterly period.'])
  const year = Number((monthly ?? quarterly)![1])
  const endMonth = monthly ? Number(monthly[2]) : Number(quarterly![2]) * 3
  const startMonth = monthly ? endMonth : endMonth - 2
  const lastDay = new Date(Date.UTC(year, endMonth, 0)).getUTCDate()
  const from = `${year}-${String(startMonth).padStart(2, '0')}-01`; const to = `${year}-${String(endMonth).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`
  const profile = await companyProfileForPeriod(ownerId, new Date(`${from}T00:00:00.000Z`), new Date(`${to}T23:59:59.999Z`))
  const expectedFrequency = monthly ? 'MONTHLY' : 'QUARTERLY'
  if (profile.vatRegime !== 'STANDARD' || profile.vatFilingFrequency !== expectedFrequency) throw new VatValidationError([`${expectedFrequency === 'MONTHLY' ? 'Monthly' : 'Quarterly'} USTVA preparation requires an effective STANDARD VAT regime and ${expectedFrequency} filing frequency.`])
  const { details, reconciliation } = await withVatOwnerLock(ownerId, () => reconciledTenantVat(ownerId, from, to))
  if (!reconciliation.ok) throw new VatValidationError(['Binding USTVA preparation requires VAT detail to reconcile exactly to the ledger control accounts.', ...reconciliation.discrepancies])
  const payable = ustvaPayableCents(details, reconciliation.expected.inputTaxCents)
  const provenance = reconciliation.boxes.flatMap(box => [...box.entryIds, ...box.documentIds])
  const fields: Record<string, number> = { ZAHLLAST: payable, KZ83: payable }
  const drilldown: Record<string, readonly string[]> = { ZAHLLAST: provenance, KZ83: provenance }
  for (const box of reconciliation.boxes) { fields[`KZ${box.box}`] = box.amountCents; drilldown[`KZ${box.box}`] = [...box.entryIds, ...box.documentIds] }
  const dataset = taxFormRegistry.prepare('USTVA', period, fields, drilldown, ownerId)
  const datasetHash = declarationDatasetHash(dataset)
  if (persist) await prisma.taxDatasetPreparationRecord.upsert({ where: { ownerId_datasetHash: { ownerId, datasetHash } }, create: { ownerId, kind: dataset.kind, period: dataset.period, datasetHash }, update: {} })
  return { reconciliation, dataset: Object.freeze(dataset), copyContext: { companyName: profile.companyName, taxNumber: profile.taxNumber, taxOffice: profile.taxOffice, filingFrequency: profile.vatFilingFrequency, ...(profile.registeredAddress ? { registeredAddress: profile.registeredAddress } : {}) } }
}

export function ustvaPayableCents(details: readonly VatPostingDetail[], inputTaxCents: number) {
  if (!Number.isSafeInteger(inputTaxCents)) throw new VatValidationError(['UStVA input tax must use safe integer cents.'])
  let explicitOutputTaxCents = 0
  const implicit = new Map<string, { baseCents: number; rateBasisPoints: number }>()
  for (const detail of details) {
    if (!detail.outputTaxCents) continue
    const baseBoxes = detail.returnBoxes.filter(box => box.value === 'net-base')
    const outputBoxes = detail.returnBoxes.filter(box => box.value === 'output-tax')
    if (outputBoxes.length) { explicitOutputTaxCents += detail.outputTaxCents; continue }
    if (baseBoxes.length !== 1) throw new VatValidationError([`UStVA output VAT detail ${detail.sourceId} requires exactly one implicit-tax base field.`])
    const key = `${baseBoxes[0].box}\u0000${detail.rateBasisPoints}`
    const group = implicit.get(key) ?? { baseCents: 0, rateBasisPoints: detail.rateBasisPoints }
    group.baseCents += detail.netBaseCents
    if (!Number.isSafeInteger(group.baseCents)) throw new VatValidationError(['UStVA aggregate bases exceed safe integer cents.'])
    implicit.set(key, group)
  }
  const implicitOutputTaxCents = [...implicit.values()].reduce((sum, group) => sum + taxFromWholeEuroBase(group.baseCents, group.rateBasisPoints), 0)
  const payable = explicitOutputTaxCents + implicitOutputTaxCents - inputTaxCents
  if (!Number.isSafeInteger(payable)) throw new VatValidationError(['UStVA payable exceeds safe integer cents.'])
  return payable
}

function taxFromWholeEuroBase(baseCents: number, rateBasisPoints: number) {
  if (!Number.isSafeInteger(baseCents) || !Number.isSafeInteger(rateBasisPoints) || rateBasisPoints < 0) throw new VatValidationError(['UStVA implicit tax inputs are invalid.'])
  const wholeEuroCents = Math.trunc(baseCents / 100) * 100
  const sign = wholeEuroCents < 0 ? BigInt(-1) : BigInt(1)
  const rounded = (BigInt(Math.abs(wholeEuroCents)) * BigInt(rateBasisPoints) + BigInt(5_000)) / BigInt(10_000)
  const result = Number(sign * rounded)
  if (!Number.isSafeInteger(result)) throw new VatValidationError(['UStVA implicit tax exceeds safe integer cents.'])
  return result
}

export function prepareReconciledVatDataset(ownerId: string, period: string) { return reconciledVatDataset(ownerId, period, true) }
export function currentReconciledVatDataset(ownerId: string, period: string) { return reconciledVatDataset(ownerId, period, false) }

async function reconciledAnnualVatDataset(ownerId: string, year: number, persist: boolean): Promise<{ reconciliation: Awaited<ReturnType<typeof reconcileTenantVat>>; dataset: DeclarationDataset }> {
  if (!Number.isSafeInteger(year) || year < 1000 || year > 9999) throw new VatValidationError(['Annual VAT preparation requires a four-digit calendar year.'])
  const period = String(year)
  try { taxFormRegistry.resolve('UST_ANNUAL', period) }
  catch (error) { throw new VatValidationError([error instanceof Error ? error.message : `Annual VAT form ${period} is unsupported.`]) }
  const from = `${period}-01-01`; const to = `${period}-12-31`
  return withVatOwnerLock(ownerId, async () => {
    const fiscalYear = await prisma.fiscalYear.findFirst({ where: { ownerId, year }, select: { id: true } })
    if (!fiscalYear) throw new VatValidationError(['Configure the tenant fiscal year before annual VAT preparation.'])
    const profile = await companyProfileForPeriod(ownerId, new Date(`${from}T00:00:00.000Z`), new Date(`${to}T23:59:59.999Z`))
    if (profile.vatRegime === 'EXEMPT') throw new VatValidationError(['Annual VAT preparation is not available for tenants with the effective EXEMPT VAT regime.'])
    const { details, reconciliation } = await reconciledTenantVat(ownerId, from, to)
    if (!reconciliation.ok) throw new VatValidationError(['Binding annual VAT preparation requires VAT detail to reconcile exactly to the ledger control accounts.', ...reconciliation.discrepancies])
    const dataset = annualVatDataset(year, details, reconciliation, taxFormRegistry, ownerId)
    const datasetHash = declarationDatasetHash(dataset)
    if (persist) await prisma.taxDatasetPreparationRecord.upsert({ where: { ownerId_datasetHash: { ownerId, datasetHash } }, create: { ownerId, kind: dataset.kind, period: dataset.period, datasetHash }, update: {} })
    return { reconciliation, dataset: Object.freeze(dataset) }
  })
}

export function prepareReconciledAnnualVatDataset(ownerId: string, year: number) { return reconciledAnnualVatDataset(ownerId, year, true) }
export function currentReconciledAnnualVatDataset(ownerId: string, year: number) { return reconciledAnnualVatDataset(ownerId, year, false) }

export async function listVatPostings(ownerId: string) {
  return prisma.vatPostingRecord.findMany({ where: { ownerId }, orderBy: { taxPoint: 'desc' } })
}
