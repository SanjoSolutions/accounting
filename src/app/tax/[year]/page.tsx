import { TaxWorkspace } from '@/TaxWorkspace'
import { requirePageUser } from '@/server/authentication'

export default async function TaxPage({ params }: { params: Promise<{ year: string }> }) {
  await requirePageUser()
  return <TaxWorkspace year={Number((await params).year)} />
}
