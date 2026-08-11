import { AccountingWorkspace } from '@/AccountingWorkspace'
import { accountingRouteViews } from '@/accountingRoutes'
import { fiscalYearFromSearchParameter } from '@/fiscalYearRouting'
import { requirePageUser } from '@/server/authentication'

export default async function HomePage({ searchParams }: { searchParams: Promise<{ year?: string | string[] }> }) {
  const user = await requirePageUser()
  const initialYear = fiscalYearFromSearchParameter((await searchParams).year)
  return <AccountingWorkspace key={`${user.id}:${initialYear}`} ownerId={user.id} view={accountingRouteViews['/']} initialYear={initialYear} />
}
