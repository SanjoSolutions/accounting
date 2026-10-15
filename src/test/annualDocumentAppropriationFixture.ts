import { canonicalJson } from '@/core/compliance/auditExport'
import { hashDocument } from '@/core/compliance/annualDocuments'
import { MICRO_BALANCE_SHEET_ORDER, SMALL_BALANCE_SHEET_ORDER } from '@/core/compliance/annualAccounts'
import { annualDocumentFixture } from './annualDocumentFixture'

/** Synthetic renderer contract for the immutable DTO published by #55, cc9c513.
 * The producing domain's accounting validation is owned by that dependency.
 */
export function annualDocumentAppropriationFixture(size: 'SMALL' | 'MICRO' = 'SMALL') {
  const source = annualDocumentFixture(size)
  const appropriation = {
    annualResultCents: 11900, shareCapitalCents: 100000, priorLossCarryforwardCents: 10000,
    priorProfitCarryforwardCents: 0, priorStatutoryReserveCents: 0, reserveAllocationCents: 475,
    distributionCents: 0, carryforwardCents: 1425, priorCarryforwardEvidenceId: 'private-prior-loss',
    resolutionEvidenceId: 'private-appropriation-resolution', capitalAccountId: 'private-capital-account',
    carryforwardAccountId: 'private-carry-account', reserveAccountId: 'private-reserve-account', reserveProposalId: 'private-reserve-posting',
  }
  const amounts: Record<string, [number, number]> = {
    'A.ASSETS': [101900, 90000], 'A.CURRENT': [101900, 90000], 'A.CASH': [101900, 90000],
    'B.EQUITY_LIABILITIES': [101900, 90000], 'B.EQUITY': [101900, 90000], 'B.SUBSCRIBED_CAPITAL': [100000, 100000],
    'B.REVENUE_RESERVES': [475, 0], 'B.LEGAL_RESERVE': [475, 0], 'B.CARRYFORWARD': [0, -10000], 'B.NET_INCOME': [1425, 0],
  }
  const labels: Record<string, string> = {
    'B.CARRYFORWARD': 'Gewinnvortrag/Verlustvortrag (im Bilanzgewinn enthalten)',
    'B.NET_INCOME': 'Bilanzgewinn/Bilanzverlust (Vorjahr: Jahresergebnis)',
  }
  source.input.balanceSheet = source.input.balanceSheet.map(line => ({ ...line, amountCents: amounts[line.code]?.[0] ?? 0, comparativeCents: amounts[line.code]?.[1] ?? 0, label: labels[line.code] ?? line.label }))
  const positions: readonly string[] = size === 'MICRO' ? MICRO_BALANCE_SHEET_ORDER : SMALL_BALANCE_SHEET_ORDER
  source.input.balanceSheet = source.input.balanceSheet.filter(line => positions.includes(line.code))
  source.input.incomeStatement = source.input.incomeStatement.map(line => ({ ...line, amountCents: ['REVENUE', 'RESULT_AFTER_TAX', 'NET_INCOME'].includes(line.code) ? 11900 : 0, comparativeCents: 0 }))
  Object.assign(source.input, { ugResultAppropriation: appropriation })
  const immutablePayload = canonicalJson(source.input)
  const checksum = hashDocument(immutablePayload)
  source.annual = { ...source.annual, immutablePayload, checksum, id: `${source.input.profile.tenantId}:${source.input.fiscalPeriodStart}:${source.input.fiscalPeriodEnd}:v1:${checksum}` }
  source.equity = { ...source.equity, resultCents: 11900, shareCapitalCents: 100000 }
  return { source, appropriation }
}
