import { describe, expect, it } from 'vitest'
import { incomingInvoicePostingLines, parseIsoDate } from './incomingInvoicePosting'

const invoice = { supplierName: 'Lieferant GmbH', invoiceNumber: 'RE-1', issueDate: '2026-07-23', netAmountCents: 10_000, taxAmountCents: 1_900, grossAmountCents: 11_900, currency: 'EUR' as const, confidence: { supplierName: 1, invoiceNumber: 1, issueDate: 1, netAmountCents: 1, taxAmountCents: 1, grossAmountCents: 1 }, provenance: 'HUMAN_REVIEW' as const }

describe('incoming supplier invoice posting', () => {
  it('debits expense and deductible input VAT and credits trade payables', () => {
    expect(incomingInvoicePostingLines(invoice)).toEqual([
      { role: 'EXPENSE', debitCents: 10_000, creditCents: 0 },
      { role: 'INPUT_VAT', debitCents: 1_900, creditCents: 0 },
      { role: 'PAYABLES', debitCents: 0, creditCents: 11_900 },
    ])
  })

  it('posts a reviewed tax-free invoice without inventing a VAT line', () => {
    expect(incomingInvoicePostingLines({ ...invoice, taxAmountCents: 0, grossAmountCents: 10_000 })).toHaveLength(2)
  })

  it('fails closed when reviewed VAT is neither zero nor exact 19 percent', () => {
    expect(() => incomingInvoicePostingLines({ ...invoice, taxAmountCents: 700, grossAmountCents: 10_700 })).toThrow(/19%/)
  })

  it('accepts only real ISO calendar dates', () => {
    expect(parseIsoDate('2026-02-28', 'Due date').toISOString()).toBe('2026-02-28T00:00:00.000Z')
    expect(() => parseIsoDate('2026-02-30', 'Due date')).toThrow(/valid ISO/)
  })
})
