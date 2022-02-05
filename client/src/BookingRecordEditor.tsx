import { first, last } from '@sanjo/array'
import { BookingRecordElementTransferData, BookingRecordTransferData } from 'accounting-core/BookingRecord.js'
import { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { IRow } from './IRow'
import { Row } from './Row'

function createRow(id: number): IRow {
  return {
    id,
    date: '',
    documentId: '',
    to: '',
    account: '',
    debit: '',
    credit: '',
  }
}

export function BookingRecordEditor() {
  const { t } = useTranslation('BookingRecordEditor')

  const [rows, setRows] = useState<IRow[]>([createRow(1)])
  const [nextId, setNextId] = useState(1 + 1)

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
          debitSide: []
        }
        for (const row of rows) {
          const bookingRecordElement: BookingRecordElementTransferData = {
            document: row.documentId,
            account: row.account,
            amount: Number(row.debit || row.credit)
          }
          let side
          if (row.debit) {
            side = bookingRecord.debitSide
          } else {
            side = bookingRecord.creditSide
          }
          side.push(bookingRecordElement)
        }
        await fetch('http://localhost/booking-records', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(bookingRecord),
        })
      }
    },
    [rows],
  )

  return (
    <form onSubmit={ onSubmit }>
      <table className="table mb-2">
        <thead>
          <tr>
            <th>{ t('Date') }</th>
            <th>{ t('Document ID') }</th>
            <th>{ t('Booking record') }</th>
            <th>{ t('Debit') }</th>
            <th>{ t('Credit') }</th>
            <th>&nbsp;</th>
          </tr>
        </thead>
        <tbody>
          { rows.map((row, index) => <Row key={ row.id } row={ row } onRemove={ removeRow.bind(null, index) } />) }
        </tbody>
      </table>
      <div className="text-end mb-2">
        <button type="button" className="btn btn-secondary" onClick={ addRow }>{ t('Add') }</button>
      </div>
      <div className="text-end">
        <button type="submit" className="btn btn-primary">{ t('Submit') }</button>
      </div>
    </form>
  )
}
