export interface InvoiceFormLine { id: string; description: string; quantity: string; unitCode: string; netAmount: string; taxRate: '19' | '7' }
export interface StructuredInvoiceFormValues {
  requestKey: string; issueDate: string; supplyDate: string
  buyerReference: string
  buyerElectronicAddressScheme: '0204' | '9930' | 'EM'; buyerElectronicAddress: string
  buyerName: string; buyerStreet: string; buyerPostalCode: string; buyerCity: string; buyerCountry: string; buyerVatId?: string
  paymentTerms?: string; paymentIban?: string; lines: readonly InvoiceFormLine[]
}

export function euroToCents(value: string): number {
  const normalized = value.trim().replace(',', '.')
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(normalized)) throw new Error('Amounts require zero to two decimal places and cannot be negative.')
  const [euros, decimals = ''] = normalized.split('.')
  const cents = Number(euros) * 100 + Number(decimals.padEnd(2, '0'))
  if (!Number.isSafeInteger(cents)) throw new Error('Amount exceeds safe cent precision.')
  return cents
}

export function calculateInvoiceTotals(lines: readonly Pick<InvoiceFormLine, 'netAmount' | 'taxRate'>[]) {
  if (!lines.length) throw new Error('At least one invoice line is required.')
  const grouped = new Map<number, number>()
  for (const line of lines) {
    const net = euroToCents(line.netAmount)
    const rate = Number(line.taxRate) * 100
    const total = (grouped.get(rate) ?? 0) + net
    if (!Number.isSafeInteger(total)) throw new Error('Invoice total exceeds safe cent precision.')
    grouped.set(rate, total)
  }
  const netAmountCents = [...grouped.values()].reduce((sum, value) => sum + value, 0)
  const taxAmountCents = [...grouped].reduce((sum, [rate, net]) => sum + Number((BigInt(net) * BigInt(rate) + BigInt(5_000)) / BigInt(10_000)), 0)
  const grossAmountCents = netAmountCents + taxAmountCents
  if (![netAmountCents, taxAmountCents, grossAmountCents].every(Number.isSafeInteger)) throw new Error('Invoice total exceeds safe cent precision.')
  return { netAmountCents, taxAmountCents, grossAmountCents }
}

export function isValidIban(value: string) {
  const compact = value.replace(/\s/g, '').toUpperCase()
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(compact)) return false
  const rearranged = compact.slice(4) + compact.slice(0, 4)
  let remainder = 0
  for (const character of rearranged) for (const digit of (/\d/.test(character) ? character : String(character.charCodeAt(0) - 55))) remainder = (remainder * 10 + Number(digit)) % 97
  return remainder === 1
}

function required(value: string, label: string) { if (!value.trim()) throw new Error(`${label} is required.`); return value.trim() }
function isoDate(value: string, label: string) { const date = new Date(`${value}T00:00:00.000Z`); if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(date.valueOf()) || date.toISOString().slice(0, 10) !== value) throw new Error(`${label} must be a calendar date.`); return value }

export function buildStructuredInvoiceRequest(values: StructuredInvoiceFormValues) {
  if (!/^[A-Za-z0-9._:-]{16,100}$/.test(values.requestKey)) throw new Error('A stable issuance request key is required.')
  const paymentIban = required(values.paymentIban ?? '', 'IBAN').replace(/\s/g, '').toUpperCase()
  if (!isValidIban(paymentIban)) throw new Error('IBAN is invalid.')
  const lines = values.lines.map((line, index) => {
    const quantity = Number(line.quantity.replace(',', '.'))
    if (!Number.isFinite(quantity) || quantity <= 0) throw new Error(`Quantity row ${index + 1} must be positive.`)
    return { description: required(line.description, `Description row ${index + 1}`), quantity, unitCode: required(line.unitCode, `Unit row ${index + 1}`).toUpperCase(), netAmountCents: euroToCents(line.netAmount), taxRateBasisPoints: Number(line.taxRate) * 100, taxCategoryCode: 'S' }
  })
  const totals = calculateInvoiceTotals(values.lines)
  return {
    requestKey: values.requestKey, kind: 'invoice' as const, issueDate: isoDate(values.issueDate, 'Issue date'), supplyDate: isoDate(values.supplyDate, 'Supply date'), buyerReference: required(values.buyerReference, 'Buyer reference'),
    buyerElectronicAddress: { schemeId: values.buyerElectronicAddressScheme, value: required(values.buyerElectronicAddress, 'Buyer electronic address') },
    buyer: { name: required(values.buyerName, 'Buyer name'), street: required(values.buyerStreet, 'Buyer street'), postalCode: required(values.buyerPostalCode, 'Buyer postal code'), city: required(values.buyerCity, 'Buyer city'), countryCode: required(values.buyerCountry, 'Buyer country').toUpperCase(), ...(values.buyerVatId?.trim() ? { vatId: values.buyerVatId.trim().toUpperCase() } : {}) },
    lines, ...totals, currency: 'EUR', paymentTerms: required(values.paymentTerms ?? '', 'Payment terms'), paymentIban,
  }
}
