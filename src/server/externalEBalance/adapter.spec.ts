import { describe, expect, test } from 'vitest'
import { parse } from 'csv-parse/sync'
import { strFromU8, unzipSync } from 'fflate'
import type { LedgerBalance } from '@/core/doubleEntry'
import { createAccountExports, createExternalPackage, hashBytes, readExternalPackage, type ExternalEBalanceSource } from './adapter'

const bank: LedgerBalance = { accountId: 'bank', number: 1200, name: 'Bank; "Geschäft"', category: 'ASSET', eBilanzPosition: 'bs.ass.currAss.cashEquiv.bank', debitCents: 10001, creditCents: 0, balanceCents: 10001 }
const capital: LedgerBalance = { ...bank, accountId: 'capital', number: 800, name: 'Kapital', category: 'EQUITY', eBilanzPosition: 'bs.eqLiab.equity.subscribed', debitCents: 0, creditCents: 10001, balanceCents: -10001 }
const zero: LedgerBalance = { ...bank, accountId: 'zero', number: 1210, name: '=Unveränderte Bezeichnung', debitCents: 900, creditCents: 900, balanceCents: 0 }
export function externalFixture(): ExternalEBalanceSource {
  return { fiscalYearId: 'year-2026', year: 2026, startsAt: '2026-01-01', endsAt: '2026-12-31', closeGenerationId: 'close-1', sourceFingerprint: 'a'.repeat(64), taxonomyVersion: '6.9', accounts: [zero, bank, capital], dataset: { taxAdjustments: [{ amountCents: 300 }], assets: [{ id: 'asset-1' }] }, xbrl: '<xbrl/>', xbrlPackage: new Uint8Array([80, 75]) }
}
describe('External E-Bilanz documented adapter', () => {
  test('Given signed and zero balances and escaped German names, when exported, then exact cents and every account round-trip without lossy sanitization', () => {
    const result = createAccountExports(externalFixture().accounts)
    expect(result.providerCsv).toBeNull()
    expect(result.receiverLimitations[0]).toContain('Konto 1200')
    expect(result.reconciliation).toEqual({ accountCount: 3, debitCents: 10901, creditCents: 10901, differenceCents: 0, zeroBalanceAccounts: 1 })
    expect(result.mappingText).toContain('de-gaap-ci:bs.ass.currAss.cashEquiv.bank=1200,1210')
    expect((parse(result.portableCsv, { delimiter: ';', columns: true }) as Array<Record<string, string>>)[1]['Soll EUR']).toBe('100.01')
    expect((parse(result.portableCsv, { delimiter: ';', columns: true }) as Array<Record<string, string>>)[1]['Bezeichnung']).toBe('Bank; "Geschäft"')
    const compatible = createAccountExports([{ ...bank, name: 'Bank; Geschäft' }, capital, zero])
    expect(parse(compatible.providerCsv!, { delimiter: ';' })).toEqual([['800', '-100.01', 'Kapital'], ['1200', '100.01', 'Bank; Geschäft'], ['1210', '0.00', '=Unveränderte Bezeichnung']])
  })
  test.each([
    { ...bank, number: 0 }, { ...bank, balanceCents: 1 }, { ...bank, debitCents: 0.1 },
    { ...bank, name: 'Bank\n[csv]' }, { ...bank, eBilanzPosition: null }, { ...bank, eBilanzPosition: 'bs.bank\r\nignore=1' },
  ])('Given an invalid account %j, when exporting, then validation fails closed', account => {
    expect(() => createAccountExports([account, capital])).toThrow()
  })
  test('Given duplicate accounts or an unbalanced ledger, when exporting, then no reconciled export is produced', () => {
    expect(() => createAccountExports([bank, bank, capital])).toThrow(/eindeutig/)
    expect(() => createAccountExports([bank])).toThrow(/ausgeglichen/)
  })
  test('Given complete source evidence, when packaging, then every original fact and XBRL byte remains retained and the receiver is explicitly unvalidated', () => {
    const source = externalFixture(); source.accounts = source.accounts.map(account => ({ ...account, name: account.name.replaceAll('"', "'") })); const result = createExternalPackage(source, 2)
    const { files, manifest } = readExternalPackage(result.archive, hashBytes(result.archive))
    expect(manifest).toMatchObject({ version: 2, closeGenerationId: 'close-1', receiverStatus: 'NOT_VALIDATED', acceptanceStatus: 'NOT_AUTHENTICATED' })
    expect(JSON.parse(strFromU8(files['datengrundlage.json']))).toEqual(source.dataset)
    expect(strFromU8(files['e-bilanz.xbrl'])).toBe(source.xbrl)
    expect(files['xbrl-mit-taxonomie.zip']).toEqual(source.xbrlPackage)
    expect(strFromU8(files['myebilanz-mapping.ini.template'])).toContain('fieldXBRL=0')
    expect([...files['myebilanz-mapping.ini.template']].every(byte => byte < 128)).toBe(true)
    expect(strFromU8(files['SHA256SUMS.txt'])).toContain(hashBytes(files['manifest.json']) + '  manifest.json')
    expect(createExternalPackage(source, 2).archive).toEqual(result.archive)
  })
  test('Given changed bytes or an unsupported receiver year, when reading or preparing, then the package is rejected', () => {
    const source = externalFixture(); const { archive } = createExternalPackage(source, 1)
    expect(() => readExternalPackage(archive, '0'.repeat(64))).toThrow(/verändert/)
    expect(() => createExternalPackage({ ...source, taxonomyVersion: '6.10' }, 1)).toThrow(/6.9/)
    expect(unzipSync(archive)['ANLEITUNG.txt']).toBeDefined()
  })
  test('Given a name the receiver cannot escape, when packaging, then portable data stays complete and incompatible receiver files are omitted explicitly', () => {
    const { archive, manifest } = createExternalPackage(externalFixture(), 1)
    expect(manifest.receiverMode).toBe('PORTABLE_MANUAL_ALTERNATIVE')
    expect(manifest.receiverLimitations).toHaveLength(1)
    expect(unzipSync(archive)['myebilanz-salden.csv']).toBeUndefined()
    expect(unzipSync(archive)['susa.csv']).toBeDefined()
  })
})
