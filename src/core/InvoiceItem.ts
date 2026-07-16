import { Unit } from "./Unit"

export class InvoiceItem {
  description: string = ''
  amountOfUnit: number = 0
  unit: Unit = Unit.None
  pricePerUnit: number = 0

  get netAmount(): number {
    return this.amountOfUnit * this.pricePerUnit
  }
}
