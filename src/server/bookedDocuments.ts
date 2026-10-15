import 'server-only'

import type { Document } from '@/core/Document'
import type { DocumentBooking } from '@/core/documentBooking'
import { prisma } from './persistence/client'

/** Read retained evidence without returning it to the inbox or changing its links. */
export async function listBookedDocuments(ownerId: string) {
  const records = await prisma.documentRecord.findMany({
    where: { ownerId, availableForBooking: false },
    orderBy: { id: 'desc' },
    include: {
      attachments: {
        where: { journalEntry: { ownerId } },
        orderBy: { journalEntry: { bookingDate: 'desc' } },
        select: { journalEntry: { select: {
          id: true, documentNumber: true, description: true, bookingDate: true,
          state: true, reversalOfId: true, fiscalYear: { select: { year: true } },
        } } },
      },
    },
  })

  return records.map(record => {
    const metadata = JSON.parse(record.payload) as Document
    const bookings: DocumentBooking[] = record.attachments.map(({ journalEntry: entry }) => ({
      id: entry.id,
      documentNumber: entry.documentNumber,
      description: entry.description,
      bookingDate: entry.bookingDate.toISOString().slice(0, 10),
      fiscalYear: entry.fiscalYear.year,
      state: entry.state,
      reversalOfId: entry.reversalOfId,
    }))
    return {
      id: record.id,
      url: `/api/documents/${encodeURIComponent(record.id)}/file`,
      fileName: metadata.fileName,
      contentType: metadata.contentType,
      size: metadata.size,
      thumbnailUrl: metadata.thumbnailStorageKey ? `/api/documents/${encodeURIComponent(record.id)}/thumbnail` : undefined,
      bookings,
    }
  })
}
