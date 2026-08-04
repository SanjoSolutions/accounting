import { describe, expect, it } from 'vitest'
import { validateReviewedInvoiceExtraction } from './documentExtraction'

describe('invoice extraction review', () => {
  it('Given balanced integer-cent invoice facts, when a person confirms them, then canonical reviewed evidence is returned', () => {
    expect(validateReviewedInvoiceExtraction({ supplierName: 'Supplier GmbH', invoiceNumber: 'RE-1', issueDate: '2026-08-04', netAmountCents: 10000, taxAmountCents: 1900, grossAmountCents: 11900 })).toMatchObject({ provenance: 'HUMAN_REVIEW', currency: 'EUR', confidence: { grossAmountCents: 1 } })
  })

  it('Given contradictory totals, when review is attempted, then confirmation fails closed', () => {
    expect(() => validateReviewedInvoiceExtraction({ supplierName: 'Supplier GmbH', invoiceNumber: 'RE-1', issueDate: '2026-08-04', netAmountCents: 10000, taxAmountCents: 1900, grossAmountCents: 11899 })).toThrow(/must equal/)
  })
})
