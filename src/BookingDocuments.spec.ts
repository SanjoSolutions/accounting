import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import de from '../messages/de.json'
import en from '../messages/en.json'
import { readFileSync } from 'node:fs'
import { acceptedPdfFiles, clampDocumentColumnPercent, DocumentCard, documentDisplayName, LongTouchSelectionGesture, longTouchSelectionDelayMs, mergeDocumentLists, mergeDocumentSelection, mergeUploadedDocument, parseSavedDocumentColumnPercent, readDocumentUploadResponse, selectDocument, selectionExtendsForActivation } from './BookingDocuments'

afterEach(() => vi.useRealTimers())

describe('booking document selection', () => {
  it('selects only the clicked document unless Shift extends the selection', () => {
    expect(selectDocument(['one', 'two'], 'three', false)).toEqual(['three'])
    expect(selectDocument(['one'], 'two', true)).toEqual(['one', 'two'])
    expect(selectDocument(['one', 'two'], 'one', true)).toEqual(['two'])
  })

  it('extends selection only for Shift-click or a deliberate long touch', () => {
    expect(selectionExtendsForActivation(false, false)).toBe(false)
    expect(selectionExtendsForActivation(true, false)).toBe(true)
    expect(selectionExtendsForActivation(false, true)).toBe(true)
    expect(longTouchSelectionDelayMs).toBe(500)
  })

  it('suppresses only the click following a completed long touch', () => {
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

  it('does not suppress the next tap after a long touch is cancelled', () => {
    vi.useFakeTimers()
    const gesture = new LongTouchSelectionGesture()
    const onLongTouch = vi.fn()

    gesture.start(onLongTouch)
    vi.advanceTimersByTime(longTouchSelectionDelayMs)
    gesture.cancel()

    expect(onLongTouch).not.toHaveBeenCalled()
    expect(gesture.consumeClick()).toBe(false)
  })

  it('shows only a PDF preview thumbnail and the document name on each card', () => {
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

  it('falls back to a PDF icon when a stored thumbnail is unavailable', () => {
    const html = renderToStaticMarkup(createElement(DocumentCard, {
      document: { id: 'one', url: '/api/documents/one/file', fileName: 'Invoice.pdf' },
      selected: false,
      fallbackName: 'Unnamed document',
      onSelect: () => undefined,
    }))

    expect(html).toContain('bi-file-earmark-pdf')
    expect(html).not.toContain('<iframe')
  })

  it('removes only the trailing PDF extension from document display names', () => {
    expect(documentDisplayName('Invoice.final.PDF')).toBe('Invoice.final')
    expect(documentDisplayName('Invoice')).toBe('Invoice')
    expect(documentDisplayName('.pdf', 'Unnamed document')).toBe('Unnamed document')
  })

  it('uses only the concise document panel heading and upload action copy', () => {
    expect(en.Workspaces.documents).toBe('Documents')
    expect(en.Workspaces.chooseDocuments).toBe('Upload documents')
    expect(de.Workspaces.documents).toBe('Belege')
    expect(de.Workspaces.chooseDocuments).toBe('Belege hochladen')
    expect(en.Workspaces).not.toHaveProperty('selectDocuments')
    expect(en.Workspaces).not.toHaveProperty('documentsHelp')
    expect(en.Workspaces).not.toHaveProperty('documentsSelected')
  })

  it('accepts one or many PDFs from the viewport drop target or file picker', () => {
    const files = [{ name: 'invoice.pdf', type: '' }, { name: 'scan', type: 'application/pdf' }, { name: 'notes.txt', type: 'text/plain' }]
    expect(acceptedPdfFiles(files).map(file => file.name)).toEqual(['invoice.pdf', 'scan'])
  })

  it('merges each successful upload into the latest selection without overwriting concurrent choices', () => {
    expect(mergeDocumentSelection(['selected-during-upload'], 'uploaded')).toEqual(['selected-during-upload', 'uploaded'])
    expect(mergeDocumentSelection(['uploaded'], 'uploaded')).toEqual(['uploaded'])
  })

  it('shows each successful upload immediately even if a later file fails', () => {
    const existing = { id: 'existing', url: '/existing' }
    const uploaded = { id: 'uploaded', url: '/uploaded' }
    expect(mergeUploadedDocument([existing], uploaded)).toEqual([uploaded, existing])
  })

  it('does not let a stale initial list hide a document uploaded while it loaded', () => {
    const uploaded = { id: 'uploaded', url: '/uploaded' }
    const fetched = { id: 'existing', url: '/existing' }
    expect(mergeDocumentLists([uploaded], [fetched])).toEqual([uploaded, fetched])
  })

  it('resizes the document column while keeping both panels usable', () => {
    expect(clampDocumentColumnPercent(20)).toBe(40)
    expect(clampDocumentColumnPercent(55)).toBe(55)
    expect(clampDocumentColumnPercent(90)).toBe(75)
  })

  it('restores a saved manual column size safely', () => {
    expect(parseSavedDocumentColumnPercent('62')).toBe(62)
    expect(parseSavedDocumentColumnPercent('100')).toBe(75)
    expect(parseSavedDocumentColumnPercent('not-a-number')).toBeNull()
  })

  it('uses the localized upload fallback when an error response has no JSON body', async () => {
    await expect(readDocumentUploadResponse(new Response('', { status: 500 }), 'Upload failed')).rejects.toThrow('Upload failed')
  })

  it('keeps spacing below a document loading error', () => {
    const css = readFileSync(new URL('./index.css', import.meta.url), 'utf8')
    expect(css).toMatch(/\.document-picker-panel \.error-summary\s*\{[^}]*margin-bottom:\s*14px/)
  })
})
