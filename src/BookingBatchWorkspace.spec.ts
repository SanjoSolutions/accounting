import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'
import {
  bookingBatchDraftsForYear,
  bookingBatchDocumentForPicker,
  bookingBatchDocumentsForPicker,
  bookingBatchLineRequest,
  bookingBatchPatchRequest,
  bookingBatchPostRequest,
  bookingBatchVatTreatment,
  bookingBatchYearFromSearchParameter,
  editableBookingBatchPosting,
  unlinkBookingBatchDocument,
  type BookingBatchDraft,
} from './BookingBatchWorkspace'

const bookingBatchWorkspaceSource = readFileSync(resolve(process.cwd(), 'src/BookingBatchWorkspace.tsx'), 'utf8')

const draft = (overrides: Partial<BookingBatchDraft> = {}): BookingBatchDraft => ({
  id: 'draft-1',
  version: 4,
  status: 'DRAFT',
  updatedAt: '2026-08-11T10:00:00.000Z',
  posting: {
    fiscalYear: 2026,
    bookingDate: '2026-08-10',
    description: 'Büromaterial',
    documentIds: ['document-1'],
    lines: [
      { accountId: 'expense', debitCents: 11900, creditCents: 0, vat: { ruleId: 'DE_STANDARD', mode: 'gross', direction: 'purchase' } },
      { accountId: 'bank', debitCents: 0, creditCents: 11900 },
    ],
  },
  ...overrides,
})

describe('booking batch fiscal-year and draft selection', () => {
  test('accepts a valid year deep link and rejects unsafe values', () => {
    expect(bookingBatchYearFromSearchParameter('2025', 2026)).toBe(2025)
    expect(bookingBatchYearFromSearchParameter(['2025'], 2026)).toBe(2026)
    expect(bookingBatchYearFromSearchParameter('1899', 2026)).toBe(2026)
  })

  test('lists only DRAFT items belonging to the selected fiscal year', () => {
    expect(bookingBatchDraftsForYear({ fiscalYear: { year: 2026 }, accounts: [], drafts: [
      draft(),
      draft({ id: 'posted', status: 'POSTED' }),
      draft({ id: 'other-year', posting: { ...draft().posting, fiscalYear: 2025 } }),
    ] }, 2026).map(item => item.id)).toEqual(['draft-1'])
  })

  test('keeps draft list metadata focused on dates without row counts or revision numbers', () => {
    expect(bookingBatchWorkspaceSource).toContain('{formatDisplayDate(draft.posting.bookingDate)}</span>')
    expect(bookingBatchWorkspaceSource).toContain("t('updatedAt', { date: formatDisplayDate(draft.updatedAt)")
    expect(bookingBatchWorkspaceSource).not.toContain("t('lineCount'")
    expect(bookingBatchWorkspaceSource).not.toContain('v{draft.version}')
  })
})

describe('booking batch editing requests', () => {
  test('maps attached document metadata to a viewable picker document without exposing IDs as the UI value', () => {
    expect(bookingBatchDocumentForPicker({ id: 'invoice/one', fileName: 'Invoice.pdf', contentType: 'application/pdf', size: 42, thumbnailUrl: '/thumb' })).toEqual({
      id: 'invoice/one',
      url: '/api/documents/invoice%2Fone/file',
      fileName: 'Invoice.pdf',
      contentType: 'application/pdf',
      size: 42,
      thumbnailUrl: '/thumb',
    })
    expect(bookingBatchDocumentsForPicker(undefined)).toEqual([])
  })

  test('unlinks only the requested attached document while preserving the other selections', () => {
    expect(unlinkBookingBatchDocument(['one', 'two', 'one'], 'one')).toEqual(['two'])
    expect(unlinkBookingBatchDocument(['one', 'two'], 'missing')).toEqual(['one', 'two'])
  })

  test('normalizes cents and VAT metadata into editable fields', () => {
    const editable = editableBookingBatchPosting(draft().posting)
    expect(editable.lines[0]).toEqual({ accountId: 'expense', debit: '119.00', credit: '', vatTreatment: 'DE_STANDARD_PURCHASE_GROSS' })
    expect(editable.documentIds).toEqual(['document-1'])
    expect(bookingBatchVatTreatment({ accountId: 'sales', debitCents: 0, creditCents: 1000, vat: { mode: 'net', direction: 'sale' } })).toBe('DE_STANDARD_SALE_NET')
    expect(bookingBatchVatTreatment({ accountId: 'expense', debitCents: 680, creditCents: 0, vat: { ruleId: 'EU_13B_SERVICE_RECIPIENT', mode: 'net', direction: 'purchase' } })).toBe('EU_13B_SERVICE_RECIPIENT_NET')
    expect(bookingBatchLineRequest({ accountId: 'expense', debit: '6.80', credit: '', vatTreatment: 'EU_13B_SERVICE_RECIPIENT_NET' })).toEqual({ accountId: 'expense', debitCents: 680, creditCents: 0, vat: { ruleId: 'EU_13B_SERVICE_RECIPIENT', mode: 'net', direction: 'purchase' } })
  })

  test('includes expectedVersion and edited posting fields when saving', () => {
    const posting = editableBookingBatchPosting(draft().posting)
    posting.description = 'Geänderte Beschreibung'
    posting.documentIds = ['document-1', 'document-2']
    posting.lines[0].vatTreatment = 'DE_STANDARD_PURCHASE_NET'
    expect(bookingBatchPatchRequest(4, posting)).toEqual({
      expectedVersion: 4,
      fiscalYear: 2026,
      bookingDate: '2026-08-10',
      description: 'Geänderte Beschreibung',
      documentIds: ['document-1', 'document-2'],
      lines: [
        { accountId: 'expense', debitCents: 11900, creditCents: 0, vat: { ruleId: 'DE_STANDARD', mode: 'net', direction: 'purchase' } },
        { accountId: 'bank', debitCents: 0, creditCents: 11900 },
      ],
    })
  })

  test('serializes an optional posting reason without sending blank text', () => {
    expect(bookingBatchPostRequest('  Reviewed by finance  ')).toEqual({ reason: 'Reviewed by finance' })
    expect(bookingBatchPostRequest('   ')).toEqual({})
  })

  test('keeps two editable lines when a draft has no lines', () => {
    expect(editableBookingBatchPosting({ ...draft().posting, lines: [] }).lines).toHaveLength(2)
  })

  test('maps direct decimal amounts when an API returns non-cent values', () => {
    const editable = editableBookingBatchPosting({ ...draft().posting, lines: [{ accountId: 'expense', debit: '12.50', credit: '', vatTreatment: '' }] })
    expect(bookingBatchLineRequest(editable.lines[0])).toEqual({ accountId: 'expense', debitCents: 1250, creditCents: 0 })
  })
})
