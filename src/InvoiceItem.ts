import { Unit } from "./Unit"

export class InvoiceItem {
  description: string = ''
  amountOfUnit: number = 0
  unit: Unit = Unit.None
  pricePerUnit: number = 0
  netAmount: number = 0
}
