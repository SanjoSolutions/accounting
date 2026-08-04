import { CommercialWorkspace } from '@/CommercialWorkspace'
import { requirePageUser } from '@/server/authentication'

export default async function ReceivablesPage() {
  await requirePageUser()
  return <CommercialWorkspace />
}
