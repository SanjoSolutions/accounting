import 'server-only'

import { TaxDeclarationError } from '@/core/taxDeclarations'
import { getCurrentUser } from '@/server/authentication'
import { forbiddenUnless } from '@/server/authorization'
import { taxError } from '@/server/tax/http'
import { prepareNarrowCapitalCompanyAnnualTax } from '@/server/tax/narrowUgAnnualRepository'

export async function POST(request: Request) {
  const user = await getCurrentUser(request.headers)
  if (!user) return Response.json({ success: false }, { status: 401 })
  const forbidden = forbiddenUnless(user, 'write'); if (forbidden) return forbidden
  try {
    const body: unknown = await request.json().catch(() => ({}))
    const year = body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>).year : undefined
    if (year !== 2025 && year !== 2026) throw new TaxDeclarationError(['The narrow UG/GmbH annual workflow supports only assessment years 2025 and 2026.'])
    return Response.json({ success: true, data: await prepareNarrowCapitalCompanyAnnualTax(user.id, user.actorId, year) }, { status: 201 })
  } catch (error) { return taxError(error) }
}
