import { Address } from "../Address";
import type { ChartOfAccountsStandard } from '../ChartOfAccounts'
import type { CompanyProfile } from '../../server/compliance/companyProfile'
import type { IncomingEuAcquisitionAccounts, IncomingReverseChargeAccounts } from '../incomingReverseCharge'

export class Account {
  id: string
  address: Address = Address.createNullAddress()
  invoiceIssuer: Address = Address.createNullAddress()
  chartOfAccounts: ChartOfAccountsStandard = 'SKR03'
  activeChart: CompanyProfile['chart'] = 'SKR03'
  importedCharts: string[] = []
  companyProfile?: CompanyProfile
  incomingReverseChargeAccounts?: IncomingReverseChargeAccounts
  incomingEuAcquisitionAccounts?: IncomingEuAcquisitionAccounts
  persistencePayload?: string

  constructor(id: string) {
    this.id = id
  }
}
