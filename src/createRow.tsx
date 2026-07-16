import { IRow } from './IRow'

export function createRow(id: number): IRow {
  return {
    id,
    date: '',
    documentId: '',
    to: '',
    account: '',
    debit: '',
    credit: '',
    hasBeenEdited: false
  }
}
