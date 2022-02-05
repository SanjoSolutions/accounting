import { identity } from '@sanjo/identity'
import { useCallback, useState } from 'react'
import type { IRow } from './IRow'

function useInputStateHandler(options: { name: string, defaultValue: any, row: any, transform?: (value: any) => any }): [any, (event: any) => void] {
  const transform = options.transform ?? identity

  const [value, setValue] = useState(options.defaultValue)
  const onChange = useCallback(
    (event: any) => {
      const value = event.target.value
      setValue(value)
      options.row[options.name] = transform(value)
    },
    [
      options,
      transform,
    ],
  )
  return [value, onChange]
}

export function Row({ row, onRemove }: { row: IRow, onRemove: () => void }) {
  const [date, onDateChange] = useInputStateHandler({
    name: 'date',
    defaultValue: '',
    row,
    transform: value => new Date(value),
  })

  const [documentId, onDocumentIdChange] = useInputStateHandler({
    name: 'documentId',
    defaultValue: '',
    row,
  })

  const [to, onToChange] = useInputStateHandler({
    name: 'to',
    defaultValue: '',
    row,
  })

  const [account, onAccountChange] = useInputStateHandler({
    name: 'account',
    defaultValue: '',
    row,
  })

  const [debit, onDebitChange] = useInputStateHandler({
    name: 'debit',
    defaultValue: '',
    row,
  })

  const [credit, onCreditChange] = useInputStateHandler({
    name: 'credit',
    defaultValue: '',
    row,
  })

  return (
    <tr>
      <td>
        <input
          type="date"
          className="form-control"
          value={ date }
          onChange={ onDateChange }
        />
      </td>
      <td>
        <input
          type="text"
          className="form-control"
          value={ documentId }
          onChange={ onDocumentIdChange }
        />
      </td>
      <td>
        <div className="d-flex">
          <select className="form-select me-2" style={ { width: 'auto' } } value={ to } onChange={ onToChange }>
            <option value=""></option>
            <option value="to">to</option>
          </select>
          <input
            type="text"
            className="form-control flex-grow-1"
            value={ account }
            onChange={ onAccountChange }
          />
        </div>
      </td>
      <td>
        <input
          type="number"
          className="form-control"
          value={ debit}
          onChange={onDebitChange}
        />
      </td>
      <td>
        <input
          type="number"
          className="form-control"
          value={credit}
          onChange={onCreditChange}
        />
      </td>
      <td>
        <button type="button" className="btn btn-secondary" onClick={ onRemove }>
          <i className="bi bi-x-lg"></i>
        </button>
      </td>
    </tr>
  )
}
