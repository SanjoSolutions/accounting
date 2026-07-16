import { AccountingWorkspace } from '@/AccountingWorkspace'
import { requirePageUser } from '@/server/authentication'
export default async function BookingsPage() { await requirePageUser(); return <AccountingWorkspace /> }
