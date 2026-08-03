import { compareCanonicalText } from './deterministicOrder'
import { hasStrictEvidenceIds } from './validation'

export type HgbCostBasisKind = 'ACQUISITION' | 'PRODUCTION'
export type HgbCostComponentType =
  | 'PURCHASE_PRICE'
  | 'PURCHASE_PRICE_REDUCTION'
  | 'ACQUISITION_INCIDENTAL'
  | 'SUBSEQUENT_ACQUISITION'
  | 'DIRECT_MATERIAL'
  | 'DIRECT_LABOUR'
  | 'SPECIAL_PRODUCTION'
  | 'MATERIAL_OVERHEAD'
  | 'PRODUCTION_OVERHEAD'
  | 'PRODUCTION_DEPRECIATION'

export interface HgbCostComponent {
  id: string
  type: HgbCostComponentType
  amountCents: number
  evidenceIds: readonly string[]
}

export interface HgbAdjustmentAccounts { assetAccount: string; expenseAccount: string; incomeAccount: string }
export interface HgbAdjustmentProposal {
  id: string
  sourceId: string
  reason: 'DEPRECIATION' | 'IMPAIRMENT' | 'IMPAIRMENT_REVERSAL' | 'DISPOSAL' | 'INVENTORY_COUNT' | 'INVENTORY_WRITEDOWN' | 'INVENTORY_REVERSAL' | 'GL_RECONCILIATION'
  amountCents: number
  debitAccount: string
  creditAccount: string
  evidenceIds: readonly string[]
}

export interface HgbAssetValuationInput {
  id: string
  description: string
  costBasisKind: HgbCostBasisKind
  costComponents: readonly HgbCostComponent[]
  acquisitionDate: string
  availableForUseDate: string
  usefulLifeMonths: number
  depreciationConvention: 'FULL_MONTH'
  residualValueCents: number
  fiscalPeriod: { start: string; end: string }
  priorCumulativeImpairmentCents: number
  lowerValueAtPeriodEndCents?: number
  disposalDate?: string
  disposalEvidenceIds?: readonly string[]
  glCarryingAmountCents: number
  accounts: HgbAdjustmentAccounts
  evidenceIds: readonly string[]
}

export function calculateHgbCostBasis(kind: HgbCostBasisKind, components: readonly HgbCostComponent[]) {
  if (kind !== 'ACQUISITION' && kind !== 'PRODUCTION') throw new Error('HGB cost basis kind is unsupported.')
  const rows = dense(components, 'HGB cost components').map(component => {
    if (!component || typeof component !== 'object') throw new Error('HGB cost components must be structured records.')
    if (typeof component.id !== 'string' || !component.id.trim() || !Number.isSafeInteger(component.amountCents) || component.amountCents < 0 || !hasStrictEvidenceIds(component.evidenceIds)) throw new Error('Every HGB cost component requires an ID, nonnegative safe integer cents and evidence.')
    return { ...component, evidenceIds: [...component.evidenceIds] }
  })
  if (new Set(rows.map(row => row.id)).size !== rows.length) throw new Error('HGB cost component IDs must be unique.')
  const permitted = kind === 'ACQUISITION'
    ? new Set<HgbCostComponentType>(['PURCHASE_PRICE', 'PURCHASE_PRICE_REDUCTION', 'ACQUISITION_INCIDENTAL', 'SUBSEQUENT_ACQUISITION'])
    : new Set<HgbCostComponentType>(['DIRECT_MATERIAL', 'DIRECT_LABOUR', 'SPECIAL_PRODUCTION', 'MATERIAL_OVERHEAD', 'PRODUCTION_OVERHEAD', 'PRODUCTION_DEPRECIATION'])
  if (rows.some(row => !permitted.has(row.type))) throw new Error(`A ${kind.toLowerCase()} cost basis contains an unsupported or inapplicable component.`)
  if (kind === 'ACQUISITION' && !rows.some(row => row.type === 'PURCHASE_PRICE')) throw new Error('Acquisition cost requires an evidenced purchase price.')
  if (kind === 'PRODUCTION' && (!rows.some(row => row.type === 'DIRECT_MATERIAL') || !rows.some(row => row.type === 'DIRECT_LABOUR'))) throw new Error('Production cost requires evidenced direct material and direct labour; complex or incomplete production costing is unsupported.')
  let amountCents = 0
  for (const row of rows.sort((a, b) => compareCanonicalText(a.id, b.id))) amountCents = safeAdd(amountCents, row.type === 'PURCHASE_PRICE_REDUCTION' ? -row.amountCents : row.amountCents)
  if (amountCents < 0) throw new Error('HGB cost reductions cannot exceed the positive cost components.')
  return { kind, amountCents, components: rows }
}

export function createHgbAssetValuation(input: HgbAssetValuationInput) {
  validateAssetInput(input)
  const basis = calculateHgbCostBasis(input.costBasisKind, input.costComponents)
  if (input.residualValueCents > basis.amountCents) throw new Error('Asset residual value cannot exceed its HGB cost basis.')
  const depreciationEnd = input.disposalDate && input.disposalDate <= input.fiscalPeriod.end ? input.disposalDate : input.fiscalPeriod.end
  const priorEnd = previousDay(input.fiscalPeriod.start)
  const openingDepreciationEnd = input.disposalDate && input.disposalDate < input.fiscalPeriod.start ? input.disposalDate : priorEnd
  const depreciableCents = safeAdd(basis.amountCents, -input.residualValueCents)
  const openingScheduledDepreciationCents = cumulativeMonthlyDepreciation(depreciableCents, input.usefulLifeMonths, input.availableForUseDate, openingDepreciationEnd)
  const closingScheduledDepreciationCents = cumulativeMonthlyDepreciation(depreciableCents, input.usefulLifeMonths, input.availableForUseDate, depreciationEnd)
  const periodDepreciationCents = safeAdd(closingScheduledDepreciationCents, -openingScheduledDepreciationCents)
  const unimpairedCarryingAmountCents = safeAdd(basis.amountCents, -closingScheduledDepreciationCents)
  if (input.priorCumulativeImpairmentCents > safeAdd(basis.amountCents, -openingScheduledDepreciationCents)) throw new Error('Prior asset impairment exceeds the opening carrying amount.')
  const disposed = input.disposalDate !== undefined && input.disposalDate <= input.fiscalPeriod.end
  if (disposed && input.lowerValueAtPeriodEndCents !== undefined) throw new Error('A disposed asset cannot also have a period-end lower-value measurement.')
  if (input.lowerValueAtPeriodEndCents !== undefined && input.lowerValueAtPeriodEndCents > unimpairedCarryingAmountCents) throw new Error('An impairment input cannot exceed the unimpaired carrying amount; omit it to reverse a prior impairment.')
  const targetImpairmentCents = disposed ? input.priorCumulativeImpairmentCents : input.lowerValueAtPeriodEndCents === undefined ? 0 : safeAdd(unimpairedCarryingAmountCents, -input.lowerValueAtPeriodEndCents)
  const impairmentMovementCents = safeAdd(targetImpairmentCents, -input.priorCumulativeImpairmentCents)
  const carryingBeforeDisposalCents = safeAdd(unimpairedCarryingAmountCents, -targetImpairmentCents)
  const targetCarryingAmountCents = disposed ? 0 : carryingBeforeDisposalCents
  const proposals: HgbAdjustmentProposal[] = []
  if (periodDepreciationCents > 0) proposals.push(proposal(input.id, 'DEPRECIATION', periodDepreciationCents, input.accounts.expenseAccount, input.accounts.assetAccount, input.evidenceIds))
  if (impairmentMovementCents > 0) proposals.push(proposal(input.id, 'IMPAIRMENT', impairmentMovementCents, input.accounts.expenseAccount, input.accounts.assetAccount, input.evidenceIds))
  if (impairmentMovementCents < 0) proposals.push(proposal(input.id, 'IMPAIRMENT_REVERSAL', -impairmentMovementCents, input.accounts.assetAccount, input.accounts.incomeAccount, input.evidenceIds))
  if (disposed && carryingBeforeDisposalCents > 0) proposals.push(proposal(input.id, 'DISPOSAL', carryingBeforeDisposalCents, input.accounts.expenseAccount, input.accounts.assetAccount, input.disposalEvidenceIds!))
  const glDifferenceCents = safeAdd(targetCarryingAmountCents, -input.glCarryingAmountCents)
  return {
    assetId: input.id, description: input.description, costBasisCents: basis.amountCents, residualValueCents: input.residualValueCents,
    openingScheduledDepreciationCents, periodDepreciationCents, closingScheduledDepreciationCents,
    priorCumulativeImpairmentCents: input.priorCumulativeImpairmentCents, impairmentMovementCents, targetImpairmentCents,
    disposed, targetCarryingAmountCents, glCarryingAmountCents: input.glCarryingAmountCents, glDifferenceCents,
    reconciled: glDifferenceCents === 0, proposals: proposals.sort((a, b) => compareCanonicalText(a.id, b.id)),
  }
}

export type InventoryCostFormula = 'FIFO' | 'WEIGHTED_AVERAGE'
export interface InventoryLayer { id: string; date: string; quantity: number; unitCostCents: number; evidenceIds: readonly string[] }
export interface HgbInventoryValuationInput {
  id: string
  formula: InventoryCostFormula | 'LIFO'
  layers: readonly InventoryLayer[]
  issuedQuantity: number
  expectedQuantity: number
  countedQuantity: number
  countEvidenceIds: readonly string[]
  replacementCostPerUnitCents: number
  netRealizableValuePerUnitCents: number
  priorWriteDownCents: number
  glAmountCents: number
  accounts: HgbAdjustmentAccounts
}

export function createHgbInventoryValuation(input: HgbInventoryValuationInput) {
  if (input.formula === 'LIFO') throw new Error('LIFO inventory valuation is outside the explicitly supported HGB close scope.')
  if (input.formula !== 'FIFO' && input.formula !== 'WEIGHTED_AVERAGE') throw new Error('Inventory cost formula is unsupported.')
  for (const value of [input.issuedQuantity, input.expectedQuantity, input.countedQuantity, input.replacementCostPerUnitCents, input.netRealizableValuePerUnitCents, input.priorWriteDownCents, input.glAmountCents]) requireNonnegativeSafe(value, 'Inventory quantities and valuation amounts')
  if (typeof input.id !== 'string' || !input.id.trim() || !hasStrictEvidenceIds(input.countEvidenceIds)) throw new Error('Inventory valuation requires an item ID and physical-count evidence.')
  for (const account of Object.values(input.accounts)) if (typeof account !== 'string' || !account.trim()) throw new Error('Adjustment proposal accounts must be explicit.')
  const layers = dense(input.layers, 'Inventory layers').map(layer => {
    if (!layer || typeof layer !== 'object' || typeof layer.id !== 'string' || !layer.id.trim() || !validDate(layer.date) || !hasStrictEvidenceIds(layer.evidenceIds)) throw new Error('Every inventory layer requires identity, date and evidence.')
    requireNonnegativeSafe(layer.quantity, 'Inventory layer quantity'); requireNonnegativeSafe(layer.unitCostCents, 'Inventory layer unit cost')
    return { ...layer, evidenceIds: [...layer.evidenceIds] }
  }).sort((a, b) => compareCanonicalText(a.date, b.date) || compareCanonicalText(a.id, b.id))
  if (new Set(layers.map(layer => layer.id)).size !== layers.length) throw new Error('Inventory layer IDs must be unique.')
  const receivedQuantity = layers.reduce((sum, layer) => safeAdd(sum, layer.quantity), 0)
  if (input.issuedQuantity > receivedQuantity) throw new Error('Inventory issues exceed evidenced available quantities.')
  const calculatedExpectedQuantity = safeAdd(receivedQuantity, -input.issuedQuantity)
  if (input.expectedQuantity !== calculatedExpectedQuantity) throw new Error('Inventory expected quantity does not reconcile to evidenced layers and issues.')
  const countedQuantity = input.countedQuantity
  if (countedQuantity > receivedQuantity) throw new Error('Inventory count exceeds the supported evidenced quantity pool; unidentified layers must be resolved first.')
  const costForCountedQuantityCents = input.formula === 'FIFO'
    ? fifoClosingCost(layers, countedQuantity)
    : roundedRatio(layers.reduce((sum, layer) => safeAdd(sum, safeMultiply(layer.quantity, layer.unitCostCents)), 0), safeMultiply(countedQuantity, 1), receivedQuantity)
  const lowerUnitValueCents = Math.min(input.replacementCostPerUnitCents, input.netRealizableValuePerUnitCents)
  const lowerValueCents = safeMultiply(countedQuantity, lowerUnitValueCents)
  const targetInventoryValueCents = Math.min(costForCountedQuantityCents, lowerValueCents)
  const targetWriteDownCents = safeAdd(costForCountedQuantityCents, -targetInventoryValueCents)
  if (input.priorWriteDownCents > costForCountedQuantityCents) throw new Error('Prior inventory write-down exceeds the current evidenced cost ceiling.')
  const writeDownMovementCents = safeAdd(targetWriteDownCents, -input.priorWriteDownCents)
  const countDifferenceQuantity = safeAdd(countedQuantity, -input.expectedQuantity)
  const glDifferenceCents = safeAdd(targetInventoryValueCents, -input.glAmountCents)
  const proposals: HgbAdjustmentProposal[] = []
  if (countDifferenceQuantity !== 0) {
    const magnitude = input.formula === 'WEIGHTED_AVERAGE'
      ? roundedRatio(layers.reduce((sum, layer) => safeAdd(sum, safeMultiply(layer.quantity, layer.unitCostCents)), 0), Math.abs(countDifferenceQuantity), receivedQuantity)
      : Math.abs(safeAdd(costForCountedQuantityCents, -fifoClosingCost(layers, input.expectedQuantity)))
    proposals.push(proposal(input.id, 'INVENTORY_COUNT', magnitude, countDifferenceQuantity > 0 ? input.accounts.assetAccount : input.accounts.expenseAccount, countDifferenceQuantity > 0 ? input.accounts.incomeAccount : input.accounts.assetAccount, input.countEvidenceIds))
  }
  if (writeDownMovementCents > 0) proposals.push(proposal(input.id, 'INVENTORY_WRITEDOWN', writeDownMovementCents, input.accounts.expenseAccount, input.accounts.assetAccount, input.countEvidenceIds))
  if (writeDownMovementCents < 0) proposals.push(proposal(input.id, 'INVENTORY_REVERSAL', -writeDownMovementCents, input.accounts.assetAccount, input.accounts.incomeAccount, input.countEvidenceIds))
  return { itemId: input.id, formula: input.formula, receivedQuantity, expectedQuantity: input.expectedQuantity, countedQuantity, countDifferenceQuantity, costForCountedQuantityCents, lowerUnitValueCents, targetWriteDownCents, writeDownMovementCents, targetInventoryValueCents, glAmountCents: input.glAmountCents, glDifferenceCents, reconciled: glDifferenceCents === 0, proposals: proposals.sort((a, b) => compareCanonicalText(a.id, b.id)) }
}

export function createHgbSubledgerReconciliation(assetRows: readonly ReturnType<typeof createHgbAssetValuation>[], inventoryRows: readonly ReturnType<typeof createHgbInventoryValuation>[]) {
  const assets = dense(assetRows, 'Asset valuation rows').slice().sort((a, b) => compareCanonicalText(a.assetId, b.assetId))
  const inventory = dense(inventoryRows, 'Inventory valuation rows').slice().sort((a, b) => compareCanonicalText(a.itemId, b.itemId))
  if (new Set(assets.map(row => row.assetId)).size !== assets.length || new Set(inventory.map(row => row.itemId)).size !== inventory.length) throw new Error('HGB subledger reconciliation row IDs must be unique.')
  for (const row of assets) if (typeof row.assetId !== 'string' || !row.assetId.trim() || !Number.isSafeInteger(row.targetCarryingAmountCents) || !Number.isSafeInteger(row.glCarryingAmountCents) || row.glDifferenceCents !== safeAdd(row.targetCarryingAmountCents, -row.glCarryingAmountCents)) throw new Error('Asset valuation row is malformed or has an inconsistent GL difference.')
  for (const row of inventory) if (typeof row.itemId !== 'string' || !row.itemId.trim() || !Number.isSafeInteger(row.targetInventoryValueCents) || !Number.isSafeInteger(row.glAmountCents) || row.glDifferenceCents !== safeAdd(row.targetInventoryValueCents, -row.glAmountCents)) throw new Error('Inventory valuation row is malformed or has an inconsistent GL difference.')
  const assetDifferenceCents = assets.reduce((sum, row) => safeAdd(sum, row.glDifferenceCents), 0)
  const inventoryDifferenceCents = inventory.reduce((sum, row) => safeAdd(sum, row.glDifferenceCents), 0)
  const issues = [...assets.filter(row => row.glDifferenceCents !== 0).map(row => `Asset ${row.assetId} differs from the GL by ${row.glDifferenceCents} cents.`), ...inventory.filter(row => row.glDifferenceCents !== 0).map(row => `Inventory ${row.itemId} differs from the GL by ${row.glDifferenceCents} cents.`)]
  return { assetDifferenceCents, inventoryDifferenceCents, canClose: issues.length === 0, issues, assets, inventory }
}

export function createHgbInventorySchedule(expectedItemIds: readonly string[], valuationRows: readonly ReturnType<typeof createHgbInventoryValuation>[]) {
  const expected = dense(expectedItemIds, 'Expected inventory item IDs').map(id => {
    if (typeof id !== 'string' || !id.trim()) throw new Error('Expected inventory item IDs must be nonblank.')
    return id
  }).sort(compareCanonicalText)
  const rows = dense(valuationRows, 'Inventory valuation rows').slice().sort((a, b) => compareCanonicalText(a.itemId, b.itemId))
  if (new Set(expected).size !== expected.length || new Set(rows.map(row => row.itemId)).size !== rows.length) throw new Error('Inventory schedule item IDs must be unique.')
  const actual = rows.map(row => row.itemId)
  const missingItemIds = expected.filter(id => !actual.includes(id))
  const unexpectedItemIds = actual.filter(id => !expected.includes(id))
  if (missingItemIds.length || unexpectedItemIds.length) throw new Error(`Inventory count completeness failed; missing: ${missingItemIds.join(',') || 'none'}; unexpected: ${unexpectedItemIds.join(',') || 'none'}.`)
  for (const row of rows) if (!Number.isSafeInteger(row.targetInventoryValueCents) || !Number.isSafeInteger(row.glAmountCents) || row.glDifferenceCents !== safeAdd(row.targetInventoryValueCents, -row.glAmountCents)) throw new Error('Inventory valuation row is malformed or has an inconsistent GL difference.')
  const targetInventoryValueCents = rows.reduce((sum, row) => safeAdd(sum, row.targetInventoryValueCents), 0)
  const glAmountCents = rows.reduce((sum, row) => safeAdd(sum, row.glAmountCents), 0)
  const glDifferenceCents = safeAdd(targetInventoryValueCents, -glAmountCents)
  return { rows, targetInventoryValueCents, glAmountCents, glDifferenceCents, complete: true, reconciled: glDifferenceCents === 0 }
}

function validateAssetInput(input: HgbAssetValuationInput) {
  if (!input || typeof input !== 'object' || typeof input.id !== 'string' || !input.id.trim() || typeof input.description !== 'string' || !input.description.trim() || !validDate(input.acquisitionDate) || !validDate(input.availableForUseDate) || input.availableForUseDate < input.acquisitionDate || !validDate(input.fiscalPeriod.start) || !validDate(input.fiscalPeriod.end) || input.fiscalPeriod.start > input.fiscalPeriod.end || !hasStrictEvidenceIds(input.evidenceIds)) throw new Error('HGB asset valuation master data, period or evidence is incomplete.')
  for (const value of [input.usefulLifeMonths, input.residualValueCents, input.priorCumulativeImpairmentCents, input.glCarryingAmountCents]) requireNonnegativeSafe(value, 'HGB asset valuation values')
  if (input.usefulLifeMonths === 0) throw new Error('Asset useful life must be positive.')
  if (input.depreciationConvention !== 'FULL_MONTH') throw new Error('Only the explicitly configured full-month depreciation convention is supported.')
  for (const account of Object.values(input.accounts)) if (typeof account !== 'string' || !account.trim()) throw new Error('Adjustment proposal accounts must be explicit.')
  if (input.lowerValueAtPeriodEndCents !== undefined) requireNonnegativeSafe(input.lowerValueAtPeriodEndCents, 'Asset lower value')
  if (input.disposalDate !== undefined && (!validDate(input.disposalDate) || input.disposalDate < input.acquisitionDate || !hasStrictEvidenceIds(input.disposalEvidenceIds))) throw new Error('Asset disposal requires a valid date and evidence.')
}

function proposal(sourceId: string, reason: HgbAdjustmentProposal['reason'], amountCents: number, debitAccount: string, creditAccount: string, evidenceIds: readonly string[]): HgbAdjustmentProposal {
  requireNonnegativeSafe(amountCents, 'Adjustment amount')
  return { id: `${sourceId}:${reason}`, sourceId, reason, amountCents, debitAccount, creditAccount, evidenceIds: [...evidenceIds].sort(compareCanonicalText) }
}
function fifoClosingCost(layers: readonly InventoryLayer[], closingQuantity: number) { let remaining = closingQuantity; let amount = 0; for (const layer of [...layers].reverse()) { const used = Math.min(remaining, layer.quantity); amount = safeAdd(amount, safeMultiply(used, layer.unitCostCents)); remaining -= used; if (remaining === 0) break } if (remaining !== 0) throw new Error('Inventory count exceeds evidenced FIFO layers.'); return amount }
function cumulativeMonthlyDepreciation(depreciableCents: number, lifeMonths: number, availableDate: string, through: string) { if (through < availableDate) return 0; const start = new Date(`${availableDate}T00:00:00.000Z`); const end = new Date(`${through}T00:00:00.000Z`); const months = Math.min(lifeMonths, Math.max(0, (end.getUTCFullYear() - start.getUTCFullYear()) * 12 + end.getUTCMonth() - start.getUTCMonth() + 1)); return roundedRatio(depreciableCents, months, lifeMonths) }
function roundedRatio(amount: number, numerator: number, denominator: number) { if (denominator <= 0) { if (numerator === 0) return 0; throw new Error('Valuation ratio denominator must be positive.') } const product = BigInt(amount) * BigInt(numerator); const divisor = BigInt(denominator); const rounded = product / divisor + (product % divisor * BigInt(2) >= divisor ? BigInt(1) : BigInt(0)); if (rounded > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('HGB valuation arithmetic exceeds safe integer limits.'); return Number(rounded) }
function safeAdd(left: number, right: number) { const result = left + right; if (!Number.isSafeInteger(result)) throw new Error('HGB valuation arithmetic exceeds safe integer limits.'); return result }
function safeMultiply(left: number, right: number) { const result = BigInt(left) * BigInt(right); if (result > BigInt(Number.MAX_SAFE_INTEGER) || result < BigInt(Number.MIN_SAFE_INTEGER)) throw new Error('HGB valuation arithmetic exceeds safe integer limits.'); return Number(result) }
function requireNonnegativeSafe(value: number, label: string) { if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be nonnegative safe integers.`) }
function dense<T>(value: readonly T[], label: string): T[] { if (!Array.isArray(value)) throw new Error(`${label} must be a dense array.`); for (let index = 0; index < value.length; index++) if (!Object.hasOwn(value, index)) throw new Error(`${label} must be a dense array.`); return [...value] }
function validDate(value: unknown): value is string { if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false; const parsed = new Date(`${value}T00:00:00.000Z`); return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value }
function previousDay(value: string) { const date = new Date(`${value}T00:00:00.000Z`); date.setUTCDate(date.getUTCDate() - 1); return date.toISOString().slice(0, 10) }
