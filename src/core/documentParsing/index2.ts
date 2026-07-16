import { parseInvoice } from './parseInvoice'

await parseInvoice(
  'gs://accounting-documents-public/Invoice_Example_English.pdf',
  'gs://accounting-documents-public/results/'
)
