export type DocumentExtractionStatus = 'PROCESSING' | 'NEEDS_REVIEW' | 'CONFIRMED' | 'FAILED'

export type InvoiceExtractionData = {
  supplierName: string
  invoiceNumber: string
  issueDate: string
  netAmountCents: number
  taxAmountCents: number
  grossAmountCents: number
  currency: 'EUR'
  confidence: Record<'supplierName' | 'invoiceNumber' | 'issueDate' | 'netAmountCents' | 'taxAmountCents' | 'grossAmountCents', number>
  provenance: 'PDF_TEXT' | 'HUMAN_REVIEW' | 'STRUCTURED_INVOICE'
}

export function validateReviewedInvoiceExtraction(value: unknown): InvoiceExtractionData {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Reviewed invoice data is required.')
  const input = value as Record<string, unknown>
  const supplierName = requiredText(input.supplierName, 'Supplier name')
  const invoiceNumber = requiredText(input.invoiceNumber, 'Invoice number')
  const issueDate = requiredText(input.issueDate, 'Issue date')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(issueDate) || Number.isNaN(Date.parse(`${issueDate}T00:00:00Z`))) throw new TypeError('Issue date must be a valid ISO date.')
  const [netAmountCents, taxAmountCents, grossAmountCents] = ['netAmountCents', 'taxAmountCents', 'grossAmountCents'].map(field => {
    const amount = input[field]
    if (!Number.isSafeInteger(amount) || Number(amount) < 0) throw new TypeError(`${field} must be a non-negative integer amount in cents.`)
    return Number(amount)
  })
  if (netAmountCents + taxAmountCents !== grossAmountCents) throw new TypeError('Net amount plus tax must equal gross amount.')
  return {
    supplierName, invoiceNumber, issueDate, netAmountCents, taxAmountCents, grossAmountCents, currency: 'EUR',
    confidence: { supplierName: 1, invoiceNumber: 1, issueDate: 1, netAmountCents: 1, taxAmountCents: 1, grossAmountCents: 1 },
    provenance: 'HUMAN_REVIEW',
  }
}

function requiredText(value: unknown, label: string) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${label} is required.`)
  return value.trim()
}
