import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, test, vi } from 'vitest'
import de from '../messages/de.json'
import en from '../messages/en.json'
import { readFileSync } from 'node:fs'
import { acceptedBookingDocumentFiles, acceptedPdfFiles, addDocumentSelection, attachedBookingDocuments, availableBookingDocuments, clampDocumentColumnPercent, AttachedDocumentRow, DocumentCard, documentDisplayName, documentPickerIsOpen, documentPickerOpenAfterAddition, LongTouchSelectionGesture, longTouchSelectionDelayMs, mergeDocumentLists, mergeDocumentSelection, mergeUploadedDocument, parseSavedDocumentColumnPercent, readDocumentUploadResponse, selectDocument, selectionExtendsForActivation } from './BookingDocuments'

afterEach(() => vi.useRealTimers())

describe('booking document selection', () => {
  test('selects only the clicked document unless Shift extends the selection', () => {
    expect(selectDocument(['one', 'two'], 'three', false)).toEqual(['three'])
    expect(selectDocument(['one'], 'two', true)).toEqual(['one', 'two'])
    expect(selectDocument(['one', 'two'], 'one', true)).toEqual(['two'])
  })

  test('extends selection only for Shift-click or a deliberate long touch', () => {
    expect(selectionExtendsForActivation(false, false)).toBe(false)
    expect(selectionExtendsForActivation(true, false)).toBe(true)
    expect(selectionExtendsForActivation(false, true)).toBe(true)
    expect(longTouchSelectionDelayMs).toBe(500)
  })

  test('suppresses only the click following a completed long touch', () => {
    vi.useFakeTimers()
    const gesture = new LongTouchSelectionGesture()
    const onLongTouch = vi.fn()

    gesture.start(onLongTouch)
    vi.advanceTimersByTime(longTouchSelectionDelayMs)
    expect(onLongTouch).not.toHaveBeenCalled()
    gesture.finish()

    expect(onLongTouch).toHaveBeenCalledOnce()
    expect(gesture.consumeClick()).toBe(true)
    expect(gesture.consumeClick()).toBe(false)
  })

  test('does not suppress the next tap after a long touch is cancelled', () => {
    vi.useFakeTimers()
    const gesture = new LongTouchSelectionGesture()
    const onLongTouch = vi.fn()

    gesture.start(onLongTouch)
    vi.advanceTimersByTime(longTouchSelectionDelayMs)
    gesture.cancel()

    expect(onLongTouch).not.toHaveBeenCalled()
    expect(gesture.consumeClick()).toBe(false)
  })

  test('shows only a PDF preview thumbnail and the document name on each card', () => {
    const html = renderToStaticMarkup(createElement(DocumentCard, {
      document: { id: 'one', url: '/api/documents/one/file', thumbnailUrl: '/api/documents/one/thumbnail', fileName: 'Invoice.pdf', size: 42_000 },
      selected: false,
      fallbackName: 'Unnamed document',
      onSelect: () => undefined,
    }))

    expect(html).toContain('class="document-thumbnail"')
    expect(html).toContain('src="/api/documents/one/thumbnail"')
    expect(html).toContain('loading="lazy"')
    expect(html).not.toContain('<iframe')
    expect(html).toContain('<strong class="document-name">Invoice</strong>')
    expect(html).toContain('title="Invoice"')
    expect(html).not.toContain('Invoice.pdf')
    expect(html).not.toContain('42')
    expect(html).not.toContain('PDF</small>')
  })

  test('falls back to a PDF icon when a stored thumbnail is unavailable', () => {
    const html = renderToStaticMarkup(createElement(DocumentCard, {
      document: { id: 'one', url: '/api/documents/one/file', fileName: 'Invoice.pdf' },
      selected: false,
      fallbackName: 'Unnamed document',
      onSelect: () => undefined,
    }))

    expect(html).toContain('bi-file-earmark-pdf')
    expect(html).not.toContain('<iframe')
  })

  test('removes only the trailing PDF extension from document display names', () => {
    expect(documentDisplayName('Invoice.final.PDF')).toBe('Invoice.final')
    expect(documentDisplayName('Invoice.XML')).toBe('Invoice')
    expect(documentDisplayName('Invoice')).toBe('Invoice')
    expect(documentDisplayName('.pdf', 'Unnamed document')).toBe('Unnamed document')
  })

  test('uses only the concise document panel heading and upload action copy', () => {
    expect(en.Workspaces.documents).toBe('Documents')
    expect(en.Workspaces.chooseDocuments).toBe('Upload documents')
    expect(en.Workspaces.removeDocumentAction).toBe('Remove')
    expect(de.Workspaces.documents).toBe('Belege')
    expect(de.Workspaces.chooseDocuments).toBe('Belege hochladen')
    expect(de.Workspaces.removeDocumentAction).toBe('Entfernen')
    expect(en.Workspaces).not.toHaveProperty('selectDocuments')
    expect(en.Workspaces).not.toHaveProperty('documentsHelp')
    expect(en.Workspaces).not.toHaveProperty('documentsSelected')
  })

  test('localizes the continue-with-documents checkbox', () => {
    expect(en.Workspaces.continueWithSameDocuments).toBe('Continue with same documents')
    expect(de.Workspaces.continueWithSameDocuments).toBe('Mit denselben Belegen fortfahren')
  })

  test('accepts one or many PDFs from the viewport drop target or file picker', () => {
    const files = [{ name: 'invoice.pdf', type: '' }, { name: 'scan', type: 'application/pdf' }, { name: 'notes.txt', type: 'text/plain' }]
    expect(acceptedPdfFiles(files).map(file => file.name)).toEqual(['invoice.pdf', 'scan'])
  })

  test('Given a structured invoice, when files are selected, then XML and PDF evidence enter the booking workflow while unrelated files remain excluded', () => {
    const files = [{ name: 'invoice.xml', type: '' }, { name: 'cii', type: 'application/xml' }, { name: 'hybrid.pdf', type: 'application/pdf' }, { name: 'notes.txt', type: 'text/plain' }]
    expect(acceptedBookingDocumentFiles(files).map(file => file.name)).toEqual(['invoice.xml', 'cii', 'hybrid.pdf'])
  })

  test('merges each successful upload into the latest selection without overwriting concurrent choices', () => {
    expect(mergeDocumentSelection(['selected-during-upload'], 'uploaded')).toEqual(['selected-during-upload', 'uploaded'])
    expect(mergeDocumentSelection(['uploaded'], 'uploaded')).toEqual(['uploaded'])
  })

  test('shows each successful upload immediately even if a later file fails', () => {
    const existing = { id: 'existing', url: '/existing' }
    const uploaded = { id: 'uploaded', url: '/uploaded' }
    expect(mergeUploadedDocument([existing], uploaded)).toEqual([uploaded, existing])
  })

  test('does not let a stale initial list hide a document uploaded while it loaded', () => {
    const uploaded = { id: 'uploaded', url: '/uploaded' }
    const fetched = { id: 'existing', url: '/existing' }
    expect(mergeDocumentLists([uploaded], [fetched])).toEqual([uploaded, fetched])
  })

  test('enriches draft metadata with the library thumbnail without replacing a selected document', () => {
    const draftDocument = { id: 'invoice', url: '/api/documents/invoice/file', fileName: 'invoice.pdf' }
    expect(mergeDocumentLists([draftDocument], [{ ...draftDocument, thumbnailUrl: '/api/documents/invoice/thumbnail', contentType: 'application/pdf' }])).toEqual([{
      ...draftDocument,
      thumbnailUrl: '/api/documents/invoice/thumbnail',
      contentType: 'application/pdf',
    }])
  })

  test('hides documents consumed by a completed posting from the available list', () => {
    const documents = [{ id: 'booked', url: '/booked' }, { id: 'available', url: '/available' }]
    expect(availableBookingDocuments(documents, new Set(['booked']))).toEqual([{ id: 'available', url: '/available' }])
  })

  test('resizes the document column while keeping both panels usable', () => {
    expect(clampDocumentColumnPercent(20)).toBe(40)
    expect(clampDocumentColumnPercent(55)).toBe(55)
    expect(clampDocumentColumnPercent(90)).toBe(75)
  })

  test('restores a saved manual column size safely', () => {
    expect(parseSavedDocumentColumnPercent('62')).toBe(62)
    expect(parseSavedDocumentColumnPercent('100')).toBe(75)
    expect(parseSavedDocumentColumnPercent('not-a-number')).toBeNull()
  })

  test('uses the localized upload fallback when an error response has no JSON body', async () => {
    await expect(readDocumentUploadResponse(new Response('', { status: 500 }), 'Upload failed')).rejects.toThrow('Upload failed')
  })

  test('keeps spacing below a document loading error', () => {
    const css = readFileSync(new URL('./index.css', import.meta.url), 'utf8')
    expect(css).toMatch(/\.document-picker-panel \.alert\s*\{[^}]*margin-bottom:\s*14px/)
  })
})

describe('compact attached-document flow', () => {
  test('renders only attached documents as human-friendly rows with view and remove actions', () => {
    const attached = attachedBookingDocuments(['document-1'], [
      { id: 'document-1', url: '/api/documents/document-1/file', fileName: 'Invoice.pdf' },
      { id: 'available', url: '/api/documents/available/file', fileName: 'Other.pdf' },
    ])
    expect(attached.map(document => document.fileName)).toEqual(['Invoice.pdf'])

    const html = renderToStaticMarkup(createElement(AttachedDocumentRow, {
      document: attached[0],
      fallbackName: 'Unnamed document',
      openLabel: 'Open document',
      removeLabel: 'Remove',
      removeAccessibleLabel: 'Remove Invoice from booking',
      onRemove: () => undefined,
    }))
    expect(html).toContain('<strong class="document-name" title="Invoice">Invoice</strong>')
    expect(html).toContain('>Open document</a>')
    expect(html).toContain('><i class="bi bi-x-lg me-1" aria-hidden="true"></i>Remove</button>')
    expect(html).toContain('aria-label="Remove Invoice from booking"')
    expect(html).toContain('title="Remove Invoice from booking"')
    expect(html).not.toContain('>document-1<')
  })

  test('keeps existing selections when an available document is added', () => {
    expect(addDocumentSelection(['attached'], 'new-document')).toEqual(['attached', 'new-document'])
    expect(addDocumentSelection(['attached'], 'attached')).toEqual(['attached'])
  })

  test('keeps the full picker hidden until the add flow is opened', () => {
    expect(documentPickerIsOpen(true, false)).toBe(false)
    expect(documentPickerIsOpen(true, true)).toBe(true)
    expect(documentPickerIsOpen(false, false)).toBe(true)
  })

  test('collapses the compact add flow after a successful addition while preserving the regular picker', () => {
    expect(documentPickerOpenAfterAddition(true)).toBe(false)
    expect(documentPickerOpenAfterAddition(false)).toBe(true)
  })
})
