import { Address } from "../Address";
import type { ChartOfAccountsStandard } from '../ChartOfAccounts'
import type { CompanyProfile } from '../../server/compliance/companyProfile'

export class Account {
  id: string
  address: Address = Address.createNullAddress()
  invoiceIssuer: Address = Address.createNullAddress()
  chartOfAccounts: ChartOfAccountsStandard = 'SKR03'
  activeChart: CompanyProfile['chart'] = 'SKR03'
  importedCharts: string[] = []
  companyProfile?: CompanyProfile
  persistencePayload?: string

  constructor(id: string) {
    this.id = id
  }
}
