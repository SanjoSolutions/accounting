import { describe, expect, it, test } from 'vitest'
import { buildCreditNoteRequest, buildStructuredInvoiceRequest, calculateInvoiceTotals, euroToCents, isValidIban } from './structuredInvoiceForm'

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


describe('credit-note request capture', () => {
  const values = { issueDate: '2026-08-05', description: 'Partial credit', net: '20.00', rate: '19', template: { data: { buyer: { name: 'Synthetic buyer' }, currency: 'EUR', lines: [{ taxRateBasisPoints: 1900, unitCode: 'C62' }] }, buyerReference: 'TEST', buyerElectronicAddress: { schemeId: 'EM' as const, value: 'buyer@example.test' }, paymentTerms: '14 days', paymentIban: 'DE89370400440532013000' } }
  test('Given a partial credit, when its intent is captured, then exact amounts, dates and source payment terms are retained', () => {
    expect(buildCreditNoteRequest(values, 'credit-ui-request-01')).toMatchObject({ kind: 'credit-note', requestKey: 'credit-ui-request-01', issueDate: '2026-08-05', supplyDate: '2026-08-05', netAmountCents: 2000, taxAmountCents: 380, grossAmountCents: 2380, buyerReference: 'TEST', lines: [{ description: 'Partial credit', netAmountCents: 2000 }] })
  })
  test.each([{ net: '0' }, { net: 'NaN' }, { net: '1.001' }, { rate: '20' }, { issueDate: '2026-02-30' }, { description: '  ' }])('Given invalid credit facts %j, when preparing an intent, then no request is captured', invalid => {
    expect(() => buildCreditNoteRequest({ ...values, ...invalid }, 'credit-ui-request-01')).toThrow()
  })
  test('Given a credit whose VAT pushes its gross amount beyond safe cent precision, when preparing an intent, then no request is captured', () => {
    expect(() => buildCreditNoteRequest({ ...values, net: '80000000000000.00' }, 'credit-ui-request-01')).toThrow(/safe cent precision/)
  })
})
