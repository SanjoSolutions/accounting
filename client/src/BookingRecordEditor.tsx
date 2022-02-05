import { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Row } from './Row'

export function BookingRecordEditor() {
  const { t } = useTranslation('BookingRecordEditor')

  const [rows, setRows] = useState([{ id: 1 }])
  const [nextId, setNextId] = useState(1 + 1)

  const addRow = useCallback(
    () => {
      setRows([...rows, { id: nextId }])
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

  return (
    <div>
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
          { rows.map((row, index) => <Row key={ row.id } onRemove={ removeRow.bind(null, index) } />) }
        </tbody>
      </table>
      <div className="text-end mb-2">
        <button type="button" className="btn btn-secondary" onClick={ addRow }>{ t('Add') }</button>
      </div>
      <div className="text-end">
        <button type="button" className="btn btn-primary">{ t('Submit') }</button>
      </div>
    </div>
  )
}
