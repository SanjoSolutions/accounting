import 'server-only'
import { parseAnnualTaxYear } from '@/core/annualTax'
import { TaxDeclarationError } from '@/core/taxDeclarations'
import { getCurrentUser } from '@/server/authentication'
import { forbiddenUnless } from '@/server/authorization'
import { parseTaxAdjustmentInput, saveTaxAdjustment } from '@/server/tax/annualRepository'
import { requireTaxJsonObject, taxError } from '@/server/tax/http'

export async function POST(request: Request) {
  const user = await getCurrentUser(request.headers)
  if (!user) return Response.json({ success: false }, { status: 401 })
  const forbidden = forbiddenUnless(user, 'write'); if (forbidden) return forbidden
  try {
    const body = requireTaxJsonObject(await request.json(), 'Annual adjustment request') as { year?: number; adjustment?: unknown }
    if (!body.adjustment) throw new TaxDeclarationError(['Annual tax year and adjustment are required.'])
    const year = parseAnnualTaxYear(body.year)
    const adjustment = parseTaxAdjustmentInput(body.adjustment)
    return Response.json({ success: true, data: await saveTaxAdjustment(user.id, year, adjustment) }, { status: 201 })
  } catch (error) { return taxError(error) }
}
