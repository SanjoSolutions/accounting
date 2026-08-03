import { describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('./persistence/client', () => ({ prisma: {} }))

import {
  AccountingReportInvalidSetupError,
  buildAccountingReport,
  deriveGeneralLedger,
  mapAccount,
  type AccountingReportDataset,
} from './accountingReports'

const account = (number: number, category: string, name = `Account ${number}`) => ({
  number, category, name, eBilanzPosition: null,
})

describe('accounting report mapping', () => {
  it('chooses the HGB side and taxonomy mapping from the account category', () => {
    const metadata = {
      accountNumber: 4930,
      accountName: 'Account 4930',
      accountCategory: 'EXPENSE',
      subcategory: 'Other expense',
      legacyVatPosition: null,
      legacyVatCode: '19',
      currentVatPosition: null,
      currentVatCode: '19',
      cashBasisMapping: null,
      hgbAssetMapping: 'wrong asset',
      hgbLiabilityMapping: 'wrong liability',
      hgbIncomeStatementMapping: 'Expense',
      taxonomyAssetMapping: 'wrong.asset',
      taxonomyLiabilityMapping: 'wrong.liability',
      taxonomyIncomeStatementMapping: 'is.expense',
    }

    expect(mapAccount(account(4930, 'EXPENSE'), metadata, 5)).toMatchObject({
      number: '04930',
      hgbPosition: 'GuV',
      hgbMapping: 'Expense',
      eBilanzPosition: 'is.expense',
    })
    expect(mapAccount(account(1200, 'ASSET'), { ...metadata, accountNumber: 1200, accountCategory: 'ASSET' }, 5)).toMatchObject({
      hgbPosition: 'Aktiva',
      eBilanzPosition: 'wrong.asset',
    })
    expect(mapAccount(account(70001, 'LIABILITY'), { ...metadata, accountNumber: 70001, accountCategory: 'LIABILITY' }, 5)).toMatchObject({
      hgbPosition: 'Passiva',
      eBilanzPosition: 'wrong.liability',
    })
  })

  it('derives account sheets from journal lines with counter accounts, VAT and running balances', () => {
    const sheets = deriveGeneralLedger(
      [account(4930, 'EXPENSE', 'Cloud services'), account(70001, 'LIABILITY', 'Supplier'), account(1576, 'ASSET', 'Input VAT')],
      [{
        id: 'posting-501',
        sequenceNumber: 501,
        bookingDate: new Date('2025-02-14T12:00:00.000Z'),
        sourcePostingDate: new Date('2025-02-15T12:00:00.000Z'),
        sourceJournalDate: new Date('2025-02-16T12:00:00.000Z'),
        sourcePeriod: 2,
        documentNumber: 'SYN-501',
        description: 'Synthetic cloud subscription',
        lines: [
          { id: 'expense', debitCents: 12_000, creditCents: 0, vatAccountNumber: 1576, taxRateBasisPoints: 1900, account: account(4930, 'EXPENSE') },
          { id: 'vat', debitCents: 2_280, creditCents: 0, isVatLine: true, account: account(1576, 'ASSET') },
          { id: 'supplier', debitCents: 0, creditCents: 14_280, account: account(70001, 'LIABILITY') },
        ],
      }],
      [{
        accountNumber: 4930, accountName: 'Cloud services', lastBookingDate: null,
        openingDebitCents: 1_000, openingCreditCents: 0, annualDebitCents: 0, annualCreditCents: 0,
        cumulativeDebitCents: 0, cumulativeCreditCents: 0, closingDebitCents: 0, closingCreditCents: 0,
      }],
      5,
      2025,
    )

    expect(sheets.find(sheet => sheet.accountNumber === '04930')).toMatchObject({
      openingBalanceCents: 1_000,
      closingBalanceCents: 13_000,
      entries: [{
        voucherNumber: 'SYN-501',
        voucherDate: '2025-02-14',
        sourcePostingDate: '2025-02-15',
        sourceJournalDate: '2025-02-16',
        sourcePeriod: 2,
        counterAccountNumbers: ['70001'],
        vatAccountNumber: '01576',
        vatRateBasisPoints: 1900,
        runningBalanceCents: 13_000,
        journalVoucherHref: '/journal?year=2025#journal-entry-posting-501',
      }],
    })
  })

  it('joins counterparties through subledger associations and keeps imported master data', () => {
    const report = buildAccountingReport(2025, dataset(), new Date('2026-07-31T10:00:00.000Z'))

    expect(report.company).toEqual({
      name: 'Synthetic GmbH',
      address: { street: 'Testweg', houseNumber: '8', postalCode: '12345', city: 'Musterstadt', region: 'Berlin' },
    })
    expect(report.setup.profitDetermination).toBe('Betriebsvermögensvergleich')
    expect(report.counterparties).toEqual([expect.objectContaining({
      id: 'partner-1',
      kind: 'creditor',
      accountNumber: '70001',
      partyNumber: 'V-70001',
      name: 'Synthetic Supplier',
      balanceCents: -14_280,
      address: { street: 'Ring', houseNumber: '4', postalCode: '23456', city: 'Teststadt' },
      entries: [expect.objectContaining({ voucherNumber: 'SYN-501' })],
    })])
    expect(report.annualVatStatement.fields).toEqual([{ code: '83', valueCents: 3_800 }])
    expect(report.generatedAt).toBe('2026-07-31T10:00:00.000Z')
  })

  it('rejects an internally inconsistent imported setup instead of publishing it', () => {
    const invalid = dataset()
    invalid.setup.startsAt = new Date('2025-12-31T00:00:00.000Z')
    invalid.setup.endsAt = new Date('2025-01-01T00:00:00.000Z')

    expect(() => buildAccountingReport(2025, invalid)).toThrow(AccountingReportInvalidSetupError)
  })

  it('uses requested-year account names and categories instead of mutable ledger values', () => {
    const input = dataset()
    input.accounts[0] = account(4930, 'REVENUE', 'Name changed in a later year')
    input.metadata = [{
      accountNumber: 4930,
      accountName: '2025 cloud services',
      accountCategory: 'EXPENSE',
      subcategory: 'Other expense',
      legacyVatPosition: null,
      legacyVatCode: null,
      currentVatPosition: null,
      currentVatCode: '19',
      cashBasisMapping: 'Sonstige Betriebsausgaben',
      hgbAssetMapping: null,
      hgbLiabilityMapping: null,
      hgbIncomeStatementMapping: 'Sonstige betriebliche Aufwendungen',
      taxonomyAssetMapping: null,
      taxonomyLiabilityMapping: null,
      taxonomyIncomeStatementMapping: 'is.expense.2025',
    }]

    const report = buildAccountingReport(2025, input)

    expect(report.accounts[0]).toMatchObject({
      name: '2025 cloud services',
      type: 'EXPENSE',
      cashBasisMapping: 'Sonstige Betriebsausgaben',
      hgbMapping: 'Sonstige betriebliche Aufwendungen',
      eBilanzPosition: 'is.expense.2025',
    })
    expect(report.generalLedger[0].accountName).toBe('2025 cloud services')
  })
})

function dataset(): AccountingReportDataset {
  const accounts = [account(4930, 'EXPENSE'), account(70001, 'LIABILITY')]
  return {
    setup: {
      companyName: 'Synthetic GmbH', street: 'Testweg 8', postalCode: '12345', city: 'Musterstadt', region: 'Berlin',
      currency: 'EUR', accountingMethod: 'ACCRUAL', chart: 'SKR-03',
      startsAt: new Date('2025-01-01T00:00:00.000Z'), endsAt: new Date('2025-12-31T23:59:59.999Z'),
      taxonomyVersion: '6.8',
    },
    accountLength: 5,
    accounts,
    metadata: [],
    trialBalance: [],
    entries: [{
      id: 'posting-501', sequenceNumber: 501, bookingDate: new Date('2025-02-14T12:00:00.000Z'),
      documentNumber: 'SYN-501', description: 'Cloud subscription',
      lines: [
        { id: 'expense', debitCents: 14_280, creditCents: 0, account: accounts[0] },
        { id: 'supplier', debitCents: 0, creditCents: 14_280, account: accounts[1] },
      ],
    }],
    partners: [{
      id: 'partner-1', partnerNumber: 'V-70001', name: 'Synthetic Supplier',
      street: 'Ring', houseNumber: '4', postalCode: '23456', city: 'Teststadt', industry: 'Software',
    }],
    associations: [{ accountNumber: 70001, partnerNumber: 'V-70001', kind: 'CREDITOR' }],
    vatFields: [{ fieldCode: '83', amountCents: 3_800 }],
  }
}
