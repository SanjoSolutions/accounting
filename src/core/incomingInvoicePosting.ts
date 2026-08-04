import type { InvoiceExtractionData } from './documentExtraction'

export type IncomingInvoicePostingLine = {
  role: 'EXPENSE' | 'INPUT_VAT' | 'PAYABLES'
  debitCents: number
  creditCents: number
}

export function incomingInvoicePostingLines(invoice: InvoiceExtractionData): IncomingInvoicePostingLine[] {
  if (invoice.currency !== 'EUR') throw new TypeError('Only EUR supplier invoices can currently be posted.')
  if (invoice.netAmountCents <= 0 || invoice.grossAmountCents <= 0) throw new TypeError('A supplier invoice must have a positive net and gross amount.')
  if (invoice.netAmountCents + invoice.taxAmountCents !== invoice.grossAmountCents) throw new TypeError('Net amount plus tax must equal gross amount.')
  if (invoice.taxAmountCents !== 0 && invoice.taxAmountCents !== Math.round(invoice.netAmountCents * 19 / 100)) {
    throw new TypeError('Only tax-free and exact 19% German input VAT invoices can currently be posted.')
  }
  return [
    { role: 'EXPENSE', debitCents: invoice.netAmountCents, creditCents: 0 },
    ...(invoice.taxAmountCents ? [{ role: 'INPUT_VAT' as const, debitCents: invoice.taxAmountCents, creditCents: 0 }] : []),
    { role: 'PAYABLES', debitCents: 0, creditCents: invoice.grossAmountCents },
  ]
}

export function parseIsoDate(value: string, label: string) {
  const date = new Date(`${value}T00:00:00.000Z`)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(date.valueOf()) || date.toISOString().slice(0, 10) !== value) throw new TypeError(`${label} must be a valid ISO calendar date.`)
  return date
}
