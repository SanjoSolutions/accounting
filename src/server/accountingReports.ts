import 'server-only'

import type {
  AccountingReportAccount,
  AccountingReportAccountSheet,
  AccountingReportLedgerEntry,
  AccountingReportResponse,
} from '@/accountingReports'
import { prisma } from './persistence/client'

export class AccountingReportNotFoundError extends Error {
  constructor(year: number) {
    super(`No imported accounting setup exists for fiscal year ${year}.`)
    this.name = 'AccountingReportNotFoundError'
  }
}

export class AccountingReportInvalidSetupError extends Error {
  constructor(public readonly issues: string[]) {
    super(`The imported accounting setup is invalid: ${issues.join(' ')}`)
    this.name = 'AccountingReportInvalidSetupError'
  }
}

type SetupRow = {
  companyName: string
  street: string
  houseNumber?: string | null
  postalCode: string
  city: string
  region?: string | null
  currency: string
  accountingMethod: string
  profitDetermination?: string | null
  chart: string
  startsAt: Date
  endsAt: Date
  taxonomyVersion: string | null
}

type AccountRow = {
  number: number
  name: string
  category: string
  eBilanzPosition: string | null
}

type MetadataRow = {
  accountNumber: number
  accountName: string
  accountCategory: string
  subcategory: string | null
  legacyVatPosition: string | null
  legacyVatCode: string | null
  currentVatPosition: string | null
  currentVatCode: string | null
  cashBasisMapping: string | null
  hgbAssetMapping: string | null
  hgbLiabilityMapping: string | null
  hgbIncomeStatementMapping: string | null
  taxonomyAssetMapping: string | null
  taxonomyLiabilityMapping: string | null
  taxonomyIncomeStatementMapping: string | null
}

type JournalLineRow = {
  id: string
  debitCents: number
  creditCents: number
  taxCode?: string | null
  taxRateBasisPoints?: number | null
  vatAccountNumber?: number | null
  isVatLine?: boolean
  account: AccountRow
}

type JournalEntryRow = {
  id: string
  sequenceNumber: number
  bookingDate: Date
  sourcePostingDate?: Date | null
  sourceJournalDate?: Date | null
  sourcePeriod?: number | null
  documentNumber: string
  description: string
  lines: JournalLineRow[]
}

type TrialBalanceRow = {
  accountNumber: number
  accountName: string
  lastBookingDate: Date | null
  openingDebitCents: number
  openingCreditCents: number
  annualDebitCents: number
  annualCreditCents: number
  cumulativeDebitCents: number
  cumulativeCreditCents: number
  closingDebitCents: number
  closingCreditCents: number
}

type PartnerRow = {
  id: string
  partnerNumber: string
  name: string
  street: string
  houseNumber: string
  postalCode: string
  city: string
  industry: string | null
}

type AssociationRow = {
  accountNumber: number
  partnerNumber: string
  kind: string
}

export type AccountingReportDataset = {
  setup: SetupRow
  accountLength: number | null
  accounts: AccountRow[]
  metadata: MetadataRow[]
  trialBalance: TrialBalanceRow[]
  entries: JournalEntryRow[]
  partners: PartnerRow[]
  associations: AssociationRow[]
  vatFields: Array<{ fieldCode: string; amountCents: number }>
}

export function formatAccountNumber(number: number, accountLength: number | null) {
  return String(number).padStart(accountLength ?? String(number).length, '0')
}

export function validateAccountingReportSetup(setup: SetupRow) {
  const issues = [
    ...(!setup.companyName.trim() ? ['companyName is missing.'] : []),
    ...(!setup.currency.trim() ? ['currency is missing.'] : []),
    ...(!setup.chart.trim() ? ['chart is missing.'] : []),
    ...(!setup.accountingMethod.trim() ? ['accountingMethod is missing.'] : []),
    ...(Number.isNaN(setup.startsAt.getTime()) || Number.isNaN(setup.endsAt.getTime())
      ? ['fiscal-year dates are invalid.']
      : setup.startsAt > setup.endsAt ? ['fiscal-year start is after its end.'] : []),
  ]
  if (issues.length) throw new AccountingReportInvalidSetupError(issues)
}

export function mapAccount(
  account: AccountRow,
  metadata: MetadataRow | undefined,
  accountLength: number | null,
): AccountingReportAccount {
  const category = metadata?.accountCategory ?? account.category
  const balanceSheetAsset = category === 'ASSET'
  const profitAndLoss = category === 'REVENUE' || category === 'EXPENSE'
  return {
    number: formatAccountNumber(account.number, accountLength),
    name: metadata?.accountName ?? account.name,
    type: category,
    subcategory: metadata?.subcategory ?? null,
    vatPositionOld: metadata?.legacyVatPosition ?? null,
    vatCodeOld: metadata?.legacyVatCode ?? null,
    vatPositionCurrent: metadata?.currentVatPosition ?? null,
    vatCodeCurrent: metadata?.currentVatCode ?? null,
    cashBasisMapping: metadata?.cashBasisMapping ?? null,
    hgbPosition: balanceSheetAsset ? 'Aktiva' : profitAndLoss ? 'GuV' : 'Passiva',
    hgbMapping: (balanceSheetAsset
      ? metadata?.hgbAssetMapping
      : profitAndLoss
        ? metadata?.hgbIncomeStatementMapping
        : metadata?.hgbLiabilityMapping) ?? null,
    eBilanzPosition: (balanceSheetAsset
      ? metadata?.taxonomyAssetMapping
      : profitAndLoss
        ? metadata?.taxonomyIncomeStatementMapping
        : metadata?.taxonomyLiabilityMapping) ?? account.eBilanzPosition,
  }
}

export function deriveGeneralLedger(
  accounts: readonly AccountRow[],
  entries: readonly JournalEntryRow[],
  trialBalance: readonly TrialBalanceRow[],
  accountLength: number | null,
  year: number,
): AccountingReportAccountSheet[] {
  const openingBalances = new Map(trialBalance.map(row => [
    row.accountNumber,
    row.openingDebitCents - row.openingCreditCents,
  ]))
  const orderedEntries = [...entries].sort((left, right) =>
    left.bookingDate.getTime() - right.bookingDate.getTime()
      || left.sequenceNumber - right.sequenceNumber
      || left.id.localeCompare(right.id))

  return [...accounts].sort((left, right) => left.number - right.number).map(account => {
    let runningBalanceCents = openingBalances.get(account.number) ?? 0
    const ledgerEntries: AccountingReportLedgerEntry[] = []
    for (const entry of orderedEntries) {
      const lines = entry.lines.filter(line => line.account.number === account.number)
      for (const line of lines) {
        runningBalanceCents += line.debitCents - line.creditCents
        const vatMetadata = vatMetadataFor(line, entry.lines, accountLength)
        ledgerEntries.push({
          id: line.id,
          date: dateOnly(entry.bookingDate),
          voucherDate: dateOnly(entry.bookingDate),
          sourcePostingDate: entry.sourcePostingDate ? dateOnly(entry.sourcePostingDate) : null,
          sourceJournalDate: entry.sourceJournalDate ? dateOnly(entry.sourceJournalDate) : null,
          sourcePeriod: entry.sourcePeriod ?? null,
          voucherNumber: entry.documentNumber,
          postingText: entry.description,
          debitCents: line.debitCents,
          creditCents: line.creditCents,
          runningBalanceCents,
          counterAccountNumbers: [...new Set(entry.lines
            .filter(candidate => candidate.id !== line.id && !isVatLine(candidate))
            .map(candidate => formatAccountNumber(candidate.account.number, accountLength)))],
          ...vatMetadata,
          journalVoucherHref: `/journal?year=${year}#journal-entry-${encodeURIComponent(entry.id)}`,
        })
      }
    }
    return {
      accountNumber: formatAccountNumber(account.number, accountLength),
      accountName: account.name,
      openingBalanceCents: openingBalances.get(account.number) ?? 0,
      closingBalanceCents: runningBalanceCents,
      entries: ledgerEntries,
    }
  })
}

export function buildAccountingReport(
  year: number,
  dataset: AccountingReportDataset,
  generatedAt = new Date(),
): AccountingReportResponse {
  validateAccountingReportSetup(dataset.setup)
  const metadata = new Map(dataset.metadata.map(item => [item.accountNumber, item]))
  const reportAccounts = dataset.accounts.map(account => {
    const requestedYear = metadata.get(account.number)
    return {
      ...account,
      name: requestedYear?.accountName ?? account.name,
      category: requestedYear?.accountCategory ?? account.category,
    }
  })
  const ledger = deriveGeneralLedger(reportAccounts, dataset.entries, dataset.trialBalance, dataset.accountLength, year)
  const ledgerByAccount = new Map(ledger.map(sheet => [sheet.accountNumber, sheet]))
  const partners = new Map(dataset.partners.map(partner => [partner.partnerNumber, partner]))
  const setupAddress = splitSetupAddress(dataset.setup.street, dataset.setup.houseNumber)

  return {
    year,
    generatedAt: generatedAt.toISOString(),
    company: {
      name: dataset.setup.companyName,
      address: {
        street: setupAddress.street,
        houseNumber: setupAddress.houseNumber,
        postalCode: dataset.setup.postalCode,
        city: dataset.setup.city,
        ...(dataset.setup.region ? { region: dataset.setup.region } : {}),
      },
    },
    setup: {
      fiscalYearStartsAt: dateOnly(dataset.setup.startsAt),
      fiscalYearEndsAt: dateOnly(dataset.setup.endsAt),
      chart: dataset.setup.chart,
      accountingMethod: dataset.setup.accountingMethod,
      profitDetermination: dataset.setup.profitDetermination
        ?? (dataset.setup.accountingMethod === 'CASH' ? 'Einnahmenüberschussrechnung' : 'Betriebsvermögensvergleich'),
      currency: dataset.setup.currency,
      taxonomyVersion: dataset.setup.taxonomyVersion ?? '',
    },
    accounts: reportAccounts.map(account => mapAccount(account, metadata.get(account.number), dataset.accountLength)),
    trialBalance: dataset.trialBalance.map(row => ({
      accountNumber: formatAccountNumber(row.accountNumber, dataset.accountLength),
      accountName: row.accountName,
      openingDebitCents: row.openingDebitCents,
      openingCreditCents: row.openingCreditCents,
      lastBookingDate: row.lastBookingDate ? dateOnly(row.lastBookingDate) : null,
      annualDebitCents: row.annualDebitCents,
      annualCreditCents: row.annualCreditCents,
      cumulativeDebitCents: row.cumulativeDebitCents,
      cumulativeCreditCents: row.cumulativeCreditCents,
      closingDebitCents: row.closingDebitCents,
      closingCreditCents: row.closingCreditCents,
    })),
    generalLedger: ledger,
    counterparties: dataset.associations.flatMap(association => {
      const partner = partners.get(association.partnerNumber)
      const accountNumber = formatAccountNumber(association.accountNumber, dataset.accountLength)
      const sheet = ledgerByAccount.get(accountNumber)
      if (!partner || !sheet) return []
      return [{
        id: partner.id,
        kind: association.kind === 'DEBTOR' ? 'debtor' as const : 'creditor' as const,
        accountNumber,
        partyNumber: association.partnerNumber,
        name: partner.name,
        address: {
          street: partner.street,
          houseNumber: partner.houseNumber,
          postalCode: partner.postalCode,
          city: partner.city,
        },
        industry: partner.industry,
        balanceCents: sheet.closingBalanceCents,
        entries: sheet.entries,
      }]
    }),
    annualVatStatement: {
      fields: dataset.vatFields.map(field => ({ code: field.fieldCode, valueCents: field.amountCents })),
    },
  }
}

export async function getAccountingReport(ownerId: string, year: number) {
  const setup = await prisma.lexwareCompanySetup.findUnique({ where: { ownerId_year: { ownerId, year } } })
  if (!setup) throw new AccountingReportNotFoundError(year)
  const [profile, accounts, metadata, trialBalance, entries, partners, associations, vatFields] = await Promise.all([
    prisma.ledgerProfile.findUnique({ where: { ownerId } }),
    prisma.ledgerAccount.findMany({ where: { ownerId, active: true }, orderBy: { number: 'asc' } }),
    prisma.lexwareAccountMetadata.findMany({ where: { ownerId, year }, orderBy: { accountNumber: 'asc' } }),
    prisma.lexwareTrialBalanceLine.findMany({ where: { ownerId, year }, orderBy: { accountNumber: 'asc' } }),
    prisma.journalEntry.findMany({
      where: { fiscalYear: { ownerId, year } },
      orderBy: [{ bookingDate: 'asc' }, { sequenceNumber: 'asc' }],
      include: { lines: { include: { account: true } } },
    }),
    prisma.lexwareBusinessPartner.findMany({ where: { ownerId, year }, orderBy: { partnerNumber: 'asc' } }),
    prisma.lexwareSubledgerAssociation.findMany({ where: { ownerId, year }, orderBy: [{ kind: 'asc' }, { accountNumber: 'asc' }] }),
    prisma.lexwareAnnualVatField.findMany({ where: { ownerId, year }, orderBy: { fieldCode: 'asc' } }),
  ])
  const reportAccountNumbers = new Set(metadata.map(item => item.accountNumber))
  return buildAccountingReport(year, {
    setup,
    accountLength: profile?.accountLength ?? null,
    accounts: accounts.filter(account => reportAccountNumbers.has(account.number)),
    metadata,
    trialBalance,
    entries: entries as unknown as JournalEntryRow[],
    partners,
    associations,
    vatFields,
  })
}

function vatMetadataFor(line: JournalLineRow, allLines: readonly JournalLineRow[], accountLength: number | null) {
  const explicitNumber = line.vatAccountNumber
    ?? (line.taxCode?.startsWith('LEXWARE_VAT_ACCOUNT:')
      ? Number(line.taxCode.slice('LEXWARE_VAT_ACCOUNT:'.length))
      : undefined)
    ?? (line.taxCode && /^\d+$/.test(line.taxCode) ? Number(line.taxCode) : undefined)
  const vatLine = explicitNumber === undefined
    ? allLines.find(candidate => isVatLine(candidate) && candidate.id !== line.id)
    : undefined
  const vatAccountNumber = explicitNumber ?? vatLine?.account.number
  const vatRateBasisPoints = line.taxRateBasisPoints ?? vatLine?.taxRateBasisPoints ?? undefined
  return {
    ...(vatAccountNumber === undefined ? {} : {
      vatAccountNumber: formatAccountNumber(vatAccountNumber, accountLength),
    }),
    ...(vatRateBasisPoints === undefined || vatRateBasisPoints === null ? {} : { vatRateBasisPoints }),
  }
}

function isVatLine(line: JournalLineRow) {
  return line.isVatLine === true || line.taxCode === 'LEXWARE_VAT_LINE'
}

function splitSetupAddress(street: string, explicitHouseNumber?: string | null) {
  if (explicitHouseNumber?.trim()) return { street, houseNumber: explicitHouseNumber.trim() }
  const match = street.trim().match(/^(.*\S)\s+(\d+\s*[a-zA-Z]?(?:[-/]\d+\s*[a-zA-Z]?)?)$/)
  return match ? { street: match[1], houseNumber: match[2].replace(/\s+/g, '') } : { street, houseNumber: '' }
}

function dateOnly(date: Date) {
  return date.toISOString().slice(0, 10)
}
