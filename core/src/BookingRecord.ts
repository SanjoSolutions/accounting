import type { Account } from "./Account"
import type { Document } from "./Document"

export class BookingRecord {
  date: Date
  debitSide: BookingRecordElement[]
  creditSide: BookingRecordElement[]

  constructor(date: Date, debitSide: BookingRecordElement[], creditSide: BookingRecordElement[]) {
    this.date = date
    this.debitSide = debitSide
    this.creditSide = creditSide
  }
}

export class BookingRecordElement {
  document: Document
  account: Account
  amount: number

  constructor(document: Document, account: Account, amount: number) {
    this.document = document
    this.account = account
    this.amount = amount
  }
}
