import { Accountant } from "./Accountant"

export class BookingStamp {
  date: Date
  accountant: Accountant

  constructor(date: Date, accountant: Accountant) {
    this.date = date
    this.accountant = accountant
  }
}
