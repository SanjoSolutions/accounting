import { EuerWorkspace } from '@/EuerWorkspace'
import { requirePageUser } from '@/server/authentication'

export default async function EuerPage({ params }: { params: Promise<{ year: string }> }) {
  await requirePageUser()
  return <EuerWorkspace key={(await params).year} year={Number((await params).year)} />
}
