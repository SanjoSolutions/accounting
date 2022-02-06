import { IncomingInvoice } from 'accounting-core/IncomingInvoice.js'
import React, { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { BookingRecordEditor } from './BookingRecordEditor.js'
import { createRow } from './createRow.js'
import { Document } from './Document.js'
import { DocumentUpload } from './DocumentUpload.js'
import { IRow } from './IRow.js'

export function CreateBookingRecord(): any {
  const { t } = useTranslation('CreateBookingRecord')

  const [url, setUrl] = useState<string | null>(null)
  const [netAmount, setNetAmount] = useState<number | null>(null)
  const [taxAmount, setTaxAmount] = useState<number | null>(null)
  const [grossAmount, setGrossAmount] = useState<number | null>(null)

  const [rows, setRows] = useState<IRow[]>([])

  const onNetAmountChange = useCallback(
    (event: any) => {
      const value = event.target.value

      setNetAmount(parseFloat(value))

      const row = rows.find(({id}) => id === 1)
      if (row && netAmount === parseFloat(row.debit)) {
        row.debit = value
        setRows(Array.from(rows))
      }
    },
    [rows, netAmount]
  )

  const onTaxAmountChange = useCallback(
    (event: any) => {
      const value = event.target.value

      setTaxAmount(parseFloat(value))

      const row = rows.find(({ id }) => id === 2)
      if (row && taxAmount === parseFloat(row.debit)) {
        row.debit = value
        setRows(Array.from(rows))
      }
    },
    [rows, taxAmount]
  )

  const onGrossAmountChange = useCallback(
    (event: any) => {
      const value = event.target.value

      setGrossAmount(parseFloat(value))

      const row = rows.find(({ id }) => id === 3)
      if (row && grossAmount === parseFloat(row.credit)) {
        row.credit = value
        setRows(Array.from(rows))
      }
    },
    [rows, grossAmount]
  )

  const onDocumentUploaded = useCallback(
    (document: Document) => {
      const invoice = document as unknown as IncomingInvoice

      const netAmount = invoice.netAmount
      const taxAmount = invoice.tax.amount
      const grossAmount = invoice.total

      setUrl(invoice.url)
      setNetAmount(netAmount)
      setTaxAmount(taxAmount)
      setGrossAmount(grossAmount)

      const rowA = createRow(1)
      rowA.date = '2022-01-01'
      rowA.documentId = 'ER1'
      rowA.account = '6170: Sonstige Aufwendungen für bezogene Leistungen'
      rowA.debit = Number(netAmount).toFixed(2)

      const rowB = createRow(2)
      rowB.documentId = 'ER1'
      rowB.account = 'Vorsteuer'
      rowB.debit = Number(taxAmount).toFixed(2)

      const rowC = createRow(3)
      rowC.documentId = 'ER1'
      rowC.to = 'to'
      rowC.account = 'Verbindlichkeiten a. LL'
      rowC.credit = Number(grossAmount).toFixed(2)

      const rows = [rowA, rowB, rowC]

      setRows(rows)
    },
    []
  )

  return (
    <div>
      <h1>{ t('Create booking record') }</h1>
      <h2>{ t('Upload document') }</h2>
      <div className="mb-3">
        <DocumentUpload onDocumentUploaded={ onDocumentUploaded } />
      </div>
      <h2>{ t('Document') }</h2>
      <div className="mb-3">
        <Document
          url={ url }
          netAmount={ netAmount }
          onNetAmountChange={ onNetAmountChange }
          taxAmount={ taxAmount }
          onTaxAmountChange={ onTaxAmountChange }
          grossAmount={ grossAmount }
          onGrossAmountChange={ onGrossAmountChange }
        />
      </div>
      <h2>{ t('Booking record') }</h2>
      <BookingRecordEditor rows={ rows } />
    </div>
  )
}
