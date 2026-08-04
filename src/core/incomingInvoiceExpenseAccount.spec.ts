import { describe, expect, it } from 'vitest'
import { recommendIncomingInvoiceExpenseAccount } from './incomingInvoiceExpenseAccount'

const account = (id: string, number: number, name: string, eBilanzPosition: string | null = 'is.netIncome.regular.operatingTC.otherCost') => ({ id, number, name, eBilanzPosition })

describe('incoming supplier invoice expense-account recommendation', () => {
  it('Given an expanded SKR03 chart, when a default is requested, then general office expense 4930 is preferred over depreciation 4830', () => {
    expect(recommendIncomingInvoiceExpenseAccount('SKR03', 4, [
      account('depreciation', 4830, 'Abschreibungen auf Sachanlagen', 'is.netIncome.regular.operatingTC.deprAmort.fixAss.tan'),
      account('office', 4930, 'Bürobedarf'),
    ])).toBe('office')
  })

  it('Given no chart-specific preference, when ordinary expenses exist, then the lowest numbered non-depreciation account is the stable fallback', () => {
    expect(recommendIncomingInvoiceExpenseAccount('CUSTOM', 4, [
      account('later', 4990, 'Sonstiger Aufwand'),
      account('depreciation', 100, 'Depreciation expense', null),
      account('earlier', 4920, 'Telekommunikation'),
    ])).toBe('earlier')
  })

  it('Given only depreciation accounts, when a default is requested, then no unsafe account is preselected', () => {
    expect(recommendIncomingInvoiceExpenseAccount('SKR04', 4, [
      account('depreciation', 6220, 'Abschreibungen auf Sachanlagen', 'is.netIncome.regular.operatingTC.deprAmort.fixAss.tan'),
    ])).toBeNull()
  })
})
