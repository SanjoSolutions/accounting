import { describe, it } from 'vitest'
import { Account } from './Account'
import { createAccount } from './data_fixtures/createAccount'

describe('Account', () => {
  it('can be booked on', () => {
    const account = createAccount()
  })
})
