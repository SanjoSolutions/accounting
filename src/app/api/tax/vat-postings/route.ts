import 'server-only'
import { VatValidationError } from '@/core/vatEngine'
import { getCurrentUser } from '@/server/authentication'
import { listVatPostings, parsePersistentVatInput, persistVatPosting } from '@/server/tax/vatRepository'

export async function GET(request: Request) {
  const user = await getCurrentUser(request.headers)
  if (!user) return Response.json({ success: false }, { status: 401 })
  return Response.json({ success: true, data: await listVatPostings(user.id) })
}
export async function POST(request: Request) {
  const user = await getCurrentUser(request.headers)
  if (!user) return Response.json({ success: false }, { status: 401 })
  try { return Response.json({ success: true, data: await persistVatPosting(user.id, parsePersistentVatInput(await request.json())) }, { status: 201 }) }
  catch (error) { if (error instanceof VatValidationError || error instanceof SyntaxError) return Response.json({ success: false, issues: error instanceof VatValidationError ? error.issues : ['Invalid JSON body.'] }, { status: 400 }); throw error }
}
