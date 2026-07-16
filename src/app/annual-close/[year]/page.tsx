import { AnnualCloseWorkspace } from '@/AnnualCloseWorkspace'
import { requirePageUser } from '@/server/authentication'
export default async function AnnualClosePage({ params }: { params: Promise<{ year: string }> }) { await requirePageUser(); return <AnnualCloseWorkspace year={Number((await params).year)} /> }
