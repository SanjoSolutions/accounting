import { describe, it } from '@jest/globals'
import { Account } from './Account'
import { ChartOfAccounts } from './ChartOfAccounts'
import { createAccount } from './data_fixtures/createAccount'

describe('ChartOfAccounts', () => {
  it('defines accounts with its purposes', () => {
    const chartOfAccounts = new ChartOfAccounts()
    chartOfAccounts.addAccount(createAccount())
  })
})
