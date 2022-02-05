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

  const rowA = createRow(1)
  rowA.date = '2022-01-01'
  rowA.documentId = 'ER1'
  rowA.account = '6170: Sonstige Aufwendungen für bezogene Leistungen'
  rowA.debit = String(780)

  const rowB = createRow(2)
  rowB.documentId = 'ER1'
  rowB.account = 'Vorsteuer'
  rowB.debit = String(148.20)

  const rowC = createRow(3)
  rowC.documentId = 'ER1'
  rowC.to = 'to'
  rowC.account = 'Verbindlichkeiten a. LL'
  rowC.credit = String(928.20)

  const [rows, setRows] = useState<IRow[]>([rowA, rowB, rowC])
  const [nextId, setNextId] = useState(rowC.id + 1)

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
      <table className="table table-borderless mb-2">
        <thead>
          <tr>
            <th style={ { width: '165px' } }>{ t('Date') }</th>
            <th style={ { width: '124px' } }>{ t('Document ID') }</th>
            <th>{ t('Booking record') }</th>
            <th style={ { width: '172px' } }>{ t('Debit') }</th>
            <th style={ { width: '172px' } }>{ t('Credit') }</th>
            <th style={ { width: '56px' } }>&nbsp;</th>
          </tr>
        </thead>
        <tbody style={ { borderTopWidth: '2px' } }>
          {
            rows.map((row, index) => <Row
              key={ row.id }
              row={ row }
              onRemove={ removeRow.bind(null, index) }
              showDate={ index === 0 }
            />)
          }
        </tbody>
      </table>
      <div className="text-end mb-3">
        <button type="button" className="btn btn-secondary" onClick={ addRow }>{ t('Add row') }</button>
      </div>
      <div className="text-end">
        <button type="submit" className="btn btn-primary">{ t('Create booking record') }</button>
      </div>
    </form>
  )
}
