import { describe, expect, it } from 'vitest'
import { createFinancialStatements, type LedgerBalance } from './doubleEntry'
import { createEBalanceXbrl, getEBalanceTaxonomy, parseEBalanceMasterData } from './eBilanz'

describe('E-Bilanz XBRL export', () => {
  it('selects taxonomy 6.9 only for explicitly supported fiscal years', () => {
    expect(getEBalanceTaxonomy(2026).version).toBe('6.9')
    expect(() => getEBalanceTaxonomy(2024)).toThrow('keine freigegebene E-Bilanz-Taxonomie')
    expect(() => getEBalanceTaxonomy(2027)).toThrow('keine freigegebene E-Bilanz-Taxonomie')
  })
  it('requires every registered-office field in the master-data contract', () => {
    const complete = { companyName: 'A GmbH', street: 'Musterstraße 1', postalCode: '10115', city: 'Berlin', taxNumber: '1234567890123', legalForm: 'GMBH' }
    expect(parseEBalanceMasterData(complete)).toEqual(complete)
    for (const field of ['street', 'postalCode', 'city'] as const) {
      expect(() => parseEBalanceMasterData({ ...complete, [field]: ' ' })).toThrow('Straße, PLZ, Ort')
    }
  })
  it('creates deterministic, escaped EUR facts from mapped ledger accounts', () => {
    const balances: LedgerBalance[] = [{
      accountId: 'bank', number: 1200, name: 'Bank', category: 'ASSET',
      eBilanzPosition: 'bs.ass.currAss.cashEquiv.bank', debitCents: 12345,
      creditCents: 0, balanceCents: 12345,
    }]
    const xml = createEBalanceXbrl({
      name: 'A & B GmbH', street: 'Musterstraße 1', postalCode: '10115', city: 'Berlin', taxNumber: '1234/5678/90123', legalForm: 'GMBH', fiscalYear: 2026,
      fiscalYearStart: '2026-01-01', fiscalYearEnd: '2026-12-31', taxonomyVersion: '6.9',
      gaapNamespace: 'http://www.xbrl.de/taxonomies/de-gaap-ci-2025-04-01', gcdNamespace: 'http://www.xbrl.de/taxonomies/de-gcd-2025-04-01', entryPoint: 'de-gaap-ci-2025-04-01/de-gaap-ci-2025-04-01-shell-fiscal.xsd', gcdEntryPoint: 'de-gcd-2025-04-01/de-gcd-2025-04-01-shell.xsd', generationDate: '2027-01-10',
    }, createFinancialStatements(balances))

    expect(xml).toContain('A &amp; B GmbH')
    expect(xml).toContain('<xbrli:instant>2026-12-31</xbrli:instant>')
    expect(xml).not.toContain('genInfo.report.id.reportType')
    expect(xml).toContain('genInfo.report.id.reportElement.reportElements.BAL xsi:nil="true" contextRef="duration" />')
    expect(xml).toContain('genInfo.report.id.reportElement.reportElements.BVV xsi:nil="true" contextRef="duration" />')
    expect(xml).toContain('genInfo.report.id.statementType.statementType.E contextRef="duration" />')
    expect(xml).toContain('genInfo.report.id.accountingStandard.accountingStandard.HGB contextRef="duration" />')
    expect(xml).toContain('genInfo.report.id.incomeStatementFormat.incomeStatementFormat.GKV contextRef="duration" />')
    expect(xml).toContain('genInfo.company.id.idNo.type.companyId.ST13 contextRef="duration">1234567890123')
    expect(xml).toContain('genInfo.company.id.legalStatus.legalStatus.GMBH contextRef="duration" />')
    expect(xml).toContain('genInfo.company.id.location.street contextRef="duration">Musterstraße 1')
    expect(xml).toContain('genInfo.company.id.location.zipCode contextRef="duration">10115')
    expect(xml).toContain('genInfo.company.id.location.city contextRef="duration">Berlin')
    expect(xml).toContain('genInfo.report.period.fiscalYearBegin contextRef="duration">2026-01-01')
    expect(xml).toContain('<de-gaap-ci:bs.ass.currAss.cashEquiv.bank contextRef="instant" unitRef="EUR" decimals="2">123.45</de-gaap-ci:bs.ass.currAss.cashEquiv.bank>')
    expect(xml).toContain('<de-gaap-ci:bs.ass contextRef="instant" unitRef="EUR" decimals="2">123.45</de-gaap-ci:bs.ass>')
    expect(xml).toContain('<de-gaap-ci:bs.eqLiab contextRef="instant" unitRef="EUR" decimals="2">0.00</de-gaap-ci:bs.eqLiab>')
    expect(xml).toContain('<de-gaap-ci:detailedInformation.accountbalances.accountNumber contextRef="duration">1200</de-gaap-ci:detailedInformation.accountbalances.accountNumber>')
    expect(xml).toContain('<de-gaap-ci:detailedInformation.accountbalances.accountDescription contextRef="duration">Bank</de-gaap-ci:detailedInformation.accountbalances.accountDescription>')
    expect(xml).toContain('<de-gaap-ci:detailedInformation.accountbalances.amount contextRef="duration" unitRef="EUR" decimals="2">123.45</de-gaap-ci:detailedInformation.accountbalances.amount>')
    expect(xml).not.toContain('123,45')
  })

  it('cannot produce an invalid XML comment from the company name', () => {
    const xml = createEBalanceXbrl({ name: 'A--B', street: 'Weg 1', postalCode: '10115', city: 'Berlin', taxNumber: '1234567890123', legalForm: 'EUN', fiscalYear: 2026, fiscalYearStart: '2026-01-01', fiscalYearEnd: '2026-12-31', taxonomyVersion: '6.9', gaapNamespace: 'urn:gaap', gcdNamespace: 'urn:gcd', entryPoint: 'gaap.xsd', gcdEntryPoint: 'gcd.xsd', generationDate: '2027-01-10' }, createFinancialStatements([]))
    expect(xml).toContain('legalStatus.legalStatus.EUN')
    expect(xml).not.toContain('<!-- A--B')
    expect(xml).toContain('>A--B</de-gcd:genInfo.company.id.name>')
  })

  it('reconciles current-year profit into total equity', () => {
    const balances: LedgerBalance[] = [
      { accountId: 'capital', number: 2900, name: 'Eigenkapital', category: 'EQUITY', eBilanzPosition: 'bs.eqLiab.equity', debitCents: 0, creditCents: 100000, balanceCents: -100000 },
      { accountId: 'revenue', number: 8400, name: 'Erlöse', category: 'REVENUE', eBilanzPosition: 'is.revenue', debitCents: 0, creditCents: 50000, balanceCents: -50000 },
    ]
    const xml = createEBalanceXbrl({ name: 'A', street: 'Weg 1', postalCode: '10115', city: 'Berlin', taxNumber: '1234567890123', legalForm: 'GMBH', fiscalYear: 2026, fiscalYearStart: '2026-01-01', fiscalYearEnd: '2026-12-31', taxonomyVersion: '6.9', gaapNamespace: 'urn:gaap', gcdNamespace: 'urn:gcd', entryPoint: 'gaap.xsd', gcdEntryPoint: 'gcd.xsd', generationDate: '2027-01-10' }, createFinancialStatements(balances))
    expect(xml).toContain('bs.eqLiab.equity contextRef="instant" unitRef="EUR" decimals="2">1500.00')
    expect(xml).toContain('bs.eqLiab contextRef="instant" unitRef="EUR" decimals="2">1500.00')
    expect(xml).toContain('is.netIncome contextRef="duration" unitRef="EUR" decimals="2">500.00')
    expect(xml).toContain('detailedInformation.accountbalances.accountNumber contextRef="duration">2900')
    expect(xml).toContain('detailedInformation.accountbalances.amount contextRef="duration" unitRef="EUR" decimals="2">1000.00')
    expect(xml).toContain('detailedInformation.accountbalances.accountNumber contextRef="duration">ABSCHLUSS-EK')
    expect(xml).toContain('detailedInformation.accountbalances.accountNumber contextRef="duration">ABSCHLUSS-ERGEBNIS')
  })

  it('creates an equity fact when first-year opening equity is zero', () => {
    const balances: LedgerBalance[] = [{ accountId: 'revenue', number: 8400, name: 'Erlöse', category: 'REVENUE', eBilanzPosition: 'is.revenue', debitCents: 0, creditCents: 50000, balanceCents: -50000 }]
    const xml = createEBalanceXbrl({ name: 'A', street: 'Weg 1', postalCode: '10115', city: 'Berlin', taxNumber: '1234567890123', legalForm: 'EUN', fiscalYear: 2026, fiscalYearStart: '2026-01-01', fiscalYearEnd: '2026-12-31', taxonomyVersion: '6.9', gaapNamespace: 'urn:gaap', gcdNamespace: 'urn:gcd', entryPoint: 'gaap.xsd', gcdEntryPoint: 'gcd.xsd', generationDate: '2027-01-10' }, createFinancialStatements(balances))
    expect(xml).toContain('bs.eqLiab.equity contextRef="instant" unitRef="EUR" decimals="2">500.00')
    expect(xml).toContain('detailedInformation.accountbalances.accountNumber contextRef="duration">ABSCHLUSS-EK')
  })

  it('rejects XML 1.0 forbidden characters in user-provided master data', () => {
    expect(() => createEBalanceXbrl({ name: 'A\u0001GmbH', street: 'Weg 1', postalCode: '10115', city: 'Berlin', taxNumber: '1234567890123', legalForm: 'GMBH', fiscalYear: 2026, fiscalYearStart: '2026-01-01', fiscalYearEnd: '2026-12-31', taxonomyVersion: '6.9', gaapNamespace: 'urn:gaap', gcdNamespace: 'urn:gcd', entryPoint: 'gaap.xsd', gcdEntryPoint: 'gcd.xsd', generationDate: '2027-01-10' }, createFinancialStatements([]))).toThrow('in XML nicht zulässiges Zeichen')
  })

  it('normalizes and requires the 13-digit ELSTER tax number', () => {
    const base = { name: 'A', street: 'Weg 1', postalCode: '10115', city: 'Berlin', legalForm: 'GMBH' as const, fiscalYear: 2026, fiscalYearStart: '2026-01-01', fiscalYearEnd: '2026-12-31', taxonomyVersion: '6.9', gaapNamespace: 'urn:gaap', gcdNamespace: 'urn:gcd', entryPoint: 'gaap.xsd', gcdEntryPoint: 'gcd.xsd', generationDate: '2027-01-10' }
    expect(createEBalanceXbrl({ ...base, taxNumber: '1234/5678/90123' }, createFinancialStatements([]))).toContain('>1234567890123</de-gcd:genInfo.company.id.idNo.type.companyId.ST13>')
    expect(() => createEBalanceXbrl({ ...base, taxNumber: '1' }, createFinancialStatements([]))).toThrow('genau 13 Ziffern')
  })
})
