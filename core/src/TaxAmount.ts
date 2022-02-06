import { Tax } from './Tax.js'

export class TaxAmount {
  amount: number
  tax: Tax

  static createNullTaxAmount() {
    return new TaxAmount(0, Tax.createNullTax())
  }

  constructor(amount: number, tax: Tax) {
    this.amount = amount
    this.tax = tax
  }
}
