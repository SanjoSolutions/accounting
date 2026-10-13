import { describe, expect, test } from 'vitest'
import golden from './fixtures/hgb-annual-golden.json'
import { prepareAnnualAccounts, validateAnnualAccounts, type AnnualPackageInput } from './annualAccounts'

function input(): AnnualPackageInput {
  const source = structuredClone(golden) as AnnualPackageInput
  source.profile = { ...source.profile, legalForm: 'UG', size: 'SMALL' }
  const amounts: Record<string, [number, number]> = {
    'A.ASSETS': [101900, 90000], 'A.CURRENT': [101900, 90000], 'A.CASH': [101900, 90000],
    'B.EQUITY_LIABILITIES': [101900, 90000], 'B.EQUITY': [101900, 90000], 'B.SUBSCRIBED_CAPITAL': [100000, 100000],
    'B.REVENUE_RESERVES': [475, 0], 'B.LEGAL_RESERVE': [475, 0], 'B.CARRYFORWARD': [0, -10000], 'B.NET_INCOME': [1425, 0],
  }
  source.balanceSheet = source.balanceSheet.map(line => ({ ...line, amountCents: amounts[line.code]?.[0] ?? 0, comparativeCents: amounts[line.code]?.[1] ?? 0 }))
  source.incomeStatement = source.incomeStatement.map(line => ({ ...line, amountCents: ['REVENUE', 'RESULT_AFTER_TAX', 'NET_INCOME'].includes(line.code) ? 11900 : 0, comparativeCents: 0 }))
  source.ugResultAppropriation = { annualResultCents: 11900, shareCapitalCents: 100000, priorLossCarryforwardCents: 10000, priorProfitCarryforwardCents: 0, priorStatutoryReserveCents: 0, reserveAllocationCents: 475, distributionCents: 0, carryforwardCents: 1425, priorCarryforwardEvidenceId: 'prior', resolutionEvidenceId: 'resolution', capitalAccountId: 'capital', carryforwardAccountId: 'carry', reserveAccountId: 'reserve', reserveProposalId: 'reserve-posting' }
  return source
}

describe('UG annual result appropriation', () => {
  test('Given partial appropriation, when preparing a SMALL package, then the full annual profit and remaining balance-sheet profit coexist and the calculation is retained immutably', () => {
    const source = input()
    expect(validateAnnualAccounts(source)).toEqual([])
    const prepared = prepareAnnualAccounts(source, 1)
    const retained = JSON.parse(prepared.immutablePayload)
    expect(retained.ugResultAppropriation).toEqual(source.ugResultAppropriation)
    source.ugResultAppropriation!.reserveAllocationCents++
    expect(JSON.parse(prepared.immutablePayload).ugResultAppropriation.reserveAllocationCents).toBe(475)
    expect(retained.incomeStatement.find((line: { code: string }) => line.code === 'NET_INCOME').amountCents).toBe(11900)
    expect(retained.balanceSheet.find((line: { code: string }) => line.code === 'B.NET_INCOME').amountCents).toBe(1425)
  })

  test('Given inconsistent appropriation, when preparing the package, then mismatched profit, reserve or repeated carryforward is rejected', () => {
    for (const field of ['annualResultCents', 'reserveAllocationCents'] as const) {
      const source = input(); source.ugResultAppropriation![field]++
      expect(() => prepareAnnualAccounts(source, 1)).toThrow()
    }
    const source = input(); source.balanceSheet = source.balanceSheet.map(line => line.code === 'B.CARRYFORWARD' ? { ...line, amountCents: -10000 } : line)
    expect(validateAnnualAccounts(source)).toContain('Partial appropriation must include prior carryforward in balance-sheet profit/loss.')
  })
})
