import React from 'react'
import { useTranslation } from 'react-i18next'
import { BookingRecordEditor } from './BookingRecordEditor.js'
import { Document } from './Document.js'
import { DocumentUpload } from './DocumentUpload.js'

export function CreateBookingRecord(): any {
  const { t } = useTranslation('CreateBookingRecord')

  return (
    <div>
      <h1>{ t('Create booking record') }</h1>
      <h2>{ t('Upload document') }</h2>
      <div className="mb-3">
        <DocumentUpload />
      </div>
      <h2>{ t('Document') }</h2>
      <div className="mb-3">
        <Document />
      </div>
      <h2>{ t('Booking record') }</h2>
      <BookingRecordEditor />
    </div>
  )
}
