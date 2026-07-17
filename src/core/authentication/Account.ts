import { Address } from "../Address";
import type { ChartOfAccountsStandard } from '../ChartOfAccounts'

export class Account {
  id: string
  address: Address = Address.createNullAddress()
  invoiceIssuer: Address = Address.createNullAddress()
  chartOfAccounts: ChartOfAccountsStandard = 'SKR03'

  constructor(id: string) {
    this.id = id
  }
}
