import { StructuredInvoicesWorkspace } from '@/StructuredInvoicesWorkspace'
import { requirePageUser } from '@/server/authentication'

export default async function InvoicesPage() {
  await requirePageUser()
  return <StructuredInvoicesWorkspace />
}
