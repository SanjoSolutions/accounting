import { parseDocument } from './parseDocument.js'

await parseDocument(
  'gs://accounting-documents-public/Invoice_Example_German.pdf',
  'gs://accounting-documents-public/result.json'
)
