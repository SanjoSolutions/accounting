import 'server-only'
import type { Assessment } from '@/core/annualTax'
import { TaxDeclarationError } from '@/core/taxDeclarations'
import { getCurrentUser } from '@/server/authentication'
import { requireTaxJsonObject, taxError } from '@/server/tax/http'
import { listTaxAssessments, recordTaxAssessment } from '@/server/tax/workflows'

export async function GET(request: Request) {
  const user = await getCurrentUser(request.headers)
  if (!user) return Response.json({ success: false }, { status: 401 })
  return Response.json({ success: true, data: await listTaxAssessments(user.id) })
}
export async function POST(request: Request) {
  const user = await getCurrentUser(request.headers)
  if (!user) return Response.json({ success: false }, { status: 401 })
  try {
    const body = requireTaxJsonObject(await request.json(), 'Tax assessment') as unknown as Partial<Assessment>
    if (typeof body.id !== 'string' || typeof body.kind !== 'string' || typeof body.period !== 'string' || !Number.isSafeInteger(body.assessedAmountCents) || typeof body.receivedAt !== 'string' || typeof body.documentHash !== 'string' || typeof body.declarationSubmissionId !== 'string') throw new TaxDeclarationError(['A complete canonical tax assessment is required.'])
    const { taxpayerId: _ignored, ...input } = body as Assessment
    return Response.json({ success: true, data: await recordTaxAssessment(user.id, input) }, { status: 201 })
  }
  catch (error) { return taxError(error) }
}
