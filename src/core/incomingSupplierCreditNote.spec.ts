import { describe, expect, it } from 'vitest'
import { planIncomingSupplierCredit } from './incomingSupplierCreditNote'
import type { StructuredInvoiceData } from './eInvoice'

const invoice: StructuredInvoiceData = { syntax: 'UBL', kind: 'invoice', invoiceNumber: 'ER-1', issueDate: '2026-07-01', supplyDate: '2026-07-01', seller: { name: 'Supplier GmbH', street: 'A 1', postalCode: '10115', city: 'Berlin', countryCode: 'DE', vatId: 'DE123456789' }, buyer: { name: 'Buyer GmbH', street: 'B 1', postalCode: '10115', city: 'Berlin', countryCode: 'DE' }, lines: [{ description: 'Books', quantity: 1, unitCode: 'C62', netAmountCents: 10_000, taxRateBasisPoints: 700, taxCategoryCode: 'S' }, { description: 'Service', quantity: 1, unitCode: 'C62', netAmountCents: 10_000, taxRateBasisPoints: 1900, taxCategoryCode: 'S' }], netAmountCents: 20_000, taxAmountCents: 2_600, grossAmountCents: 22_600, currency: 'EUR' }
const credit = (overrides: Partial<StructuredInvoiceData> = {}): StructuredInvoiceData => ({ ...invoice, kind: 'credit-note', invoiceNumber: 'GS-1', correctedInvoiceNumber: 'ER-1', issueDate: '2026-08-01', supplyDate: '2026-08-01', lines: [{ ...invoice.lines[0], netAmountCents: 5_000 }, { ...invoice.lines[1], netAmountCents: 5_000 }], netAmountCents: 10_000, taxAmountCents: 1_300, grossAmountCents: 11_300, ...overrides })
const authoritativeDates = ['2026-07-01', '2026-07-02', '2026-07-03']

describe('incoming supplier credit-note planning', () => {
  it('Given a partially paid mixed-rate payable, when its exact supplier credit note is planned, then only the remainder is netted and the debit credit balance is preserved', () => {
    expect(planIncomingSupplierCredit({ credit: credit(), original: invoice, priorCredits: [], originalRemainingCents: 6_000, effectiveDate: '2026-08-04', originalAuthoritativeDates: authoritativeDates })).toEqual(expect.objectContaining({ groups: [{ rateBasisPoints: 700, netAmountCents: 5_000, taxAmountCents: 350 }, { rateBasisPoints: 1900, netAmountCents: 5_000, taxAmountCents: 950 }], nettingAmountCents: 6_000, unappliedCreditCents: 5_300 }))
  })

  it.each([
    { label: 'UBL 7%', syntax: 'UBL' as const, line: invoice.lines[0], net: 10_000, tax: 700 },
    { label: 'CII 19%', syntax: 'CII' as const, line: invoice.lines[1], net: 10_000, tax: 1_900 },
  ])('Given an exact domestic $label supplier credit, when planned, then its canonical rate cohort is accepted', scenario => {
    const original = { ...invoice, syntax: scenario.syntax, lines: [scenario.line], netAmountCents: scenario.net, taxAmountCents: scenario.tax, grossAmountCents: scenario.net + scenario.tax }
    const candidate = { ...original, kind: 'credit-note' as const, invoiceNumber: `GS-${scenario.syntax}`, correctedInvoiceNumber: original.invoiceNumber }
    expect(planIncomingSupplierCredit({ credit: candidate, original, priorCredits: [], originalRemainingCents: candidate.grossAmountCents, effectiveDate: '2026-08-04', originalAuthoritativeDates: authoritativeDates })).toMatchObject({ groups: [{ rateBasisPoints: scenario.line.taxRateBasisPoints, taxAmountCents: scenario.tax }], unappliedCreditCents: 0 })
  })

  it('Given an untouched exact invoice, when a full cancellation is planned, then it is accepted while a partial cancellation is rejected', () => {
    expect(planIncomingSupplierCredit({ credit: credit({ kind: 'cancellation', lines: invoice.lines, netAmountCents: 20_000, taxAmountCents: 2_600, grossAmountCents: 22_600 }), original: invoice, priorCredits: [], originalRemainingCents: 22_600, effectiveDate: '2026-08-04', originalAuthoritativeDates: authoritativeDates })).toMatchObject({ kind: 'cancellation', nettingAmountCents: 22_600 })
    expect(() => planIncomingSupplierCredit({ credit: credit({ kind: 'cancellation' }), original: invoice, priorCredits: [], originalRemainingCents: 22_600, effectiveDate: '2026-08-04', originalAuthoritativeDates: authoritativeDates })).toThrow(/fully reverse/)
  })

  it.each([
    ['another invoice', credit({ correctedInvoiceNumber: 'ER-OTHER' })],
    ['another supplier', credit({ seller: { ...invoice.seller, vatId: 'DE987654321' } })],
    ['foreign currency', credit({ currency: 'USD' })],
    ['unsupported VAT', credit({ lines: [{ ...invoice.lines[0], taxRateBasisPoints: 500 }], netAmountCents: 5_000, taxAmountCents: 250, grossAmountCents: 5_250 })],
  ])('Given %s evidence, when the supplier correction is planned, then it fails closed', (_label, candidate) => {
    expect(() => planIncomingSupplierCredit({ credit: candidate, original: invoice, priorCredits: [], originalRemainingCents: 22_600, effectiveDate: '2026-08-04', originalAuthoritativeDates: authoritativeDates })).toThrow()
  })

  it('Given an earlier credit consumed the 7% base, when another correction over-credits that cohort, then it fails closed', () => {
    const prior = credit({ invoiceNumber: 'GS-0', lines: [{ ...invoice.lines[0], netAmountCents: 8_000 }], netAmountCents: 8_000, taxAmountCents: 560, grossAmountCents: 8_560 })
    const next = credit({ lines: [{ ...invoice.lines[0], netAmountCents: 3_000 }], netAmountCents: 3_000, taxAmountCents: 210, grossAmountCents: 3_210 })
    expect(() => planIncomingSupplierCredit({ credit: next, original: invoice, priorCredits: [prior], originalRemainingCents: 14_040, effectiveDate: '2026-08-04', originalAuthoritativeDates: authoritativeDates })).toThrow(/VAT-rate base/)
  })

  it('Given the original service, posting, and VAT dates, when an adjustment date predates any authoritative recognition date, then planning fails closed', () => {
    expect(() => planIncomingSupplierCredit({ credit: credit(), original: invoice, priorCredits: [], originalRemainingCents: 22_600, effectiveDate: '2026-07-02', originalAuthoritativeDates: authoritativeDates })).toThrow(/cannot predate.*service.*posting.*VAT/i)
  })
})
