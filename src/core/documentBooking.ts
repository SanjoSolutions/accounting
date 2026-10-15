export type DocumentLibraryView = 'inbox' | 'booked'

export type DocumentBooking = {
  id: string
  documentNumber: string
  description: string
  bookingDate: string
  fiscalYear: number
  state: string
  reversalOfId: string | null
}

export function documentBookingUrl(booking: Pick<DocumentBooking, 'id' | 'fiscalYear'>): string {
  return `/journal?year=${booking.fiscalYear}#journal-entry-${encodeURIComponent(booking.id)}`
}
