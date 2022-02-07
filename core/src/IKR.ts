import { Account } from './Account.js'

/**
 * Industrieller Kontenrahmen
 */
export class IKR {

}

export enum BalanceSheetPosition {
  // Active
  FixedAssets = 1,
  CurrentAssets = 2,
  RechnungsabgrenzungspostenAktiv = 3,
  DeferredTaxAssets = 4,
  ActiveDifferenceFromAssetAllocation = 5,
  // Passive
  EquityCapital = 6,
  Accruals = 7,
  Liabilities = 8,
  RechnungsabgrenzungspostenPassiv = 9,
  DeferredTaxLiabilities = 10,
}

export function determineBalanceSheetPositionForAccount(account: Account): BalanceSheetPosition | null {
  const number = account.number
  if (number === null) {
    return null
  } else if (number >= 0 && number < 2000) {
    return BalanceSheetPosition.FixedAssets
  } else if (number >= 2000 && number < 2900) {
    return BalanceSheetPosition.CurrentAssets
  } else if (number >= 2900 && number < 3000) {
    return BalanceSheetPosition.RechnungsabgrenzungspostenAktiv
    // FIXME: DeferredTaxAssets? (more reading about that: https://de.wikipedia.org/wiki/Latente_Steuern)
    // FIXME: ActiveDifferenceFromAssetAllocation
  } else if (number >= 3000 && number < 3700) {
    return BalanceSheetPosition.EquityCapital
  } else if (number >= 3700 && number < 4000) {
    return BalanceSheetPosition.Accruals
    // FIXME: RechnungsabgrenzungspostenPassiv
    // FIXME: DeferredTaxLiabilities
  } else {
    return null
  }
}
