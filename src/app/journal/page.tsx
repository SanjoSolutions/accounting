import { AccountingWorkspace } from '@/AccountingWorkspace'
import { accountingRouteViews } from '@/accountingRoutes'
import { requirePageUser } from '@/server/authentication'

export default async function JournalPage({ searchParams }: {
  searchParams: Promise<{ year?: string | string[] }>
}) {
  const user = await requirePageUser()
  const initialYear = journalYearFromSearchParameter((await searchParams).year)
  return <AccountingWorkspace key={`${user.id}:${initialYear}`} ownerId={user.id} view={accountingRouteViews['/journal']} initialYear={initialYear} />
}

export function journalYearFromSearchParameter(value: string | string[] | undefined, currentYear = new Date().getFullYear()) {
  if (typeof value !== 'string' || !/^\d{4}$/.test(value)) return currentYear
  const year = Number(value)
  return year >= 1900 && year <= 2200 ? year : currentYear
}
