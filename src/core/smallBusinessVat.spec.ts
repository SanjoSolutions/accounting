import { describe, expect, test } from 'vitest'
import { calculateVat, createConfiguredVatRuleBook, representativeGermanVatRules } from './vatEngine'
import { assertVatRegimeRule, domesticSalesAccounts, isSmallBusinessInvoice, purchaseVatRule, smallBusinessVatRules, SMALL_BUSINESS_NOTICE, SMALL_BUSINESS_RULE } from './smallBusinessVat'
import { deriveReportApplicability, type CompanyProfile } from '@/server/compliance/companyProfile'
import { calculateInvoiceTotals, buildStructuredInvoiceRequest } from '@/structuredInvoiceForm'
import { generateXRechnungUblInvoice, receiveStructuredInvoice, renderInvoiceHtml } from './eInvoice'

const rules = createConfiguredVatRuleBook([...representativeGermanVatRules, ...smallBusinessVatRules(representativeGermanVatRules)], 'small-business-test')
const source = { ownerId: 'synthetic', sourceId: 'sale', amountCents: 10_000, mode: 'net' as const, taxPoint: '2026-01-01', ruleId: SMALL_BUSINESS_RULE }

describe('domestic Kleinunternehmer VAT from 2025', () => {
  test('Given §19 sales, when calculated, then no VAT or ordinary return box is produced', () => {
    expect(calculateVat(source, rules)).toMatchObject({ netBaseCents: 10_000, grossCents: 10_000, taxCents: 0, outputTaxCents: 0, inputTaxCents: 0, returnBoxes: [], reason: SMALL_BUSINESS_NOTICE })
    expect(() => calculateVat({ ...source, taxPoint: '2024-12-31' }, rules)).toThrow()
    expect(calculateVat({ ...source, taxPoint: '2025-01-01' }, rules).taxCents).toBe(0)
  })
  test.each([['DE_STANDARD', 1900, 0], ['DE_REDUCED', 700, 0], ['DE_13B', 1900, 1900], ['EU_13B_SERVICE_RECIPIENT', 1900, 1900], ['EU_ACQUISITION', 1900, 1900]])('Given a small-business purchase using %s, when calculated, then supplier or recipient VAT remains and no deduction arises', (rule, tax, output) => {
    const posting = calculateVat({ ...source, ruleId: purchaseVatRule(rule, 'SMALL_BUSINESS'), direction: 'purchase', ...(rule === 'EU_ACQUISITION' ? { supplyKind: 'goods' as const } : {}) }, rules)
    expect(posting).toMatchObject({ taxCents: tax, inputTaxCents: 0, deductibleTaxCents: 0, outputTaxCents: output })
    expect(posting.returnBoxes.some(box => box.value === 'input-tax')).toBe(false)
    if (output) expect(posting.returnBoxes.length).toBeGreaterThan(0)
  })
  test('Given an effective VAT regime, when a contradictory rule is requested, then it is rejected independently of legal form', () => {
    expect(() => assertVatRegimeRule('STANDARD', source)).toThrow(/effective Kleinunternehmer/)
    expect(() => assertVatRegimeRule('SMALL_BUSINESS', { ...source, ruleId: 'DE_STANDARD' })).toThrow(/effective Kleinunternehmer/)
    expect(() => assertVatRegimeRule('SMALL_BUSINESS', { ...source, direction: 'purchase' })).toThrow()
    expect(() => assertVatRegimeRule('SMALL_BUSINESS', { ...source, taxPoint: '2024-12-31' })).toThrow(/earlier periods/)
    expect(() => assertVatRegimeRule('SMALL_BUSINESS', source)).not.toThrow()
    expect(() => assertVatRegimeRule('STANDARD', { ...source, reversalOf: 'original' })).not.toThrow()
  })
  test.each(['UG', 'SOLE_TRADER'] as const)('Given a %s using §19, when reporting is derived, then routine VAT returns are omitted and explicit requests remain visible', legalForm => {
    const profile = { vatRegime: 'SMALL_BUSINESS', legalForm, sizeClass: 'MICRO', elections: [] } as unknown as CompanyProfile
    const reports = deriveReportApplicability(profile)
    expect(reports.VAT_ANNUAL.applicable).toBe(false)
    expect(reports.VAT_ADVANCE.applicable).toBe(false)
    expect(deriveReportApplicability({ ...profile, applicabilityOverrides: { VAT_ANNUAL: true } }).VAT_ANNUAL).toMatchObject({ applicable: true, overridden: true })
  })
  test('Given the post-2025 charts, when exempt sales are posted, then the new revenue account needs no VAT control', () => {
    expect(domesticSalesAccounts('SKR03', 0)).toEqual({ revenue: 8192, outputVat: undefined })
    expect(domesticSalesAccounts('SKR04', 0, 10)).toEqual({ revenue: 41840, outputVat: undefined })
  })
  test('Given exempt form lines, when an invoice is built and rendered without a VAT ID, then the statutory notice and email endpoint survive the XML round trip', () => {
    const request = buildStructuredInvoiceRequest({ requestKey: 'small-business-test-request', issueDate: '2026-05-01', supplyDate: '2026-05-01', buyerReference: 'Order 1', buyerElectronicAddressScheme: 'EM', buyerElectronicAddress: 'buyer@example.test', buyerName: 'Buyer', buyerStreet: 'Test 2', buyerPostalCode: '10115', buyerCity: 'Berlin', buyerCountry: 'DE', paymentTerms: '14 days', paymentIban: 'DE89370400440532013000', lines: [{ id: 'line', description: 'Consulting', quantity: '1', unitCode: 'C62', netAmount: '100', taxRate: '0' }] })
    expect(request).toMatchObject({ taxAmountCents: 0, grossAmountCents: 10_000, exemptionReason: SMALL_BUSINESS_NOTICE })
    const bytes = generateXRechnungUblInvoice({ ...request, invoiceNumber: '2026-1', seller: { name: 'Seller', street: 'Test 1', postalCode: '10115', city: 'Berlin', countryCode: 'DE', taxId: '12/345/67890' }, sellerContact: { name: 'Seller', telephone: '+49 30 123456', email: 'seller@example.test' } })
    expect(new TextDecoder().decode(bytes)).toContain('<cbc:EndpointID schemeID="EM">seller@example.test</cbc:EndpointID>')
    const received = receiveStructuredInvoice(bytes)
    expect(isSmallBusinessInvoice(received.data.lines, received.data.exemptionReason)).toBe(true)
    expect(renderInvoiceHtml(received)).toContain(SMALL_BUSINESS_NOTICE)
    expect(() => calculateInvoiceTotals([{ netAmount: '100', taxRate: '0' }, { netAmount: '100', taxRate: '19' }])).toThrow(/cannot be combined/)
  })
})
