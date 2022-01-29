import { Account } from "./Account";

export class Payment {
  account: Account
  amount: number

  constructor(account: Account, amount: number) {
    this.account = account
    this.amount = amount
  }
}
