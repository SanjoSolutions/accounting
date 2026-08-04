import { applyAssetEvents, calculatePartialYearDepreciation, type AssetEvent, type FixedAsset } from './compliance/assetsInventory'

export interface RegisteredFixedAsset extends FixedAsset {
  assetAccountId: string
  depreciationExpenseAccountId: string
  sourceDocumentId: string
  acquisitionJournalLineId: string
  registrationRequestKey?: string
  registrationRequestHash?: string
}

export interface DepreciationScheduleRow {
  period: string
  postingDate: string
  amountCents: number
  cumulativeCents: number
  carryingAmountCents: number
  status: 'SCHEDULED' | 'POSTED' | 'REVERSED'
  eventId?: string
}

export function createMonthlyDepreciationSchedule(asset: RegisteredFixedAsset, events: readonly AssetEvent[] = []): DepreciationScheduleRow[] {
  validateRegisteredAsset(asset)
  const byPeriod = new Map<string, AssetEvent[]>()
  for (const event of events) {
    if (event.assetId !== asset.id) continue
    const period = event.effectiveDate.slice(0, 7)
    byPeriod.set(period, [...(byPeriod.get(period) ?? []), event])
  }
  const start = new Date(`${asset.availableForUseDate.slice(0, 7)}-01T00:00:00.000Z`)
  let cumulativeCents = 0
  return Array.from({ length: asset.usefulLifeMonths }, (_, index) => {
    const month = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + index, 1))
    const period = month.toISOString().slice(0, 7)
    const postingDate = monthEnd(period)
    const amountCents = calculatePartialYearDepreciation(asset, { start: `${period}-01`, end: postingDate }, 'BOOK')
    cumulativeCents += amountCents
    const depreciations = (byPeriod.get(period) ?? []).filter(event => event.type === 'DEPRECIATION')
    const active = depreciations.find(depreciation => !events.some(event => event.type === 'REVERSAL' && event.reversesEventId === depreciation.id))
    const displayed = active ?? depreciations.at(-1)
    return { period, postingDate, amountCents, cumulativeCents, carryingAmountCents: asset.costCents - cumulativeCents, status: active ? 'POSTED' : displayed ? 'REVERSED' : 'SCHEDULED', ...(displayed ? { eventId: displayed.id } : {}) }
  })
}

export function scheduledDepreciationForPeriod(asset: RegisteredFixedAsset, period: string) {
  if (!/^\d{4}-\d{2}$/.test(period)) throw new TypeError('Depreciation period must use YYYY-MM.')
  const row = createMonthlyDepreciationSchedule(asset).find(candidate => candidate.period === period)
  if (!row) throw new TypeError('The period is outside the asset useful life.')
  return row
}

export function fixedAssetFullRetirementFacts(asset: RegisteredFixedAsset, events: readonly AssetEvent[], effectiveDate: string) {
  validateRegisteredAsset(asset)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(effectiveDate)) throw new TypeError('Retirement date must use YYYY-MM-DD.')
  if (events.some(event => event.assetId === asset.id && event.effectiveDate > effectiveDate)) throw new TypeError('A fixed asset cannot be retired before an already posted later lifecycle event.')
  const before = applyAssetEvents(asset, events, effectiveDate)
  if (before.disposed) throw new TypeError('The fixed asset is already retired.')
  if (before.bookTaxDifferenceCents !== 0) throw new TypeError('A book/tax carrying-value difference requires a dedicated disposal-tax workflow.')
  if (before.bookValueCents <= 0) throw new TypeError('A fully depreciated asset requires a non-monetary retirement workflow.')
  return { carryingAmountCents: before.bookValueCents, taxCarryingAmountCents: before.taxValueCents, location: before.location }
}

export function fixedAssetFullSaleFacts(asset: RegisteredFixedAsset, events: readonly AssetEvent[], effectiveDate: string, netProceedsCents: number, vatRateBasisPoints: number) {
  const carrying = fixedAssetFullRetirementFacts(asset, events, effectiveDate)
  if (!Number.isSafeInteger(netProceedsCents) || netProceedsCents <= 0) throw new TypeError('Net sale proceeds must be positive integer cents.')
  if (vatRateBasisPoints !== 1900) throw new TypeError('The supported domestic fixed-asset sale requires the German standard 19% VAT rate.')
  const outputVatCents = Math.round(netProceedsCents * vatRateBasisPoints / 10_000)
  if (!Number.isSafeInteger(outputVatCents) || !Number.isSafeInteger(netProceedsCents + outputVatCents)) throw new TypeError('Fixed-asset sale totals exceed the safe integer range.')
  const gainLossCents = netProceedsCents - carrying.carryingAmountCents
  return {
    ...carrying,
    netProceedsCents,
    vatRateBasisPoints,
    outputVatCents,
    grossProceedsCents: netProceedsCents + outputVatCents,
    gainLossCents,
    result: gainLossCents >= 0 ? 'GAIN' as const : 'LOSS' as const,
  }
}

export function validateRegisteredAsset(asset: RegisteredFixedAsset) {
  if (asset.method !== 'STRAIGHT_LINE' || asset.taxMethod !== 'STRAIGHT_LINE') throw new TypeError('Only ordinary straight-line book and tax depreciation is supported; special tax depreciation is not supported.')
  if (asset.taxUsefulLifeMonths !== asset.usefulLifeMonths) throw new TypeError('Different book and tax useful lives require an unsupported deferred-tax workflow.')
  if (![asset.assetAccountId, asset.depreciationExpenseAccountId, asset.sourceDocumentId, asset.acquisitionJournalLineId].every(value => typeof value === 'string' && value.trim())) throw new TypeError('Asset, depreciation expense, source-document, and acquisition-journal-line references are required.')
  createMonthlyBoundaryValidation(asset)
}

export function rejectUnsupportedAssetOperation(operation: string) {
  if (operation === 'PARTIAL_DISPOSAL' || operation === 'SPECIAL_TAX_DEPRECIATION') throw new TypeError(`${operation} is outside the supported fixed-asset workflow.`)
}

function createMonthlyBoundaryValidation(asset: RegisteredFixedAsset) {
  calculatePartialYearDepreciation(asset, { start: `${asset.availableForUseDate.slice(0, 7)}-01`, end: monthEnd(asset.availableForUseDate.slice(0, 7)) }, 'BOOK')
}

function monthEnd(period: string) {
  const [year, month] = period.split('-').map(Number)
  return new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10)
}
