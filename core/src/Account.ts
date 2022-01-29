import type { AccountEntry } from "./AccountEntry.js"

export class Account {
  number: number | null
  name: string
  debit: AccountEntry[] = []
  credit: AccountEntry[] = []

  constructor(number: number | null, name: string) {
    this.number = number
    this.name = name
  }
}
