import React from 'react'
import { useTranslation } from 'react-i18next'
import type { IRow } from './IRow'
import { Row } from './Row'

export function BookingRecordEditor({
    rows,
    onSubmit,
    addRow,
    removeRow,
  }: {
    rows: IRow[],
    addRow: () => void,
    removeRow: (index: number) => void
    onSubmit: React.FormEventHandler<HTMLFormElement>,
  },
) {
  const { t } = useTranslation('BookingRecordEditor')

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
