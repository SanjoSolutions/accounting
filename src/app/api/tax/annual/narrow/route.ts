import 'server-only'

import { TaxDeclarationError } from '@/core/taxDeclarations'
import { getCurrentUser } from '@/server/authentication'
import { taxError } from '@/server/tax/http'
import { prepareNarrowUgAnnualTax } from '@/server/tax/narrowUgAnnualRepository'

export async function POST(request: Request) {
  const user = await getCurrentUser(request.headers)
  if (!user) return Response.json({ success: false }, { status: 401 })
  try {
    const body: unknown = await request.json().catch(() => ({}))
    if (!body || typeof body !== 'object' || Array.isArray(body) || (body as Record<string, unknown>).year !== 2025) throw new TaxDeclarationError(['The narrow UG annual workflow initially supports only assessment year 2025.'])
    return Response.json({ success: true, data: await prepareNarrowUgAnnualTax(user.id, user.id) }, { status: 201 })
  } catch (error) { return taxError(error) }
}
