import type { EBalanceExportInput, EBalanceTaxBalanceEvidence } from '../eBilanzExport'
import { reconciliationChecksum } from '../eBilanzExport'
import type { LedgerBalance } from '../doubleEntry'

/** Synthetic, independently calculated: commercial profit 550, tax profit 500,
 * assets/equity 1550/1500 EUR, statutory reserve 100 EUR, prior loss 100 EUR.
 * The account labelled inactive remains in the locked close snapshot.
 */
export function eBilanz2026Fixture(): EBalanceExportInput {
  const account = (accountId: string, number: number, category: LedgerBalance['category'], position: string, debitCents: number, creditCents: number): LedgerBalance => ({
    accountId, number, name: accountId, category, eBilanzPosition: position, debitCents, creditCents, balanceCents: debitCents - creditCents,
  })
  const payload: EBalanceTaxBalanceEvidence = {
    schemaVersion: 'EBILANZ_TAX_BALANCE_V1', closeGenerationId: 'close-2026-v1', sourceChecksum: 'c'.repeat(64), evidenceChecksum: 'd'.repeat(64), complete: true,
    adjustments: [{ id: 'tax-depreciation', description: 'Tax depreciation exceeds book depreciation by EUR 50.', evidenceIds: ['evidence-tax-depreciation'], lines: [
      { accountId: 'depreciation', debitCents: 5000, creditCents: 0 }, { accountId: 'accumulated-depreciation', debitCents: 0, creditCents: 5000 },
    ] }], assetMappings: [{ assetId: 'laptop', accountId: 'asset' }],
    bvv: { openingEquityCents: 100000, capitalAdjustmentsCents: 0, contributionsCents: 0, distributionsCents: 0 },
    gcd: { business: 'Softwareentwicklung', country: 'DE', houseNumber: '1', previousPeriod: { start: '2025-04-01', end: '2026-03-31' }, domesticOrdinaryCompany: true, businessId: null,
      shareholders: [{ id: 'owner-1', name: 'Erika Muster', legalStatus: 'NPP', shareNumerator: 1, shareDenominator: 1, taxNumber: null, taxId: '12345678901', businessId: null }] },
    nilReasons: { 'company.businessId': 'Not yet assigned in this synthetic fixture.', 'shareholder.owner-1.taxNumber': 'Not available in this synthetic fixture.', 'shareholder.owner-1.businessId': 'Private natural person.' },
  }
  const evidenceIds = ['evidence-tax-depreciation', 'evidence-gcd', 'evidence-bvv']
  const book = { assetId: 'laptop', description: 'Laptop & Zubehör', openingCostCents: 0, additionsCents: 120000, acquisitionCostTransfersCents: 0, disposalsCents: 0, closingCostCents: 120000, costCents: 120000,
    openingAccumulatedDepreciationCents: 0, currentDepreciationCents: 20000, impairmentsCents: 0, reversalsCents: 0, accumulatedDepreciationTransfersCents: 0, depreciationRemovedOnDisposalCents: 0,
    closingAccumulatedDepreciationCents: 20000, accumulatedDepreciationCents: 20000, carryingAmountCents: 100000, transferEventIds: [], location: 'Berlin' }
  return {
    ownerId: 'synthetic-tenant', sourceChecksum: 'c'.repeat(64), fiscalYear: { id: 'fy-2026', year: 2026, startsAt: '2026-04-01', endsAt: '2027-03-31' },
    closeGeneration: { id: 'close-2026-v1', snapshotHash: 'a'.repeat(64), hgbCloseRunChecksum: 'b'.repeat(64), lockedAt: '2027-04-01T12:00:00.000Z' },
    company: { companyName: 'Muster & Test UG (haftungsbeschränkt)', street: 'Musterstraße', postalCode: '10115', city: 'Berlin', taxNumber: '1234567890123', legalForm: 'UG' },
    balances: [
      account('bank-inactive', 1200, 'ASSET', 'bs.ass.currAss.cashEquiv.bank', 55000, 0),
      account('asset', 400, 'ASSET', 'bs.ass.fixAss.tan.otherEquipm', 120000, 0),
      account('accumulated-depreciation', 490, 'ASSET', 'bs.ass.fixAss.tan.otherEquipm', 0, 20000),
      account('capital', 2900, 'EQUITY', 'bs.eqLiab.equity.subscribed.corp', 0, 100000),
      account('UG-reserve', 2930, 'EQUITY', 'bs.eqLiab.equity.revenueRes.legal', 0, 10000),
      account('loss-carried-forward', 2978, 'EQUITY', 'bs.eqLiab.equity.retainedEarnings', 10000, 0),
      account('revenue', 8400, 'REVENUE', 'is.netIncome.regular.operatingTC.grossTradingProfit.totalOutput.netSales', 0, 80000),
      account('revenue-refund', 8730, 'REVENUE', 'is.netIncome.regular.operatingTC.grossTradingProfit.totalOutput.netSales', 5000, 0),
      account('depreciation', 4830, 'EXPENSE', 'is.netIncome.regular.operatingTC.deprAmort.fixAss.tan', 20000, 0),
    ],
    assets: [{ book, tax: { ...book, currentDepreciationCents: 25000, closingAccumulatedDepreciationCents: 25000, accumulatedDepreciationCents: 25000, carryingAmountCents: 95000 }, acquisitionDate: '2026-04-01' }],
    reconciliation: { id: 'reconciliation-1', ownerId: 'synthetic-tenant', fiscalYearId: 'fy-2026', approvedBy: 'owner', approvedAt: '2027-04-02T12:00:00.000Z', evidenceIds, payload,
      checksum: reconciliationChecksum('synthetic-tenant', 'fy-2026', payload, evidenceIds) },
  }
}
