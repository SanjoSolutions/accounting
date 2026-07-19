import 'server-only'

import {
  VatValidationError,
  attachVatDocument,
  calculateVat,
  createConfiguredVatReversalStore,
  createConfiguredVatRuleBook,
  reconcileVat,
  representativeGermanVatRules,
  restoreVatPosting,
  type VatPostingDetail,
  type VatSourceSplit,
} from '@/core/vatEngine'
import { prisma } from '@/server/persistence/client'
import { declarationDatasetHash, taxFormRegistry, type DeclarationDataset } from '@/core/taxDeclarations'
import { scaleMappingsForAccountLength, seedChart, type AccountMapping } from '@/server/compliance/chartLifecycle'
import { companyProfileForPeriod } from './profileRepository'
import { isPrismaInt } from './persistenceLimits'

const ruleBook = createConfiguredVatRuleBook(representativeGermanVatRules, 'german-vat-rules:2026.1')

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

type ReversalContext = { registry: ReturnType<typeof createConfiguredVatReversalStore>; values: Set<string>; pending?: Set<string> }
const reversalContexts = new Map<string, ReversalContext>()
const ownerLocks = new Map<string, Promise<void>>()
async function withOwnerLock<T>(ownerId: string, task: () => Promise<T>): Promise<T> {
  const previous = ownerLocks.get(ownerId) ?? Promise.resolve()
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const tail = previous.then(() => gate)
  ownerLocks.set(ownerId, tail)
  await previous
  try { return await task() }
  finally { release(); if (ownerLocks.get(ownerId) === tail) ownerLocks.delete(ownerId) }
}
async function reversalContext(ownerId: string) {
  const durable = (await prisma.vatReversalMarker.findMany({ where: { ownerId }, select: { marker: true } })).map(item => item.marker)
  const existing = reversalContexts.get(ownerId)
  if (existing) {
    durable.forEach(marker => existing.values.add(marker))
    return existing
  }
  const values = new Set(durable)
  const persistence = {
    appendAllUnique(candidateOwner: string, markers: readonly string[]) {
      const pending = context.pending
      if (candidateOwner !== ownerId || !pending || markers.some(marker => values.has(marker) || pending.has(marker))) return false
      markers.forEach(marker => pending.add(marker)); return true
    },
    snapshot(candidateOwner: string) { return candidateOwner === ownerId ? [...values, ...(context.pending ?? [])] : [] },
  }
  const context = { values } as ReversalContext
  context.registry = createConfiguredVatReversalStore(ownerId, persistence)
  reversalContexts.set(ownerId, context)
  return context
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

async function restoreExistingPosting(ownerId: string, input: PersistentVatInput, existing: { source: string; journalLineId: string | null; documentId: string | null }, context: ReversalContext) {
  if (existing.journalLineId !== (input.journalLineId ?? null) || existing.documentId !== (input.documentId ?? null)) throw new VatValidationError(['The VAT source ID is already bound to different journal or document provenance.'])
  const candidate = JSON.parse(existing.source) as VatPostingDetail
  const requested: VatSourceSplit = { ...input, ownerId }; delete (requested as PersistentVatInput).journalLineId; delete (requested as PersistentVatInput).documentId
  if (JSON.stringify(sourceShape(candidate)) !== JSON.stringify(sourceShape(requested))) throw new VatValidationError(['The VAT source ID is already bound to a different immutable posting.'])
  let original: VatPostingDetail | undefined
  if (candidate.reversalOf) {
    const originalRow = await prisma.vatPostingRecord.findFirst({ where: { ownerId, sourceId: candidate.reversalOf } })
    if (!originalRow) throw new VatValidationError(['The immutable original VAT posting does not exist for this tenant.'])
    original = restoreVatPosting(JSON.parse(originalRow.source) as VatPostingDetail, ruleBook, context.registry)
  }
  const restored = restoreVatPosting(candidate, ruleBook, context.registry, original)
  return existing.documentId ? attachVatDocument(restored, existing.documentId) : restored
}

export async function persistVatPosting(ownerId: string, value: unknown) {
  const input = parsePersistentVatInput(value)
  return withOwnerLock(ownerId, async () => {
    const existing = await prisma.vatPostingRecord.findUnique({ where: { ownerId_sourceId: { ownerId, sourceId: input.sourceId } } })
    const context = await reversalContext(ownerId)
    if (existing) return restoreExistingPosting(ownerId, input, existing, context)
    const linkedLine = await assertLinks(ownerId, input.amountCents, input.taxPoint, input.journalLineId, input.documentId)
    context.pending = new Set()
    try {
      let original: VatPostingDetail | undefined
      if (input.reversalOf) {
        const row = await prisma.vatPostingRecord.findFirst({ where: { ownerId, sourceId: input.reversalOf } })
        if (!row) throw new VatValidationError(['The immutable original VAT posting does not exist for this tenant.'])
        original = restoreVatPosting(JSON.parse(row.source) as VatPostingDetail, ruleBook, context.registry)
      }
      const split: VatSourceSplit = { ...input, ownerId }
      delete (split as PersistentVatInput).journalLineId
      delete (split as PersistentVatInput).documentId
      const calculated = calculateVat(split, ruleBook, original, context.registry)
      const persistedAmounts = [calculated.netBaseCents, calculated.rateBasisPoints, calculated.taxCents, calculated.deductibleTaxCents, calculated.grossCents, calculated.outputTaxCents, calculated.inputTaxCents]
      if (persistedAmounts.some(amount => !isPrismaInt(amount))) throw new VatValidationError(['Calculated VAT facts exceed signed 32-bit integer storage. Split the source into smaller traceable postings.'])
      const attached = input.documentId ? attachVatDocument(calculated, input.documentId) : calculated
      const source = JSON.stringify(calculated)
      const data = {
        ownerId, sourceId: calculated.sourceId, journalLineId: input.journalLineId, documentId: input.documentId,
        taxPoint: new Date(`${calculated.taxPoint}T00:00:00.000Z`), jurisdiction: calculated.jurisdiction,
        netBaseCents: calculated.netBaseCents, rateBasisPoints: calculated.rateBasisPoints,
        taxCents: calculated.taxCents, deductibleTaxCents: calculated.deductibleTaxCents,
        grossCents: calculated.grossCents, outputTaxCents: calculated.outputTaxCents, inputTaxCents: calculated.inputTaxCents,
        ruleId: calculated.ruleId, ruleVersion: calculated.ruleVersion, vatCase: calculated.case,
        reason: calculated.reason, returnBoxes: JSON.stringify(calculated.returnBoxes), source,
      }
      const newMarkers = [...context.pending]
      await prisma.$transaction(async transaction => {
        await transaction.vatPostingRecord.create({ data })
        for (const marker of newMarkers) await transaction.vatReversalMarker.create({ data: { ownerId, marker } })
        if (input.journalLineId && linkedLine) {
          const updated = await transaction.journalLine.updateMany({ where: { id: input.journalLineId, debitCents: linkedLine.debitCents, creditCents: linkedLine.creditCents, journalEntry: { state: { not: 'POSTED' }, fiscalYear: { ownerId } } }, data: {
          taxCode: calculated.ruleId, taxPoint: data.taxPoint, taxJurisdiction: calculated.jurisdiction,
          netBaseCents: calculated.netBaseCents, taxRateBasisPoints: calculated.rateBasisPoints,
          taxAmountCents: calculated.taxCents, deductibleTaxCents: calculated.deductibleTaxCents,
          taxRuleId: calculated.ruleId, taxRuleVersion: calculated.ruleVersion, taxReason: calculated.reason,
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
  const context = await reversalContext(ownerId)
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
    const posting = restoreVatPosting(candidate, ruleBook, context.registry, original)
    restored.set(posting.sourceId, posting)
    visiting.delete(sourceId)
    return row.documentId ? attachVatDocument(posting, row.documentId) : posting
  }
  return rows.filter(row => (!from || row.taxPoint >= new Date(`${from}T00:00:00.000Z`)) && (!to || row.taxPoint <= new Date(`${to}T23:59:59.999Z`))).map(row => restoreRow(row.sourceId))
}

export async function reconcileTenantVat(ownerId: string, from: string, to: string) {
  return withOwnerLock(ownerId, async () => {
  const unfinished = await prisma.vatPostingRecord.count({ where: { ownerId, taxPoint: { gte: new Date(`${from}T00:00:00.000Z`), lte: new Date(`${to}T23:59:59.999Z`) }, journalLine: { journalEntry: { state: { not: 'POSTED' } } } } })
  if (unfinished) throw new VatValidationError(['Binding VAT reconciliation excludes detail linked to mutable draft journal entries.'])
  const details = await restoreTenantPostings(ownerId, from, to)
  const { outputAccounts, inputAccounts } = await tenantVatControlAccounts(ownerId, from, to)
  const lines = await prisma.journalLine.findMany({ where: { journalEntry: { state: 'POSTED', fiscalYear: { ownerId }, bookingDate: { gte: new Date(`${from}T00:00:00.000Z`), lte: new Date(`${to}T23:59:59.999Z`) } }, account: { number: { in: [...outputAccounts, ...inputAccounts] } } }, include: { account: true } })
  const outputTaxCents = lines.filter(line => outputAccounts.includes(line.account.number)).reduce((sum, line) => sum + line.creditCents - line.debitCents, 0)
  const inputTaxCents = lines.filter(line => inputAccounts.includes(line.account.number)).reduce((sum, line) => sum + line.debitCents - line.creditCents, 0)
  return reconcileVat(details, { outputTaxCents, inputTaxCents }, 0, ownerId)
  })
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

async function tenantVatControlAccounts(ownerId: string, from: string, to: string) {
  const startsAt = new Date(`${from}T00:00:00.000Z`); const endsAt = new Date(`${to}T23:59:59.999Z`)
  const profile = await companyProfileForPeriod(ownerId, startsAt, endsAt)
  const rows = await prisma.accountMappingVersion.findMany({ where: { ownerId, chartId: profile.chart, effectiveFrom: { lte: endsAt } }, orderBy: { effectiveFrom: 'desc' } })
  const starts = [...new Set(rows.map(row => row.effectiveFrom.toISOString()))]
  const selectedStart = starts.find(start => {
    const cohort = rows.filter(row => row.effectiveFrom.toISOString() === start)
    return new Date(start) <= startsAt && cohort.length > 0 && cohort.every(row => !row.effectiveTo || row.effectiveTo >= endsAt)
  })
  if (selectedStart) {
    if (starts.some(start => start > selectedStart && new Date(start) <= endsAt)) throw new VatValidationError(['Account-mapping transitions inside a filing period must be resolved before binding VAT reconciliation.'])
    return vatControlAccountsFromMappings(rows.filter(row => row.effectiveFrom.toISOString() === selectedStart).map(row => ({ accountNumber: row.accountNumber, eBilanzPosition: row.eBilanzPosition, active: row.active })))
  }
  if (rows.length) throw new VatValidationError(['No effective account-mapping cohort covers the complete VAT filing period for the tenant chart.'])
  if (profile.chart === 'SKR03' || profile.chart === 'SKR04') {
    const ledgerProfile = await prisma.ledgerProfile.findUnique({ where: { ownerId } })
    const controls = vatControlAccountsFromMappings(scaleMappingsForAccountLength(seedChart(profile.chart), ledgerProfile?.accountLength))
    const expected = new Map<number, { category: string; position: string }>([
      ...controls.inputAccounts.map(number => [number, { category: 'ASSET', position: INPUT_VAT_POSITION }] as const),
      ...controls.outputAccounts.map(number => [number, { category: 'LIABILITY', position: OUTPUT_VAT_POSITION }] as const),
    ])
    const accounts = await prisma.ledgerAccount.findMany({ where: { ownerId, number: { in: [...expected.keys()] } }, select: { number: true, category: true, eBilanzPosition: true, active: true } })
    if (accounts.length !== expected.size || accounts.some(account => !account.active || account.category !== expected.get(account.number)?.category || account.eBilanzPosition !== expected.get(account.number)?.position)) throw new VatValidationError(['Persisted VAT control accounts conflict with the canonical tenant chart semantics. Configure a valid mapping cohort before binding reconciliation.'])
    return controls
  }
  throw new VatValidationError(['No effective account-mapping cohort covers the VAT filing period for the tenant chart.'])
}

async function reconciledVatDataset(ownerId: string, period: string, persist: boolean): Promise<{ reconciliation: Awaited<ReturnType<typeof reconcileTenantVat>>; dataset: DeclarationDataset }> {
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(period)
  if (!match) throw new VatValidationError(['USTVA preparation requires a canonical monthly period.'])
  const year = Number(match[1]); const month = Number(match[2]); const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate()
  const from = `${period}-01`; const to = `${period}-${String(lastDay).padStart(2, '0')}`
  const profile = await companyProfileForPeriod(ownerId, new Date(`${from}T00:00:00.000Z`), new Date(`${to}T23:59:59.999Z`))
  if (profile.vatRegime !== 'STANDARD' || profile.vatFilingFrequency !== 'MONTHLY') throw new VatValidationError(['Monthly USTVA preparation is only available for tenants with the effective STANDARD VAT regime and MONTHLY filing frequency.'])
  const reconciliation = await reconcileTenantVat(ownerId, from, to)
  if (!reconciliation.ok) throw new VatValidationError(['Binding USTVA preparation requires VAT detail to reconcile exactly to the ledger control accounts.', ...reconciliation.discrepancies])
  const fields: Record<string, number> = { ZAHLLAST: reconciliation.expected.outputTaxCents - reconciliation.expected.inputTaxCents }
  const drilldown: Record<string, readonly string[]> = { ZAHLLAST: reconciliation.boxes.flatMap(box => [...box.entryIds, ...box.documentIds]) }
  for (const box of reconciliation.boxes) { fields[`KZ${box.box}`] = box.amountCents; drilldown[`KZ${box.box}`] = [...box.entryIds, ...box.documentIds] }
  const dataset = taxFormRegistry.prepare('USTVA', period, fields, drilldown, ownerId)
  const datasetHash = declarationDatasetHash(dataset)
  if (persist) await prisma.taxDatasetPreparationRecord.upsert({ where: { ownerId_datasetHash: { ownerId, datasetHash } }, create: { ownerId, kind: dataset.kind, period: dataset.period, datasetHash }, update: {} })
  return { reconciliation, dataset: Object.freeze(dataset) }
}

export function prepareReconciledVatDataset(ownerId: string, period: string) { return reconciledVatDataset(ownerId, period, true) }
export function currentReconciledVatDataset(ownerId: string, period: string) { return reconciledVatDataset(ownerId, period, false) }

export async function listVatPostings(ownerId: string) {
  return prisma.vatPostingRecord.findMany({ where: { ownerId }, orderBy: { taxPoint: 'desc' } })
}
