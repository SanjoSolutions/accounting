import { EuerValidationError, euerYear } from '@/core/euer'
import { TaxDeclarationError } from '@/core/taxDeclarations'
import { getCurrentUser } from '@/server/authentication'
import { forbiddenUnless } from '@/server/authorization'
import { EuerConflictError, exportEuer, getEuerWorkspace, saveEuerRevision } from '@/server/tax/euerRepository'

function errorResponse(error: unknown) {
  if (error instanceof EuerConflictError) return Response.json({ issues: [error.message] }, { status: 409 })
  if (error instanceof EuerValidationError || error instanceof TaxDeclarationError) return Response.json({ issues: error.issues }, { status: 400 })
  if (error instanceof SyntaxError) return Response.json({ issues: ['Invalid JSON body.'] }, { status: 400 })
  throw error
}
export async function GET(request: Request) {
  const user = await getCurrentUser(request.headers)
  if (!user) return Response.json({ success: false }, { status: 401 })
  try {
    const url = new URL(request.url); const year = euerYear(Number(url.searchParams.get('year')))
    if (url.searchParams.get('format') === 'csv') {
      const csv = await exportEuer(user.id, year, Number(url.searchParams.get('version')))
      return new Response(csv, { headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="euer-${year}.csv"`, 'cache-control': 'no-store' } })
    }
    return Response.json({ data: await getEuerWorkspace(user.id, year), canWrite: !forbiddenUnless(user, 'write') }, { headers: { 'cache-control': 'no-store' } })
  } catch (error) { return errorResponse(error) }
}
export async function POST(request: Request) {
  const user = await getCurrentUser(request.headers)
  if (!user) return Response.json({ success: false }, { status: 401 })
  const forbidden = forbiddenUnless(user, 'write'); if (forbidden) return forbidden
  try { return Response.json({ data: await saveEuerRevision(user.id, user.actorId, await request.json()) }) }
  catch (error) { return errorResponse(error) }
}
