import { AccountingWorkspace } from '@/AccountingWorkspace'
import { accountingRouteViews } from '@/accountingRoutes'
import { fiscalYearFromSearchParameter } from '@/fiscalYearRouting'
import { requirePageUser } from '@/server/authentication'

export default async function BookingsPage({ searchParams }: { searchParams: Promise<{ year?: string | string[] }> }) {
  const user = await requirePageUser()
  const params = await searchParams
  const initialYear = fiscalYearFromSearchParameter(params.year)
  return <AccountingWorkspace
    key={`${user.id}:${initialYear}`}
    ownerId={user.id}
    view={accountingRouteViews['/bookings']}
    initialYear={initialYear}
    restoreStoredYear={false}
  />
}
