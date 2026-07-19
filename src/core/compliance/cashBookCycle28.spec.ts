import { describe, expect, it } from 'vitest'
import { addCashEntry, exportCashAudit, type CashBook } from './cashBook'

const book = (): CashBook => ({ id: 'cash-cycle-28', tenantId: 'tenant-a', location: 'Berlin', register: 'Register 1', timeZone: 'Europe/Berlin', currency: 'EUR', glAccountId: '1000', retainedThrough: '2036-12-31', entries: [], closes: [] })
const entry = (occurredAt: string, createdAt: string) => ({ journalEntryId: 'cash-2026-07-17', occurredAt, businessDate: '2026-07-17', type: 'RECEIPT' as const, amountCents: 100, description: 'Cash receipt', evidenceIds: ['receipt'], createdAt, createdBy: 'cashier', source: 'MANUAL' as const })

describe('cycle 28 cash append chronology', () => {
  it('rejects an append created before the previous append even when it occurred later', () => {
    const first = addCashEntry(book(), entry('2026-07-17T09:00:00Z', '2026-07-17T12:00:00Z')).book
    expect(() => addCashEntry(first, entry('2026-07-17T10:00:00Z', '2026-07-17T11:00:00Z'))).toThrow('append chronology')
  })

  it('rejects persisted chains whose creation instants decrease while occurrence instants increase', () => {
    const first = addCashEntry(book(), entry('2026-07-17T09:00:00Z', '2026-07-17T12:00:00Z')).book
    const second = { ...first.entries[0], id: 'cash-cycle-28:2', sequence: 2, occurredAt: '2026-07-17T10:00:00.000Z', createdAt: '2026-07-17T11:00:00.000Z' }
    expect(() => exportCashAudit({ ...first, entries: [...first.entries, second] })).toThrow('append chronology')
  })
})
