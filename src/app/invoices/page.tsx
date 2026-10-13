import { StructuredInvoicesWorkspace } from '@/StructuredInvoicesWorkspace'
import { requirePageUser } from '@/server/authentication'

export default async function InvoicesPage() {
  const user = await requirePageUser()
  return <StructuredInvoicesWorkspace key={`${user.id}:${user.actorId}`} ownerId={user.id} actorId={user.actorId ?? user.id} />
}
