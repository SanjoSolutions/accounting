import { EBalanceWorkspace } from '@/EBalanceWorkspace'
import { requirePageUser } from '@/server/authentication'
export default async function EBalancePage({ params }: { params: Promise<{ year: string }> }) { await requirePageUser(); return <EBalanceWorkspace year={Number((await params).year)} /> }
