import { describe, expect, it } from 'vitest'
import { applyAssetEvents, type AssetEvent, type FixedAsset } from './assetsInventory'

const asset: FixedAsset = {
  id: 'asset-review', tenantId: 'tenant-review', description: 'Machine', costCents: 10_000,
  acquisitionDate: '2026-01-01', availableForUseDate: '2026-01-01', location: 'Berlin',
  usefulLifeMonths: 60, method: 'NO_DEPRECIATION', taxUsefulLifeMonths: 60,
  taxMethod: 'NO_DEPRECIATION', evidenceIds: ['invoice'],
}

describe('asset approval chronology review regression', () => {
  it('rejects an approved movement whose signed local calendar date predates its effective date', () => {
    const event: AssetEvent = {
      id: 'transfer-1', assetId: asset.id, sequence: 1, type: 'TRANSFER', effectiveDate: '2027-01-01',
      amountCents: 0, fromLocation: 'Berlin', toLocation: 'Hamburg', approvedBy: 'Controller',
      approvedAt: '2026-12-31T23:59:59+01:00', postingId: 'journal-1', evidenceIds: [],
    }
    expect(() => applyAssetEvents(asset, [event], '2027-12-31')).toThrow('approval cannot predate')
    expect(() => applyAssetEvents(asset, [{ ...event, approvedAt: '2027-01-01T00:00:00+01:00' }], '2027-12-31')).not.toThrow()
    expect(() => applyAssetEvents(asset, [{ ...event, approvedAt: '2027-01-01T00:30:00+14:00' }], '2027-12-31')).toThrow('authoritative German timezone')
    expect(() => applyAssetEvents(asset, [{ ...event, approvedAt: '2026-12-31T23:30:00-02:00' }], '2027-12-31')).not.toThrow()
  })
})
