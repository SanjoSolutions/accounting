import 'bootstrap-icons/font/bootstrap-icons.css'
import 'bootstrap/dist/css/bootstrap.css'

import { initializeApp } from 'firebase/app'
import { getAuth, signInWithEmailAndPassword } from 'firebase/auth'
import i18n from 'i18next'
import React from 'react'
import ReactDOM from 'react-dom'
import { initReactI18next } from 'react-i18next'
import { App } from './App'
import { firebaseConfig } from './firebaseConfig.js'
import './index.css'
import reportWebVitals from './reportWebVitals'

i18n
  .use(initReactI18next) // passes i18n down to react-i18next
  .init({
    // the translations
    // (tip move them in a JSON file and import them,
    // or even better, manage them via a UI: https://react.i18next.com/guides/multiple-translation-files#manage-your-translations-with-a-management-gui)
    resources: {
      en: {
        'App': {
          'Document upload': 'Document upload',
        },
        'DocumentUpload': {
          'Document': 'Document',
          'Upload': 'Upload',
        },
        'BookingRecordEditor': {
          'Date': 'Date',
          'Document ID': 'Document ID',
          'Booking record': 'Booking record',
          'Debit': 'Debit',
          'Credit': 'Credit',
          'Add': 'Add',
          'Submit': 'Submit',
        },
      },
      de: {
        'App': {
          'Document upload': 'Dokument upload',
        },
        'DocumentUpload': {
          'Document': 'Dokument',
          'Upload': 'Hochladen',
        },
        'BookingRecordEditor': {
          'Date': 'Datum',
          'Document ID': 'Buchungsbeleg Nr.',
          'Booking record': 'Buchungssatz',
          'Debit': 'Soll',
          'Credit': 'Haben',
          'Add': 'Hinzufügen',
          'Submit': 'Abschicken',
        },
      },
    },
    lng: 'de',
    fallbackLng: 'en',

    interpolation: {
      escapeValue: false, // react already safes from xss => https://www.i18next.com/translation-function/interpolation#unescape
    },
  })

initializeApp(firebaseConfig)

window.signIn = async function (email: string, password: string) {
  const auth = getAuth()
  await signInWithEmailAndPassword(auth, email, password)
}
declare global {
  interface Window {
    signIn(email: string, password: string): Promise<void>
  }
}

ReactDOM.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
  document.getElementById('root'),
)

// If you want to start measuring performance in your app, pass a function
// to log results (for example: reportWebVitals(console.log))
// or send to an analytics endpoint. Learn more: https://bit.ly/CRA-vitals
reportWebVitals()
