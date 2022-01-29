import type { Account } from './Account'
import type { AccountPurpose } from './AccountPurpose'

export class AccountPurposeToAccountMapping {
  _map: Map<AccountPurpose, Account> = new Map()

  map(accountPurpose: AccountPurpose, account: Account) {
    this._map.set(accountPurpose, account)
  }

  get(accountPurpose: AccountPurpose): Account | null {
    return this._map.get(accountPurpose) ?? null
  }
}
