import { describe, expect, test } from 'vitest'
import { MAX_DATABASE_CENTS, type OpeningBalanceLine } from './doubleEntry'
import { createOpeningBalanceDeltaLines } from './openingBalanceDelta'

const pair = (amount: number): OpeningBalanceLine[] => [
  { accountId: 'bank', debitCents: Math.max(amount, 0), creditCents: Math.max(-amount, 0) },
  { accountId: 'equity', debitCents: Math.max(-amount, 0), creditCents: Math.max(amount, 0) },
]

describe('opening balance deltas', () => {
  test('Given multiple carry-forwards, when calculating the next delta, then it subtracts their net account balances', () => {
    expect(createOpeningBalanceDeltaLines(pair(8000), [...pair(10000), ...pair(10000)])).toEqual(pair(-12000))
    expect(createOpeningBalanceDeltaLines(pair(8000), pair(8000))).toEqual([])
  })

  test('Given an account removed from the target, when reclosed, then its carried balance is cancelled', () => {
    const target = pair(20000).map(line => line.accountId === 'bank' ? { ...line, accountId: 'cash' } : line)
    expect(createOpeningBalanceDeltaLines(target, pair(10000))).toEqual([
      { accountId: 'cash', debitCents: 20000, creditCents: 0 },
      { accountId: 'equity', debitCents: 0, creditCents: 10000 },
      { accountId: 'bank', debitCents: 0, creditCents: 10000 },
    ])
  })

  test('Given a large sign change, when calculating a delta, then each line fits the database integer limit', () => {
    expect(createOpeningBalanceDeltaLines(pair(MAX_DATABASE_CENTS), pair(-MAX_DATABASE_CENTS))).toEqual([
      pair(MAX_DATABASE_CENTS)[0], pair(MAX_DATABASE_CENTS)[0],
      pair(MAX_DATABASE_CENTS)[1], pair(MAX_DATABASE_CENTS)[1],
    ])
  })

  test('Given an unbalanced carry-forward, when calculating a delta, then close fails instead of posting an unbalanced journal', () => {
    expect(() => createOpeningBalanceDeltaLines(pair(20000), pair(10000).slice(0, 1))).toThrow(/nicht ausgeglichen/)
  })
})
