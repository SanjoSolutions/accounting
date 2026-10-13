import { createHash } from 'node:crypto'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import type { InvoiceExtractionData } from '@/core/documentExtraction'

export interface InvoiceExtractionProvider {
  readonly id: string
  readonly version: string
  extract(input: { content: Buffer; fileName: string; signal: AbortSignal }): Promise<{ data: InvoiceExtractionData | null; rawTextHash: string | null; failureCode?: 'NEEDS_OCR' }>
}

export class LocalPdfTextInvoiceProvider implements InvoiceExtractionProvider {
  readonly id = 'local-pdf-text'
  readonly version = '2'

  async extract({ content, signal }: { content: Buffer; fileName: string; signal: AbortSignal }) {
    if (signal.aborted) throw signal.reason
    const loadingTask = getDocument({ data: new Uint8Array(content) })
    const pdf = await loadingTask.promise
    const pages: string[] = []
    try {
      for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
        if (signal.aborted) throw signal.reason
        const page = await pdf.getPage(pageNumber)
        const text = await page.getTextContent()
        pages.push(text.items.flatMap(item => 'str' in item ? [item.str] : []).join(' '))
      }
    } finally {
      await loadingTask.destroy()
    }
    const rawText = pages.join('\n').replace(/\s+/g, ' ').trim()
    if (!rawText) return { data: null, rawTextHash: null, failureCode: 'NEEDS_OCR' as const }
    return { data: parseInvoiceText(rawText), rawTextHash: createHash('sha256').update(rawText).digest('hex') }
  }
}

export function parseInvoiceText(rawText: string): InvoiceExtractionData | null {
  const invoiceNumber = /(?:invoice\s*(?:no\.?|number)|rechnungs(?:nummer|nr\.?))\s*[:#]?\s*([^\s]+)/i.exec(rawText)?.[1]?.trim() ?? ''
  const issueDate = parseDate(/(?:date|rechnungsdatum)\s*:\s*((?:\d{4}-\d{2}-\d{2})|(?:\d{1,2}\.\d{1,2}\.\d{4})|(?:\d{1,2}\s+[A-Za-z]+\s+\d{4}))/i.exec(rawText)?.[1] ?? '')
  const supplierName = /([A-ZÄÖÜ][A-Za-zÄÖÜäöüß&.-]+(?:\s+[A-ZÄÖÜ][A-Za-zÄÖÜäöüß&.-]+){0,5}\s+(?:GmbH|UG\s*\(haftungsbeschr[aä]nkt\)|UG))\b/.exec(rawText)?.[1]?.trim() ?? ''
  const amounts = parseEuroAmounts(rawText)
  if (!amounts) return null
  const [netAmountCents, taxAmountCents, grossAmountCents] = amounts
  if (!invoiceNumber || !issueDate || !supplierName || netAmountCents + taxAmountCents !== grossAmountCents) return null
  const confidence = { supplierName: .8, invoiceNumber: .9, issueDate: .85, netAmountCents: .85, taxAmountCents: .85, grossAmountCents: .85 }
  return { supplierName, invoiceNumber, issueDate, netAmountCents, taxAmountCents, grossAmountCents, currency: 'EUR', confidence, provenance: 'PDF_TEXT' }
}

function parseEuroAmounts(rawText: string): number[] | null {
  // Capture whole tokens before validating their notation. A restrictive money
  // regex could skip malformed candidates or start inside an ungrouped amount.
  // PDF text can join a currency marker to the next amount ("19.00 EUR119.00
  // EUR"), so a completed marker also serves as a token boundary.
  const tokens = [...rawText.matchAll(/(?:^|[\s:]|(?<=EUR))([^\s:]+?)\s*EUR(?![A-Za-z_])/gi)]
  if (tokens.length < 3) return null
  const amounts: number[] = []
  for (const token of tokens) {
    // Do not drop a numeric prefix or a sign separated by whitespace/colon.
    if (/[\d.,+\-−('/’]$/.test(rawText.slice(0, token.index).replace(/[\s:]+$/, ''))) return null
    const value = token[1]
    const english = /^(?:\d+|\d{1,3}(?:,\d{3})+)\.\d{2}$/
    const german = /^(?:\d+|\d{1,3}(?:\.\d{3})+),\d{2}$/
    if (!english.test(value) && !german.test(value)) return null
    // The validated final two digits are cents. Parse them directly to avoid
    // floating-point rounding when multiplying a decimal euro value by 100.
    const cents = Number(value.replace(/[.,]/g, ''))
    if (!Number.isSafeInteger(cents)) return null
    amounts.push(cents)
  }
  // A repeated gross/amount-due value is common. Distinct additional amounts
  // are ambiguous without interpreting labels and line-item layout.
  return amounts.slice(3).every(amount => amount === amounts[2]) ? amounts : null
}

function parseDate(value: string) {
  const iso = /\b(\d{4})-(\d{2})-(\d{2})\b/.exec(value)
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`
  const german = /\b(\d{1,2})\.(\d{1,2})\.(\d{4})\b/.exec(value)
  if (german) return `${german[3]}-${german[2].padStart(2, '0')}-${german[1].padStart(2, '0')}`
  const english = /\b(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})\b/.exec(value)
  if (english) {
    const month = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'].indexOf(english[2].toLowerCase()) + 1
    if (month) return `${english[3]}-${String(month).padStart(2, '0')}-${english[1].padStart(2, '0')}`
  }
  const timestamp = Date.parse(value.trim())
  return Number.isNaN(timestamp) ? '' : new Date(timestamp).toISOString().slice(0, 10)
}
