import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { extractDocumentSearchText } from './documentSearchText'
import { mixedSearchPdf, scannedSearchPdf } from '@/test/documentSearchFixtures'

afterEach(() => vi.unstubAllEnvs())
describe('local searchable text extraction', () => {
  test('Given a text-layer PDF, when indexed, then the full content is available independently of invoice parsing', async () => {
    const result = await extractDocumentSearchText({ content: readFileSync('e2e/fixtures/invoice.pdf'), contentType: 'application/pdf' }, { ocrCommand: '' })
    expect(result).toMatchObject({ status: 'READY', source: 'PDF_TEXT' })
    expect(result.text).toContain('E2E-2026-001')
  }, 30_000)
  test('Given a scan without configured OCR, when indexed, then missing text is explicit and retryable after setup', async () => {
    expect(await extractDocumentSearchText({ content: scannedSearchPdf(), contentType: 'application/pdf' }, { ocrCommand: '' })).toMatchObject({ status: 'NEEDS_OCR', failureCode: 'OCR_NOT_CONFIGURED', text: '' })
  }, 30_000)
  test('Given text and image-only pages, when OCR is unavailable, then readable text is retained with partial status', async () => {
    expect(await extractDocumentSearchText({ content: mixedSearchPdf(), contentType: 'application/pdf' }, { ocrCommand: '' })).toMatchObject({ status: 'PARTIAL', text: 'Readable first page' })
  }, 30_000)
  test.skipIf(!process.env.DOCUMENT_SEARCH_TEST_OCR_COMMAND)('Given actual scanned pixels and local Tesseract, when OCR runs, then words absent from the PDF text layer become searchable', async () => {
    const result = await extractDocumentSearchText({ content: scannedSearchPdf(), contentType: 'application/pdf' }, { ocrCommand: process.env.DOCUMENT_SEARCH_TEST_OCR_COMMAND, ocrLanguages: 'eng' })
    expect(result).toMatchObject({ status: 'READY', source: 'OCR' })
    expect(result.text).toContain('Bergwald')
    expect(result.text).toContain('47291')
  }, 60_000)
  test('Given a missing OCR executable, when a scan is processed, then the failure exposes no subprocess output', async () => {
    await expect(extractDocumentSearchText({ content: scannedSearchPdf(), contentType: 'application/pdf' }, { ocrCommand: 'nonexistent-search-ocr-executable' })).rejects.toThrow('OCR_FAILURE')
  }, 30_000)
  test('Given malformed PDF bytes, when parsed, then indexing fails without invented text', async () => {
    await expect(extractDocumentSearchText({ content: Buffer.from('%PDF-broken'), contentType: 'application/pdf' })).rejects.toThrow('PARSER_FAILURE')
  }, 30_000)
  test('Given an exceeded processing budget, when the worker is terminated, then a subsequent job can run', async () => {
    await expect(extractDocumentSearchText({ content: Buffer.from('<Document>hello</Document>'), contentType: 'application/xml' }, { timeoutMs: 1 })).rejects.toThrow('TIMEOUT')
    const result = await extractDocumentSearchText({ content: Buffer.from('<Document>Hello &amp; world</Document>'), contentType: 'application/xml' })
    expect(result).toMatchObject({ status: 'READY', source: 'XML', text: 'Hello & world' })
  }, 30_000)
  test('Given XML with a DTD, when indexed, then entity-based file or network reads are refused', async () => {
    await expect(extractDocumentSearchText({ content: Buffer.from('<!DOCTYPE x SYSTEM "file:///private"><x/>'), contentType: 'application/xml' })).rejects.toThrow('UNSUPPORTED_XML')
  }, 30_000)
  test('Given oversized input, when indexing is requested, then it is refused before launching a worker', async () => {
    await expect(extractDocumentSearchText({ content: Buffer.alloc(20 * 1024 * 1024 + 1), contentType: 'application/pdf' })).rejects.toThrow('INPUT_LIMIT')
  })
})
