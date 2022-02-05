import React from 'react'
import { useTranslation } from 'react-i18next'
import './App.css'
import { BookingRecordEditor } from './BookingRecordEditor.js'
import { Document } from './Document.js'
import { DocumentUpload } from './DocumentUpload.js'
import { LanguageSelect } from './LanguageSelect.js'

export function App() {
  const { t } = useTranslation('App')

  return (
    <div className="container">
      <div className="row mb-2">
        <div className="col">
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
          <div className="mt-5 border-top pt-2 text-end">
            <LanguageSelect />
          </div>
        </div>
      </div>
    </div>
  )
}
