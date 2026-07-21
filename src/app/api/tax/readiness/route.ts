import { TaxDeclarationError } from '@/core/taxDeclarations'
import { getCurrentUser } from '@/server/authentication'
import { getTaxReadiness } from '@/server/tax/operations'

export async function GET(request: Request) {
  const user = await getCurrentUser(request.headers)
  if (!user) return Response.json({ success: false }, { status: 401 })
  const url = new URL(request.url)
  const kind = url.searchParams.get('kind')
  const period = url.searchParams.get('period')
  try {
    if (!kind || !period) throw new TaxDeclarationError(['Tax readiness requires kind and period query parameters.'])
    return Response.json({ success: true, data: await getTaxReadiness(user.id, kind as never, period) })
  } catch (error) {
    if (error instanceof TaxDeclarationError) return Response.json({ success: false, issues: error.issues }, { status: 400 })
    throw error
  }
}
