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
  readonly version = '1'

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
  const amounts = [...rawText.matchAll(/(\d{1,3}(?:[.,]\d{3})*[.,]\d{2})\s*EUR/gi)].map(match => eurosToCents(match[1]))
  const [netAmountCents, taxAmountCents, grossAmountCents] = amounts
  if (!invoiceNumber || !issueDate || !supplierName || !Number.isSafeInteger(netAmountCents) || !Number.isSafeInteger(taxAmountCents) || netAmountCents + taxAmountCents !== grossAmountCents) return null
  const confidence = { supplierName: .8, invoiceNumber: .9, issueDate: .85, netAmountCents: .85, taxAmountCents: .85, grossAmountCents: .85 }
  return { supplierName, invoiceNumber, issueDate, netAmountCents, taxAmountCents, grossAmountCents, currency: 'EUR', confidence, provenance: 'PDF_TEXT' }
}

function eurosToCents(value: string) {
  const normalized = value.lastIndexOf(',') > value.lastIndexOf('.') ? value.replace(/\./g, '').replace(',', '.') : value.replace(/,/g, '')
  return Math.round(Number(normalized) * 100)
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
