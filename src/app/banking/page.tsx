import { BankingWorkspace } from '@/BankingWorkspace'
import { requirePageUser } from '@/server/authentication'

export default async function BankingPage() {
  await requirePageUser()
  return <BankingWorkspace />
}
