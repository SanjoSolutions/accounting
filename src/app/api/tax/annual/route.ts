import 'server-only'
import { TaxDeclarationError } from '@/core/taxDeclarations'
import { parseAnnualTaxValues, parseAnnualTaxYear, type AnnualTaxValue } from '@/core/annualTax'
import { getCurrentUser } from '@/server/authentication'
import { annualTaxApplicability, prepareAnnualTaxDatasets } from '@/server/tax/annualRepository'
import { requireTaxJsonObject, taxError } from '@/server/tax/http'

export async function GET(request: Request) {
  const user = await getCurrentUser(request.headers)
  if (!user) return Response.json({ success: false }, { status: 401 })
  try {
    const url = new URL(request.url); const year = parseAnnualTaxYear(Number(url.searchParams.get('year')))
    return Response.json({ success: true, data: await annualTaxApplicability(user.id, year) })
  } catch (error) { return taxError(error) }
}

export async function POST(request: Request) {
  const user = await getCurrentUser(request.headers)
  if (!user) return Response.json({ success: false }, { status: 401 })
  try {
    const body = requireTaxJsonObject(await request.json(), 'Annual tax request') as { year?: number; values?: AnnualTaxValue[] }
    const year = parseAnnualTaxYear(body.year)
    const values = parseAnnualTaxValues(body.values)
    return Response.json({ success: true, data: await prepareAnnualTaxDatasets(user.id, year, values) })
  } catch (error) { return taxError(error) }
}
