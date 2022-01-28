import { Account } from './Account.js'

export class Ledger {
  accounts: Map<string, Account> = new Map()

  addAccount(account: Account) {
    this.accounts.set(account.name, account)
  }
}
