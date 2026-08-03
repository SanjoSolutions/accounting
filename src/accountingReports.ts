export type AccountingReportAddress = {
  street: string
  houseNumber: string
  postalCode: string
  city: string
  region?: string
}

export type AccountingReportCompany = {
  name: string
  address: AccountingReportAddress
}

export type AccountingReportSetup = {
  fiscalYearStartsAt: string
  fiscalYearEndsAt: string
  chart: string
  accountingMethod: string
  profitDetermination: string
  currency: string
  taxonomyVersion: string
}

export type AccountingReportAccount = {
  number: string
  name: string
  type: string
  subcategory: string | null
  vatPositionOld: string | null
  vatCodeOld: string | null
  vatPositionCurrent: string | null
  vatCodeCurrent: string | null
  cashBasisMapping: string | null
  hgbPosition: 'Aktiva' | 'Passiva' | 'GuV'
  hgbMapping: string | null
  eBilanzPosition: string | null
}

export type AccountingReportTrialBalanceRow = {
  accountNumber: string
  accountName: string
  openingDebitCents: number
  openingCreditCents: number
  lastBookingDate: string | null
  annualDebitCents: number
  annualCreditCents: number
  cumulativeDebitCents: number
  cumulativeCreditCents: number
  closingDebitCents: number
  closingCreditCents: number
}

export type AccountingReportLedgerEntry = {
  id: string
  date: string
  voucherDate: string
  sourcePostingDate: string | null
  sourceJournalDate: string | null
  sourcePeriod: number | null
  voucherNumber: string
  postingText: string
  debitCents: number
  creditCents: number
  runningBalanceCents: number
  counterAccountNumbers: string[]
  vatAccountNumber?: string
  vatRateBasisPoints?: number
  journalVoucherHref: string
}

export type AccountingReportAccountSheet = {
  accountNumber: string
  accountName: string
  openingBalanceCents: number
  closingBalanceCents: number
  entries: AccountingReportLedgerEntry[]
}

export type AccountingReportCounterparty = {
  id: string
  kind: 'debtor' | 'creditor'
  accountNumber: string
  partyNumber: string
  name: string
  address: AccountingReportAddress
  industry: string | null
  balanceCents: number
  entries: AccountingReportLedgerEntry[]
}

export type AccountingReportVatLine = {
  code: string
  valueCents: number
}

/**
 * Stable response body returned by GET /api/accounting-reports?year={year}.
 * All monetary values are integer cents; dates are ISO-8601 calendar dates.
 */
export type AccountingReportResponse = {
  year: number
  generatedAt: string
  company: AccountingReportCompany
  setup: AccountingReportSetup
  accounts: AccountingReportAccount[]
  trialBalance: AccountingReportTrialBalanceRow[]
  generalLedger: AccountingReportAccountSheet[]
  counterparties: AccountingReportCounterparty[]
  annualVatStatement: {
    fields: AccountingReportVatLine[]
  }
}

export function filterAccountingReportAccounts(
  accounts: readonly AccountingReportAccount[],
  query: string,
) {
  const search = query.trim().toLocaleLowerCase()
  if (!search) return accounts
  return accounts.filter(account =>
    [
      account.number, account.name, account.type, account.subcategory,
      account.vatPositionOld, account.vatCodeOld, account.vatPositionCurrent,
      account.vatCodeCurrent, account.cashBasisMapping, account.hgbPosition, account.hgbMapping, account.eBilanzPosition,
    ]
      .some(value => value?.toLocaleLowerCase().includes(search)),
  )
}

export function accountingReportEndpoint(year: number) {
  if (!Number.isInteger(year) || year < 1900 || year > 2200) throw new Error('Invalid fiscal year')
  return `/api/accounting-reports?year=${year}`
}
