import { StructuredInvoicesWorkspace } from '@/StructuredInvoicesWorkspace'
import { requirePageUser } from '@/server/authentication'
import { hasAccountingPermission } from '@/server/authorization'

export default async function InvoicesPage() {
  const user = await requirePageUser()
  return <StructuredInvoicesWorkspace canManageNumbering={hasAccountingPermission(user, 'manage_numbering')} />
}
