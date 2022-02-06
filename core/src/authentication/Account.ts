import { Address } from "../Address.js";

export class Account {
  id: string
  invoiceIssuer: Address = Address.createNullAddress()

  constructor(id: string) {
    this.id = id
  }
}
