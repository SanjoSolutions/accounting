import { describe, expect, it } from 'vitest'
import { closePhysicalInventory, createAssetSchedules, type FixedAsset, type InventoryCount, type InventoryItem } from './assetsInventory'

const tenantId = 'tenant-cycle-35'
const period = { start: '2026-01-01', end: '2026-12-31', timeZone: 'Europe/Berlin' }
const asset = (id: string): FixedAsset => ({ id, tenantId, description: id, costCents: 1200, acquisitionDate: '2026-01-01', availableForUseDate: '2026-01-01', location: 'Berlin', usefulLifeMonths: 12, method: 'NO_DEPRECIATION', taxUsefulLifeMonths: 12, taxMethod: 'NO_DEPRECIATION', evidenceIds: [`evidence-${id}`] })
const item = (id: string): InventoryItem => ({ id, tenantId, sku: id, description: id, location: 'Berlin', quantity: 2, unitCostCents: 100 })
const count = (itemId: string): InventoryCount => ({ itemId, countedQuantity: 2, countedBy: 'counter', countedAt: '2026-12-31T12:00:00Z', evidenceIds: [`count-${itemId}`], approvedBy: 'approver', approvedAt: '2026-12-31T13:00:00Z' })

describe('cycle 35 canonical asset and physical inventory rows', () => {
  it('sorts both statutory fixed-asset schedules by stable asset ID', () => {
    const first = createAssetSchedules(tenantId, [asset('z-asset'), asset('a-asset')], [], period)
    const second = createAssetSchedules(tenantId, [asset('a-asset'), asset('z-asset')], [], period)
    expect(second).toEqual(first)
    expect(first.hgbAnlagenspiegel.map(row => row.assetId)).toEqual(['a-asset', 'z-asset'])
    expect(first.eBilanzAnlagenverzeichnis.map(row => row.assetId)).toEqual(['a-asset', 'z-asset'])
  })

  it('sorts completed physical inventory rows before immutable payload and checksum creation', () => {
    const first = closePhysicalInventory(tenantId, period, [item('z-item'), item('a-item')], [count('z-item'), count('a-item')], '2026-12-31T14:00:00Z')
    const second = closePhysicalInventory(tenantId, period, [item('a-item'), item('z-item')], [count('a-item'), count('z-item')], '2026-12-31T14:00:00Z')
    expect(second).toEqual(first)
    expect(first.rows.map(row => row.id)).toEqual(['a-item', 'z-item'])
  })
})
