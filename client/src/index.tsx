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
import { getLanguage } from './getLanguage'
import './index.css'
import reportWebVitals from './reportWebVitals'
import { BrowserRouter } from "react-router-dom"
import { Requester } from './Requester.js'

window.api = new Requester('http://localhost')

declare global {
  interface Window {
    api: Requester
  }
}

i18n
  .use(initReactI18next) // passes i18n down to react-i18next
  .init({
    // the translations
    // (tip move them in a JSON file and import them,
    // or even better, manage them via a UI: https://react.i18next.com/guides/multiple-translation-files#manage-your-translations-with-a-management-gui)
    resources: {
      en: {
        'Navbar': {
          'Accounting': 'Accounting',
          'Create booking record': 'Create booking record',
          'Create balance sheet': 'Create balance sheet',
          'Settings': 'Settings'
        },
        'CreateBookingRecord': {
          'Create booking record': 'Create booking record',
          'Upload document': 'Upload document',
          'Document': 'Document',
          'Booking record': 'Booking record'
        },
        'LanguageSelect': {
          'en': 'English',
          'de': 'Deutsch'
        },
        'DocumentUpload': {
          'Document': 'Document',
          'Upload': 'Upload',
        },
        'Document': {
          'Net amount': 'Net amount',
          'Taxes': 'Taxes',
          'Gross amount': 'Gross amount',
        },
        'BookingRecordEditor': {
          'Date': 'Date',
          'Document ID': 'Document ID',
          'Booking record': 'Booking record',
          'Debit': 'Debit',
          'Credit': 'Credit',
          'Add row': 'Add row',
          'Create booking record': 'Create booking record',
        },
        'Row': {
          'to': 'to'
        },
        'CreateBalanceSheet': {
          'For year': 'For year',
          'Type': 'Type',
          'Opening balance sheet': 'Opening balance sheet',
          'Create balance sheet': 'Create balance sheet'
        },
        'Settings': {
          'Invoice issuer': 'Invoice issuer',
          'Name': 'Name',
          'Street and house number': 'Street and house number',
          'Zip code': 'Zip code',
          'City': 'City',
          'Country': 'Country',
          'Save': 'Save'
        }
      },
      de: {
        'Navbar': {
          'Accounting': 'Buchf??hrung',
          'Create booking record': 'Buchungssatz erstellen',
          'Create balance sheet': 'Bilanz erstellen',
          'Settings': 'Einstellungen'
        },
        'CreateBookingRecord': {
          'Create booking record': 'Buchungssatz erstellen',
          'Upload document': 'Dokument hochladen',
          'Document': 'Dokument',
          'Booking record': 'Buchungssatz'
        },
        'DocumentUpload': {
          'Document': 'Dokument',
          'Upload': 'Hochladen',
        },
        'Document': {
          'Net amount': 'Nettobetrag',
          'Taxes': 'Steuern',
          'Gross amount': 'Bruttobetrag',
        },
        'BookingRecordEditor': {
          'Date': 'Datum',
          'Document ID': 'Buchungsbeleg Nr.',
          'Booking record': 'Buchungssatz',
          'Debit': 'Soll',
          'Credit': 'Haben',
          'Add row': 'Zeile hinzuf??gen',
          'Create booking record': 'Buchungssatz erstellen',
        },
        'Row': {
          'to': 'an'
        },
        'CreateBalanceSheet': {
          'For year': 'F??r Jahr',
          'Type': 'Art',
          'Opening balance sheet': 'Er??ffnungsbilanz',
          'Create balance sheet': 'Bilanz erstellen'
        },
        'Settings': {
          'Invoice issuer': 'Rechnungsaussteller',
          'Name': 'Name',
          'Street and house number': 'Stra??e und Hausnummer',
          'Zip code': 'Postleitzahl',
          'City': 'Stadt',
          'Country': 'Land',
          'Save': 'Speichern'
        }
      },
    },
    lng: getLanguage() ?? 'en',
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
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>,
  document.getElementById('root'),
)

// If you want to start measuring performance in your app, pass a function
// to log results (for example: reportWebVitals(console.log))
// or send to an analytics endpoint. Learn more: https://bit.ly/CRA-vitals
reportWebVitals()
