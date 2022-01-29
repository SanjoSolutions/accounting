import { describe, it } from '@jest/globals'
import { Account } from './Account'
import { createAccount } from './data_fixtures/createAccount'

describe('Account', () => {
  it('can be booked on', () => {
    const account = createAccount()
  })
})
