import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { NextIntlClientProvider } from 'next-intl'
import { describe, expect, test } from 'vitest'
import en from '../messages/en.json'
import de from '../messages/de.json'
import { BookedDocumentList } from './BookedDocumentList'
import { bookingDocumentsForView, mergeDocumentLists, selectDocument } from './BookingDocuments'
import { documentBookingUrl } from './core/documentBooking'

describe('already booked document selection', () => {
  const documents = [{ id: 'inbox', url: '/inbox' }, { id: 'booked', url: '/booked' }]

  test('Given cached booked metadata, when the inbox is selected, then only inbox results are offered', () => {
    expect(bookingDocumentsForView(documents, ['inbox'], new Set(), 'inbox')).toEqual([documents[0]])
    expect(bookingDocumentsForView(documents, ['inbox'], new Set(['inbox']), 'inbox')).toEqual([])
    expect(bookingDocumentsForView(documents, [], new Set(), 'booked')).toEqual([])
  })

  test('Given a document consumed by posting, when the booked view is selected, then it can be explicitly selected again', () => {
    const booked = bookingDocumentsForView(documents, ['booked'], new Set(['booked']), 'booked')
    expect(booked).toEqual([documents[1]])
    expect(selectDocument([], booked[0].id, false)).toEqual(['booked'])
    expect(selectDocument(['inbox'], booked[0].id, true)).toEqual(['inbox', 'booked'])
  })

  test('Given a selected booked document, when inbox metadata loads, then its preview and selection metadata are retained', () => {
    const history = { ...documents[1], bookings: [] }
    expect(mergeDocumentLists([history], [documents[0]])).toEqual([history, documents[0]])
  })

  test.each([['en', en], ['de', de]] as const)('Given %s, when booked evidence is rendered, then selection, journal links, dates and status are accessible', (locale, messages) => {
    const booking = { id: 'entry/1', documentNumber: 'B-2026-1', description: 'Synthetic original', bookingDate: '2026-01-10', fiscalYear: 2026, state: 'POSTED', reversalOfId: null }
    const html = renderToStaticMarkup(createElement(NextIntlClientProvider, { locale, messages, timeZone: 'UTC', children:
      createElement(BookedDocumentList, { documents: [{ ...documents[1], fileName: 'Evidence.pdf', bookings: [booking, { ...booking, id: 'reversal', reversalOfId: booking.id }] }], selectedIds: ['booked'], onSelect: () => undefined }),
    }))
    expect(html).toContain('aria-pressed="true"')
    expect(html).toContain('Evidence')
    expect(html).toContain(documentBookingUrl(booking))
    expect(html).toContain('target="_blank"')
    expect(html).toContain('B-2026-1 · Synthetic original')
    expect(html).toContain('dateTime="2026-01-10"')
    expect(html).toContain(messages.Workspaces.bookingPosted)
    expect(html).toContain(messages.Workspaces.bookingReversal)
  })
})
