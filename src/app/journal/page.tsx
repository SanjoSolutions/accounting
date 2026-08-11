import { AccountingWorkspace } from '@/AccountingWorkspace'
import { accountingRouteViews } from '@/accountingRoutes'
import { fiscalYearFromSearchParameter } from '@/fiscalYearRouting'
import { requirePageUser } from '@/server/authentication'

export default async function JournalPage({ searchParams }: {
  searchParams: Promise<{ year?: string | string[] }>
}) {
  const user = await requirePageUser()
  const initialYear = journalYearFromSearchParameter((await searchParams).year)
  return <AccountingWorkspace key={`${user.id}:${initialYear}`} ownerId={user.id} view={accountingRouteViews['/journal']} initialYear={initialYear} />
}

export function journalYearFromSearchParameter(value: string | string[] | undefined, currentYear = new Date().getFullYear()) {
  return fiscalYearFromSearchParameter(value, currentYear)
}
