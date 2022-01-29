import { useCallback, useState } from 'react'
import { Row } from './Row'

export function BookingRecordEditor() {
  const [rows, setRows] = useState([{id: 1}])
  const [nextId, setNextId] = useState(1 + 1)

  const addRow = useCallback(
    () => {
      setRows([...rows, {id: nextId}])
      setNextId(nextId + 1)
    },
    [
      rows,
      nextId
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
            <th>Date</th>
            <th>Document ID</th>
            <th>Booking record</th>
            <th>Debit</th>
            <th>Credit</th>
            <th>&nbsp;</th>
          </tr>
        </thead>
        <tbody>
          { rows.map((row, index) => <Row key={ row.id } onRemove={ removeRow.bind(null, index) } />) }
        </tbody>
      </table>
      <div className="text-end mb-2">
        <button type="button" className="btn btn-secondary" onClick={ addRow }>Add</button>
      </div>
      <div className="text-end">
        <button type="button" className="btn btn-primary">Submit</button>
      </div>
    </div>
  )
}
