import { describe, expect, test } from 'vitest'
import { euerCsv, euerDecimal, euerPositionsForVatRegime, euerRecognitionYear, parseEuerInput, prepareEuer, type EuerEntry, type EuerProfile } from './euer'
import { usesEuer, validateSoleTraderTaxProfile } from './companyTaxProfile'
import { deriveReportApplicability, validateCompanyProfile, type CompanyProfile } from '@/server/compliance/companyProfile'
import { parseEuerAmount } from '@/euerForm'

const profile: EuerProfile = { legalForm: 'SOLE_TRADER', companyName: 'Example', taxNumber: '123/456/78901', activity: 'Consulting', vatRegime: 'STANDARD', soleTraderTaxProfile: { profitDetermination: 'EUER', incomeType: 'TRADE', euerEligibilityConfirmed: true } }
const entry = (position = 'taxableReceipts', amountCents = 10000, patch: Partial<EuerEntry> = {}): EuerEntry => ({ id: position, position, amountCents, paymentDate: '2026-07-01', reference: 'BANK-1', description: 'Paid consulting', ...patch })
const input = (entries: EuerEntry[], scopeConfirmed = true) => ({ entries, scopeConfirmed })

describe('sole trader profit determination', () => {
  test('Given a legacy or balance-sheet profile, when determining applicability, then EÜR is never inferred from legal form or VAT status', () => {
    expect(usesEuer({ legalForm: 'SOLE_TRADER' })).toBe(false)
    expect(usesEuer({ ...profile, soleTraderTaxProfile: { ...profile.soleTraderTaxProfile!, profitDetermination: 'BALANCE_SHEET' } })).toBe(false)
    expect(validateSoleTraderTaxProfile('SOLE_TRADER', undefined)).toEqual([])
    expect(validateSoleTraderTaxProfile('GMBH', profile.soleTraderTaxProfile)).not.toEqual([])
    expect(validateSoleTraderTaxProfile('SOLE_TRADER', { ...profile.soleTraderTaxProfile, euerEligibilityConfirmed: false })).not.toEqual([])
    expect(validateSoleTraderTaxProfile('SOLE_TRADER', { ...profile.soleTraderTaxProfile, incomeType: 'OTHER' })).not.toEqual([])
  })
  test('Given confirmed EÜR, when deriving reports, then balance-sheet reports do not apply and VAT treatment remains independent', () => {
    for (const vatRegime of ['STANDARD', 'SMALL_BUSINESS', 'EXEMPT'] as const) {
      const facts = { ...profile, legalForm: 'SOLE_TRADER', taxOffice: 'Berlin', chart: 'SKR03', vatRegime, vatFilingFrequency: 'MONTHLY', sizeClass: 'SMALL', elections: [] } satisfies CompanyProfile
      expect(usesEuer(facts)).toBe(true)
      expect(deriveReportApplicability(facts).E_BILANZ.applicable).toBe(false)
      expect(deriveReportApplicability(facts).HGB_FINANCIAL_STATEMENTS.applicable).toBe(false)
      expect(deriveReportApplicability(facts).VAT_ADVANCE.applicable).toBe(vatRegime === 'STANDARD')
      expect(validateCompanyProfile({ ...facts, applicabilityOverrides: { E_BILANZ: true } })).toContain('EÜR cannot enable balance-sheet reporting overrides')
    }
  })
})

describe('EÜR workpaper calculations', () => {
  test('Given received and paid amounts, when preparing EÜR, then VAT is separate and owner transfers do not affect profit', () => {
    const report = prepareEuer(2026, profile, input([entry(), entry('vatReceived', 1900), entry('supplies', 2000), entry('inputVatPaid', 380), entry('deposits', 99999), entry('withdrawals', 88888)]))
    expect(report).toMatchObject({ incomeCents: 11900, expenseCents: 2380, profitCents: 9520, transmission: 'MANUAL_ELSTER' })
    expect(report.positions.find(row => row.key === 'taxableReceipts')?.entryIds).toEqual(['taxableReceipts'])
    expect(report.positions.find(row => row.key === 'deposits')?.amountCents).toBe(99999)
  })
  test('Given refunds and a loss, when calculating, then signed exact cents and year-specific form lines are preserved', () => {
    const report = prepareEuer(2026, profile, input([entry('taxableReceipts', -101), entry('supplies', 202)]))
    expect(report.profitCents).toBe(-303)
    expect(euerDecimal(report.profitCents)).toBe('-3,03')
    expect(report.positions.find(row => row.key === 'supplies')).toMatchObject({ line: 52, code: '229' })
    const previous = prepareEuer(2025, profile, input([]))
    expect(previous.positions.find(row => row.key === 'supplies')).toMatchObject({ line: 51, code: '229' })
    expect(previous.profitLine).toBe(97); expect(report.profitLine).toBe(98)
    expect(previous.positions.find(row => row.key === 'goods')?.line).toBe(27)
    expect(report.positions.find(row => row.key === 'goods')?.line).toBe(29)
  })
  test('Given a different payment year or an unpaid invoice date, when preparing, then the entry cannot be treated as current-year cash income', () => {
    expect(() => prepareEuer(2026, profile, input([entry('taxableReceipts', 100, { paymentDate: '2027-01-11' })]))).toThrow(/does not belong/)
    expect(() => prepareEuer(2026, profile, input([entry('taxableReceipts', 100, { paymentDate: '' })]))).toThrow(/dates/)
  })
  test('Given a recurring year-boundary payment, when both payment and due date meet §11 timing, then it belongs to its economic year', () => {
    const paid = entry('vatRemitted', 1900, { paymentDate: '2027-01-10', recurring: { dueDate: '2027-01-10', economicYear: 2026 } })
    expect(prepareEuer(2026, profile, input([paid])).expenseCents).toBe(1900)
    expect(euerRecognitionYear(entry('rent', 100, { paymentDate: '2025-12-22', recurring: { dueDate: '2026-01-05', economicYear: 2026 } }))).toBe(2026)
    for (const patch of [{ paymentDate: '2027-01-11' }, { recurring: { dueDate: '2027-01-11', economicYear: 2026 } }]) expect(() => prepareEuer(2026, profile, input([{ ...paid, ...patch }]))).toThrow(/ten days/)
    expect(() => prepareEuer(2026, profile, input([{ ...paid, position: 'withdrawals' }]))).toThrow(/Owner transfers/)
  })
  test('Given the configured VAT regime, when recording receipts, then incompatible positions and separate small-business input VAT are rejected', () => {
    const small = { ...profile, vatRegime: 'SMALL_BUSINESS' }
    expect(prepareEuer(2026, small, input([entry('smallBusinessReceipts', 11900), entry('supplies', 2380)])).profitCents).toBe(9520)
    expect(euerPositionsForVatRegime('SMALL_BUSINESS').map(item => item.key)).not.toContain('inputVatPaid')
    expect(euerPositionsForVatRegime('STANDARD').map(item => item.key)).not.toContain('smallBusinessReceipts')
    expect(euerPositionsForVatRegime('EXEMPT').map(item => item.key)).not.toContain('vatReceived')
    expect(() => prepareEuer(2026, small, input([entry('inputVatPaid', 380)]))).toThrow(/gross amounts/)
    expect(() => prepareEuer(2026, profile, input([entry('smallBusinessReceipts')]))).toThrow(/regime/)
    expect(() => prepareEuer(2026, { ...profile, vatRegime: 'EXEMPT' }, input([entry('vatReceived')]))).toThrow(/VAT-exempt/)
    expect(prepareEuer(2026, { ...profile, soleTraderTaxProfile: { ...profile.soleTraderTaxProfile!, incomeType: 'SELF_EMPLOYED' } }, input([])).incomeType).toBe('SELF_EMPLOYED')
  })
  test('Given malformed, duplicated, unsafe or unsupported facts, when preparing, then no plausible workpaper is returned', () => {
    for (const raw of [null, [], {}, { entries: [null], scopeConfirmed: false }, input([entry(), entry()]), input([entry('unknown')]), input([entry('supplies', 1.1)]), input([entry('supplies', 0)]), input([entry('supplies', 100, { paymentDate: '2026-02-30' })]), input([entry('supplies', 100, { reference: ' ' })])]) expect(() => parseEuerInput(raw)).toThrow()
    expect(() => prepareEuer(2027, profile, input([]))).toThrow(/2025 and 2026/)
    expect(() => prepareEuer(2026, { ...profile, legalForm: 'UG' }, input([]))).toThrow(/sole trader/)
    expect(() => prepareEuer(2026, profile, input([entry('supplies', Number.MAX_SAFE_INTEGER), entry('supplies', 1, { id: 'second' })]))).toThrow(/totals exceed/)
  })
  test('Given a reviewed workpaper, when exporting, then exact amounts, sources and manual-filing status are included without spreadsheet formulas', () => {
    const report = prepareEuer(2026, { ...profile, companyName: '=SUM(1;2)' }, input([entry('taxableReceipts', 12345, { reference: '@evil', description: 'A;B "quoted"' })]))
    const csv = euerCsv(report)
    expect(csv).toContain('"123,45"'); expect(csv).toContain('"\'=SUM(1;2)"'); expect(csv).toContain('"\'@evil"')
    expect(csv).toContain('"A;B ""quoted"""'); expect(csv).toContain('Keine elektronische Übermittlung')
    expect(csv).toContain('2 - Gewerbebetrieb'); expect(csv).toContain(report.sourceUrl)
    expect(() => euerCsv(prepareEuer(2026, profile, input([], false)))).toThrow(/Review/)
  })
})

describe('EÜR amount entry', () => {
  test('Given decimal input, when converting to cents, then no floating-point rounding or grouping ambiguity is accepted', () => {
    expect(parseEuerAmount('0,29')).toBe(29); expect(parseEuerAmount('-12.5')).toBe(-1250)
    for (const value of ['1.234', '1,234.00', 'NaN', '1e3', '0', '', '90071992547409.92']) expect(() => parseEuerAmount(value)).toThrow()
  })
})
