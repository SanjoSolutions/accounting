import { first, last } from '@sanjo/array'
import { BookingRecordElementTransferData, BookingRecordTransferData } from 'accounting-core/BookingRecord.js'
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
  const [nextId, setNextId] = useState(1)

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

      let id = nextId

      const rowA = createRow(id)
      rowA.date = '2022-01-01'
      rowA.documentId = 'ER1'
      rowA.account = '6170: Sonstige Aufwendungen für bezogene Leistungen'
      rowA.debit = Number(netAmount).toFixed(2)

      id++

      const rowB = createRow(id)
      rowB.documentId = 'ER1'
      rowB.account = 'Vorsteuer'
      rowB.debit = Number(taxAmount).toFixed(2)

      id++

      const rowC = createRow(id)
      rowC.documentId = 'ER1'
      rowC.to = 'to'
      rowC.account = 'Verbindlichkeiten a. LL'
      rowC.credit = Number(grossAmount).toFixed(2)

      id++

      const rows = [rowA, rowB, rowC]

      setNextId(id)
      setRows(rows)
    },
    [nextId]
  )

  const addRow = useCallback(
    () => {
      const row = createRow(nextId)
      if (rows.length >= 1 && last(rows)!.to === 'to') {
        row.to = 'to'
      }
      setRows([...rows, row])
      setNextId(nextId + 1)
    },
    [
      rows,
      nextId,
    ],
  )

  const removeRow = useCallback(
    (index) => {
      setRows([...rows.slice(0, index), ...rows.slice(index + 1)])
    },
    [
      rows,
    ],
  )

  const onSubmit = useCallback(
    async (event: any) => {
      event.preventDefault()

      if (rows.length >= 1) {
        const bookingRecord: BookingRecordTransferData = {
          date: new Date(first(rows)!.date),
          creditSide: [],
          debitSide: [],
        }
        for (const row of rows) {
          const bookingRecordElement: BookingRecordElementTransferData = {
            document: row.documentId,
            account: row.account,
            amount: Number(row.debit || row.credit),
          }
          let side
          if (row.debit) {
            side = bookingRecord.debitSide
          } else {
            side = bookingRecord.creditSide
          }
          side.push(bookingRecordElement)
        }

        await window.api.post('/booking-records', bookingRecord)
      }
    },
    [rows],
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
      <BookingRecordEditor
        rows={ rows }
        addRow={ addRow }
        removeRow={ removeRow }
        onSubmit={ onSubmit }
      />
    </div>
  )
}
