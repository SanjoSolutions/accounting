import { AccountingWorkspace } from '@/AccountingWorkspace'
import { accountingRouteViews } from '@/accountingRoutes'
import { requirePageUser } from '@/server/authentication'
export default async function BookingsPage() { const user = await requirePageUser(); return <AccountingWorkspace key={user.id} ownerId={user.id} view={accountingRouteViews['/bookings']} /> }
