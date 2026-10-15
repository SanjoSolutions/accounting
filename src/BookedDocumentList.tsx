'use client'

import { useTranslations } from 'next-intl'
import { documentBookingUrl } from './core/documentBooking'
import type { BookingDocument } from './BookingDocuments'
import { documentDisplayName, documentIconClass } from './documentPresentation'
import { LocalDate } from './LocalDate'

export function BookedDocumentList({ documents, selectedIds, onSelect }: {
  documents: BookingDocument[]
  selectedIds: string[]
  onSelect: (id: string, extendSelection: boolean) => void
}) {
  const t = useTranslations('Workspaces')
  return <ul className="list-group" aria-label={t('bookedDocuments')}>
    {documents.map(document => <li className="list-group-item" key={document.id}>
      <button type="button" className={`btn ${selectedIds.includes(document.id) ? 'btn-primary' : 'btn-outline-secondary'} text-start text-break w-100`}
        aria-pressed={selectedIds.includes(document.id)}
        onClick={event => onSelect(document.id, event.shiftKey)}>
        <i className={`${documentIconClass(document)} me-2`} aria-hidden="true" />
        {documentDisplayName(document.fileName || t('unnamedDocument'), t('unnamedDocument'))}
      </button>
      <div className="small mt-2">
        <strong>{t('linkedBookings')}</strong>
        {document.bookings?.length ? <ul className="list-unstyled mb-0">
          {document.bookings.map(booking => <li key={booking.id} className="mt-1 d-flex flex-wrap align-items-baseline gap-2">
            <a href={documentBookingUrl(booking)} target="_blank" rel="noreferrer" className="text-break">
              {booking.documentNumber} · {booking.description}
              <i className="bi bi-box-arrow-up-right ms-1" aria-hidden="true" /><span className="visually-hidden"> {t('opensNewTab')}</span>
            </a>
            <LocalDate value={booking.bookingDate} />
            <span className="badge bg-secondary">{booking.reversalOfId ? t('bookingReversal') : booking.state === 'POSTED' ? t('bookingPosted') : booking.state}</span>
          </li>)}
        </ul> : <p className="text-muted mb-0">{t('bookingHistoryUnavailable')}</p>}
      </div>
    </li>)}
  </ul>
}
