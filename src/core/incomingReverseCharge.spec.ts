import { describe, expect, it } from 'vitest'
import { classifyIncomingGermanReverseCharge, parseIncomingReverseChargeAccounts, requireIncomingReverseChargeAccountsForLedger } from './incomingReverseCharge'

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

describe('incoming EU supplier service reverse charge', () => {
  const invoice = (sellerCountry = 'AT') => ({ syntax: 'UBL' as const, kind: 'invoice' as const, invoiceNumber: 'AT-SVC-1', issueDate: '2026-07-26', supplyDate: '2026-07-26', seller: { name: 'Vienna Cloud GmbH', street: 'Ring 1', city: 'Wien', postalCode: '1010', countryCode: sellerCountry, vatId: `${sellerCountry}U12345678` }, buyer: { name: 'Buyer GmbH', street: 'B 2', city: 'Berlin', postalCode: '10115', countryCode: 'DE', vatId: 'DE987654321' }, lines: [{ description: 'Cloud service', quantity: 1, unitCode: 'C62', netAmountCents: 10_000, taxRateBasisPoints: 0, taxCategoryCode: 'AE', reverseCharge: true, exemptionReason: 'Reverse charge - Article 196 VAT Directive' }], netAmountCents: 10_000, taxAmountCents: 0, grossAmountCents: 10_000, payableAmountCents: 10_000, currency: 'EUR', reverseCharge: true })

  it('Given an Austrian supplier and German business buyer with an explicit Article 196 service line, when classified, then the distinct EU §13b profile is selected', () => {
    expect(classifyIncomingGermanReverseCharge(invoice())).toMatchObject({ kind: 'DE_13B_EU_SERVICE', supportedAssessmentRatesBasisPoints: [1900] })
  })

  it.each(['DE', 'GB', 'CH', 'NO', 'XI'])('Given seller country %s outside the other EU member countries, when classified, then it fails closed', sellerCountry => {
    const candidate = invoice(sellerCountry)
    if (sellerCountry === 'DE') candidate.seller.vatId = 'DE123456789'
    expect(() => classifyIncomingGermanReverseCharge(candidate)).toThrow()
  })

  it('Given an AE invoice without exact business, service, VAT-ID, or legal-reason evidence, when classified, then it fails closed', () => {
    const valid = invoice()
    expect(() => classifyIncomingGermanReverseCharge({ ...valid, buyer: { ...valid.buyer, vatId: undefined } })).toThrow(/German VAT ID/)
    expect(() => classifyIncomingGermanReverseCharge({ ...valid, seller: { ...valid.seller, vatId: 'DE123456789' } })).toThrow(/matching/)
    expect(() => classifyIncomingGermanReverseCharge({ ...valid, seller: { ...valid.seller, vatId: 'ATU123' } })).toThrow(/syntactically valid/)
    expect(() => classifyIncomingGermanReverseCharge({ ...valid, lines: [{ ...valid.lines[0], exemptionReason: 'Reverse charge' }] })).toThrow(/Article 196/)
  })

  it('Given exact structured legal evidence, when descriptions vary, then classification does not infer supply kind from free text', () => {
    const valid = invoice()
    expect(classifyIncomingGermanReverseCharge({ ...valid, lines: [{ ...valid.lines[0], description: 'Subscription position 1' }] })).toMatchObject({ kind: 'DE_13B_EU_SERVICE' })
    expect(classifyIncomingGermanReverseCharge({ ...valid, lines: [{ ...valid.lines[0], description: 'Laptop' }] })).toMatchObject({ kind: 'DE_13B_EU_SERVICE' })
  })
})
