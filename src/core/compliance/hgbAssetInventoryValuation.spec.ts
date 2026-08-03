import { describe, expect, it } from 'vitest'
import { calculateHgbCostBasis, createHgbAssetValuation, createHgbInventorySchedule, createHgbInventoryValuation, createHgbSubledgerReconciliation, type HgbAssetValuationInput, type HgbInventoryValuationInput } from './hgbAssetInventoryValuation'

const accounts = { assetAccount: '0200', expenseAccount: '6200', incomeAccount: '4840' }
const assetInput = (patch: Partial<HgbAssetValuationInput> = {}): HgbAssetValuationInput => ({
  id: 'machine-1', description: 'Machine', costBasisKind: 'ACQUISITION',
  costComponents: [
    { id: 'invoice', type: 'PURCHASE_PRICE', amountCents: 122_000, evidenceIds: ['invoice.pdf'] },
    { id: 'discount', type: 'PURCHASE_PRICE_REDUCTION', amountCents: 2_000, evidenceIds: ['credit-note.pdf'] },
  ],
  acquisitionDate: '2025-04-10', availableForUseDate: '2025-04-15', usefulLifeMonths: 36, depreciationConvention: 'FULL_MONTH', residualValueCents: 12_000,
  fiscalPeriod: { start: '2026-07-01', end: '2027-06-30' }, priorCumulativeImpairmentCents: 0,
  lowerValueAtPeriodEndCents: 30_000, glCarryingAmountCents: 30_000, accounts, evidenceIds: ['useful-life-review.pdf'], ...patch,
})

const inventoryInput = (patch: Partial<HgbInventoryValuationInput> = {}): HgbInventoryValuationInput => ({
  id: 'sku-1', formula: 'FIFO',
  layers: [
    { id: 'layer-a', date: '2026-01-01', quantity: 10, unitCostCents: 100, evidenceIds: ['receipt-a'] },
    { id: 'layer-b', date: '2026-06-01', quantity: 10, unitCostCents: 200, evidenceIds: ['receipt-b'] },
  ],
  issuedQuantity: 8, expectedQuantity: 12, countedQuantity: 11, countEvidenceIds: ['count-sheet'],
  replacementCostPerUnitCents: 180, netRealizableValuePerUnitCents: 190, priorWriteDownCents: 0,
  glAmountCents: 1_980, accounts, ...patch,
})

describe('HGB fixed-asset valuation', () => {
  it('builds evidenced acquisition and production cost bases and rejects mixed or incomplete costing', () => {
    expect(calculateHgbCostBasis('ACQUISITION', assetInput().costComponents).amountCents).toBe(120_000)
    expect(calculateHgbCostBasis('PRODUCTION', [
      { id: 'material', type: 'DIRECT_MATERIAL', amountCents: 10_000, evidenceIds: ['bom'] },
      { id: 'labour', type: 'DIRECT_LABOUR', amountCents: 5_000, evidenceIds: ['time-sheet'] },
      { id: 'overhead', type: 'PRODUCTION_OVERHEAD', amountCents: 2_000, evidenceIds: ['allocation'] },
    ]).amountCents).toBe(17_000)
    expect(() => calculateHgbCostBasis('PRODUCTION', [{ id: 'material', type: 'DIRECT_MATERIAL', amountCents: 1, evidenceIds: ['bom'] }])).toThrow('direct material and direct labour')
    expect(() => calculateHgbCostBasis('ACQUISITION', [{ id: 'labour', type: 'DIRECT_LABOUR', amountCents: 1, evidenceIds: ['time'] }])).toThrow('unsupported or inapplicable')
  })

  it('calculates non-calendar partial-period depreciation, impairment and deterministic postings', () => {
    const result = createHgbAssetValuation(assetInput())
    expect(result).toMatchObject({ costBasisCents: 120_000, openingScheduledDepreciationCents: 45_000, periodDepreciationCents: 36_000, closingScheduledDepreciationCents: 81_000, targetImpairmentCents: 9_000, targetCarryingAmountCents: 30_000, reconciled: true })
    expect(result.proposals.map(row => [row.id, row.amountCents])).toEqual([
      ['machine-1:DEPRECIATION', 36_000],
      ['machine-1:IMPAIRMENT', 9_000],
    ])
  })

  it('limits reversals to unimpaired carrying amount and derecognizes an evidenced disposal', () => {
    const reversal = createHgbAssetValuation(assetInput({ priorCumulativeImpairmentCents: 9_000, lowerValueAtPeriodEndCents: undefined, glCarryingAmountCents: 39_000 }))
    expect(reversal.impairmentMovementCents).toBe(-9_000)
    expect(reversal.proposals.some(row => row.reason === 'IMPAIRMENT_REVERSAL' && row.amountCents === 9_000)).toBe(true)
    const disposal = createHgbAssetValuation(assetInput({ disposalDate: '2027-03-20', disposalEvidenceIds: ['sale-contract'], lowerValueAtPeriodEndCents: undefined, glCarryingAmountCents: 0 }))
    expect(disposal).toMatchObject({ disposed: true, targetCarryingAmountCents: 0, periodDepreciationCents: 27_000 })
    expect(disposal.proposals.find(row => row.reason === 'DISPOSAL')?.evidenceIds).toEqual(['sale-contract'])
    expect(() => createHgbAssetValuation(assetInput({ lowerValueAtPeriodEndCents: 40_000 }))).toThrow('cannot exceed the unimpaired carrying amount')
  })

  it('fails closed for unsafe arithmetic or missing evidence', () => {
    expect(() => createHgbAssetValuation(assetInput({ evidenceIds: [] }))).toThrow('incomplete')
    expect(() => calculateHgbCostBasis('ACQUISITION', [{ id: 'a', type: 'PURCHASE_PRICE', amountCents: Number.MAX_SAFE_INTEGER, evidenceIds: ['a'] }, { id: 'b', type: 'ACQUISITION_INCIDENTAL', amountCents: 1, evidenceIds: ['b'] }])).toThrow('safe integer')
  })
})

describe('HGB inventory valuation', () => {
  it('values FIFO layers, physical-count differences and the strict lower value deterministically', () => {
    const result = createHgbInventoryValuation(inventoryInput())
    expect(result).toMatchObject({ receivedQuantity: 20, expectedQuantity: 12, countedQuantity: 11, countDifferenceQuantity: -1, costForCountedQuantityCents: 2_100, lowerUnitValueCents: 180, targetWriteDownCents: 120, targetInventoryValueCents: 1_980, reconciled: true })
    expect(result.proposals.map(row => [row.reason, row.amountCents])).toEqual([['INVENTORY_COUNT', 100], ['INVENTORY_WRITEDOWN', 120]])
  })

  it('supports weighted average and reverses a prior write-down only up to the cost ceiling', () => {
    const result = createHgbInventoryValuation(inventoryInput({ formula: 'WEIGHTED_AVERAGE', replacementCostPerUnitCents: 160, netRealizableValuePerUnitCents: 170, priorWriteDownCents: 100, glAmountCents: 1_650 }))
    expect(result).toMatchObject({ costForCountedQuantityCents: 1_650, targetWriteDownCents: 0, writeDownMovementCents: -100, targetInventoryValueCents: 1_650 })
    expect(result.proposals.find(row => row.reason === 'INVENTORY_REVERSAL')?.amountCents).toBe(100)
  })

  it('rejects LIFO, unexplained quantities, missing count evidence and unsafe multiplication', () => {
    expect(() => createHgbInventoryValuation(inventoryInput({ formula: 'LIFO' }))).toThrow('outside the explicitly supported')
    expect(() => createHgbInventoryValuation(inventoryInput({ expectedQuantity: 13 }))).toThrow('does not reconcile')
    expect(() => createHgbInventoryValuation(inventoryInput({ countEvidenceIds: [] }))).toThrow('physical-count evidence')
    expect(() => createHgbInventoryValuation(inventoryInput({ layers: [{ id: 'huge', date: '2026-01-01', quantity: Number.MAX_SAFE_INTEGER, unitCostCents: 2, evidenceIds: ['receipt'] }], issuedQuantity: 0, expectedQuantity: Number.MAX_SAFE_INTEGER, countedQuantity: Number.MAX_SAFE_INTEGER }))).toThrow('safe integer')
  })

  it('requires complete item coverage and reconciles every asset and inventory row to the GL', () => {
    const inventory = createHgbInventoryValuation(inventoryInput())
    const asset = createHgbAssetValuation(assetInput())
    expect(createHgbInventorySchedule(['sku-1'], [inventory])).toMatchObject({ complete: true, reconciled: true, targetInventoryValueCents: 1_980 })
    expect(() => createHgbInventorySchedule(['sku-1', 'sku-2'], [inventory])).toThrow('missing: sku-2')
    expect(createHgbSubledgerReconciliation([asset], [inventory])).toMatchObject({ canClose: true, assetDifferenceCents: 0, inventoryDifferenceCents: 0 })
    const mismatch = createHgbInventoryValuation(inventoryInput({ glAmountCents: 2_000 }))
    expect(createHgbSubledgerReconciliation([asset], [mismatch])).toMatchObject({ canClose: false, inventoryDifferenceCents: -20 })
    expect(() => createHgbSubledgerReconciliation([asset], [{ ...mismatch, glDifferenceCents: 0, reconciled: true }])).toThrow('inconsistent GL difference')
  })
})
