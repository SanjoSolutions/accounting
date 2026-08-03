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
    const extra = body as Partial<Assessment> & { noticeId?: string; documentId?: string; authority?: string }
    if (typeof body.id !== 'string' || typeof body.kind !== 'string' || typeof body.period !== 'string' || !Number.isSafeInteger(body.assessedAmountCents) || typeof body.receivedAt !== 'string' || typeof body.declarationSubmissionId !== 'string' || typeof extra.noticeId !== 'string' || !extra.noticeId.trim() || typeof extra.documentId !== 'string' || !extra.documentId.trim() || extra.authority !== 'FINANZAMT') throw new TaxDeclarationError(['A complete canonical Finanzamt assessment with notice and evidence document is required.'])
    const { taxpayerId: _ignored, documentHash: _untrustedCallerHash, ...input } = body as Assessment
    return Response.json({ success: true, data: await recordTaxAssessment(user.id, { ...input, noticeId: extra.noticeId, documentId: extra.documentId, authority: 'FINANZAMT' }) }, { status: 201 })
  }
  catch (error) { return taxError(error) }
}
