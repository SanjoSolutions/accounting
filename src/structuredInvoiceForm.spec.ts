import { describe, expect, it } from 'vitest'
import { buildStructuredInvoiceRequest, calculateInvoiceTotals, euroToCents, isValidIban } from './structuredInvoiceForm'

describe('structured UBL invoice form arithmetic', () => {
  it('Given German or dot decimal input, when converted, then exact integer cents are retained', () => {
    expect(euroToCents('100,00')).toBe(10_000)
    expect(euroToCents('0.01')).toBe(1)
    expect(() => euroToCents('1.001')).toThrow(/two decimal/)
  })

  it('Given 19% and 7% line groups, when totals are calculated, then VAT is rounded once per group', () => {
    expect(calculateInvoiceTotals([{ netAmount: '100.00', taxRate: '19' }, { netAmount: '10.00', taxRate: '7' }])).toEqual({ netAmountCents: 11_000, taxAmountCents: 1_970, grossAmountCents: 12_970 })
    expect(calculateInvoiceTotals([{ netAmount: '0.01', taxRate: '19' }, { netAmount: '0.02', taxRate: '19' }])).toEqual({ netAmountCents: 3, taxAmountCents: 1, grossAmountCents: 4 })
  })
})

describe('structured UBL invoice request', () => {
  const values = { requestKey: 'invoice-ui-request-0001', issueDate: '2026-08-04', supplyDate: '2026-08-04', buyerReference: 'KUNDENREF-2026', buyerElectronicAddressScheme: '0204' as const, buyerElectronicAddress: '04011000-12345-03', buyerName: 'Kunde GmbH', buyerStreet: 'Kundenweg 2', buyerPostalCode: '50667', buyerCity: 'Köln', buyerCountry: 'DE', buyerVatId: '', paymentTerms: 'Payable within 14 days.', paymentIban: 'DE89370400440532013000', lines: [{ id: 'line-1', description: 'Softwareberatung', quantity: '1', unitCode: 'C62', netAmount: '100.00', taxRate: '19' as const }] }

  it('Given a complete invoice, when the request is built, then seller is absent and totals are derived', () => {
    expect(buildStructuredInvoiceRequest(values)).toMatchObject({ requestKey: values.requestKey, buyerReference: 'KUNDENREF-2026', buyerElectronicAddress: { schemeId: '0204', value: '04011000-12345-03' }, buyer: { name: 'Kunde GmbH' }, netAmountCents: 10_000, taxAmountCents: 1_900, grossAmountCents: 11_900, lines: [{ netAmountCents: 10_000, taxRateBasisPoints: 1_900 }] })
    expect(buildStructuredInvoiceRequest(values).buyer).not.toHaveProperty('vatId')
    expect(buildStructuredInvoiceRequest(values)).not.toHaveProperty('seller')
  })

  it('Given a retry, when the same form values are rebuilt, then the stable request key remains unchanged', () => {
    expect(buildStructuredInvoiceRequest(values).requestKey).toBe(buildStructuredInvoiceRequest(values).requestKey)
  })

  it('Given an invalid IBAN or quantity, when issuance is prepared, then no request can be built', () => {
    expect(isValidIban('DE89370400440532013000')).toBe(true)
    expect(() => buildStructuredInvoiceRequest({ ...values, paymentIban: 'DE00370400440532013000' })).toThrow(/IBAN/)
    expect(() => buildStructuredInvoiceRequest({ ...values, lines: [{ ...values.lines[0], quantity: '0' }] })).toThrow(/positive/)
  })
})
