import { useTranslation } from 'react-i18next'
import type { IRow } from './IRow'
import { useInputStateHandler } from './useInputStateHandler.js'

const accounts = {
  debit: [
    '6170: Sonstige Aufwendungen für bezogene Leistungen',
    'Vorsteuer',
  ],
  credit: [
    'Verbindlichkeiten a. LL',
  ],
}

export function Row({ row, onRemove, showDate }: { row: IRow, onRemove: () => void, showDate?: boolean }) {
  const { t } = useTranslation('Row')

  const [date, onDateChange] = useInputStateHandler({
    name: 'date',
    data: row,
    transform: value => new Date(value),
  })

  const [documentId, onDocumentIdChange] = useInputStateHandler({
    name: 'documentId',
    data: row,
  })

  const [to, onToChange] = useInputStateHandler({
    name: 'to',
    data: row,
  })

  const [account, onAccountChange] = useInputStateHandler({
    name: 'account',
    data: row,
  })

  const [debit, onDebitChange] = useInputStateHandler({
    name: 'debit',
    data: row,
  })

  const [credit, onCreditChange] = useInputStateHandler({
    name: 'credit',
    data: row,
  })

  return (
    <tr>
      {
        showDate !== false ?
          <td>
            <input
              type="date"
              className="form-control"
              style={ { width: '165px' } }
              value={ date }
              onChange={ onDateChange }
            />
          </td> :
          <td className="border-bottom-0">&nbsp;</td>
      }
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
            <option value="to">{ t('to') }</option>
          </select>
          <select
            className="form-select"
            value={ account }
            onChange={ onAccountChange }
          >
            {
              to === '' ?
                accounts.debit.map(account => <option key={ account } value={ account }>{ account }</option>) :
                accounts.credit.map(account => <option key={ account } value={ account }>{ account }</option>)
            }
          </select>
        </div>
      </td>
      {
        to === '' ?
          <td>
            <div className="input-group" style={ { width: '156px' } }>
              <input
                type="number"
                className="form-control"
                value={ debit }
                onChange={ onDebitChange }
              />
              <span className="input-group-text">€</span>
            </div>
          </td> :
          <td>&nbsp;</td>
      }
      {
        to === 'to' ?
          <td>
            <div className="input-group" style={ { width: '156px' } }>
              <input
                type="number"
                className="form-control"
                value={ credit }
                onChange={ onCreditChange }
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
