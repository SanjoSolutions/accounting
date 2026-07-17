import { describe, expect, it } from 'vitest'
import { Account } from './Account'
import {
  chartOfAccountsStandards,
  chartOfAccountsStandardLabel,
  ChartOfAccounts,
  isChartOfAccountsStandard,
} from './ChartOfAccounts'
import { createAccount } from './data_fixtures/createAccount'

describe('ChartOfAccounts', () => {
  it('defines accounts with its purposes', () => {
    const chartOfAccounts = new ChartOfAccounts()
    chartOfAccounts.addAccount(createAccount())
  })

  it('supports exactly SKR03 and SKR04 as configurable standards', () => {
    expect(chartOfAccountsStandards).toEqual(['SKR03', 'SKR04'])
    expect(isChartOfAccountsStandard('SKR03')).toBe(true)
    expect(isChartOfAccountsStandard('SKR04')).toBe(true)
    expect(isChartOfAccountsStandard('SKR05')).toBe(false)
    expect(chartOfAccountsStandards.map(chartOfAccountsStandardLabel)).toEqual(['SKR 03', 'SKR 04'])
  })
})
