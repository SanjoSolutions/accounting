import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'

if (!i18n.isInitialized) {
  void i18n.use(initReactI18next).init({
    resources: {
      en: {
        Navbar: {
          Accounting: 'Accounting',
          'Create booking record': 'Create booking record',
          'Create balance sheet': 'Create balance sheet',
          Settings: 'Settings',
        },
        CreateBookingRecord: {
          'Create booking record': 'Create booking record',
          'Upload document': 'Upload document',
          Document: 'Document',
          'Booking record': 'Booking record',
        },
        LanguageSelect: { en: 'English', de: 'Deutsch' },
        DocumentUpload: { Document: 'Document', Upload: 'Upload' },
        Document: {
          'Net amount': 'Net amount',
          Taxes: 'Taxes',
          'Gross amount': 'Gross amount',
        },
        BookingRecordEditor: {
          Date: 'Date',
          'Document ID': 'Document ID',
          'Booking record': 'Booking record',
          Debit: 'Debit',
          Credit: 'Credit',
          'Add row': 'Add row',
          'Create booking record': 'Create booking record',
        },
        Row: { to: 'to' },
        CreateBalanceSheet: {
          'For year': 'For year',
          Type: 'Type',
          'Opening balance sheet': 'Opening balance sheet',
          'Create balance sheet': 'Create balance sheet',
        },
        Settings: {
          'Invoice issuer': 'Invoice issuer',
          Name: 'Name',
          'Street and house number': 'Street and house number',
          'Zip code': 'Zip code',
          City: 'City',
          Country: 'Country',
          Save: 'Save',
        },
      },
      de: {
        Navbar: {
          Accounting: 'Buchführung',
          'Create booking record': 'Buchungssatz erstellen',
          'Create balance sheet': 'Bilanz erstellen',
          Settings: 'Einstellungen',
        },
        CreateBookingRecord: {
          'Create booking record': 'Buchungssatz erstellen',
          'Upload document': 'Dokument hochladen',
          Document: 'Dokument',
          'Booking record': 'Buchungssatz',
        },
        DocumentUpload: { Document: 'Dokument', Upload: 'Hochladen' },
        Document: {
          'Net amount': 'Nettobetrag',
          Taxes: 'Steuern',
          'Gross amount': 'Bruttobetrag',
        },
        BookingRecordEditor: {
          Date: 'Datum',
          'Document ID': 'Buchungsbeleg Nr.',
          'Booking record': 'Buchungssatz',
          Debit: 'Soll',
          Credit: 'Haben',
          'Add row': 'Zeile hinzufügen',
          'Create booking record': 'Buchungssatz erstellen',
        },
        Row: { to: 'an' },
        CreateBalanceSheet: {
          'For year': 'Für Jahr',
          Type: 'Art',
          'Opening balance sheet': 'Eröffnungsbilanz',
          'Create balance sheet': 'Bilanz erstellen',
        },
        Settings: {
          'Invoice issuer': 'Rechnungsaussteller',
          Name: 'Name',
          'Street and house number': 'Straße und Hausnummer',
          'Zip code': 'Postleitzahl',
          City: 'Stadt',
          Country: 'Land',
          Save: 'Speichern',
        },
      },
    },
    lng: 'en',
    fallbackLng: 'en',
    interpolation: { escapeValue: false },
  })
}

export default i18n
