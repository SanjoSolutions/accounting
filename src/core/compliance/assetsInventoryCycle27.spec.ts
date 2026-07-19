import { describe, expect, it } from 'vitest'
import { closePhysicalInventory, type InventoryCount, type InventoryItem } from './assetsInventory'

const period = { start: '2026-01-01', end: '2026-12-31', timeZone: 'Europe/Berlin' }
const closedAt = '2026-12-31T15:00:00Z'
const item: InventoryItem = { id: 'item-1', tenantId: 'tenant-a', sku: 'SKU', description: 'Part', location: 'Warehouse', quantity: 1, unitCostCents: 100 }
const count: InventoryCount = { itemId: item.id, countedQuantity: 1, countedBy: 'Counter', countedAt: '2026-12-31T12:00:00Z', evidenceIds: ['photo'], approvedBy: 'Approver', approvedAt: '2026-12-31T14:00:00Z' }

describe('cycle 27 physical inventory tenant validation', () => {
  it('normalizes the supplied tenant before sealing, including an empty inventory', () => {
    const closed = closePhysicalInventory('  tenant-a  ', period, [], [], closedAt)
    expect(closed.tenantId).toBe('tenant-a')
    expect(JSON.parse(closed.immutablePayload)).toMatchObject({ tenantId: 'tenant-a', rows: [] })
  })

  it('rejects a whitespace tenant even when there are no records to filter', () => {
    expect(() => closePhysicalInventory('   ', period, [], [], closedAt)).toThrow('Inventory tenantId must be nonblank')
  })

  it('rejects blank and mismatched item tenants instead of silently filtering them', () => {
    expect(() => closePhysicalInventory('tenant-a', period, [{ ...item, tenantId: ' ' }], [count], closedAt)).toThrow('blank or mismatched tenantId')
    expect(() => closePhysicalInventory('tenant-a', period, [{ ...item, tenantId: 'tenant-b' }], [count], closedAt)).toThrow('blank or mismatched tenantId')
    expect(closePhysicalInventory(' tenant-a ', period, [item], [count], closedAt).rows[0].tenantId).toBe('tenant-a')
  })
})
