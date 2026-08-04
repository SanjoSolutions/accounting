import { describe, expect, it } from 'vitest'
import { parseIncomingReverseChargeAccounts, requireIncomingReverseChargeAccountsForLedger } from './incomingReverseCharge'

describe('incoming §13b control-account configuration', () => {
  it('Given explicit distinct chart-bound 19% controls, when configuration is parsed, then exact account identities are retained without inferred mappings', () => {
    expect(parseIncomingReverseChargeAccounts({ chart: 'SKR04', rateBasisPoints: 1900, inputVatAccountNumber: 1407, outputVatAccountNumber: 3837 })).toEqual({ chart: 'SKR04', rateBasisPoints: 1900, inputVatAccountNumber: 1407, outputVatAccountNumber: 3837 })
  })

  it('Given missing, reduced-rate, same-account, or extra-field configuration, when parsed, then configuration fails closed', () => {
    expect(parseIncomingReverseChargeAccounts(undefined)).toBeNull()
    for (const value of [
      { chart: 'SKR03', rateBasisPoints: 700, inputVatAccountNumber: 1577, outputVatAccountNumber: 1787 },
      { chart: 'SKR03', rateBasisPoints: 1900, inputVatAccountNumber: 1577, outputVatAccountNumber: 1577 },
      { chart: 'SKR03', rateBasisPoints: 1900, inputVatAccountNumber: 1577, outputVatAccountNumber: 1787, guessed: true },
    ]) expect(() => parseIncomingReverseChargeAccounts(value)).toThrow(/configuration/)
  })

  it('Given explicit controls for another chart or account length, when activated, then they fail before ledger accounts are created', () => {
    const configuration = parseIncomingReverseChargeAccounts({ chart: 'SKR03', rateBasisPoints: 1900, inputVatAccountNumber: 1577, outputVatAccountNumber: 1787 })!
    expect(() => requireIncomingReverseChargeAccountsForLedger(configuration, 'SKR04', 4)).toThrow(/active ledger chart/)
    expect(() => requireIncomingReverseChargeAccountsForLedger(configuration, 'SKR03', 5)).toThrow(/exactly 5 digits/)
    expect(requireIncomingReverseChargeAccountsForLedger(configuration, 'SKR03', 4)).toBe(configuration)
  })
})
