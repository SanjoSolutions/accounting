import React, { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { IRow } from './IRow'

const accounts = {
  debit: [
    '6170: Sonstige Aufwendungen für bezogene Leistungen',
    'Vorsteuer',
  ],
  credit: [
    'Verbindlichkeiten a. LL',
  ],
}

export function Row({
  row: rowProp,
  index,
  rows,
  onRemove,
  showDate,
}: { row: IRow, index: number, rows: IRow[], onRemove: () => void, showDate?: boolean }) {
  const { t } = useTranslation('Row')

  const [row, setRow] = useState(rowProp)

  useEffect(
    () => {
      setRow(rowProp)
    },
    [rowProp],
  )

  const onChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
      const target = event.target
      const { name, value } = target
      const newRow = {
        ...row,
        [name]: value,
        hasBeenEdited: true
      }
      rows[index] = newRow
      setRow(newRow)
    },
    [row, index, rows],
  )

  return (
    <tr>
      {
        showDate !== false ?
          <td>
            <input
              name="date"
              type="date"
              className="form-control"
              style={ { width: '165px' } }
              value={ row.date }
              onChange={ onChange }
            />
          </td> :
          <td className="border-bottom-0">&nbsp;</td>
      }
      <td>
        <input
          name="documentId"
          type="text"
          className="form-control"
          value={ row.documentId }
          onChange={ onChange }
        />
      </td>
      <td>
        <div className="d-flex">
          <select
            name="to"
            className="form-select me-2"
            style={ { width: 'auto' } }
            value={ row.to }
            onChange={ onChange }
          >
            <option value=""></option>
            <option value="to">{ t('to') }</option>
          </select>
          <select
            name="account"
            className="form-select"
            value={ row.account }
            onChange={ onChange }
          >
            {
              row.to === '' ?
                accounts.debit.map(account => <option key={ account } value={ account }>{ account }</option>) :
                accounts.credit.map(account => <option key={ account } value={ account }>{ account }</option>)
            }
          </select>
        </div>
      </td>
      {
        row.to === '' ?
          <td>
            <div className="input-group" style={ { width: '156px' } }>
              <input
                name="debit"
                type="number"
                className="form-control"
                value={ row.debit }
                onChange={ onChange }
              />
              <span className="input-group-text">€</span>
            </div>
          </td> :
          <td>&nbsp;</td>
      }
      {
        row.to === 'to' ?
          <td>
            <div className="input-group" style={ { width: '156px' } }>
              <input
                name="credit"
                type="number"
                className="form-control"
                value={ row.credit }
                onChange={ onChange }
              />
              <span className="input-group-text">€</span>
            </div>
          </td> :
          <td>&nbsp;</td>
      }
      <td>
        <button type="button" className="btn btn-secondary" onClick={ onRemove }>
          <i className="bi bi-x-lg"></i>
        </button>
      </td>
    </tr>
  )
}
