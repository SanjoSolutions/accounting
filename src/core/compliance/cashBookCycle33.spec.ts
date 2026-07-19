import { describe, expect, it } from 'vitest'
import { addCashEntry, closeCashDay, exportCashAudit, type CashBook } from './cashBook'

const book = (): CashBook => ({ id: 'cash-cycle-33', tenantId: 'tenant-a', location: 'Berlin', register: 'Register 1', timeZone: 'Europe/Berlin', currency: 'EUR', glAccountId: '1000', retainedThrough: '2036-12-31', entries: [], closes: [] })
const entry = { journalEntryId: 'cash-2026-07-17', occurredAt: '2026-07-17T09:00:00Z', businessDate: '2026-07-17', type: 'RECEIPT' as const, amountCents: 100, description: 'Cash receipt', evidenceIds: ['receipt'], createdAt: '2026-07-17T09:01:00Z', createdBy: 'cashier', source: 'MANUAL' as const }

describe('cycle 33 persisted cash close frontier', () => {
  it('rejects a later-sequence July 18 entry appended behind a July 20 empty close', () => {
    const entered = addCashEntry(book(), entry).book
    const july17 = closeCashDay(entered, { businessDate: '2026-07-17', countedBalanceCents: 100, signedBy: 'cashier', signedAt: '2026-07-17T20:00:00Z', approvedBy: 'manager', approvedAt: '2026-07-17T20:01:00Z' }).book
    const july20 = closeCashDay(july17, { businessDate: '2026-07-20', countedBalanceCents: 100, signedBy: 'cashier', signedAt: '2026-07-20T20:00:00Z', approvedBy: 'manager', approvedAt: '2026-07-20T20:01:00Z' }).book
    const backdated = { ...july20.entries[0], id: 'cash-cycle-33:2', sequence: 2, occurredAt: '2026-07-18T09:00:00.000Z', businessDate: '2026-07-18', createdAt: '2026-07-18T09:01:00.000Z' }
    expect(() => exportCashAudit({ ...july20, entries: [...july20.entries, backdated] })).toThrow('cannot target an already closed business date')
  })
})
