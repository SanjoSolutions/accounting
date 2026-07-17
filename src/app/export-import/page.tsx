import { ExportImportWorkspace } from '@/ExportImportWorkspace'
import { requirePageUser } from '@/server/authentication'

export default async function ExportImportPage() {
  await requirePageUser()
  return <ExportImportWorkspace />
}
