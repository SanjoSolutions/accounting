import 'server-only'
import { getCurrentUser } from '@/server/authentication'
import { forbiddenUnless } from '@/server/authorization'
import { authorizeComplianceTenant, complianceError } from '@/server/compliance/runtime'
import { selectHgbReviewPolicy } from '@/server/hgbReviewPolicyRepository'
import type { HgbReviewPolicyChoice } from '@/core/hgbReviewPolicy'

export async function PUT(request: Request, { params }: { params: Promise<{ year: string }> }) {
  const user = await getCurrentUser(request.headers)
  if (!user) return Response.json({ success: false }, { status: 401 })
  const forbidden = forbiddenUnless(user, 'manage_access'); if (forbidden) return forbidden
  try {
    const body = await request.json()
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new TypeError('Policy request must be an object.')
    const ownerId = await authorizeComplianceTenant(user.id, body.tenantId)
    const year = Number((await params).year)
    if (!Number.isSafeInteger(year)) throw new TypeError('Fiscal year must be an integer.')
    if (body.expectedPolicyId !== null && typeof body.expectedPolicyId !== 'string') throw new TypeError('The current policy ID or explicit null is required.')
    return Response.json({ success: true, data: await selectHgbReviewPolicy(ownerId, user.actorId, year, body.policy as HgbReviewPolicyChoice, body.expectedPolicyId) })
  } catch (error) { return complianceError(error) }
}
