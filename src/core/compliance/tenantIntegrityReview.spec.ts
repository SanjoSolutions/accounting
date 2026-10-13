import { describe, expect, test } from 'vitest'
import { addCashEntry, closeCashDay, exportCashAudit, type CashBook } from './cashBook'
import { applyAssetEvents, createAssetSchedules, closePhysicalInventory, type FixedAsset } from './assetsInventory'

const book: CashBook = { id: 'cash', tenantId: 'tenant-a', location: 'Berlin', register: 'R1', timeZone: 'Europe/Berlin', currency: 'EUR', glAccountId: '1000', retainedThrough: '2036-12-31', entries: [], closes: [] }
const entry = { journalEntryId: 'journal-1', occurredAt: '2026-12-31T09:00:00Z', businessDate: '2026-12-31', type: 'RECEIPT' as const, amountCents: 100, description: 'Synthetic receipt', evidenceIds: ['receipt'], createdAt: '2026-12-31T09:01:00Z', createdBy: 'cashier', source: 'MANUAL' as const }
const period = { start: '2026-01-01', end: '2026-12-31' }
const asset: FixedAsset = { id: 'asset', tenantId: 'tenant-a', description: 'Machine', costCents: 1200, acquisitionDate: '2026-01-01', availableForUseDate: '2026-01-01', location: 'Berlin', usefulLifeMonths: 12, method: 'NO_DEPRECIATION', taxUsefulLifeMonths: 12, taxMethod: 'NO_DEPRECIATION', evidenceIds: ['invoice'] }

describe('independent canonical tenant boundary review', () => {
  test.each(['id', 'tenantId', 'glAccountId'] as const)('Given a padded cash %s, when appending, closing or exporting, then the aggregate rejects a second spelling of its identity', field => {
    const padded = { ...book, [field]: ` ${book[field]} ` }
    expect(() => addCashEntry(padded, entry)).toThrow(/canonical/)
    expect(() => closeCashDay(padded, { businessDate: '2026-12-31', countedBalanceCents: 0, signedBy: 'cashier', signedAt: '2026-12-31T20:00:00Z', approvedBy: 'manager', approvedAt: '2026-12-31T20:01:00Z' })).toThrow(/canonical/)
    expect(() => exportCashAudit(padded)).toThrow(/canonical/)
  })

  test('Given a padded asset tenant even in an empty schedule, when schedules or asset state are built, then canonical identity is required', () => {
    expect(() => createAssetSchedules(' tenant-a ', [], [], period)).toThrow(/canonical/)
    expect(() => createAssetSchedules(' tenant-a ', [{ ...asset, tenantId: ' tenant-a ' }], [], period)).toThrow(/canonical/)
    expect(() => applyAssetEvents({ ...asset, tenantId: ' tenant-a ' }, [], period.end)).toThrow(/canonical/)
  })

  test('Given a canonical tenant, when another tenant supplies an asset or inventory item, then the aggregate rejects cross-tenant reuse', () => {
    expect(() => createAssetSchedules('tenant-b', [asset], [], period)).toThrow(/tenant identity/)
    expect(() => closePhysicalInventory('tenant-b', { ...period, timeZone: 'Europe/Berlin' }, [{ id: 'item', tenantId: 'tenant-a', sku: 's', description: 'stock', location: 'Berlin', quantity: 1, unitCostCents: 10 }], [], '2027-01-01T10:00:00Z')).toThrow(/tenant/)
  })
})
