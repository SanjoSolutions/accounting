import { Account } from '../Account.js'

export function createAccount(): Account {
  return new Account(800, 'Gezeichnetes Kapital')
}
