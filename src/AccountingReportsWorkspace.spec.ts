import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import type { AccountingReportResponse } from './accountingReports'

vi.mock('next-intl', () => ({
  useTranslations: (namespace: string) => {
    const messages = JSON.parse(readFileSync('messages/en.json', 'utf8'))[namespace] as Record<string, string>
    return (key: string, values: Record<string, string | number> = {}) =>
      Object.entries(values).reduce(
        (message, [name, value]) => message.replace(`{${name}}`, String(value)),
        messages[key] ?? key,
      )
  },
}))

import { AccountingReportsView } from './AccountingReportsWorkspace'
import { accountingReportEndpoint, filterAccountingReportAccounts } from './accountingReports'

const syntheticReport: AccountingReportResponse = {
  year: 2025,
  generatedAt: '2026-07-31T10:00:00.000Z',
  company: {
    name: 'Example Workshop GmbH',
    address: { street: 'Sample Street', houseNumber: '12', postalCode: '12345', city: 'Exampletown', region: 'Sample Region' },
  },
  setup: {
    fiscalYearStartsAt: '2025-01-01',
    fiscalYearEndsAt: '2025-12-31',
    chart: 'Synthetic chart',
    accountingMethod: 'Double-entry accounting',
    profitDetermination: 'Accrual',
    currency: 'EUR',
    taxonomyVersion: '6.9',
  },
  accounts: [
    { number: '1200', name: 'Sample bank', type: 'asset', subcategory: 'liquid funds', vatPositionOld: null, vatCodeOld: null, vatPositionCurrent: null, vatCodeCurrent: null, cashBasisMapping: null, hgbPosition: 'Aktiva', hgbMapping: 'Bank', eBilanzPosition: 'bs.ass.currAss.cashEquiv.bank' },
    { number: '8400', name: 'Synthetic revenue', type: 'revenue', subcategory: 'domestic revenue', vatPositionOld: '81', vatCodeOld: '3', vatPositionCurrent: '81', vatCodeCurrent: '3', cashBasisMapping: 'Betriebseinnahmen', hgbPosition: 'GuV', hgbMapping: 'Umsatzerlöse', eBilanzPosition: 'is.netIncome.regular.operatingTC.grossTradingProfit.totalOutput' },
  ],
  trialBalance: [{
    accountNumber: '1200', accountName: 'Sample bank',
    openingDebitCents: 100_00, openingCreditCents: 0, lastBookingDate: '2025-02-03',
    annualDebitCents: 119_00, annualCreditCents: 0, cumulativeDebitCents: 219_00, cumulativeCreditCents: 0,
    closingDebitCents: 219_00, closingCreditCents: 0,
  }],
  generalLedger: [{
    accountNumber: '1200',
    accountName: 'Sample bank',
    openingBalanceCents: 100_00,
    closingBalanceCents: 219_00,
    entries: [{
      id: 'entry-1', date: '2025-02-03', voucherDate: '2025-02-03', sourcePostingDate: '2025-02-03',
      sourceJournalDate: '2025-02-03', sourcePeriod: 2, voucherNumber: 'SYN-0001', postingText: 'Synthetic sale',
      debitCents: 119_00, creditCents: 0, runningBalanceCents: 219_00,
      counterAccountNumbers: ['8400'], vatAccountNumber: '1776', vatRateBasisPoints: 1900,
      journalVoucherHref: '/journal?voucher=SYN-0001',
    }],
  }],
  counterparties: [{
    id: 'party-1',
    kind: 'debtor',
    accountNumber: '10001',
    partyNumber: 'C-10001',
    name: 'Sample Customer AG',
    address: { street: 'Demo Avenue', houseNumber: '7', postalCode: '54321', city: 'Testburg' },
    industry: 'Synthetic services',
    balanceCents: 119_00,
    entries: [{
      id: 'subledger-1', date: '2025-02-03', voucherDate: '2025-02-03', sourcePostingDate: '2025-02-03',
      sourceJournalDate: '2025-02-03', sourcePeriod: 2, voucherNumber: 'SYN-0001', postingText: 'Synthetic invoice',
      debitCents: 119_00, creditCents: 0, runningBalanceCents: 119_00,
      counterAccountNumbers: ['8400'],
      journalVoucherHref: '/journal?voucher=SYN-0001',
    }],
  }],
  annualVatStatement: {
    fields: [{ code: 'KZ83', valueCents: 19_00 }],
  },
}

describe('accounting report workspace', () => {
  it('builds the documented fiscal-year endpoint and rejects invalid years', () => {
    expect(accountingReportEndpoint(2025)).toBe('/api/accounting-reports?year=2025')
    expect(() => accountingReportEndpoint(2025.5)).toThrow('Invalid fiscal year')
  })

  it('searches chart metadata by number, name, type and tax metadata', () => {
    expect(filterAccountingReportAccounts(syntheticReport.accounts, 'Betriebseinnahmen').map(account => account.number)).toEqual(['8400'])
    expect(filterAccountingReportAccounts(syntheticReport.accounts, 'sample BANK')).toHaveLength(1)
    expect(filterAccountingReportAccounts(syntheticReport.accounts, '')).toHaveLength(2)
  })

  it('renders imported setup, balances, ledgers, counterparties, VAT and journal voucher links', () => {
    const html = renderToStaticMarkup(createElement(AccountingReportsView, { report: syntheticReport }))

    expect(html).toContain('Example Workshop GmbH')
    expect(html).toContain('Synthetic chart')
    expect(html).toContain('Trial balance')
    expect(html).toContain('General-ledger account sheets')
    expect(html).toContain('Cash-basis mapping')
    expect(html).toContain('Umsatzerlöse')
    expect(html).toContain('Sample Region')
    expect(html).toContain('Posting date')
    expect(html).toContain('Sample Customer AG')
    expect(html).toContain('Customer / supplier number')
    expect(html).toContain('C-10001')
    expect(html).toContain('Annual VAT statement')
    expect(html).toContain('KZ83')
    expect(html).toContain('href="/journal?voucher=SYN-0001"')
  })
})
