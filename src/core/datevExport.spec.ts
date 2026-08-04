import { describe, expect, it } from 'vitest'
import { parseDatevFiles } from './datev'
import { createDatevBookingBatch, datevBookingHeaders, splitEntry } from './datevExport'

const config = { consultantNumber: '29098', clientNumber: '55003', fiscalYearStart: '2026-01-01', periodStart: '2026-01-01', periodEnd: '2026-12-31', accountLength: 4, chart: 'SKR03' as const, generatedAt: '20260804120000000' }

describe('DATEV EXTF booking export', () => {
  it('Given a split VAT posting, when exported, then deterministic format-13 bytes round-trip to the exact ledger cents without tax automation', () => {
    const entry = { id: 'entry-1', bookingDate: '2026-07-23', documentNumber: 'RE-2026.1', description: 'Bürobedarf; geprüft', lines: [
      { accountNumber: 4930, category: 'EXPENSE' as const, debitCents: 10000, creditCents: 0 },
      { accountNumber: 1576, category: 'ASSET' as const, debitCents: 1900, creditCents: 0 },
      { accountNumber: 70001, category: 'LIABILITY' as const, debitCents: 0, creditCents: 11900 },
    ] }
    const first = createDatevBookingBatch(config, [entry]); const second = createDatevBookingBatch(config, [entry])
    expect(first).toEqual(second)
    expect([...first.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf])
    expect(datevBookingHeaders).toHaveLength(125)
    const parsed = parseDatevFiles([{ name: 'EXTF_Buchungsstapel.csv', bytes: first }])
    expect(parsed.bookings.map(item => ({ amountCents: item.amountCents, accountNumber: item.accountNumber, contraAccountNumber: item.contraAccountNumber, taxCode: item.taxCode }))).toEqual([
      { amountCents: 10000, accountNumber: 4930, contraAccountNumber: 70001, taxCode: '40' },
      { amountCents: 1900, accountNumber: 1576, contraAccountNumber: 70001, taxCode: undefined },
    ])
  })

  it('Given an unbalanced or signed posting, when pairing is attempted, then export fails closed', () => {
    expect(() => splitEntry({ id: 'bad', bookingDate: '2026-01-01', documentNumber: '', description: '', lines: [{ accountNumber: 1200, category: 'ASSET', debitCents: 100, creditCents: 0 }] })).toThrow(/not balanced/)
    expect(() => splitEntry({ id: 'signed', bookingDate: '2026-01-01', documentNumber: '', description: '', lines: [{ accountNumber: 1200, category: 'ASSET', debitCents: -100, creditCents: 0 }, { accountNumber: 1600, category: 'LIABILITY', debitCents: 0, creditCents: -100 }] })).toThrow(/signed/)
  })
})
