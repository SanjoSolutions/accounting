import { TaxWorkspace } from '@/TaxWorkspace'

export default async function TaxPage({ params }: { params: Promise<{ year: string }> }) {
  return <TaxWorkspace year={Number((await params).year)} />
}
