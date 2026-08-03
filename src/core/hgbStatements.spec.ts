import { describe, expect, it } from 'vitest'
import { buildHgbStatements, createHgbStatementRuleSet, HgbStatementValidationError, type HgbAccountMapping, type HgbStatementInput, type HgbTrialBalanceAccount } from './hgbStatements'

const mapping = (accountNumber: string, lineId: string, normalBalance: 'DEBIT' | 'CREDIT', presentationSign: 1 | -1 = 1): HgbAccountMapping => ({ accountNumber, lineId, normalBalance, presentationSign, effectiveFrom: '2024-01-01' })
const row = (accountNumber: string, debitCents: number, creditCents: number, openingDebitCents = 0, openingCreditCents = 0): HgbTrialBalanceAccount => ({ accountNumber, debitCents, creditCents, openingDebitCents, openingCreditCents })

function validInput(method: 'GKV' | 'UKV' = 'GKV', size: 'MICRO' | 'SMALL' = 'SMALL'): HgbStatementInput {
  const ruleSet = createHgbStatementRuleSet(size, method)
  const revenue = size === 'MICRO' ? 'IS.M.1' : `IS.${method}.1`
  const expense = size === 'MICRO' ? 'IS.M.6' : method === 'GKV' ? 'IS.GKV.8' : 'IS.UKV.5'
  const expected = new Map(ruleSet.lines.filter(item => !ruleSet.lines.some(candidate => candidate.parentId === item.id)).map(item => [item.id, 0]))
  expected.set(size === 'MICRO' ? 'BS.A.B' : 'BS.A.B.IV', 90_000)
  expected.set(size === 'MICRO' ? 'BS.P.A' : 'BS.P.A.I', size === 'MICRO' ? 90_000 : 30_000)
  expected.set(revenue, 75_000); expected.set(expense, 15_000)
  expected.set(size === 'MICRO' ? 'IS.M.8' : `IS.${method}.NET`, 60_000)
  if (size === 'SMALL') {
    expected.set('BS.P.A.V', 60_000); expected.set(`IS.${method}.AFTER_TAX`, 60_000)
    if (method === 'UKV') expected.set('IS.UKV.3', 75_000)
  }
  return {
    ruleSet,
    current: { startsAt: '2025-01-01', endsAt: '2025-12-31', accounts: [row('1000', 120_000, 0), row('2000', 0, 40_000), row('4000', 0, 100_000), row('6000', 20_000, 0)] },
    comparative: { startsAt: '2024-01-01', endsAt: '2024-12-31', accounts: [row('1000', 90_000, 0), row('2000', 0, 30_000), row('4000', 0, 75_000), row('6000', 15_000, 0)] },
    mappings: [mapping('1000', size === 'MICRO' ? 'BS.A.B' : 'BS.A.B.IV', 'DEBIT'), mapping('2000', size === 'MICRO' ? 'BS.P.A' : 'BS.P.A.I', 'CREDIT'), mapping('4000', revenue, 'CREDIT'), mapping('6000', expense, 'DEBIT')],
    expectedComparativeLeaves: [...expected].map(([lineId, amountCents]) => ({ lineId, amountCents })),
  }
}

describe('HGB statement generation', () => {
  it.each([['SMALL', 'GKV'], ['SMALL', 'UKV'], ['MICRO', 'GKV'], ['MICRO', 'UKV']] as const)('rolls mapped leaves into the %s %s hierarchy and reconciles both periods', (size, method) => {
    const result = buildHgbStatements(validInput(method, size))
    expect(result.lines.find(item => item.id === 'BS.ASSETS')).toMatchObject({ amountCents: 120_000, comparativeAmountCents: 90_000, changeCents: 30_000 })
    expect(result.lines.find(item => item.id === 'BS.EQUITY_LIABILITIES')).toMatchObject({ amountCents: 120_000, comparativeAmountCents: 90_000 })
    expect(result.currentNetIncomeCents).toBe(80_000)
    expect(result.comparativeNetIncomeCents).toBe(60_000)
    expect(Object.values(result.checks)).toEqual([0, 0, 0, 0, 0, 0, 0])
  })

  it('normalizes credit-normal contra assets with an explicit negative presentation sign', () => {
    const input = validInput()
    input.current.accounts = [...input.current.accounts, row('1299', 0, 10_000), row('6999', 10_000, 0)]
    input.comparative.accounts = [...input.comparative.accounts, row('1299', 0, 5_000), row('6999', 5_000, 0)]
    input.mappings = [...input.mappings, mapping('1299', 'BS.A.A.II', 'CREDIT', -1), mapping('6999', 'IS.GKV.8', 'DEBIT')]
    input.expectedComparativeLeaves = input.expectedComparativeLeaves.map(item => {
      if (item.lineId === 'BS.A.A.II') return { ...item, amountCents: -5_000 }
      if (item.lineId === 'IS.GKV.8') return { ...item, amountCents: 20_000 }
      if (item.lineId === 'BS.P.A.V' || item.lineId === 'IS.GKV.NET' || item.lineId === 'IS.GKV.AFTER_TAX') return { ...item, amountCents: 55_000 }
      return item
    })
    const result = buildHgbStatements(input)
    expect(result.mappedAccounts.find(item => item.accountNumber === '1299' && item.period === 'CURRENT')).toMatchObject({ normalBalanceAmountCents: 10_000, statementAmountCents: -10_000 })
    expect(result.lines.find(item => item.id === 'BS.A.A.II')?.amountCents).toBe(-10_000)
  })

  it('rolls GKV subitems into their statutory parent without losing account drilldown', () => {
    const input = validInput()
    input.mappings = input.mappings.map(item => item.accountNumber === '6000' ? { ...item, lineId: 'IS.GKV.5.A' } : item)
    input.expectedComparativeLeaves = input.expectedComparativeLeaves.map(item => item.lineId === 'IS.GKV.8' ? { ...item, amountCents: 0 } : item.lineId === 'IS.GKV.5.A' ? { ...item, amountCents: 15_000 } : item)
    const result = buildHgbStatements(input)
    expect(result.lines.find(item => item.id === 'IS.GKV.5.A')?.amountCents).toBe(20_000)
    expect(result.lines.find(item => item.id === 'IS.GKV.5')?.amountCents).toBe(20_000)
    expect(result.mappedAccounts.find(item => item.accountNumber === '6000' && item.period === 'CURRENT')?.lineId).toBe('IS.GKV.5.A')
  })

  it.each([
    ['missing', (input: HgbStatementInput) => { input.mappings = input.mappings.filter(item => item.accountNumber !== '4000') }, /0 effective mappings/],
    ['ambiguous', (input: HgbStatementInput) => { input.mappings = [...input.mappings, mapping('4000', 'IS.GKV.4', 'CREDIT')] }, /2 effective mappings/],
    ['parent target', (input: HgbStatementInput) => { input.mappings = input.mappings.map(item => item.accountNumber === '1000' ? { ...item, lineId: 'BS.A.B' } : item) }, /account-bearing leaf/],
  ])('fails closed on a %s effective mapping', (_name, mutate, expected) => {
    const input = validInput(); mutate(input)
    expect(() => buildHgbStatements(input)).toThrow(expected)
  })

  it('selects mappings independently at each period end', () => {
    const input = validInput()
    input.mappings = input.mappings.flatMap(item => item.accountNumber === '1000' ? [
      { ...item, lineId: 'BS.A.B.II', effectiveFrom: '2024-01-01', effectiveTo: '2024-12-31' },
      { ...item, lineId: 'BS.A.B.IV', effectiveFrom: '2025-01-01' },
    ] : [item])
    input.expectedComparativeLeaves = input.expectedComparativeLeaves.map(item => item.lineId === 'BS.A.B.IV' ? { ...item, amountCents: 0 } : item.lineId === 'BS.A.B.II' ? { ...item, amountCents: 90_000 } : item)
    const result = buildHgbStatements(input)
    expect(result.lines.find(item => item.id === 'BS.A.B.II')).toMatchObject({ amountCents: 0, comparativeAmountCents: 90_000 })
    expect(result.lines.find(item => item.id === 'BS.A.B.IV')).toMatchObject({ amountCents: 120_000, comparativeAmountCents: 0 })
  })

  it('reconciles every comparative leaf to an approved prior presentation', () => {
    const input = validInput()
    expect(buildHgbStatements(input).checks.comparativeExpectedDifferenceCents).toBe(0)
    const expectations = [...input.expectedComparativeLeaves]
    expectations[0] = { ...expectations[0], amountCents: expectations[0].amountCents + 1 }
    input.expectedComparativeLeaves = expectations
    expect(() => buildHgbStatements(input)).toThrow(/approved prior presentation by 1 cents/)
  })

  it('does not publish comparatives without approved prior-period leaf values', () => {
    const input = validInput()
    ;(input as unknown as { expectedComparativeLeaves?: unknown }).expectedComparativeLeaves = undefined
    expect(() => buildHgbStatements(input)).toThrow(/Approved prior-period comparative leaf values are required/)
  })

  it.each([
    ['unbalanced postings', (input: HgbStatementInput) => { input.current.accounts[0].debitCents += 1 }, /period trial balance does not balance/],
    ['unbalanced opening balances', (input: HgbStatementInput) => { input.current.accounts[0].openingDebitCents = 1 }, /opening trial balance does not balance/],
    ['an income-statement opening balance', (input: HgbStatementInput) => { input.current.accounts[2].openingCreditCents = 1; input.current.accounts[0].openingDebitCents = 1 }, /income-statement account.*nonzero opening/],
    ['an unsafe amount', (input: HgbStatementInput) => { input.current.accounts[0].debitCents = Number.MAX_SAFE_INTEGER + 1 }, /safe integer/],
    ['a negative debit', (input: HgbStatementInput) => { input.current.accounts[0].debitCents = -1 }, /cannot be negative/],
    ['an impossible calendar date', (input: HgbStatementInput) => { input.current.endsAt = '2025-02-30' }, /dates are invalid/],
    ['an incompatible sign', (input: HgbStatementInput) => { input.mappings = input.mappings.map(item => item.accountNumber === '1000' ? { ...item, normalBalance: 'CREDIT' as const } : item) }, /incompatible/],
  ])('fails closed on %s', (_name, mutate, expected) => {
    const input = validInput(); mutate(input)
    expect(() => buildHgbStatements(input)).toThrow(expected)
  })

  it('fails closed when a supplied layout differs from the registered statutory profile', () => {
    const input = validInput()
    input.ruleSet = { ...input.ruleSet, lines: input.ruleSet.lines.map(item => item.id === 'BS.P.A.V' ? { ...item, derived: undefined } : item) }
    expect(() => buildHgbStatements(input)).toThrow(/does not match the registered/)
  })

  it('reports structured validation failures without returning a partial statement', () => {
    const input = validInput(); input.current.accounts[0].debitCents += 1
    expect(() => buildHgbStatements(input)).toThrow(HgbStatementValidationError)
  })
})
