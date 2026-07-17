import { describe, expect, it } from 'vitest'
import { acceptedPdfFiles, clampDocumentColumnPercent, mergeDocumentLists, mergeDocumentSelection, mergeUploadedDocument, parseSavedDocumentColumnPercent, toggleDocumentSelection } from './BookingDocuments'

describe('booking document selection', () => {
  it('allows zero to many selected documents', () => {
    expect(toggleDocumentSelection([], 'one')).toEqual(['one'])
    expect(toggleDocumentSelection(['one'], 'two')).toEqual(['one', 'two'])
    expect(toggleDocumentSelection(['one'], 'one')).toEqual([])
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
})
