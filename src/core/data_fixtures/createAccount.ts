import { Account } from '../Account'

export function createAccount(): Account {
  return new Account(800, 'Gezeichnetes Kapital')
}
