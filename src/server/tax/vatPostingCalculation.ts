import {
  calculateMixedVat,
  createConfiguredVatReversalStore,
  createConfiguredVatRuleBook,
  representativeGermanVatRules,
  type VatPostingDetail,
  type VatSourceSplit,
} from '@/core/vatEngine'
import { prisma } from '@/server/persistence/client'

export const germanVatRuleBook = createConfiguredVatRuleBook(representativeGermanVatRules, 'german-vat-rules:2026.1')

export type VatReversalContext = {
  registry: ReturnType<typeof createConfiguredVatReversalStore>
  values: Set<string>
  pending?: Set<string>
}

const contexts = new Map<string, VatReversalContext>()
const ownerLocks = new Map<string, Promise<void>>()

export async function withVatOwnerLock<T>(ownerId: string, task: () => Promise<T>): Promise<T> {
  const previous = ownerLocks.get(ownerId) ?? Promise.resolve()
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const tail = previous.then(() => gate)
  ownerLocks.set(ownerId, tail)
  await previous
  try { return await task() }
  finally {
    release()
    if (ownerLocks.get(ownerId) === tail) ownerLocks.delete(ownerId)
  }
}

export async function vatReversalContext(ownerId: string) {
  const durable = (await prisma.vatReversalMarker.findMany({
    where: { ownerId },
    select: { marker: true },
  })).map(item => item.marker)
  const existing = contexts.get(ownerId)
  if (existing) {
    durable.forEach(marker => existing.values.add(marker))
    return existing
  }
  const values = new Set(durable)
  const context = { values } as VatReversalContext
  const persistence = {
    appendAllUnique(candidateOwner: string, markers: readonly string[]) {
      const pending = context.pending
      if (candidateOwner !== ownerId || !pending || markers.some(marker => values.has(marker) || pending.has(marker))) return false
      markers.forEach(marker => pending.add(marker))
      return true
    },
    snapshot(candidateOwner: string) {
      return candidateOwner === ownerId ? [...values, ...(context.pending ?? [])] : []
    },
  }
  context.registry = createConfiguredVatReversalStore(ownerId, persistence)
  contexts.set(ownerId, context)
  return context
}

/**
 * Calculates and durably binds original VAT postings around one caller-owned
 * transaction. The callback must persist every supplied marker atomically with
 * the returned VAT posting details.
 */
export async function withCalculatedOriginalVatPostings<T>(
  ownerId: string,
  splits: readonly VatSourceSplit[],
  persist: (details: readonly VatPostingDetail[], markers: readonly string[]) => Promise<T>,
): Promise<T> {
  return withVatOwnerLock(ownerId, async () => {
    const context = await vatReversalContext(ownerId)
    context.pending = new Set()
    try {
      if (splits.some(split => split.ownerId !== ownerId || split.reversalOf)) throw new Error('Atomic journal VAT preparation accepts only original postings for the same tenant.')
      const details = calculateMixedVat(splits, germanVatRuleBook, [], context.registry)
      const markers = [...context.pending]
      const result = await persist(details, markers)
      markers.forEach(marker => context.values.add(marker))
      context.pending = undefined
      return result
    } catch (error) {
      context.pending = undefined
      throw error
    }
  })
}

export function journalLineVatData(detail: VatPostingDetail) {
  return {
    taxCode: detail.ruleId,
    taxPoint: new Date(`${detail.taxPoint}T00:00:00.000Z`),
    taxJurisdiction: detail.jurisdiction,
    netBaseCents: detail.netBaseCents,
    taxRateBasisPoints: detail.rateBasisPoints,
    taxAmountCents: detail.taxCents,
    deductibleTaxCents: detail.deductibleTaxCents,
    taxRuleId: detail.ruleId,
    taxRuleVersion: detail.ruleVersion,
    taxReason: detail.reason,
  }
}

export function vatPostingCreateData(ownerId: string, journalLineId: string | undefined, detail: VatPostingDetail, documentId?: string) {
  return {
    ownerId,
    sourceId: detail.sourceId,
    journalLineId: journalLineId ?? null,
    documentId: documentId ?? null,
    taxPoint: new Date(`${detail.taxPoint}T00:00:00.000Z`),
    jurisdiction: detail.jurisdiction,
    netBaseCents: detail.netBaseCents,
    rateBasisPoints: detail.rateBasisPoints,
    taxCents: detail.taxCents,
    deductibleTaxCents: detail.deductibleTaxCents,
    grossCents: detail.grossCents,
    outputTaxCents: detail.outputTaxCents,
    inputTaxCents: detail.inputTaxCents,
    ruleId: detail.ruleId,
    ruleVersion: detail.ruleVersion,
    vatCase: detail.case,
    reason: detail.reason,
    returnBoxes: JSON.stringify(detail.returnBoxes),
    source: JSON.stringify(detail),
  }
}

export function vatControlAccount(detail: VatPostingDetail, direction: 'output' | 'input') {
  const rule = germanVatRuleBook.at(detail.ruleId, detail.taxPoint)
  return direction === 'output' ? rule.outputAccount : rule.inputAccount
}
