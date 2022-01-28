import { describe, it, test } from '@jest/globals'
import { BalanceSheet } from './BalanceSheet'

describe('BalanceSheet', () => {
  test('', () => {
    const balanceSheet = new BalanceSheet()
  })

  describe('support for the German law system', () => {
    describe('support for micro-corporations', () => {
      /**
       * @see https://www.gesetze-im-internet.de/hgb/__266.html
       */
      it('supports the positions from § 266 Abs. 1 Satz 4 HGB', () => {
        const balanceSheet = new BalanceSheet()

        balanceSheet.addActivePosition('A. Anlagevermögen')
        balanceSheet.addActivePosition('B. Umlaufvermögen')
        balanceSheet.addActivePosition('C. Rechnungsabgrenzungsposten')
        balanceSheet.addActivePosition('D. Aktive latente Steuern')
        balanceSheet.addActivePosition('E. Aktiver Unterschiedsbetrag aus der Vermögensverrechnung')

        balanceSheet.addPassivePosition('A. Eigenkapital')
        balanceSheet.addPassivePosition('B. Rückstellungen')
        balanceSheet.addPassivePosition('C. Verbindlichkeiten')
        balanceSheet.addPassivePosition('D. Rechnungsabgrenzungsposten')
        balanceSheet.addPassivePosition('E. Passive latente Steuern')
      })
    })
  })

  it('supports set the value of a position', () => {
    const balanceSheet = new BalanceSheet()
    balanceSheet.addActivePosition('A. Anlagevermögen')
    balanceSheet.setActivePosition('A. Anlagevermögen', 1000)
  })
})
