import 'server-only'

import { getCurrentUser } from '@/server/authentication'
import { authorizeComplianceTenant, complianceError } from '@/server/compliance/runtime'
import { evaluateAndPersistHgbClose, getHgbCloseRuns } from '@/server/hgbCloseRepository'

const parseYear = async (params: Promise<{ year: string }>) => {
  const year = Number((await params).year)
  if (!Number.isSafeInteger(year)) throw new TypeError('Fiscal year must be an integer')
  return year
}

export async function GET(request: Request, { params }: { params: Promise<{ year: string }> }) {
  const user = await getCurrentUser(request.headers)
  if (!user) return Response.json({ success: false }, { status: 401 })
  try { const ownerId = await authorizeComplianceTenant(user.id, new URL(request.url).searchParams.get('tenantId')); return Response.json({ success: true, data: await getHgbCloseRuns(ownerId, await parseYear(params)) }) }
  catch (error) { return complianceError(error) }
}

export async function POST(request: Request, { params }: { params: Promise<{ year: string }> }) {
  const user = await getCurrentUser(request.headers)
  if (!user) return Response.json({ success: false }, { status: 401 })
  try {
    const body: unknown = await request.json()
    if (!body || typeof body !== 'object' || Array.isArray(body)) return Response.json({ success: false, error: 'HGB close request body must be an object' }, { status: 400 })
    const ownerId = await authorizeComplianceTenant(user.id, (body as Record<string, unknown>).tenantId)
    return Response.json({ success: true, data: await evaluateAndPersistHgbClose(ownerId, user.id, await parseYear(params), body as Record<string, unknown>) }, { status: 201 })
  } catch (error) { return complianceError(error) }
}
