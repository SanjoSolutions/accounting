import { describe, expect, it } from 'vitest'
import { addCashEntry, exportCashAudit, type CashBook } from './cashBook'

const book = (): CashBook => ({ id: 'cash-cycle-29', tenantId: 'tenant-a', location: 'Berlin', register: 'Register 1', timeZone: 'Europe/Berlin', currency: 'EUR', glAccountId: '1000', retainedThrough: '2036-12-31', entries: [], closes: [] })
const entry = () => ({ journalEntryId: 'cash-2026-07-17', occurredAt: '2026-07-17T09:00:00Z', businessDate: '2026-07-17', type: 'RECEIPT' as const, amountCents: 100, description: 'Cash receipt', evidenceIds: ['receipt'], createdAt: '2026-07-17T09:01:00Z', createdBy: 'cashier', source: 'MANUAL' as const })

describe('cycle 29 cash correction relationship presence', () => {
  it('rejects blank relationship fields on otherwise normal appended entries', () => {
    expect(() => addCashEntry(book(), { ...entry(), correctsEntryId: '' })).toThrow('relationship IDs must be nonblank')
    expect(() => addCashEntry(book(), { ...entry(), replacementEntryId: '   ' })).toThrow('relationship IDs must be nonblank')
  })

  it('omits explicitly undefined relationship fields instead of sealing them', () => {
    const appended = addCashEntry(book(), { ...entry(), correctsEntryId: undefined, replacementEntryId: undefined }).entry
    expect(Object.hasOwn(appended, 'correctsEntryId')).toBe(false)
    expect(Object.hasOwn(appended, 'replacementEntryId')).toBe(false)
  })

  it('rejects persisted blank relationship fields by own-property presence', () => {
    const valid = addCashEntry(book(), entry()).book
    expect(() => exportCashAudit({ ...valid, entries: [{ ...valid.entries[0], correctsEntryId: '' }] })).toThrow('relationship IDs must be nonblank')
    expect(() => exportCashAudit({ ...valid, entries: [{ ...valid.entries[0], replacementEntryId: ' ' }] })).toThrow('relationship IDs must be nonblank')
  })
})
