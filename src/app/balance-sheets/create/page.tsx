import { CreateBalanceSheet } from '../../../CreateBalanceSheet'
import { requirePageUser } from '@/server/authentication'

export default async function CreateBalanceSheetPage() {
  await requirePageUser()
  return <CreateBalanceSheet />
}
