import { AccountingReportsWorkspace } from '@/AccountingReportsWorkspace'
import { requirePageUser } from '@/server/authentication'

export default async function AccountingReportsPage({ params }: { params: Promise<{ year: string }> }) {
  await requirePageUser()
  return <AccountingReportsWorkspace year={Number((await params).year)} />
}
