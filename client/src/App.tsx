import React from 'react'
import { useTranslation } from 'react-i18next'
import './App.css'
import { BookingRecordEditor } from './BookingRecordEditor'
import { DocumentUpload } from './DocumentUpload'
import { LanguageSelect } from './LanguageSelect'

export function App() {
  const { t } = useTranslation('App')

  return (
    <div className="container">
      <div className="row">
        <div className="col">
          <h1>{ t('Document upload') }</h1>
          <div className="mb-3">
            <DocumentUpload />
          </div>
          <BookingRecordEditor />
          <div className="mt-5 border-top pt-2 text-end">
            <LanguageSelect />
          </div>
        </div>
      </div>
    </div>
  )
}
