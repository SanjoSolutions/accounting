import { Address } from "../Address.js";

export class Account {
  id: string
  address: Address = Address.createNullAddress()
  invoiceIssuer: Address = Address.createNullAddress()

  constructor(id: string) {
    this.id = id
  }
}
