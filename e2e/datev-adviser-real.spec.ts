import { expect, test } from '@playwright/test'
import { parseDatevFiles } from '../src/core/datev'
import { DatevAdviserPage } from './datev-adviser-page'

test.describe('real DATEV adviser handoff', () => {
  test('Given a posted VAT invoice, when DATEV EXTF is downloaded and re-imported, then exact explicit cents survive the no-mock round trip', async ({ page }) => {
    const unique = `${Date.now()}-${Math.random().toString(16).slice(2)}`; const adviser = new DatevAdviserPage(page)
    await adviser.signUp(`DATEV ${unique}`, `datev-${unique}@example.test`, 'playwright-password-2026')
    await adviser.importSource(sourceDatev())
    const exported = await adviser.downloadExport()
    expect([...exported.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf])
    const parsed = parseDatevFiles([{ name: 'EXTF_Buchungsstapel_2026.csv', bytes: exported }])
    expect(parsed.bookings.map(item => ({ amount: item.amountCents, account: item.accountNumber, contra: item.contraAccountNumber, taxCode: item.taxCode }))).toEqual([
      { amount: 10000, account: 4930, contra: 70001, taxCode: '40' },
      { amount: 1900, account: 1576, contra: 70001, taxCode: undefined },
    ])
    await adviser.reimportExport(exported)
  })
})

function sourceDatev() {
  const metadata = ['EXTF', '700', '21', 'Buchungsstapel', '13', '20260804120000000', '', 'RE', '', '', '29098', '55003', '20260101', '4', '20260101', '20261231', 'Source', 'EX', '1', '0', '1', 'EUR', '', '', '', '', '03', '', '', '', '']
  const headers = ['Umsatz (ohne Soll/Haben-Kz)', 'Soll/Haben-Kennzeichen', 'Konto', 'Gegenkonto (ohne BU-Schlüssel)', 'BU-Schlüssel', 'Belegdatum', 'Belegfeld 1', 'Buchungstext', 'Buchungs GUID']
  const q = (value: string) => `"${value}"`
  const csv = [metadata.map((value, index) => [0, 3, 7, 8, 9, 16, 17, 21, 23, 26, 29, 30].includes(index) ? q(value) : value).join(';'), headers.join(';'), ['119,00', q('S'), '4930', '70001', q('0009'), '2307', q('RE-1'), q('Office invoice'), q('11111111-1111-1111-1111-111111111111')].join(';')].join('\r\n') + '\r\n'
  return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(csv)])
}
