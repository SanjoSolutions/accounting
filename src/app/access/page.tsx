import { AccessWorkspace } from '@/AccessWorkspace'
import { requirePageUser } from '@/server/authentication'

export default async function AccessPage() {
  await requirePageUser()
  return <AccessWorkspace />
}
