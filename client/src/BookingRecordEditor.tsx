import { first, last } from '@sanjo/array'
import { BookingRecordElementTransferData, BookingRecordTransferData } from 'accounting-core/BookingRecord.js'
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { createRow } from './createRow'
import type { IRow } from './IRow'
import { Row } from './Row'

export function BookingRecordEditor(props: {rows: IRow[]}) {
  const { t } = useTranslation('BookingRecordEditor')

  const [rows, setRows] = useState<IRow[]>(props.rows)
  const [nextId, setNextId] = useState(Math.max(...rows.map(row => row.id)) + 1)

  useEffect(
    () => {
      setRows(props.rows)
    },
    [
      props.rows
    ]
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
              index={ index }
              rows={ rows }
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
