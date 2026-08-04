import { FixedAssetsWorkspace } from '@/FixedAssetsWorkspace'
import { requirePageUser } from '@/server/authentication'

export default async function FixedAssetsPage() { await requirePageUser(); return <FixedAssetsWorkspace /> }
