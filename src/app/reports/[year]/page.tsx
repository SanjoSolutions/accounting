import { AccountingReportsWorkspace } from '@/AccountingReportsWorkspace'

export default async function AccountingReportsPage({ params }: { params: Promise<{ year: string }> }) {
  return <AccountingReportsWorkspace year={Number((await params).year)} />
}
