import { describe, expect, it } from 'vitest'
import { createMonthlyDepreciationSchedule, fixedAssetFullRetirementFacts, fixedAssetFullSaleFacts, rejectUnsupportedAssetOperation, scheduledDepreciationForPeriod, type RegisteredFixedAsset } from './fixedAssets'

const asset: RegisteredFixedAsset = { id: 'asset-1', tenantId: 'tenant-a', description: 'Laptop', costCents: 100, acquisitionDate: '2026-01-10', availableForUseDate: '2026-01-10', location: 'Berlin office', usefulLifeMonths: 3, method: 'STRAIGHT_LINE', taxUsefulLifeMonths: 3, taxMethod: 'STRAIGHT_LINE', evidenceIds: ['document-1'], assetAccountId: 'asset-account', depreciationExpenseAccountId: 'expense-account', sourceDocumentId: 'document-1', acquisitionJournalLineId: 'acquisition-line-1' }

describe('German small-company fixed-asset schedule', () => {
  it('allocates exact cents deterministically over full months without losing a cent', () => {
    expect(createMonthlyDepreciationSchedule(asset)).toEqual([
      { period: '2026-01', postingDate: '2026-01-31', amountCents: 33, cumulativeCents: 33, carryingAmountCents: 67, status: 'SCHEDULED' },
      { period: '2026-02', postingDate: '2026-02-28', amountCents: 34, cumulativeCents: 67, carryingAmountCents: 33, status: 'SCHEDULED' },
      { period: '2026-03', postingDate: '2026-03-31', amountCents: 33, cumulativeCents: 100, carryingAmountCents: 0, status: 'SCHEDULED' },
    ])
  })

  it('returns one authoritative monthly amount for ledger posting', () => {
    expect(scheduledDepreciationForPeriod(asset, '2026-02')).toMatchObject({ amountCents: 34, postingDate: '2026-02-28' })
  })

  it('marks posted depreciation and its append-only reversal in the schedule', () => {
    const depreciation = { id: 'dep', assetId: asset.id, sequence: 1, type: 'DEPRECIATION' as const, effectiveDate: '2026-01-31', amountCents: 33, approvedBy: 'user', approvedAt: '2026-01-31T12:00:00.000Z', postingId: 'journal', evidenceIds: ['document-1'] }
    const reversal = { ...depreciation, id: 'reverse', sequence: 2, type: 'REVERSAL' as const, effectiveDate: '2026-02-28', reversesEventId: depreciation.id, postingId: 'reversal-journal' }
    expect(createMonthlyDepreciationSchedule(asset, [depreciation])[0].status).toBe('POSTED')
    expect(createMonthlyDepreciationSchedule(asset, [depreciation, reversal])[0].status).toBe('REVERSED')
  })

  it('fails closed for special tax depreciation, divergent tax lives, and partial disposal', () => {
    expect(() => createMonthlyDepreciationSchedule({ ...asset, taxMethod: 'NO_DEPRECIATION' })).toThrow(/special tax/)
    expect(() => createMonthlyDepreciationSchedule({ ...asset, taxUsefulLifeMonths: 6 })).toThrow(/deferred-tax/)
    expect(() => rejectUnsupportedAssetOperation('PARTIAL_DISPOSAL')).toThrow(/outside/)
  })

  it('Given an evidenced partially depreciated asset, when full retirement is prepared, then the exact equal book/tax carrying amount is derecognized', () => {
    const events = [{ id: 'depr', assetId: asset.id, sequence: 1, type: 'DEPRECIATION' as const, effectiveDate: '2026-01-31', amountCents: 33, bookAmountCents: 33, taxAmountCents: 33, approvedBy: 'accountant', approvedAt: '2026-01-31T12:00:00Z', postingId: 'journal-1', evidenceIds: ['document-1'] }]
    expect(fixedAssetFullRetirementFacts(asset, events, '2026-02-15')).toEqual({ carryingAmountCents: 67, taxCarryingAmountCents: 67, location: 'Berlin office' })
  })

  it('Given future lifecycle facts, an existing disposal, or zero carrying value, when retirement is prepared, then it fails closed instead of fabricating a disposal posting', () => {
    const depreciation = (id: string, sequence: number, effectiveDate: string, amountCents: number) => ({ id, assetId: asset.id, sequence, type: 'DEPRECIATION' as const, effectiveDate, amountCents, approvedBy: 'accountant', approvedAt: `${effectiveDate}T12:00:00Z`, postingId: `journal-${id}`, evidenceIds: ['document-1'] })
    expect(() => fixedAssetFullRetirementFacts(asset, [depreciation('future', 1, '2026-02-28', 67)], '2026-01-31')).toThrow(/later lifecycle event/)
    const disposal = { id: 'dispose', assetId: asset.id, sequence: 1, type: 'DISPOSAL' as const, effectiveDate: '2026-02-15', amountCents: 0, approvedBy: 'accountant', approvedAt: '2026-02-15T12:00:00Z', postingId: 'journal-dispose', evidenceIds: ['retirement'] }
    expect(() => fixedAssetFullRetirementFacts(asset, [disposal], '2026-02-15')).toThrow(/already retired/)
    expect(() => fixedAssetFullRetirementFacts(asset, [depreciation('full', 1, '2026-03-31', 100)], '2026-03-31')).toThrow(/fully depreciated/)
  })

  it('Given a partially depreciated asset and domestic net proceeds, when a full sale is prepared, then carrying value, 19% output VAT, gross receivable, and gain are exact', () => {
    const depreciation = { id: 'depr', assetId: asset.id, sequence: 1, type: 'DEPRECIATION' as const, effectiveDate: '2026-01-31', amountCents: 33, bookAmountCents: 33, taxAmountCents: 33, approvedBy: 'accountant', approvedAt: '2026-01-31T12:00:00Z', postingId: 'journal-1', evidenceIds: ['document-1'] }
    expect(fixedAssetFullSaleFacts(asset, [depreciation], '2026-02-15', 100, 1900)).toEqual({ carryingAmountCents: 67, taxCarryingAmountCents: 67, location: 'Berlin office', netProceedsCents: 100, vatRateBasisPoints: 1900, outputVatCents: 19, grossProceedsCents: 119, gainLossCents: 33, result: 'GAIN' })
    expect(fixedAssetFullSaleFacts(asset, [depreciation], '2026-02-15', 50, 1900)).toMatchObject({ gainLossCents: -17, result: 'LOSS' })
  })

  it('Given unsupported or unsafe sale claims, when facts are prepared, then no approximate or untaxed sale is produced', () => {
    expect(() => fixedAssetFullSaleFacts(asset, [], '2026-02-15', 0, 1900)).toThrow(/positive integer cents/)
    expect(() => fixedAssetFullSaleFacts(asset, [], '2026-02-15', 100, 0)).toThrow(/standard 19%/)
    expect(() => fixedAssetFullSaleFacts(asset, [], '2026-02-15', Number.MAX_SAFE_INTEGER, 1900)).toThrow(/safe integer/)
  })
})
